import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Sql } from 'postgres';
import { runMigrations } from '../src/db/migration.runner.ts';
import { createFileDatabase, dropFileDatabase } from './db-per-file.ts';
import { cleanCatalog, physicalColumns } from './helpers.ts';
import { PostgresStore } from '../src/db/postgres.store.ts';
import { createServer } from '../src/http/uws.adapter.ts';
import { freePort } from './helpers.ts';
import type { Engine } from '../src/store/engine.ts';
import type { Registry } from '../src/db/registry.ts';

/**
 * be-05 COMPONENT BUILDER — end-to-end over a REAL uWS server + REAL Postgres (no mocks). Proves:
 *  - `POST /component-types` defines a reusable component (meta-only, NO physical table);
 *  - a content type attaches a single / repeatable / dynamiczone component field — each a jsonb COLUMN;
 *  - projectDef emits the component metadata (component / components) conditionally;
 *  - a definition-time reference CYCLE is rejected (400);
 *  - a dangling component ref is rejected (400); the drop guard refuses an in-use component (409);
 *  - a content type WITHOUT component fields is BYTE-IDENTICAL (no projection / column / shape drift).
 *
 * The server is rebuilt PER TEST (the registry's component store must reflect a just-created component
 * before a content type can reference it — mirrors startTestServer but kept local so each test gets a
 * fresh registry over the just-cleaned catalog).
 */

let sql: Sql;
let db: Awaited<ReturnType<typeof createFileDatabase>>;
let base: string;
let close: (token: unknown) => void;
let token: unknown;
let engine: Engine;
let registry: Registry;

async function boot(): Promise<void> {
  const store = new PostgresStore(sql);
  const built = await store.loadWithRegistry();
  engine = built.engine;
  registry = built.registry;
  const server = createServer(engine, store, registry);
  const port = await freePort();
  token = await server.listen(port);
  base = `http://127.0.0.1:${port}`;
  close = server.close;
}

before(async () => {
  db = await createFileDatabase('cmpbuild');
  sql = db.sql;
  await runMigrations(db.url);
});

beforeEach(async () => {
  if (token) close(token);
  await cleanCatalog(sql);
  await boot();
});

after(async () => {
  if (token) close(token);
  if (sql) await sql.end();
  if (db) await dropFileDatabase(db.name);
});

const POST = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', body: JSON.stringify(body) });
const GET = (path: string) => fetch(`${base}${path}`);
const DEL = (path: string) => fetch(`${base}${path}`, { method: 'DELETE' });

interface FieldDef { name: string; cmsType: string; nullable: boolean; component?: string; components?: string[]; multiple?: boolean }
interface CmpDef { apiId: string; fields: FieldDef[] }
interface CtField extends FieldDef { system: boolean }
interface CtDef { apiId: string; fields: CtField[]; relations: unknown[] }

// --- P1: define a component over HTTP (meta-only, no physical table) ---------------------------
test('P1 POST /component-types defines a reusable component with no physical table', async () => {
  const r = await POST('/component-types', {
    apiId: 'seo',
    fields: [
      { name: 'metaTitle', cmsType: 'string', options: { nullable: false } },
      { name: 'metaDescription', cmsType: 'text' },
      { name: 'keywords', cmsType: 'json' },
    ],
  });
  const def = (await r.json()) as CmpDef;
  assert.equal(r.status, 201);
  assert.equal(def.apiId, 'seo');
  assert.deepEqual(def.fields.map((f) => f.name), ['metaTitle', 'metaDescription', 'keywords']);
  // A component has NO ct_ table and NO component_*-derived physical table.
  const cols = await physicalColumns(sql, 'ct_seo');
  assert.deepEqual(cols, []);
  // It is in the meta + the registry component store (GET round-trips).
  const got = (await (await GET('/component-types/seo')).json()) as CmpDef;
  assert.deepEqual(got.fields.map((f) => f.cmsType), ['string', 'text', 'json']);
  // GET list includes it.
  const list = (await (await GET('/component-types')).json()) as CmpDef[];
  assert.equal(list.length, 1);
});

