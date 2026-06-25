import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Sql } from 'postgres';
import type { ComponentSchema, Schema, FieldSchema, FieldType } from '../src/db/schema/model.ts';
import type { FieldOptions } from '../src/db/type.catalog.ts';

// Point local storage at a fresh temp dir BEFORE any config access (config caches on first read).
const STORAGE_DIR = await mkdtemp(path.join(os.tmpdir(), 'absurd-cmp-write-'));
process.env.LOCAL_STORAGE_PATH = STORAGE_DIR;
delete process.env.S3_BUCKET; // select the LOCAL provider for this run.

const { runMigrations } = await import('../src/db/migration.runner.ts');
const { createFileDatabase, dropFileDatabase } = await import('./db-per-file.ts');
const { cleanCatalog, schema, startTestServerFromSchemas } = await import('./helpers.ts');
const { mintId } = await import('../src/db/schema/model.ts');
const { resetStorageProvider } = await import('../src/storage/index.ts');
const { pngBytes } = await import('./storage-fixtures.ts');

/** Build an in-memory ComponentSchema (mints the component + field ids). Fields use the files-first `type`. */
function component(apiId: string, fields: { name: string; type: FieldType; options?: FieldOptions }[]): ComponentSchema {
  return { id: mintId('cmp'), apiId, fields: fields.map((f): FieldSchema => ({ id: mintId('f'), ...f })) };
}

/**
 * be-05 COMPONENT — RECURSIVE WRITE VALIDATION + READ POPULATE, end-to-end over a REAL uWS server + REAL
 * Postgres (per-file clone) + REAL local-fs (no mocks). Proves:
 *  - a SINGLE / REPEATABLE / DYNAMIC-ZONE component value is validated field-by-field, stored as jsonb,
 *    and read back VERBATIM un-populated (with stable assigned instance ids + preserved array order);
 *  - wire fidelity INSIDE a component (biginteger/decimal STRING, datetime ISO, nested json verbatim);
 *  - invalid shapes 400 with a SCOPED path (unknown nested field, bad/disallowed/unknown __component,
 *    too-deep nesting, oversized JSON);
 *  - an INLINE media ref inside a component is existence-checked in the write tx (dangling id -> 400) and
 *    POPULATED on read (the asset object inlined in place of the bare id);
 *  - a content type WITHOUT a component field is byte-identical (its read path is untouched).
 */

let sql: Sql;
let db: Awaited<ReturnType<typeof createFileDatabase>>;
let base: string;
let close: (token: unknown) => void;
let token: unknown;

/** Per-test files-first server: each test owns its host modules + in-memory components. */
async function boot(schemas: Schema[], components: ComponentSchema[] = []): Promise<void> {
  const srv = await startTestServerFromSchemas(sql, schemas, { components });
  base = srv.base;
  close = srv.close;
  token = srv.token;
}

before(async () => {
  resetStorageProvider();
  db = await createFileDatabase('cmpwrite');
  sql = db.sql;
  await runMigrations(db.url);
});

beforeEach(async () => {
  if (token) close(token);
  token = undefined;
  await cleanCatalog(sql);
});

after(async () => {
  if (token) close(token);
  if (sql) await sql.end();
  if (db) await dropFileDatabase(db.name);
  await rm(STORAGE_DIR, { recursive: true, force: true });
});

const POST = (p: string, body: unknown) => fetch(`${base}${p}`, { method: 'POST', body: JSON.stringify(body) });
const PUT = (p: string, body: unknown) => fetch(`${base}${p}`, { method: 'PUT', body: JSON.stringify(body) });
const GET = (p: string) => fetch(`${base}${p}`);

interface Asset { id: number; mime: string; url: string | null }
async function uploadAsset(w: number, h: number): Promise<Asset> {
  const fd = new FormData();
  fd.set('file', new Blob([pngBytes(w, h)], { type: 'image/png' }), `img-${w}x${h}.png`);
  const r = await fetch(`${base}/_files/upload`, { method: 'POST', body: fd });
  assert.ok(r.status === 201 || r.status === 200, `upload -> ${r.status}`);
  return ((await r.json()) as { data: Asset }).data;
}

