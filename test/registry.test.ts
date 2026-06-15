import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createSql } from '../src/db/client.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { createContentType } from '../src/db/content-type-repo.ts';
import { Registry, RegistryError } from '../src/store/registry.ts';
import { loadType } from '../src/db/load.ts';
import { Engine } from '../src/store/engine.ts';

/**
 * REGISTRY SLICE — Registry.build from the real meta tables (no mocks). Proves the runtime source of
 * truth: system fields synthesized + prepended in order, engine types 1:1, decimal scale/precision
 * threaded (incl. scale 0), the index plan, writable/required derivation, and the loud failures
 * (unknown/forward-incompatible meta -> RegistryError, incl. the `time` rejection).
 */

const sql = createSql();

async function cleanCatalog(): Promise<void> {
  const tables = await sql<{ table_name: string }[]>`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'ct\\_%'`;
  for (const { table_name } of tables) await sql.unsafe(`DROP TABLE IF EXISTS "${table_name}" CASCADE`);
  await sql`DELETE FROM content_type_fields`;
  await sql`DELETE FROM content_types`;
}

before(async () => {
  await runMigrations();
  await cleanCatalog();
});
beforeEach(cleanCatalog);
after(async () => {
  await cleanCatalog();
  await sql.end();
});

test('build: system fields prepended in order, engine types 1:1, decimal scale/precision (incl scale 0), index plan, writable/required', async () => {
  await createContentType(sql, {
    apiId: 'kitchen',
    fields: [
      { name: 'name', cmsType: 'string', options: { length: 50, nullable: false } },
      { name: 'big', cmsType: 'biginteger', options: { nullable: true } },
      { name: 'price', cmsType: 'decimal', options: { precision: 10, scale: 2, nullable: true } },
      { name: 'qty', cmsType: 'decimal', options: { precision: 8, scale: 0, nullable: true } },
      { name: 'meta', cmsType: 'json', options: { nullable: true } },
      { name: 'kind', cmsType: 'enumeration', options: { values: ['a', 'b', 'c'], nullable: false } },
      { name: 'ref', cmsType: 'uuid', options: { nullable: true } },
      { name: 'count', cmsType: 'integer', options: { nullable: true } },
      { name: 'flag', cmsType: 'boolean', options: { nullable: false } },
      { name: 'when', cmsType: 'datetime', options: { nullable: false } },
    ],
  });

  const reg = await Registry.build(sql);
  const def = reg.get('kitchen')!;
  assert.ok(def);

  // System fields first, in DDL order, then user fields by sort.
  assert.deepEqual(def.fields.slice(0, 3).map((f) => f.name), ['id', 'created_at', 'updated_at']);
  assert.deepEqual(def.fields.slice(0, 3).map((f) => f.type), ['i32', 'date', 'date']);
  assert.deepEqual(def.fields.slice(3).map((f) => f.name), ['name', 'big', 'price', 'qty', 'meta', 'kind', 'ref', 'count', 'flag', 'when']);

  // engine types 1:1
  const byName = new Map(def.fields.map((f) => [f.name, f]));
  assert.equal(byName.get('big')!.type, 'i64');
  assert.equal(byName.get('price')!.type, 'decimal');
  assert.equal(byName.get('meta')!.type, 'json');
  assert.equal(byName.get('kind')!.type, 'string');
  assert.equal(byName.get('ref')!.type, 'string');

  // decimal scale/precision threaded (incl. scale 0)
  assert.equal(byName.get('price')!.scale, 2);
  assert.equal(byName.get('price')!.precision, 10);
  assert.equal(byName.get('qty')!.scale, 0);
  assert.equal(byName.get('qty')!.precision, 8);

  // enum carries values; json is flagged
  assert.deepEqual([...byName.get('kind')!.enumValues!].sort(), ['a', 'b', 'c']);
  assert.equal(byName.get('meta')!.json, true);

  // index plan: eq(id) always, eq on bool + enum-string, sorted on numerics/date/i64/decimal, never json.
  assert.ok(def.indexPlan.eq.includes('id'));
  assert.ok(def.indexPlan.eq.includes('flag')); // bool
  assert.ok(def.indexPlan.eq.includes('kind')); // enum string
  assert.ok(!def.indexPlan.eq.includes('name')); // plain string not eq-indexed
  assert.ok(def.indexPlan.sorted.includes('big')); // i64
  assert.ok(def.indexPlan.sorted.includes('price')); // decimal
  assert.ok(def.indexPlan.sorted.includes('count')); // i32
  assert.ok(def.indexPlan.sorted.includes('when')); // date
  assert.ok(!def.indexPlan.sorted.includes('meta')); // json never

  // writable excludes system; requiredOnCreate = NOT NULL && no default.
  assert.ok(!def.writableByName.has('id'));
  assert.ok(!def.writableByName.has('created_at'));
  assert.deepEqual([...def.requiredOnCreate].sort(), ['flag', 'kind', 'name', 'when']);
  assert.ok(def.nullableNames.has('big'));
});

test('build: a `time` field is rejected with RegistryError (engineType i32 but pg returns a string)', async () => {
  await createContentType(sql, { apiId: 'sched', fields: [{ name: 'at', cmsType: 'time', options: { nullable: true } }] });
  await assert.rejects(() => Registry.build(sql), RegistryError);
});

test('a system-fields-only type builds a 3-field def and loads to a valid 0-row table', async () => {
  await createContentType(sql, { apiId: 'bare', fields: [] });
  const reg = await Registry.build(sql);
  const def = reg.get('bare')!;
  assert.equal(def.fields.length, 3);
  assert.equal(def.writable.length, 0);

  const engine = new Engine();
  await loadType(sql, engine, def);
  assert.equal(engine.rowCount('bare'), 0);
  assert.equal(engine.respondById('bare', 1), null);
});