// --- P2: attach single / repeatable / dynamiczone fields to a content type ---------------------
test('P2 attach single + repeatable + dynamiczone component fields -> jsonb columns + projected metadata', async () => {
  await POST('/component-types', { apiId: 'seo', fields: [{ name: 'metaTitle', cmsType: 'string' }] });
  await POST('/component-types', { apiId: 'hero', fields: [{ name: 'headline', cmsType: 'string' }] });

  const r = await POST('/content-types', {
    apiId: 'page',
    fields: [
      { name: 'title', cmsType: 'string', options: { nullable: false } },
      { name: 'seo', cmsType: 'component', options: { component: 'seo' } },
      { name: 'sections', cmsType: 'component-repeatable', options: { component: 'hero' } },
      { name: 'blocks', cmsType: 'dynamiczone', options: { components: ['seo', 'hero'] } },
    ],
  });
  const def = (await r.json()) as CtDef;
  assert.equal(r.status, 201);

  // Each component field projects its structural metadata conditionally.
  const byName = new Map(def.fields.map((f) => [f.name, f]));
  assert.equal(byName.get('seo')!.cmsType, 'component');
  assert.equal(byName.get('seo')!.component, 'seo');
  assert.equal(byName.get('seo')!.components, undefined);
  assert.equal(byName.get('sections')!.cmsType, 'component-repeatable');
  assert.equal(byName.get('sections')!.component, 'hero');
  assert.deepEqual(byName.get('blocks')!.components, ['seo', 'hero']);
  assert.equal(byName.get('blocks')!.component, undefined);
  // A plain scalar field carries NEITHER key (byte-identical projection).
  assert.equal(byName.get('title')!.component, undefined);
  assert.equal(byName.get('title')!.components, undefined);

  // Each component field is a real jsonb COLUMN on ct_page (no link/relational table).
  const cols = await physicalColumns(sql, 'ct_page');
  const colByName = new Map(cols.map((c) => [c.name, c]));
  assert.equal(colByName.get('seo')!.type, 'jsonb');
  assert.equal(colByName.get('sections')!.type, 'jsonb');
  assert.equal(colByName.get('blocks')!.type, 'jsonb');
});

// --- P3: attach a single component via addField (the .../fields route) -------------------------
test('P3 addField attaches a component field to an existing content type', async () => {
  await POST('/component-types', { apiId: 'seo', fields: [{ name: 'metaTitle', cmsType: 'string' }] });
  await POST('/content-types', { apiId: 'post', fields: [{ name: 'title', cmsType: 'string' }] });
  const r = await POST('/content-types/post/fields', { name: 'seo', cmsType: 'component', options: { component: 'seo' } });
  const def = (await r.json()) as CtDef;
  assert.equal(r.status, 201);
  assert.equal(def.fields.find((f) => f.name === 'seo')!.component, 'seo');
  const cols = await physicalColumns(sql, 'ct_post');
  assert.equal(cols.find((c) => c.name === 'seo')!.type, 'jsonb');
});

// --- P4: nested component (component referencing another component) ----------------------------
test('P4 a component may nest another component', async () => {
  await POST('/component-types', { apiId: 'link', fields: [{ name: 'href', cmsType: 'string' }] });
  const r = await POST('/component-types', {
    apiId: 'nav',
    fields: [
      { name: 'label', cmsType: 'string' },
      { name: 'primary', cmsType: 'component', options: { component: 'link' } },
      { name: 'extras', cmsType: 'component-repeatable', options: { component: 'link' } },
    ],
  });
  const def = (await r.json()) as CmpDef;
  assert.equal(r.status, 201);
  assert.equal(def.fields.find((f) => f.name === 'primary')!.component, 'link');
});

// --- P5: definition-time reference CYCLE is rejected -------------------------------------------
test('P5 a definition-time reference cycle is rejected (direct self + transitive)', async () => {
  // Direct self-reference: a brand-new component cannot reference itself (it does not exist yet, so this
  // is actually a dangling ref -> 400). The meaningful cycle is via addField after both exist.
  await POST('/component-types', { apiId: 'a', fields: [{ name: 'x', cmsType: 'string' }] });
  await POST('/component-types', { apiId: 'b', fields: [{ name: 'toA', cmsType: 'component', options: { component: 'a' } }] });
  // Now A -> B would close the cycle A->B->A. Forbidden at definition time.
  const r = await POST('/component-types/a/fields', { name: 'toB', cmsType: 'component', options: { component: 'b' } });
  const rText = await r.text();
  assert.equal(r.status, 400, rText);
  assert.match((JSON.parse(rText) as { error: string }).error, /cycle/i);

  // A direct self-reference via dynamiczone is also a cycle.
  await POST('/component-types', { apiId: 'c', fields: [{ name: 'x', cmsType: 'string' }] });
  const self = await POST('/component-types/c/fields', { name: 'zone', cmsType: 'dynamiczone', options: { components: ['c'] } });
  assert.equal(self.status, 400, await self.text());
});

// --- P6: dangling component ref is rejected ----------------------------------------------------
test('P6 a dangling component ref is rejected (400) on both create and addField', async () => {
  // Content-type create referencing a missing component.
  const r = await POST('/content-types', {
    apiId: 'page',
    fields: [{ name: 'seo', cmsType: 'component', options: { component: 'doesNotExist' } }],
  });
  const rText = await r.text();
  assert.equal(r.status, 400, rText);
  assert.match((JSON.parse(rText) as { error: string }).error, /not found|doesNotExist/i);
  // The failed create rolled back: no ct_page table.
  assert.deepEqual(await physicalColumns(sql, 'ct_page'), []);

  // A dynamiczone with one missing member is also rejected.
  await POST('/component-types', { apiId: 'seo', fields: [{ name: 'metaTitle', cmsType: 'string' }] });
  const dz = await POST('/content-types', {
    apiId: 'page2',
    fields: [{ name: 'blocks', cmsType: 'dynamiczone', options: { components: ['seo', 'ghost'] } }],
  });
  assert.equal(dz.status, 400, await dz.text());
});

