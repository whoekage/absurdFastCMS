import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';
import { applySchemaEdit } from '../src/compose/builder.ts';
import { reconcileBoot, SchemaReconcileHaltError } from '../src/compose/boot-reconcile.ts';
import { readAppliedSchemas, ensureAppliedTable, writeAppliedSnapshot } from '../src/db/schema/migrate.ts';
import { generateSchemaSource } from '../src/db/schema/codegen.ts';
import type { Schema } from '../src/db/schema/model.ts';
import { createFileDatabase, dropFileDatabase } from './db-per-file.ts';
import { cleanCatalog, physicalColumns } from './helpers.ts';

/**
 * S3 — the boot reconciliation guard, over REAL Postgres (no mocks). Proves it heals the S2 crash window
 * (files BEHIND the applied snapshot → recover-forward, never apply the reverse drop), migrates files-ahead
 * forward (incl. an already-acked data-dependent change), is a clean no-op in steady state, backfills the
 * baseline, and HALTs LOUD rather than write a lossy file on a non-round-trippable snapshot.
 *
 * NOTE: tests drive `reconcileBoot` with an IN-MEMORY files-IR built from `readAppliedSchemas` (the real
 * minted ids), NEVER by re-`loadTypes`-ing an edited file — Node's ESM module cache returns the first-imported
 * version of a path for the whole process, so a re-read of a rewritten schema.ts is stale (the documented
 * gotcha). Each test uses a DISTINCT name so on-disk paths never collide across the suite.
 */

const genDir = fileURLToPath(new URL(`./fixtures/.gen-${process.pid}-s3/`, import.meta.url));
const schemaPath = (name: string): string => path.join(genDir, name, 'schema.ts');
const applied = async (name: string): Promise<Schema> => (await readAppliedSchemas(sql)).find((s) => s.name === name)!;
async function writeSchemaFile(s: Schema): Promise<void> {
  await mkdir(path.join(genDir, s.name), { recursive: true });
  await writeFile(schemaPath(s.name), generateSchemaSource(s));
}

let sql: Sql;
let db: Awaited<ReturnType<typeof createFileDatabase>>;

before(async () => {
  db = await createFileDatabase('boot-reconcile');
  sql = db.sql;
});
beforeEach(async () => {
  await cleanCatalog(sql);
  await sql`DROP TABLE IF EXISTS _schema_applied`;
  await rm(genDir, { recursive: true, force: true });
});
after(async () => {
  if (sql) await sql.end();
  if (db) await dropFileDatabase(db.name);
  await rm(genDir, { recursive: true, force: true });
});

test('A — files BEHIND (crash window): recover-forward regenerates the file, the reverse drop is NOT applied', async () => {
  await applySchemaEdit(sql, genDir, { name: 'gbehind', fields: [
    { name: 'title', type: 'string', options: { nullable: true } },
    { name: 'b', type: 'string', options: { nullable: true } },
  ] });
  await sql.unsafe(`INSERT INTO ct_gbehind (title, b) VALUES ('t', 'keep')`);
  const full = await applied('gbehind');
  // Simulate the crash window: the on-disk file LAGS (missing 'b'), and the files-IR boot sees is that lag.
  const lagging: Schema = { ...full, fields: full.fields.filter((f) => f.name !== 'b') };
  await writeSchemaFile(lagging);

  const r = await reconcileBoot(sql, genDir, [lagging], new Map());
  assert.equal(r.outcome, 'recovered-forward');
  assert.deepEqual([...r.recovered], ['gbehind']);
  // The reverse drop was NOT applied: column 'b' + its value survive, snapshot unchanged.
  assert.ok((await physicalColumns(sql, 'ct_gbehind')).some((c) => c.name === 'b'), 'column b survives');
  assert.equal((await sql<{ b: string }[]>`SELECT b FROM ct_gbehind`)[0]?.b, 'keep');
  // schema.ts was regenerated back to the full shape; the served IR has 'b'.
  assert.match(await readFile(schemaPath('gbehind'), 'utf8'), /\bb:\s*c\.string/, 'file restored with field b');
  assert.ok(r.schemas.find((s) => s.name === 'gbehind')!.fields.some((f) => f.name === 'b'), 'served IR has b');
});

test('B — files AHEAD (forward SAFE add): migrate forward, snapshot + column updated', async () => {
  await applySchemaEdit(sql, genDir, { name: 'gahead', fields: [{ name: 'a', type: 'string', options: { nullable: true } }] });
  const base = await applied('gahead');
  const ahead: Schema = { ...base, fields: [...base.fields, { id: 'f_added', name: 'c', type: 'string', options: { nullable: true } }] };

  const r = await reconcileBoot(sql, genDir, [ahead], new Map());
  assert.equal(r.outcome, 'migrated');
  assert.ok((await physicalColumns(sql, 'ct_gahead')).some((c) => c.name === 'c'), 'column c added');
  assert.ok((await applied('gahead')).fields.some((f) => f.name === 'c'), 'snapshot updated');
});

