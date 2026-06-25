import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { rm, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';
import { applySchemaEdit } from '../src/compose/builder.ts';
import { MigrationDataLossError } from '../src/db/schema/migrate.ts';
import { loadTypes } from '../src/db/schema/load.ts';
import { createFileDatabase, dropFileDatabase } from './db-per-file.ts';
import { cleanCatalog, tableExists, physicalColumns } from './helpers.ts';

/**
 * Phase 5 (server side of the visual Builder) — applySchemaEdit over REAL Postgres. Proves: an edit mints
 * ids + materializes the DB (migrate) + writes entities/<apiId>/schema.ts, the written file ROUND-TRIPS
 * back to the same IR via loadTypes (generateSchemaSource is the inverse of defToSchema), and a destructive
 * edit is GATED — nothing written, nothing applied — until allowDestructive. The gen dir lives under
 * packages/api so the generated `import '@conti/core'` resolves.
 */

const genDir = fileURLToPath(new URL(`./fixtures/.gen-${process.pid}`, import.meta.url));

let sql: Sql;
let db: Awaited<ReturnType<typeof createFileDatabase>>;

before(async () => {
  db = await createFileDatabase('builder');
  sql = db.sql;
});
beforeEach(async () => {
  await cleanCatalog(sql);
  await sql`DROP TABLE IF EXISTS _schema_applied`;
});
after(async () => {
  if (sql) await sql.end();
  if (db) await dropFileDatabase(db.name);
  await rm(genDir, { recursive: true, force: true });
});

test('create: mints ids, migrates the DB, writes schema.ts that round-trips to the same IR', async () => {
  const r = await applySchemaEdit(sql, genDir, {
    apiId: 'gadget',
    fields: [
      { name: 'title', type: 'string', options: { nullable: true } },
      { name: 'count', type: 'integer', options: { nullable: false, default: 0 } },
    ],
  });
  assert.equal(r.ok, true);
  assert.ok(r.applied!.some((c) => c.kind === 'addType'));
  assert.equal(await tableExists(sql, 'ct_gadget'), true); // DB migrated
  assert.ok(r.schema!.fields.every((f) => f.id.startsWith('f_')), 'ids minted for new fields');

  // the WRITTEN file loads back to the identical IR (codegen ⇄ defToSchema round-trip).
  const { schemas } = await loadTypes(genDir);
  const loaded = schemas.find((s) => s.apiId === 'gadget');
  assert.deepStrictEqual(loaded, r.schema);
});

test('destructive edit is gated: blocked → nothing written/applied; allowDestructive → applied', async () => {
  await applySchemaEdit(sql, genDir, {
    apiId: 'widget',
    fields: [
      { name: 'a', type: 'string', options: { nullable: true } },
      { name: 'b', type: 'string', options: { nullable: true } },
    ],
  });
  const created = (await loadTypes(genDir)).schemas.find((s) => s.apiId === 'widget')!;
  // drop 'b' — keep 'a' with its existing id (rename-safety: existing ids preserved).
  const dropDraft = { apiId: 'widget', id: created.id, fields: [created.fields.find((f) => f.name === 'a')!] };

  const blocked = await applySchemaEdit(sql, genDir, dropDraft);
  assert.equal(blocked.ok, false);
  assert.ok(blocked.blocked!.some((c) => c.kind === 'dropField'));
  assert.ok((await physicalColumns(sql, 'ct_widget')).some((c) => c.name === 'b'), 'gated edit applied nothing');

  const ok = await applySchemaEdit(sql, genDir, dropDraft, { allowDestructive: true });
  assert.equal(ok.ok, true);
  assert.ok(!(await physicalColumns(sql, 'ct_widget')).some((c) => c.name === 'b'));
});

test('S2 atomicity: a migrate that fails AFTER lint leaves schema.ts untouched + orphans no temp file', async () => {
  await applySchemaEdit(sql, genDir, { apiId: 'box', fields: [{ name: 'title', type: 'string', options: { length: 1024, nullable: true } }] });
  await sql.unsafe(`INSERT INTO ct_box (title) VALUES ('${'y'.repeat(1024)}')`); // an over-long row
  const created = (await loadTypes(genDir)).schemas.find((s) => s.apiId === 'box')!;

  // Shrink title to 256 WITH allowDestructive: this PASSES migrateLint (the ack is given) so applySchemaEdit
  // proceeds to write the temp file + migrate — but migrate's pre-flight throws MigrationDataLossError on the
  // 1024-char row. The temp must be unlinked and schema.ts left at length 1024 (file never ahead of the DB).
  const shrink = { apiId: 'box', id: created.id, fields: [{ id: created.fields[0]!.id, name: 'title', type: 'string' as const, options: { length: 256, nullable: true } }] };
  await assert.rejects(() => applySchemaEdit(sql, genDir, shrink, { allowDestructive: true }), MigrationDataLossError);

  // schema.ts UNTOUCHED: it still round-trips to length 1024 (the failed edit did not flip the file).
  const reloaded = (await loadTypes(genDir)).schemas.find((s) => s.apiId === 'box')!;
  assert.equal(reloaded.fields[0]!.options?.length, 1024, 'schema.ts still the pre-edit length');
  // No orphan temp file left behind in the type's dir.
  const entries = await readdir(fileURLToPath(new URL(`./fixtures/.gen-${process.pid}/box`, import.meta.url)));
  assert.deepEqual(entries.filter((e) => e.includes('.tmp')), [], 'no leftover temp file');
  // DB column still varchar(1024) — nothing applied.
  assert.equal((await physicalColumns(sql, 'ct_box')).find((c) => c.name === 'title')?.type, 'character varying');
});
