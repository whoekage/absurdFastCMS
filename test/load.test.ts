import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createSql } from '../src/db/client.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { createContentType } from '../src/db/content-type-repo.ts';
import { Registry } from '../src/store/registry.ts';
import { buildEngine } from '../src/db/load.ts';

/**
 * LOAD SLICE — generalized loader over a REAL Postgres (no mocks). Multi-type load, i64/decimal/json
 * byte-exact round-trip (nested integers > 2^53 + key order preserved via the `::text` path), warm-once
 * (no dirty index after load), empty type -> 0 rows, and the SQL-NULL vs jsonb `'null'` distinction.
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

/** Extract the raw bytes of one field from a single-item response Buffer (avoids JSON.parse precision loss). */
function rawField(buf: Buffer, field: string): string {
  const s = buf.toString('utf8');
  const key = `"${field}":`;
  const start = s.indexOf(key) + key.length;
  // Read until the next top-level comma or the closing of data. For our test fields the value is a
  // string or object terminated by `,"` (next key) or `}` — find the matching end heuristically.
  let depth = 0;
  let i = start;
  if (s[i] === '"') {
    // string value
    i++;
    while (i < s.length && s[i] !== '"') {
      if (s[i] === '\\') i++;
      i++;
    }
    return s.slice(start, i + 1);
  }
  while (i < s.length) {
    const c = s[i]!;
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      if (depth === 0) break;
      depth--;
    } else if (c === ',' && depth === 0) break;
    i++;
  }
  return s.slice(start, i);
}

test('multi-type load with i64/decimal/json byte-exact round-trip; warm once; empty type 0 rows', async () => {
  await createContentType(sql, {
    apiId: 'note',
    fields: [
      { name: 'big', cmsType: 'biginteger', options: { nullable: true } },
      { name: 'price', cmsType: 'decimal', options: { precision: 18, scale: 2, nullable: true } },
      { name: 'meta', cmsType: 'json', options: { nullable: true } },
    ],
  });
  await createContentType(sql, { apiId: 'empty', fields: [{ name: 'x', cmsType: 'integer', options: { nullable: true } }] });

  // jsonb with a nested integer > 2^53 and out-of-order keys.
  const bigInt = 9007199254740993; // 2^53 + 1
  await sql.unsafe(
    `INSERT INTO ct_note (big, price, meta) VALUES ('9223372036854775807', '12345.67', '{"big": ${bigInt}, "z": 1, "a": 2}'::jsonb)`,
  );
  // A NULL in each nullable column, plus a jsonb literal 'null' value (distinct from SQL NULL).
  await sql.unsafe(`INSERT INTO ct_note (big, price, meta) VALUES (NULL, NULL, NULL)`);
  await sql.unsafe(`INSERT INTO ct_note (big, price, meta) VALUES ('1', '0.01', 'null'::jsonb)`);

  const registry = await Registry.build(sql);
  const engine = await buildEngine(sql, registry);

  assert.equal(engine.rowCount('note'), 3);
  assert.equal(engine.rowCount('empty'), 0);
  assert.equal(engine.respondById('empty', 1), null);

  // warm once: no dirty index after load.
  assert.equal(engine.table('note').hasDirtyIndex(), false);

  // Row 1: i64 exact quoted string, decimal formatDecimal quoted, json verbatim — the `::text` path
  // returns jsonb's OWN canonical text (jsonb reorders keys + normalizes whitespace), which we emit
  // BYTE-FOR-BYTE. Crucially the nested integer > 2^53 SURVIVES exact (postgres.js's JS parse would
  // have corrupted it to a double) — that is the precision guarantee this asserts.
  const b1 = engine.respondById('note', 1)!;
  assert.equal(rawField(b1, 'big'), '"9223372036854775807"');
  assert.equal(rawField(b1, 'price'), '"12345.67"');
  assert.equal(rawField(b1, 'meta'), `{"a": 2, "z": 1, "big": ${bigInt}}`);
  assert.ok(rawField(b1, 'meta').includes(String(bigInt))); // the > 2^53 int is intact

  // Row 2: SQL NULLs render as JSON null.
  const o2 = JSON.parse(engine.respondById('note', 2)!.toString('utf8'));
  assert.equal(o2.data.big, null);
  assert.equal(o2.data.price, null);
  assert.equal(o2.data.meta, null);

  // Row 3: jsonb literal 'null' is a real value -> renders as `null` token but is DISTINCT from SQL NULL
  // (it came from a non-NULL column). big='1' decimal='0.01'.
  const b3 = engine.respondById('note', 3)!;
  assert.equal(rawField(b3, 'big'), '"1"');
  assert.equal(rawField(b3, 'price'), '"0.01"');
  assert.equal(rawField(b3, 'meta'), 'null');
});
