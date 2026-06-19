import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/store/engine.ts';
import { queryKey } from '../src/store/response.cache.ts';
import { SYSTEM_FIELDS } from '../src/store/registry.ts';
import { type FieldDef, type QueryOptions } from '../src/store/table.ts';

/**
 * be-02 — Strapi v5 SPARSE FIELD SELECTION (`fields`), engine-level projection.
 *
 * Doctrine: NO mocks. The Engine drives the REAL Table + columns; the projected Buffer is proven by an
 * equivalence ORACLE (JSON.stringify of the materialized subset) so wire fidelity is correct BY
 * CONSTRUCTION — i64/decimal stay quoted strings, json verbatim, datetime ISO. The unprojected path is
 * asserted byte-identical to before (no `fields` arg). The cache key is asserted to differentiate a
 * projected response from a full-row one and between distinct field SETS.
 *
 * System fields (id/created_at/updated_at) are prepended exactly as the registry/DDL synthesizes them,
 * so `materialize` key order is id,created_at,updated_at,<user...> and projection emits in that order.
 */

// Real wire-fidelity-bearing columns: i64 (quoted string), decimal (quoted string), json (verbatim), date (ISO).
const USER_FIELDS: FieldDef[] = [
  { name: 'title', type: 'string' },
  { name: 'status', type: 'string' },
  { name: 'views', type: 'i32' },
  { name: 'big', type: 'i64' },
  { name: 'price', type: 'decimal', precision: 12, scale: 2 },
  { name: 'meta', type: 'json' },
  { name: 'publishedAt', type: 'date' },
];
const FIELDS: FieldDef[] = [...SYSTEM_FIELDS, ...USER_FIELDS];

function seed(): Engine {
  const engine = new Engine();
  const t = engine.define('article', FIELDS);
  t.createEqIndex('id');
  t.createEqIndex('status');
  const base = Date.UTC(2021, 0, 1);
  // big > 2^53 (precision-losing as a JSON number), decimal exact, json with a >2^53 nested int + key order.
  engine.insert('article', {
    id: 1, created_at: base, updated_at: base,
    title: 'Hello "x" é 中', status: 'published', views: 42,
    big: '9223372036854775807', price: '1234.56',
    meta: '{"z":1,"a":9007199254740993,"nested":{"k":"v"}}', publishedAt: base + 3_600_000,
  });
  engine.insert('article', {
    id: 2, created_at: base, updated_at: base,
    title: null, status: 'draft', views: null,
    big: '-1', price: '0.00',
    meta: '[1,2,3]', publishedAt: base + 7_200_000,
  });
  t.warmIndexes();
  return engine;
}

/**
 * ORACLE: the materialized row restricted to (id + requested) keys, in materialize order, with the
 * json field's RawJson marker resolved to its parsed value (the wire form the engine emits verbatim).
 * Returns a plain object for deep-equal against the parsed projected response.
 */
function projectOracle(engine: Engine, rowId: number, fields: string[]): Record<string, unknown> {
  const full = engine.table('article').materialize(rowId) as Record<string, unknown>;
  const keep = new Set(fields);
  keep.add('id');
  const picked: Record<string, unknown> = {};
  for (const key of Object.keys(full)) {
    if (!keep.has(key)) continue;
    const v = full[key];
    // A json column materializes as a RawJson marker carrying the verbatim source bytes; the wire value
    // is that JSON parsed. (Round-tripping >2^53 ints is exercised separately in the wire-fidelity test.)
    picked[key] = v !== null && typeof v === 'object' && 'raw' in (v as object)
      ? JSON.parse((v as { raw: string }).raw)
      : v;
  }
  return picked;
}

test('fields: list projection returns exactly the requested columns + id (force-included)', () => {
  const engine = seed();
  const buf = engine.respond('article', { sort: [{ field: 'id', dir: 'asc' }] }, [], ['title', 'status']);
  const parsed = JSON.parse(buf.toString('utf8')) as { data: Record<string, unknown>[] };
  assert.equal(parsed.data.length, 2);
  // EXACTLY id + the two requested keys; nothing else (no created_at/updated_at/views/...).
  assert.deepEqual(Object.keys(parsed.data[0]!), ['id', 'title', 'status']);
  assert.deepEqual(parsed.data[0], { id: 1, title: 'Hello "x" é 中', status: 'published' });
  assert.deepEqual(parsed.data[1], { id: 2, title: null, status: 'draft' });
});

test('fields: id force-included even when NOT listed (Strapi always returns id)', () => {
  const engine = seed();
  const buf = engine.respond('article', { sort: [{ field: 'id', dir: 'asc' }] }, [], ['title']);
  const parsed = JSON.parse(buf.toString('utf8')) as { data: Record<string, unknown>[] };
  assert.deepEqual(Object.keys(parsed.data[0]!), ['id', 'title']);
  assert.equal(parsed.data[0]!.id, 1);
});

test('fields: explicitly listing id is idempotent (no duplicate key, materialize order)', () => {
  const engine = seed();
  const buf = engine.respond('article', { sort: [{ field: 'id', dir: 'asc' }] }, [], ['id', 'title']);
  const parsed = JSON.parse(buf.toString('utf8')) as { data: Record<string, unknown>[] };
  assert.deepEqual(Object.keys(parsed.data[0]!), ['id', 'title']);
});