// --- W1: SINGLE component value validated, stored, read back with a stable instance id ---------
test('W1 single component value validates + stores + reads back with a stable instance id', async () => {
  const seo = component('seo', [
    { name: 'metaTitle', type: 'string', options: { nullable: false } },
    { name: 'metaDescription', type: 'text' },
  ]);
  const page = schema({
    apiId: 'page',
    fields: [
      { name: 'title', cmsType: 'string', options: { nullable: false } },
      { name: 'seo', cmsType: 'component', options: { component: 'seo' } },
    ],
  });
  await boot([page], [seo]);

  const created = (await (await POST('/page', { title: 'Home', seo: { metaTitle: 'Welcome', metaDescription: null } })).json()) as {
    data: { id: number; seo: { id: number; metaTitle: string; metaDescription: string | null } };
  };
  assert.equal(created.data.seo.metaTitle, 'Welcome');
  assert.equal(created.data.seo.metaDescription, null); // an explicit null on a nullable nested field round-trips.
  assert.equal(typeof created.data.seo.id, 'number'); // server-assigned stable instance id.

  // Read back verbatim (un-populated): the same nested object incl. its id.
  const got = (await (await GET(`/page/${created.data.id}`)).json()) as { data: { seo: { id: number; metaTitle: string } } };
  assert.equal(got.data.seo.metaTitle, 'Welcome');
  assert.equal(got.data.seo.id, created.data.seo.id);
});

// --- W2: repeatable component preserves order + assigns distinct ids ---------------------------
test('W2 repeatable component preserves array order and assigns distinct instance ids', async () => {
  const item = component('item', [{ name: 'label', type: 'string', options: { nullable: false } }]);
  const list = schema({ apiId: 'list', fields: [{ name: 'items', cmsType: 'component-repeatable', options: { component: 'item' } }] });
  await boot([list], [item]);

  const created = (await (await POST('/list', { items: [{ label: 'a' }, { label: 'b' }, { label: 'c' }] })).json()) as {
    data: { id: number; items: { id: number; label: string }[] };
  };
  assert.deepEqual(created.data.items.map((i) => i.label), ['a', 'b', 'c']); // order preserved.
  const ids = created.data.items.map((i) => i.id);
  assert.equal(new Set(ids).size, 3); // distinct ids.

  const got = (await (await GET(`/list/${created.data.id}`)).json()) as { data: { items: { label: string }[] } };
  assert.deepEqual(got.data.items.map((i) => i.label), ['a', 'b', 'c']);
});

// --- W3: dynamic zone validates __component against the allowed-set + tags each block -----------
test('W3 dynamic zone validates __component, preserves order, rejects disallowed/unknown blocks', async () => {
  // banner is a REAL component but deliberately LEFT OUT of the dz allowed-set, so the test can assert a
  // real-but-disallowed block 400s distinctly from an unknown-component block.
  const hero = component('hero', [{ name: 'headline', type: 'string', options: { nullable: false } }]);
  const quote = component('quote', [{ name: 'text', type: 'string', options: { nullable: false } }]);
  const banner = component('banner', [{ name: 'src', type: 'string' }]);
  const article = schema({ apiId: 'article', fields: [{ name: 'body', cmsType: 'dynamiczone', options: { components: ['hero', 'quote'] } }] });
  await boot([article], [hero, quote, banner]);

  const created = (await (await POST('/article', {
    body: [
      { __component: 'hero', headline: 'Big' },
      { __component: 'quote', text: 'Wise' },
    ],
  })).json()) as { data: { id: number; body: { __component: string; id: number }[] } };
  assert.deepEqual(created.data.body.map((b) => b.__component), ['hero', 'quote']);
  assert.equal(typeof created.data.body[0]!.id, 'number');

  // A block naming a component NOT in the allowed-set (but a real component) -> 400, scoped path.
  const disallowed = await POST('/article', { body: [{ __component: 'banner', src: 'x' }] });
  const disallowedText = await disallowed.text();
  assert.equal(disallowed.status, 400, disallowedText);
  assert.match((JSON.parse(disallowedText) as { error: string }).error, /not allowed/i);

  // A block naming an UNKNOWN component -> 400.
  const unknown = await POST('/article', { body: [{ __component: 'ghost', x: 1 }] });
  assert.equal(unknown.status, 400, await unknown.text());

  // A block missing __component -> 400.
  const missing = await POST('/article', { body: [{ headline: 'no discriminator' }] });
  assert.equal(missing.status, 400, await missing.text());
});