test('G — files AHEAD by an already-acked DATA-DEPENDENT change: migrate forward, NOT a false-HALT', async () => {
  await applySchemaEdit(sql, genDir, { name: 'gdd', fields: [{ name: 'a', type: 'string', options: { nullable: true } }] });
  await sql.unsafe(`INSERT INTO ct_gdd (a) VALUES ('row')`);
  const base = await applied('gdd');
  // NOT-NULL add WITH default — the data-dependent class that lint() blocks WITHOUT allowDestructive; the
  // forward branch passes allowDestructive:true, so this must migrate (not throw MigrationBlockedError).
  const ahead: Schema = { ...base, fields: [...base.fields, { id: 'f_d', name: 'd', type: 'integer', options: { nullable: false, default: 0 } }] };

  const r = await reconcileBoot(sql, genDir, [ahead], new Map());
  assert.equal(r.outcome, 'migrated');
  assert.ok((await applied('gdd')).fields.some((f) => f.name === 'd'));
});

test('C — clean (file == snapshot): no-op, nothing migrated', async () => {
  await applySchemaEdit(sql, genDir, { name: 'gclean', fields: [{ name: 'a', type: 'string', options: { nullable: true } }] });
  const before = (await physicalColumns(sql, 'ct_gclean')).map((c) => c.name).sort();

  const r = await reconcileBoot(sql, genDir, [await applied('gclean')], new Map());
  assert.equal(r.outcome, 'clean');
  assert.deepEqual((await physicalColumns(sql, 'ct_gclean')).map((c) => c.name).sort(), before, 'no column change');
});

test('D — baseline (no _schema_applied, empty DB): migrate() creates the table + backfills snapshot, idempotent on re-run', async () => {
  const ir: Schema = { id: 'ct_gb', name: 'gbase', fields: [{ id: 'f_a', name: 'a', type: 'string', options: { nullable: true } }] };
  // Baseline precondition: NO snapshot AND the table not yet present. The new migrate()-based baseline path
  // CREATEs the ct_ table itself (DDL + snapshot in one tx) — unlike the old seedFromSchemas create-if-absent,
  // a pre-existing ct_ table would now 42P07 (compileCreateTable has no IF NOT EXISTS), but that state is
  // unreachable in production since DDL + snapshot always commit together.
  await sql`DROP TABLE IF EXISTS ct_gbase`;
  await sql`DROP TABLE IF EXISTS _schema_applied`;

  const r = await reconcileBoot(sql, genDir, [ir], new Map());
  assert.equal(r.outcome, 'clean');
  assert.ok((await physicalColumns(sql, 'ct_gbase')).some((c) => c.name === 'a'), 'baseline migrate created the table');
  assert.ok((await readAppliedSchemas(sql)).some((s) => s.name === 'gbase'), 'snapshot backfilled');

  // D2 — re-run is clean with an empty diff (migrate DDL ⇄ snapshot shape agree, no phantom-diff).
  assert.equal((await reconcileBoot(sql, genDir, [ir], new Map())).outcome, 'clean');
});

test('H — recover-forward of a snapshot with a localized field HALTs LOUD (never writes a lossy file)', async () => {
  const localizedIR: Schema = { id: 'ct_gh', name: 'ghalt', fields: [
    { id: 'f_a', name: 'a', type: 'string', options: { nullable: true } },
    { id: 'f_b', name: 'b', type: 'string', options: { nullable: true }, localized: true },
  ] };
  await ensureAppliedTable(sql);
  await writeAppliedSnapshot(sql, [localizedIR]); // snapshot carries the non-round-trippable property
  const lagging: Schema = { ...localizedIR, fields: [localizedIR.fields[0]!] }; // drops 'b' (reverse)
  // Write a NON-localized lagging file (codegen can't emit localized), then capture its exact bytes.
  await mkdir(path.join(genDir, 'ghalt'), { recursive: true });
  const laggingSrc = generateSchemaSource(lagging);
  await writeFile(schemaPath('ghalt'), laggingSrc);

  await assert.rejects(() => reconcileBoot(sql, genDir, [lagging], new Map()), SchemaReconcileHaltError);
  // The lagging file was NOT overwritten (no lossy recovery write landed).
  assert.equal(await readFile(schemaPath('ghalt'), 'utf8'), laggingSrc, 'file untouched by the halted recovery');
});