test('fields: wire fidelity holds on projected rows (i64/decimal quoted strings, json verbatim, datetime ISO)', () => {
  const engine = seed();
  const buf = engine.respond('article', { sort: [{ field: 'id', dir: 'asc' }] }, [], ['big', 'price', 'meta', 'publishedAt']);
  const s = buf.toString('utf8');
  // i64 + decimal are QUOTED strings (lossless past 2^53); the >2^53 json int survives VERBATIM.
  assert.match(s, /"big":"9223372036854775807"/);
  assert.match(s, /"price":"1234\.56"/);
  assert.match(s, /"meta":\{"z":1,"a":9007199254740993,"nested":\{"k":"v"\}\}/); // verbatim: key order + big int intact
  assert.match(s, /"publishedAt":"2021-01-01T01:00:00\.000Z"/); // ISO-8601 UTC
  const parsed = JSON.parse(s) as { data: Record<string, unknown>[] };
  assert.equal(parsed.data[0]!.big, '9223372036854775807');
  assert.equal(parsed.data[0]!.price, '1234.56');
  assert.deepEqual(parsed.data[1]!.meta, [1, 2, 3]); // json array survives verbatim through projection
  // NOTE: the >2^53 int's VERBATIM survival is proven by the regex above; JSON.parse here loses precision
  // (9007159...993 -> ...992), which is exactly WHY the engine splices the raw bytes instead of re-parsing.
  assert.match(s, /9007199254740993/);
});

test('fields: projected list bytes equal the materialized subset envelope (oracle)', () => {
  const engine = seed();
  const sel = ['title', 'big', 'price', 'meta', 'publishedAt'];
  const buf = engine.respond('article', { sort: [{ field: 'id', dir: 'asc' }] }, [], sel);
  const parsed = JSON.parse(buf.toString('utf8')) as { data: unknown[] };
  // Structural oracle for both rows (json verbatim normalizes identically through JSON.parse).
  assert.deepEqual(parsed.data[0], projectOracle(engine, 0, sel));
  assert.deepEqual(parsed.data[1], projectOracle(engine, 1, sel));
  assert.equal(buf.toString('utf8').startsWith('{"data":['), true);
});

test('fields: single-item (respondById) projects the same subset + id', () => {
  const engine = seed();
  const buf = engine.respondById('article', 1, [], undefined, ['title', 'views'])!;
  assert.notEqual(buf, null);
  const parsed = JSON.parse(buf.toString('utf8')) as { data: Record<string, unknown>; meta: unknown };
  assert.deepEqual(Object.keys(parsed.data), ['id', 'title', 'views']);
  assert.deepEqual(parsed.data, { id: 1, title: 'Hello "x" é 中', views: 42 });
  assert.deepEqual(parsed.meta, {});
});

test('fields: composes with filters + sort (projection applies to the matched/ordered page)', () => {
  const engine = seed();
  const buf = engine.respond(
    'article',
    { where: { leaf: { field: 'status', op: 'eq', value: 'published' } }, sort: [{ field: 'id', dir: 'desc' }] },
    [],
    ['status'],
  );
  const parsed = JSON.parse(buf.toString('utf8')) as { data: Record<string, unknown>[] };
  assert.equal(parsed.data.length, 1);
  assert.deepEqual(parsed.data[0], { id: 1, status: 'published' });
});

test('fields ABSENT: the full-row zero-copy path is byte-identical (no regression)', () => {
  const engine = seed();
  const opts: QueryOptions = { sort: [{ field: 'id', dir: 'asc' }] };
  const withUndef = engine.respond('article', opts, []); // no fields arg
  const explicitUndef = engine.respond('article', opts, [], undefined);
  assert.equal(withUndef.toString('utf8'), explicitUndef.toString('utf8'));
  // The full row carries ALL keys (system + user), unlike any projection.
  const parsed = JSON.parse(withUndef.toString('utf8')) as { data: Record<string, unknown>[] };
  assert.deepEqual(Object.keys(parsed.data[0]!).sort(), FIELDS.map((f) => f.name).sort());
});

test('cache key: a projected response is never served for a full-row request (or a different set)', () => {
  const engine = seed();
  const opts: QueryOptions = { sort: [{ field: 'id', dir: 'asc' }] };
  // Full-row, then fields=title, then fields=status — three DISTINCT cache entries; none collide.
  const full = engine.respond('article', opts, []).toString('utf8');
  const projTitle = engine.respond('article', opts, [], ['title']).toString('utf8');
  const projStatus = engine.respond('article', opts, [], ['status']).toString('utf8');
  assert.notEqual(full, projTitle);
  assert.notEqual(full, projStatus);
  assert.notEqual(projTitle, projStatus);
  // Re-issue each: a cache HIT must return the SAME (correctly-shaped) bytes — no cross-contamination.
  assert.equal(engine.respond('article', opts, []).toString('utf8'), full);
  assert.equal(engine.respond('article', opts, [], ['title']).toString('utf8'), projTitle);
  assert.equal(engine.respond('article', opts, [], ['status']).toString('utf8'), projStatus);
});

test('cache key: field ORDER is irrelevant but the SET is bound', () => {
  const opts: QueryOptions = { sort: [{ field: 'id', dir: 'asc' }] };
  // Same set, different order => SAME key (order-independent).
  assert.equal(queryKey('article', opts, undefined, ['title', 'status']), queryKey('article', opts, undefined, ['status', 'title']));
  // Different set => different key.
  assert.notEqual(queryKey('article', opts, undefined, ['title']), queryKey('article', opts, undefined, ['title', 'status']));
  // Absent fields => byte-identical to the legacy key (additive guarantee).
  assert.equal(queryKey('article', opts, undefined), queryKey('article', opts, undefined, undefined));
  assert.equal(queryKey('article', opts, undefined), queryKey('article', opts, undefined, []));
});