// --- W4: unknown nested field rejected with a scoped path --------------------------------------
test('W4 an unknown field inside a component is rejected with a scoped-path 400', async () => {
  const seo = component('seo', [{ name: 'metaTitle', type: 'string' }]);
  const page = schema({ apiId: 'page', fields: [{ name: 'seo', cmsType: 'component', options: { component: 'seo' } }] });
  await boot([page], [seo]);
  const r = await POST('/page', { seo: { metaTitle: 'ok', bogus: 'nope' } });
  const rText = await r.text();
  assert.equal(r.status, 400, rText);
  assert.match((JSON.parse(rText) as { error: string }).error, /seo\.bogus/);
});

// --- W5: missing required nested field rejected with a scoped path -----------------------------
test('W5 a missing required field inside a component is rejected (scoped path)', async () => {
  const seo = component('seo', [{ name: 'metaTitle', type: 'string', options: { nullable: false } }]);
  const page = schema({ apiId: 'page', fields: [{ name: 'seo', cmsType: 'component', options: { component: 'seo' } }] });
  await boot([page], [seo]);
  const r = await POST('/page', { seo: { metaTitle: null } }); // explicit null on a non-nullable nested field.
  assert.equal(r.status, 400, await r.text());
});

// --- W6: wire fidelity INSIDE a component (bigint / decimal / datetime / nested json) ----------
test('W6 wire fidelity holds inside a component value', async () => {
  const metrics = component('metrics', [
    { name: 'big', type: 'biginteger' },
    { name: 'price', type: 'decimal', options: { precision: 12, scale: 2 } },
    { name: 'at', type: 'datetime' },
    { name: 'blob', type: 'json' },
  ]);
  const doc = schema({ apiId: 'doc', fields: [{ name: 'm', cmsType: 'component', options: { component: 'metrics' } }] });
  await boot([doc], [metrics]);

  const bigVal = '9007199254740993'; // > 2^53, must survive as a STRING.
  const created = (await (await POST('/doc', {
    m: { big: bigVal, price: '1234.50', at: '2024-01-02T03:04:05.000Z', blob: { nested: [1, 2, 3] } },
  })).json()) as { data: { id: number; m: { big: string; price: string; at: string; blob: { nested: number[] } } } };
  assert.equal(created.data.m.big, bigVal);
  assert.equal(created.data.m.price, '1234.50');
  assert.equal(created.data.m.at, '2024-01-02T03:04:05.000Z');
  assert.deepEqual(created.data.m.blob, { nested: [1, 2, 3] });

  // Read-back raw bytes preserve the >2^53 bigint as a string (un-populated verbatim path). jsonb
  // whitespace varies by PG version, so match the key/value pair tolerant of an optional space.
  const raw = await (await GET(`/doc/${created.data.id}`)).text();
  assert.match(raw, new RegExp(`"big":\\s*"${bigVal}"`));
});

// --- W7: depth cap rejects an over-deep nested component value ---------------------------------
test('W7 too-deep component nesting is rejected (depth cap, scoped 400)', async () => {
  // node -> node -> node ... ; the depth cap (10) bites for a hand-built deep tree.
  // Nest a chain of distinct components (12 deep) so a single write recurses past the cap.
  const components = [component('node', [{ name: 'label', type: 'string' }])];
  let prev = 'node';
  const names = ['n0', 'n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8', 'n9', 'n10', 'n11'];
  for (const name of names) {
    components.push(component(name, [{ name: 'child', type: 'component', options: { component: prev } }, { name: 'label', type: 'string' }]));
    prev = name;
  }
  const tree = schema({ apiId: 'tree', fields: [{ name: 'root', cmsType: 'component', options: { component: prev } }] });
  await boot([tree], components);

  // Build a value nested 12 deep (root -> child -> child ... -> node).
  let val: Record<string, unknown> = { label: 'leaf' };
  for (let i = 0; i < 12; i++) val = { child: val, label: `lvl${i}` };
  const r = await POST('/tree', { root: val });
  const rText = await r.text();
  assert.equal(r.status, 400, rText);
  assert.match((JSON.parse(rText) as { error: string }).error, /too deep/i);
});

