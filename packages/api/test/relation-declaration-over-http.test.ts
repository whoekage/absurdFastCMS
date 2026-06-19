import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Sql } from 'postgres';
import { runMigrations } from '../src/db/migration.runner.ts';
import { createFileDatabase, dropFileDatabase } from './db-per-file.ts';
import { startTestServer, tableExists } from './helpers.ts';

/**
 * Relation DECLARATION over HTTP, end-to-end over a REAL uWS server + REAL Postgres (no mocks). Proves:
 *  - `POST /content-types/:apiId/relations` declares each of the four kinds (link table + meta rows);
 *  - the 201 body carries `relations` (physical-detail-free), and a scalar-only type returns `[]`;
 *  - a two-way declaration surfaces the inverse on BOTH the owner and the target definition;
 *  - the relation goes LIVE with NO restart: connect ids via the data write API, then `?populate` nests
 *    the related rows AND a deep relation filter (`?filters[rel][col][$eq]`) selects owners — both via
 *    the reused per-type `syncSchema` (rebuildType -> loadAllRelations);
 *  - create-time relations (declared in the POST /content-types body) also go live;
 *  - the typed-error -> HTTP table (404 unknown target, 409 name clash, 400 unknown kind).
 */

let sql: Sql;
let db: Awaited<ReturnType<typeof createFileDatabase>>;
let base: string;
let close: (token: unknown) => void;
let token: unknown;

before(async () => {
  db = await createFileDatabase('reldecl');
  sql = db.sql;
  await runMigrations(db.url);
  const srv = await startTestServer(sql);
  base = srv.base;
  close = srv.close;
  token = srv.token;
});

after(async () => {
  if (token) close(token);
  if (sql) await sql.end();
  if (db) await dropFileDatabase(db.name);
});

const POST = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', body: JSON.stringify(body) });
const GET = (path: string) => fetch(`${base}${path}`);

interface RelEntry { field: string; kind: string; target: string; owner: boolean; inverseField?: string }
interface Def { apiId: string; fields: { name: string }[]; relations: RelEntry[] }

async function createType(apiId: string, fields: { name: string; cmsType: string; options?: unknown }[]): Promise<Def> {
  const r = await POST('/content-types', { apiId, fields });
  assert.equal(r.status, 201, `create ${apiId}`);
  return (await r.json()) as Def;
}

test('scalar-only type projects relations: [] (no shape drift)', async () => {
  const def = await createType('tag', [{ name: 'name', cmsType: 'string', options: { nullable: false } }]);
  assert.deepEqual(def.relations, []);
  const got = (await (await GET('/content-types/tag')).json()) as Def;
  assert.deepEqual(got.relations, []);
});

test('declare a TWO-WAY manyToOne over HTTP: link table + meta rows + projection on owner AND target', async () => {
  await createType('user', [{ name: 'name', cmsType: 'string', options: { nullable: false } }]);
  await createType('article', [{ name: 'title', cmsType: 'string', options: { nullable: false } }]);

  const r = await POST('/content-types/article/relations', {
    field: 'author', kind: 'manyToOne', target: 'user', inverseField: 'articles',
  });
  assert.equal(r.status, 201);
  const def = (await r.json()) as Def;

  // Owner projection carries the new relation (no linkTable / content_type_id leak).
  assert.deepEqual(def.relations, [{ field: 'author', kind: 'manyToOne', target: 'user', owner: true, inverseField: 'articles' }]);

  // The derived link table physically exists.
  assert.ok(await tableExists(sql, 'article_author_lnk'));

  // Both meta rows exist (owner manyToOne, inverse oneToMany) sharing the same link table.
  const rows = await sql<{ field_name: string; kind: string; is_owner: boolean; link_table: string }[]>`
    SELECT field_name, kind, is_owner, link_table FROM content_type_relations ORDER BY is_owner DESC`;
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((x) => `${x.field_name}:${x.kind}:${x.is_owner}`), ['author:manyToOne:true', 'articles:oneToMany:false']);
  assert.equal(rows[0]!.link_table, rows[1]!.link_table);

  // The INVERSE shows up on the TARGET's projected definition too (target def was rebuilt).
  const userDef = (await (await GET('/content-types/user')).json()) as Def;
  assert.deepEqual(userDef.relations, [{ field: 'articles', kind: 'oneToMany', target: 'article', owner: false, inverseField: 'author' }]);
});

test('the declared relation is LIVE: connect, then populate + deep filter both work with no restart', async () => {
  // Create two users + two articles, then connect authors via the data write API.
  const u1 = (await (await POST('/user', { name: 'Ada' })).json()).data.id as number;
  const u2 = (await (await POST('/user', { name: 'Linus' })).json()).data.id as number;
  await POST('/article', { title: 'On Engines', author: u1 });
  await POST('/article', { title: 'On Kernels', author: u2 });

  // populate=author nests the related row (to-one => single object).
  const pop = await (await GET('/article?populate=author&sort=id:asc')).json();
  assert.equal(pop.data[0].author.name, 'Ada');
  assert.equal(pop.data[1].author.name, 'Linus');

  // Deep relation FILTER: articles whose author.name == 'Ada'.
  const filtered = await (await GET('/article?filters[author][name][$eq]=Ada')).json();
  assert.equal(filtered.data.length, 1);
  assert.equal(filtered.data[0].title, 'On Engines');

  // The inverse relation is live too: populate=articles on a user (to-many => array).
  const invPop = await (await GET(`/user/${u1}?populate=articles`)).json();
  assert.deepEqual(invPop.data.articles.map((a: { title: string }) => a.title), ['On Engines']);
});