// --- P7: malformed component field spec is rejected --------------------------------------------
test('P7 a malformed component field spec is rejected (400)', async () => {
  await POST('/component-types', { apiId: 'seo', fields: [{ name: 'metaTitle', cmsType: 'string' }] });
  // component without a `component` ref.
  const a = await POST('/content-types', { apiId: 'p1', fields: [{ name: 'seo', cmsType: 'component', options: {} }] });
  assert.equal(a.status, 400, await a.text());
  // dynamiczone with an empty allowed-set.
  const b = await POST('/content-types', { apiId: 'p2', fields: [{ name: 'z', cmsType: 'dynamiczone', options: { components: [] } }] });
  assert.equal(b.status, 400, await b.text());
});

// --- P8: drop guard — a referenced component cannot be dropped ---------------------------------
test('P8 dropping a component that is in use is refused (409); unused drops cleanly', async () => {
  await POST('/component-types', { apiId: 'seo', fields: [{ name: 'metaTitle', cmsType: 'string' }] });
  await POST('/content-types', { apiId: 'page', fields: [{ name: 'seo', cmsType: 'component', options: { component: 'seo' } }] });

  const refused = await DEL('/component-types/seo');
  assert.equal(refused.status, 409, await refused.text());

  // An unused component drops cleanly (404 thereafter).
  await POST('/component-types', { apiId: 'orphan', fields: [{ name: 'x', cmsType: 'string' }] });
  const dropped = await DEL('/component-types/orphan');
  assert.equal(dropped.status, 200, await dropped.text());
  assert.equal((await GET('/component-types/orphan')).status, 404);
});

// --- P9: a component nesting another blocks the nested one from being dropped ------------------
test('P9 a component referenced by ANOTHER component blocks its drop (409)', async () => {
  await POST('/component-types', { apiId: 'link', fields: [{ name: 'href', cmsType: 'string' }] });
  await POST('/component-types', { apiId: 'nav', fields: [{ name: 'primary', cmsType: 'component', options: { component: 'link' } }] });
  const r = await DEL('/component-types/link');
  assert.equal(r.status, 409, await r.text());
});

// --- P10: BYTE-IDENTICAL — a content type WITHOUT component fields is unchanged -----------------
test('P10 a content type with NO component field projects byte-identically (no shape drift)', async () => {
  const r = await POST('/content-types', {
    apiId: 'plain',
    fields: [
      { name: 'title', cmsType: 'string', options: { nullable: false } },
      { name: 'count', cmsType: 'integer' },
    ],
  });
  assert.equal(r.status, 201);
  const def = (await r.json()) as CtDef;
  // No field carries component/components keys; the projection shape is exactly the pre-be-05 shape.
  for (const f of def.fields) {
    assert.equal('component' in f, false, `field ${f.name} must not carry a component key`);
    assert.equal('components' in f, false, `field ${f.name} must not carry a components key`);
  }
  // System + user fields in order, relations: [] — unchanged contract.
  assert.deepEqual(def.fields.map((f) => f.name), ['id', 'created_at', 'updated_at', 'title', 'count']);
  assert.deepEqual(def.relations, []);
});

// --- P11: duplicate component api_id + duplicate field rejected --------------------------------
test('P11 duplicate component api_id (409) + duplicate field name (409)', async () => {
  await POST('/component-types', { apiId: 'seo', fields: [{ name: 'metaTitle', cmsType: 'string' }] });
  const dup = await POST('/component-types', { apiId: 'seo', fields: [{ name: 'x', cmsType: 'string' }] });
  assert.equal(dup.status, 409, await dup.text());
  const dupField = await POST('/component-types/seo/fields', { name: 'metaTitle', cmsType: 'text' });
  assert.equal(dupField.status, 409, await dupField.text());
});

// --- P12: invalid component api_id rejected (injection / reserved) -----------------------------
test('P12 an invalid/reserved component api_id is rejected (400)', async () => {
  for (const apiId of ['"; DROP TABLE component_types;--', 'ct_evil', '_hidden', 'content_types']) {
    const r = await POST('/component-types', { apiId, fields: [{ name: 'x', cmsType: 'string' }] });
    assert.equal(r.status, 400, `apiId ${JSON.stringify(apiId)} should be 400`);
  }
});