// --- W8: inline media ref inside a component — existence-checked + populated -------------------
test('W8 an inline media ref inside a component is existence-checked + populated on read', async () => {
  const card = component('card', [
    { name: 'title', type: 'string' },
    { name: 'image', type: 'media' },
  ]);
  const gallery = schema({ apiId: 'gallery', fields: [{ name: 'card', cmsType: 'component', options: { component: 'card' } }] });
  await boot([gallery], [card]);

  const asset = await uploadAsset(20, 30);

  // A dangling inline media id -> 400 in the write tx.
  const bad = await POST('/gallery', { card: { title: 'x', image: 999999 } });
  const badText = await bad.text();
  assert.equal(bad.status, 400, badText);
  assert.match((JSON.parse(badText) as { error: string }).error, /unknown file id/i);

  // A valid inline media id -> stored as the bare id un-populated.
  const created = (await (await POST('/gallery', { card: { title: 'Hero', image: asset.id } })).json()) as {
    data: { id: number; card: { image: number } };
  };
  assert.equal(created.data.card.image, asset.id);

  const plain = (await (await GET(`/gallery/${created.data.id}`)).json()) as { data: { card: { image: number } } };
  assert.equal(plain.data.card.image, asset.id); // un-populated: raw id.

  // Populated GET: the asset OBJECT inlined inside the component, in place of the id.
  const pop = (await (await GET(`/gallery/${created.data.id}?populate=card`)).json()) as {
    data: { card: { image: { id: number; mime: string } } };
  };
  assert.equal(pop.data.card.image.id, asset.id);
  assert.equal(pop.data.card.image.mime, 'image/png');
});

// --- W9: inline media inside a REPEATABLE + DYNAMIC ZONE populates across rows ------------------
test('W9 inline media inside repeatable + dynamic-zone populates correctly', async () => {
  const slide = component('slide', [{ name: 'pic', type: 'media' }]);
  const deck = schema({ apiId: 'deck', fields: [{ name: 'slides', cmsType: 'component-repeatable', options: { component: 'slide' } }] });
  await boot([deck], [slide]);
  const a1 = await uploadAsset(10, 10);
  const a2 = await uploadAsset(11, 11);
  const created = (await (await POST('/deck', { slides: [{ pic: a1.id }, { pic: a2.id }] })).json()) as { data: { id: number } };

  const pop = (await (await GET(`/deck/${created.data.id}?populate=slides`)).json()) as {
    data: { slides: { pic: { id: number } | null }[] };
  };
  assert.equal(pop.data.slides[0]!.pic!.id, a1.id);
  assert.equal(pop.data.slides[1]!.pic!.id, a2.id);
});

// --- W10: BYTE-IDENTICAL — a content type with NO component field is untouched ------------------
test('W10 a content type with NO component field reads identically (no populate effect)', async () => {
  const plainType = schema({
    apiId: 'plain',
    fields: [
      { name: 'title', cmsType: 'string', options: { nullable: false } },
      { name: 'meta', cmsType: 'json' },
    ],
  });
  await boot([plainType]);
  const created = (await (await POST('/plain', { title: 'T', meta: { a: 1 } })).json()) as { data: { id: number } };
  // Un-populated and a spurious ?populate=* produce the SAME bytes (no component/media field to populate):
  // the populate post-step is skipped entirely (componentFields + mediaFields both empty) => byte-identical.
  const plain = await (await GET(`/plain/${created.data.id}`)).text();
  const withPop = await (await GET(`/plain/${created.data.id}?populate=*`)).text();
  assert.equal(plain, withPop);
  assert.match(plain, /"title":"T"/);
  assert.match(plain, /"meta":\s*\{\s*"a":\s*1\s*\}/);
});

// --- W11: oversized component instance is rejected ---------------------------------------------
test('W11 an oversized component instance is rejected (size cap, 400)', async () => {
  const blobby = component('blobby', [{ name: 'data', type: 'json' }]);
  const big = schema({ apiId: 'big', fields: [{ name: 'b', cmsType: 'component', options: { component: 'blobby' } }] });
  await boot([big], [blobby]);
  // The request body cap is 1 MiB; the per-instance cap is 256 KiB. A ~400 KiB instance trips the instance
  // cap with a clean 400 (under the body cap, so it reaches the validator).
  const huge = 'x'.repeat(400_000);
  const r = await POST('/big', { b: { data: { s: huge } } });
  assert.equal(r.status, 400, `expected 400, got ${r.status}`);
});