test('declare a ONE-WAY manyToMany (no inverseField): UNIQUE(owner,related) link, no inverse meta row', async () => {
  const r = await POST('/content-types/article/relations', { field: 'tags', kind: 'manyToMany', target: 'tag' });
  assert.equal(r.status, 201);
  const def = (await r.json()) as Def;
  assert.ok(def.relations.some((x) => x.field === 'tags' && x.kind === 'manyToMany' && x.target === 'tag' && x.owner === true && x.inverseField === undefined));
  assert.ok(await tableExists(sql, 'article_tags_lnk'));
  // One-way: NO inverse row on the target.
  const tagRows = await sql`SELECT 1 FROM content_type_relations r JOIN content_types c ON c.id = r.content_type_id WHERE c.api_id = 'tag'`;
  assert.equal(tagRows.length, 0);

  // Live: connect tags to an article, populate to-many.
  const t1 = (await (await POST('/tag', { name: 'cs' })).json()).data.id as number;
  const t2 = (await (await POST('/tag', { name: 'os' })).json()).data.id as number;
  const a = (await (await GET('/article?filters[title][$eq]=On Kernels')).json()).data[0].id as number;
  await fetch(`${base}/article/${a}`, { method: 'PUT', body: JSON.stringify({ tags: { set: [t1, t2] } }) });
  const pop = await (await GET(`/article/${a}?populate=tags`)).json();
  assert.deepEqual((pop.data.tags as { name: string }[]).map((x) => x.name).sort(), ['cs', 'os']);
});

test('declare oneToOne and oneToMany kinds (physical UNIQUE per kind)', async () => {
  await createType('profile', [{ name: 'bio', cmsType: 'string', options: { nullable: true } }]);
  await createType('comment', [{ name: 'body', cmsType: 'string', options: { nullable: false } }]);

  // oneToOne user.profile (both sides UNIQUE).
  assert.equal((await POST('/content-types/user/relations', { field: 'profile', kind: 'oneToOne', target: 'profile' })).status, 201);
  // oneToMany article.comments (UNIQUE(related_id)).
  assert.equal((await POST('/content-types/article/relations', { field: 'comments', kind: 'oneToMany', target: 'comment' })).status, 201);

  const cols = await sql<{ link_table: string }[]>`SELECT DISTINCT link_table FROM content_type_relations`;
  assert.ok(cols.some((c) => c.link_table === 'user_profile_lnk'));
  assert.ok(await tableExists(sql, 'article_comments_lnk'));

  // oneToOne UNIQUE on both owner_id and related_id.
  const uq = await sql<{ indexdef: string }[]>`SELECT indexdef FROM pg_indexes WHERE tablename = 'user_profile_lnk'`;
  const defs = uq.map((x) => x.indexdef).join('\n');
  assert.ok(/UNIQUE.*owner_id/.test(defs) && /UNIQUE.*related_id/.test(defs));
});

test('create-time relations: declare a relation in the POST /content-types body and use it live', async () => {
  await createType('category', [{ name: 'name', cmsType: 'string', options: { nullable: false } }]);
  const r = await POST('/content-types', {
    apiId: 'post',
    fields: [{ name: 'title', cmsType: 'string', options: { nullable: false } }],
    relations: [{ field: 'category', kind: 'manyToOne', target: 'category', inverseField: 'posts' }],
  });
  assert.equal(r.status, 201);
  const def = (await r.json()) as Def;
  assert.ok(def.relations.some((x) => x.field === 'category' && x.kind === 'manyToOne' && x.owner === true));
  assert.ok(await tableExists(sql, 'post_category_lnk'));

  const c = (await (await POST('/category', { name: 'tech' })).json()).data.id as number;
  await POST('/post', { title: 'Hello', category: c });
  const pop = await (await GET('/post?populate=category')).json();
  assert.equal(pop.data[0].category.name, 'tech');
  // Inverse projected on the target too.
  const catDef = (await (await GET('/content-types/category')).json()) as Def;
  assert.ok(catDef.relations.some((x) => x.field === 'posts' && x.owner === false));
});

test('error mapping: 404 unknown target, 409 field clash, 400 unknown kind', async () => {
  // 404 target type does not exist.
  assert.equal((await POST('/content-types/article/relations', { field: 'x', kind: 'manyToOne', target: 'ghost' })).status, 404);
  // 409 the field name clashes with an existing scalar field.
  assert.equal((await POST('/content-types/article/relations', { field: 'title', kind: 'manyToOne', target: 'user' })).status, 409);
  // 409 the field name clashes with an existing relation field.
  assert.equal((await POST('/content-types/article/relations', { field: 'author', kind: 'manyToOne', target: 'user' })).status, 409);
  // 400 unknown relation kind.
  assert.equal((await POST('/content-types/article/relations', { field: 'y', kind: 'manyToFew', target: 'user' })).status, 400);
  // 404 owner type unknown.
  assert.equal((await POST('/content-types/ghost/relations', { field: 'z', kind: 'manyToOne', target: 'user' })).status, 404);
});
