import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Sql } from 'postgres';
import { createContentType, addRelation } from '../src/db/content-type.repository.ts';
import type { ListenToken } from '../src/http/uws.adapter.ts';
import { createFileDatabase, dropFileDatabase } from './db-per-file.ts';
import { cleanCatalog, startTestServer } from './helpers.ts';

/**
 * RELATIONS SLICE 6 — WRITE-SIDE connect/disconnect/set, end-to-end over a REAL uWS server + REAL
 * Postgres (no mocks). Each mutation is asserted BOTH ways: (a) a populated GET (slice 5) in BOTH
 * directions, AND (b) a direct SELECT of the link table. The scalar write + the link mutations commit
 * in ONE tx (slice 6); a FK violation rolls everything back. Pure-scalar writes stay byte-identical.
 */

let sql: Sql;
let db: Awaited<ReturnType<typeof createFileDatabase>>;
let base: string;
let token: ListenToken;
let close: (t: ListenToken) => void;

before(async () => {
  db = await createFileDatabase('relwrite');
  sql = db.sql;
});

after(async () => {
  if (token) close(token);
  if (sql) await sql.end();
  if (db) await dropFileDatabase(db.name);
});

// --- harness ------------------------------------------------------------------------------------

// The server is booted PER TEST after the schema is built (loads the engine+registry at boot), so each
// test rebuilds a fresh server over its freshly-built catalog.
let servers: { close: (t: ListenToken) => void; token: ListenToken }[] = [];

beforeEach(async () => {
  for (const s of servers) s.close(s.token);
  servers = [];
  await cleanCatalog(sql);
});

async function boot(): Promise<void> {
  const s = await startTestServer(sql);
  base = s.base;
  token = s.token;
  close = s.close;
  servers.push({ close: s.close, token: s.token });
}

async function insertRow(table: string, col: string, value: string): Promise<number> {
  const [r] = await sql.unsafe<{ id: number }[]>(`INSERT INTO "${table}" (${col}) VALUES ($1) RETURNING id`, [value]);
  return r!.id;
}

async function links(linkTable: string): Promise<{ owner_id: number; related_id: number }[]> {
  const rows = await sql.unsafe<{ owner_id: number; related_id: number }[]>(`SELECT owner_id, related_id FROM "${linkTable}" ORDER BY owner_id, related_id`);
  // Map to PLAIN objects: postgres.js returns a `Result` (Array subclass) which fails deepStrictEqual vs `[]`.
  return rows.map((r) => ({ owner_id: r.owner_id, related_id: r.related_id }));
}

async function post(type: string, body: unknown): Promise<Response> {
  return fetch(`${base}/${type}`, { method: 'POST', body: JSON.stringify(body) });
}
async function put(type: string, id: number, body: unknown): Promise<Response> {
  return fetch(`${base}/${type}/${id}`, { method: 'PUT', body: JSON.stringify(body) });
}
async function del(type: string, id: number): Promise<Response> {
  return fetch(`${base}/${type}/${id}`, { method: 'DELETE' });
}
async function getJson(type: string, query: string): Promise<{ status: number; json: { data: Record<string, unknown>[] } }> {
  const res = await fetch(`${base}/${type}?${query}`);
  return { status: res.status, json: (await res.json()) as { data: Record<string, unknown>[] } };
}

// --- set / connect / disconnect each kind -------------------------------------------------------

test('manyToMany: set (bare + {set}), connect, disconnect; link rows + populated GET both directions', async () => {
  await createContentType(sql, { apiId: 'tag', fields: [{ name: 'label', cmsType: 'string' }] });
  await createContentType(sql, { apiId: 'book', fields: [{ name: 'title', cmsType: 'string' }] });
  const rel = await addRelation(sql, 'book', { field: 'tags', kind: 'manyToMany', target: 'tag', inverseField: 'books' });
  const t1 = await insertRow('ct_tag', 'label', 'a');
  const t2 = await insertRow('ct_tag', 'label', 'b');
  const t3 = await insertRow('ct_tag', 'label', 'c');
  const b1 = await insertRow('ct_book', 'title', 'B');
  await boot();

  // bare-array set
  assert.equal((await put('book', b1, { tags: [t1, t2] })).status, 200);
  assert.deepEqual(await links(rel.link_table), [{ owner_id: b1, related_id: t1 }, { owner_id: b1, related_id: t2 }]);

  // {set} replaces
  assert.equal((await put('book', b1, { tags: { set: [t2, t3] } })).status, 200);
  assert.deepEqual(await links(rel.link_table), [{ owner_id: b1, related_id: t2 }, { owner_id: b1, related_id: t3 }]);

  // connect adds
  assert.equal((await put('book', b1, { tags: { connect: [t1] } })).status, 200);
  assert.deepEqual(await links(rel.link_table), [{ owner_id: b1, related_id: t1 }, { owner_id: b1, related_id: t2 }, { owner_id: b1, related_id: t3 }]);

  // disconnect removes specific
  assert.equal((await put('book', b1, { tags: { disconnect: [t2] } })).status, 200);
  assert.deepEqual(await links(rel.link_table), [{ owner_id: b1, related_id: t1 }, { owner_id: b1, related_id: t3 }]);

  // populated GET, both directions
  const fwd = await getJson('book', 'populate=tags');
  const tagIds = (fwd.json.data[0]!.tags as { id: number }[]).map((t) => t.id).sort((a, b) => a - b);
  assert.deepEqual(tagIds, [t1, t3]);
  const back = await getJson('tag', `filters[id][$eq]=${t1}&populate=books`);
  assert.deepEqual((back.json.data[0]!.books as { id: number }[]).map((b) => b.id), [b1]);
});

test('manyToOne: bare set, connect, disconnect; reassign on second connect (owner moves)', async () => {
  await createContentType(sql, { apiId: 'author', fields: [{ name: 'name', cmsType: 'string' }] });
  await createContentType(sql, { apiId: 'book', fields: [{ name: 'title', cmsType: 'string' }] });
  const rel = await addRelation(sql, 'book', { field: 'author', kind: 'manyToOne', target: 'author', inverseField: 'books' });
  const a1 = await insertRow('ct_author', 'name', 'A1');
  const a2 = await insertRow('ct_author', 'name', 'A2');
  const b1 = await insertRow('ct_book', 'title', 'B1');
  await boot();

  // book.author is to-one (manyToOne); owner_id = book id, related_id = author id.
  assert.equal((await put('book', b1, { author: a1 })).status, 200);
  assert.deepEqual(await links(rel.link_table), [{ owner_id: b1, related_id: a1 }]);
  // connect to a2 replaces the owner's single edge (reassign, not a 23505).
  assert.equal((await put('book', b1, { author: { connect: [a2] } })).status, 200);
  assert.deepEqual(await links(rel.link_table), [{ owner_id: b1, related_id: a2 }]);
  // disconnect clears
  assert.equal((await put('book', b1, { author: { disconnect: [a2] } })).status, 200);
  assert.deepEqual(await links(rel.link_table), []);

  const single = await getJson('book', `filters[id][$eq]=${b1}&populate=author`);
  assert.equal(single.json.data[0]!.author, null);
});

test('oneToMany: connect a book to an author, then connect that book to another author REASSIGNS it', async () => {
  await createContentType(sql, { apiId: 'author', fields: [{ name: 'name', cmsType: 'string' }] });
  await createContentType(sql, { apiId: 'book', fields: [{ name: 'title', cmsType: 'string' }] });
  const rel = await addRelation(sql, 'author', { field: 'books', kind: 'oneToMany', target: 'book', inverseField: 'author' });
  const a1 = await insertRow('ct_author', 'name', 'A1');
  const a2 = await insertRow('ct_author', 'name', 'A2');
  const b1 = await insertRow('ct_book', 'title', 'B1');
  await boot();

  // author.books oneToMany owner; owner_id = author id, related_id = book id; UNIQUE(related_id).
  assert.equal((await put('author', a1, { books: { connect: [b1] } })).status, 200);
  assert.deepEqual(await links(rel.link_table), [{ owner_id: a1, related_id: b1 }]);
  // connecting the SAME book under a2 MOVES it (UNIQUE(related_id) reassign).
  assert.equal((await put('author', a2, { books: { connect: [b1] } })).status, 200);
  assert.deepEqual(await links(rel.link_table), [{ owner_id: a2, related_id: b1 }]);

  const g1 = await getJson('author', `filters[id][$eq]=${a1}&populate=books`);
  assert.deepEqual(g1.json.data[0]!.books, []);
  const g2 = await getJson('author', `filters[id][$eq]=${a2}&populate=books`);
  assert.deepEqual((g2.json.data[0]!.books as { id: number }[]).map((b) => b.id), [b1]);
});

test('oneToOne: set then reassign on both sides (displaced partner unlinked)', async () => {
  await createContentType(sql, { apiId: 'person', fields: [{ name: 'name', cmsType: 'string' }] });
  await createContentType(sql, { apiId: 'passport', fields: [{ name: 'code', cmsType: 'string' }] });
  const rel = await addRelation(sql, 'person', { field: 'passport', kind: 'oneToOne', target: 'passport', inverseField: 'holder' });
  const p1 = await insertRow('ct_person', 'name', 'P1');
  const p2 = await insertRow('ct_person', 'name', 'P2');
  const pp1 = await insertRow('ct_passport', 'code', 'X1');
  await boot();

  assert.equal((await put('person', p1, { passport: { set: [pp1] } })).status, 200);
  assert.deepEqual(await links(rel.link_table), [{ owner_id: p1, related_id: pp1 }]);
  // assigning pp1 to p2 displaces p1 (UNIQUE(related_id) cleared by pre-DELETE).
  assert.equal((await put('person', p2, { passport: { set: [pp1] } })).status, 200);
  assert.deepEqual(await links(rel.link_table), [{ owner_id: p2, related_id: pp1 }]);

  const g1 = await getJson('person', `filters[id][$eq]=${p1}&populate=passport`);
  assert.equal(g1.json.data[0]!.passport, null);
  const g2 = await getJson('person', `filters[id][$eq]=${p2}&populate=passport`);
  assert.equal((g2.json.data[0]!.passport as { id: number }).id, pp1);
});

test('manyToMany: connect + disconnect together (disconnect-then-connect, connect wins overlap)', async () => {
  await createContentType(sql, { apiId: 'tag', fields: [{ name: 'label', cmsType: 'string' }] });
  await createContentType(sql, { apiId: 'book', fields: [{ name: 'title', cmsType: 'string' }] });
  const rel = await addRelation(sql, 'book', { field: 'tags', kind: 'manyToMany', target: 'tag' });
  const t1 = await insertRow('ct_tag', 'label', 'a');
  const t2 = await insertRow('ct_tag', 'label', 'b');
  const t3 = await insertRow('ct_tag', 'label', 'c');
  const b1 = await insertRow('ct_book', 'title', 'B');
  await boot();

  // seed [t1, t2]
  assert.equal((await put('book', b1, { tags: { set: [t1, t2] } })).status, 200);
  // disconnect t1, connect t2,t3 -> {t2, t3} (t1 gone, t2 kept once, t3 added).
  assert.equal((await put('book', b1, { tags: { disconnect: [t1], connect: [t2, t3] } })).status, 200);
  assert.deepEqual(await links(rel.link_table), [{ owner_id: b1, related_id: t2 }, { owner_id: b1, related_id: t3 }]);
  // overlapping connect/disconnect of the SAME id -> connect wins (id stays PRESENT).
  assert.equal((await put('book', b1, { tags: { connect: [t1], disconnect: [t1] } })).status, 200);
  assert.deepEqual(await links(rel.link_table), [
    { owner_id: b1, related_id: t1 },
    { owner_id: b1, related_id: t2 },
    { owner_id: b1, related_id: t3 },
  ]);
});

test('oneToMany owning-side {set} reassigns: prior owner emptied, related moves under the new owner', async () => {
  await createContentType(sql, { apiId: 'author', fields: [{ name: 'name', cmsType: 'string' }] });
  await createContentType(sql, { apiId: 'book', fields: [{ name: 'title', cmsType: 'string' }] });
  const rel = await addRelation(sql, 'author', { field: 'books', kind: 'oneToMany', target: 'book', inverseField: 'author' });
  const a1 = await insertRow('ct_author', 'name', 'A1');
  const a2 = await insertRow('ct_author', 'name', 'A2');
  const b1 = await insertRow('ct_book', 'title', 'B1');
  const b2 = await insertRow('ct_book', 'title', 'B2');
  const b3 = await insertRow('ct_book', 'title', 'B3');
  await boot();

  // a1 owns [b1, b2]; b3 owned by a2.
  assert.equal((await put('author', a1, { books: { set: [b1, b2] } })).status, 200);
  assert.equal((await put('author', a2, { books: { set: [b3] } })).status, 200);
  // a1 {set:[b2,b3]} -> b1 orphaned, b3 moved off a2 (ON CONFLICT(related_id) DO UPDATE), b2 kept.
  assert.equal((await put('author', a1, { books: { set: [b2, b3] } })).status, 200);
  assert.deepEqual(await links(rel.link_table), [
    { owner_id: a1, related_id: b2 },
    { owner_id: a1, related_id: b3 },
  ]);
  const g1 = await getJson('author', `filters[id][$eq]=${a1}&populate=books`);
  assert.deepEqual((g1.json.data[0]!.books as { id: number }[]).map((b) => b.id).sort((x, y) => x - y), [b2, b3]);
  const g2 = await getJson('author', `filters[id][$eq]=${a2}&populate=books`);
  assert.deepEqual(g2.json.data[0]!.books, []);
});

test('oneToOne dual-conflict reassign: both prior owner-edge and prior related-edge cleared', async () => {
  await createContentType(sql, { apiId: 'person', fields: [{ name: 'name', cmsType: 'string' }] });
  await createContentType(sql, { apiId: 'passport', fields: [{ name: 'code', cmsType: 'string' }] });
  const rel = await addRelation(sql, 'person', { field: 'passport', kind: 'oneToOne', target: 'passport', inverseField: 'holder' });
  const p1 = await insertRow('ct_person', 'name', 'P1');
  const p2 = await insertRow('ct_person', 'name', 'P2');
  const pp1 = await insertRow('ct_passport', 'code', 'X1');
  const pp2 = await insertRow('ct_passport', 'code', 'X2');
  await boot();

  // p1->pp1, p2->pp2 (both columns occupied), then p1->pp2: clears p1's old edge (UNIQUE owner_id)
  // AND pp2's old owner p2 (UNIQUE related_id) via the `owner_id=$1 OR related_id=$2` pre-DELETE.
  assert.equal((await put('person', p1, { passport: { set: [pp1] } })).status, 200);
  assert.equal((await put('person', p2, { passport: { set: [pp2] } })).status, 200);
  assert.equal((await put('person', p1, { passport: { set: [pp2] } })).status, 200);
  assert.deepEqual(await links(rel.link_table), [{ owner_id: p1, related_id: pp2 }]);
  // p2 lost pp2, and pp1's old edge to p1 is also gone.
  const g2 = await getJson('person', `filters[id][$eq]=${p2}&populate=passport`);
  assert.equal(g2.json.data[0]!.passport, null);
});

test('oneToOne self-referential: self-link is idempotent; reassign displaces the self-edge', async () => {
  await createContentType(sql, { apiId: 'node', fields: [{ name: 'name', cmsType: 'string' }] });
  const rel = await addRelation(sql, 'node', { field: 'spouse', kind: 'oneToOne', target: 'node', inverseField: 'spouseOf' });
  const c1 = await insertRow('ct_node', 'name', 'C1');
  const c2 = await insertRow('ct_node', 'name', 'C2');
  await boot();

  // self-link c1->c1: pre-DELETE (owner_id=c1 OR related_id=c1) finds nothing, INSERT (c1,c1).
  assert.equal((await put('node', c1, { spouse: { set: [c1] } })).status, 200);
  assert.deepEqual(await links(rel.link_table), [{ owner_id: c1, related_id: c1 }]);
  // re-set the SAME self-link: pre-DELETE removes the self-row then re-INSERTs it -> still exactly one.
  assert.equal((await put('node', c1, { spouse: { set: [c1] } })).status, 200);
  assert.deepEqual(await links(rel.link_table), [{ owner_id: c1, related_id: c1 }]);
  // reassign c1->c2 displaces the self-edge.
  assert.equal((await put('node', c1, { spouse: { set: [c2] } })).status, 200);
  assert.deepEqual(await links(rel.link_table), [{ owner_id: c1, related_id: c2 }]);
});

// --- 400s: no scalar/link written ---------------------------------------------------------------

test('400s: set+connect mutually exclusive; to-one >1; unknown relation field; bad ids; null/{}/{set:null}', async () => {
  await createContentType(sql, { apiId: 'author', fields: [{ name: 'name', cmsType: 'string' }] });
  await createContentType(sql, { apiId: 'tag', fields: [{ name: 'label', cmsType: 'string' }] });
  await createContentType(sql, { apiId: 'book', fields: [{ name: 'title', cmsType: 'string' }] });
  const relAuthor = await addRelation(sql, 'book', { field: 'author', kind: 'manyToOne', target: 'author' });
  const relTags = await addRelation(sql, 'book', { field: 'tags', kind: 'manyToMany', target: 'tag' });
  const relEditor = await addRelation(sql, 'book', { field: 'editor', kind: 'oneToOne', target: 'author' });
  const b1 = await insertRow('ct_book', 'title', 'B');
  const a1 = await insertRow('ct_author', 'name', 'A');
  await boot();

  const bad = async (body: unknown, label: string): Promise<void> => {
    assert.equal((await put('book', b1, body)).status, 400, label);
  };
  await bad({ tags: { set: [1], connect: [2] } }, 'set+connect');
  await bad({ author: { set: [a1, 2] } }, 'to-one set >1');
  await bad({ author: [a1, 2] }, 'to-one bare >1');
  await bad({ editor: { connect: [a1, 2] } }, 'oneToOne connect >1');
  await bad({ authorr: { set: [a1] } }, 'unknown relation field');
  await bad({ tags: { connect: ['1'] } }, 'string id');
  await bad({ tags: { set: [1.5] } }, 'float id');
  await bad({ tags: { connect: [0] } }, 'zero id');
  await bad({ tags: null }, 'null value');
  await bad({ tags: {} }, 'empty op object');
  await bad({ tags: { set: null } }, 'set:null');
  await bad({ tags: { connect: null } }, 'connect:null');
  await bad({ tags: { disconnect: '5' } }, 'disconnect:string');
  await bad({ tags: { set: { x: 1 } } }, 'set:object');

  // No edges were written by any 400.
  assert.deepEqual(await links(relAuthor.link_table), []);
  assert.deepEqual(await links(relTags.link_table), []);
  assert.deepEqual(await links(relEditor.link_table), []);
});

test('unknown relation field error message is "unknown field" (same as a scalar)', async () => {
  await createContentType(sql, { apiId: 'book', fields: [{ name: 'title', cmsType: 'string' }] });
  await insertRow('ct_book', 'title', 'B');
  await boot();
  const res = await put('book', 1, { authorr: { set: [1] } });
  assert.equal(res.status, 400);
  const j = (await res.json()) as { error: { message?: string } } | { message?: string };
  const msg = JSON.stringify(j);
  assert.ok(msg.includes('unknown field'), `expected "unknown field" in ${msg}`);
});

test('to-one disconnect of >1 ids is allowed (200); extra ids are no-ops', async () => {
  await createContentType(sql, { apiId: 'author', fields: [{ name: 'name', cmsType: 'string' }] });
  await createContentType(sql, { apiId: 'book', fields: [{ name: 'title', cmsType: 'string' }] });
  const rel = await addRelation(sql, 'book', { field: 'author', kind: 'manyToOne', target: 'author' });
  const a1 = await insertRow('ct_author', 'name', 'A1');
  const a2 = await insertRow('ct_author', 'name', 'A2');
  const b1 = await insertRow('ct_book', 'title', 'B');
  await boot();

  assert.equal((await put('book', b1, { author: a1 })).status, 200);
  // disconnect [a1, a2] on a to-one -> NOT a 400; a1 removed, a2 a harmless no-op.
  assert.equal((await put('book', b1, { author: { disconnect: [a1, a2] } })).status, 200);
  assert.deepEqual(await links(rel.link_table), []);
});

test('PUT to a non-existent owner with relation ops -> 404, NO link row written', async () => {
  await createContentType(sql, { apiId: 'tag', fields: [{ name: 'label', cmsType: 'string' }] });
  await createContentType(sql, { apiId: 'book', fields: [{ name: 'title', cmsType: 'string' }] });
  const rel = await addRelation(sql, 'book', { field: 'tags', kind: 'manyToMany', target: 'tag' });
  const t1 = await insertRow('ct_tag', 'label', 'a');
  await boot();

  const res = await put('book', 999999, { title: 'x', tags: { connect: [t1] } });
  assert.equal(res.status, 404);
  assert.deepEqual(await links(rel.link_table), []);
});

// --- FK rollback (no partial write) -------------------------------------------------------------

test('FK: a non-existent related id -> 400, NO scalar change, NO link row', async () => {
  await createContentType(sql, { apiId: 'tag', fields: [{ name: 'label', cmsType: 'string' }] });
  await createContentType(sql, { apiId: 'book', fields: [{ name: 'title', cmsType: 'string', options: { nullable: false } }] });
  const rel = await addRelation(sql, 'book', { field: 'tags', kind: 'manyToMany', target: 'tag' });
  const b1 = await insertRow('ct_book', 'title', 'orig');
  await boot();

  // PUT with a scalar change + a connect to a missing tag -> whole tx rolls back.
  const res = await put('book', b1, { title: 'changed', tags: { connect: [999999] } });
  assert.equal(res.status, 400);
  // scalar UNCHANGED
  const g = await getJson('book', `filters[id][$eq]=${b1}`);
  assert.equal(g.json.data[0]!.title, 'orig');
  // no link row
  const cnt = await links(rel.link_table);
  assert.equal(cnt.length, 0);

  // CREATE with a bad related id -> 400 and NO new ct_ row (no orphan).
  const before = (await sql.unsafe<{ c: string }[]>(`SELECT count(*)::text c FROM ct_book`))[0]!.c;
  const cr = await post('book', { title: 'new', tags: { connect: [999999] } });
  assert.equal(cr.status, 400);
  const afterC = (await sql.unsafe<{ c: string }[]>(`SELECT count(*)::text c FROM ct_book`))[0]!.c;
  assert.equal(afterC, before, 'no orphan ct_ row on FK rollback');
});

// --- idempotent connect / disconnect no-op / empty clear ----------------------------------------

test('connect is idempotent (dup across requests + within a request -> one edge); disconnect non-edge no-op', async () => {
  await createContentType(sql, { apiId: 'tag', fields: [{ name: 'label', cmsType: 'string' }] });
  await createContentType(sql, { apiId: 'book', fields: [{ name: 'title', cmsType: 'string' }] });
  const rel = await addRelation(sql, 'book', { field: 'tags', kind: 'manyToMany', target: 'tag' });
  const t1 = await insertRow('ct_tag', 'label', 'a');
  const t2 = await insertRow('ct_tag', 'label', 'b');
  const b1 = await insertRow('ct_book', 'title', 'B');
  await boot();

  assert.equal((await put('book', b1, { tags: { connect: [t1] } })).status, 200);
  assert.equal((await put('book', b1, { tags: { connect: [t1] } })).status, 200); // dup across requests
  assert.equal((await put('book', b1, { tags: { connect: [t1, t1] } })).status, 200); // dup within request (deduped)
  assert.deepEqual(await links(rel.link_table), [{ owner_id: b1, related_id: t1 }]);

  // disconnect of a non-edge -> no-op, 200, nothing changes.
  assert.equal((await put('book', b1, { tags: { disconnect: [t2] } })).status, 200);
  assert.deepEqual(await links(rel.link_table), [{ owner_id: b1, related_id: t1 }]);
});

test('empty set clears; populated GET shows [] (to-many) and null (to-one)', async () => {
  await createContentType(sql, { apiId: 'tag', fields: [{ name: 'label', cmsType: 'string' }] });
  await createContentType(sql, { apiId: 'author', fields: [{ name: 'name', cmsType: 'string' }] });
  await createContentType(sql, { apiId: 'book', fields: [{ name: 'title', cmsType: 'string' }] });
  const relT = await addRelation(sql, 'book', { field: 'tags', kind: 'manyToMany', target: 'tag' });
  const relA = await addRelation(sql, 'book', { field: 'author', kind: 'manyToOne', target: 'author' });
  const t1 = await insertRow('ct_tag', 'label', 'a');
  const a1 = await insertRow('ct_author', 'name', 'A');
  const b1 = await insertRow('ct_book', 'title', 'B');
  await boot();

  await put('book', b1, { tags: { connect: [t1] }, author: a1 });
  assert.equal((await links(relT.link_table)).length, 1);
  assert.equal((await links(relA.link_table)).length, 1);

  assert.equal((await put('book', b1, { tags: { set: [] }, author: { set: [] } })).status, 200);
  assert.deepEqual(await links(relT.link_table), []);
  assert.deepEqual(await links(relA.link_table), []);

  const g = await getJson('book', `filters[id][$eq]=${b1}&populate[0]=tags&populate[1]=author`);
  assert.deepEqual(g.json.data[0]!.tags, []);
  assert.equal(g.json.data[0]!.author, null);
});

// --- create-with-relations ----------------------------------------------------------------------

test('create-with-relations: owner id from RETURNING; response is scalars only; links use the new id', async () => {
  await createContentType(sql, { apiId: 'tag', fields: [{ name: 'label', cmsType: 'string' }] });
  await createContentType(sql, { apiId: 'book', fields: [{ name: 'title', cmsType: 'string' }] });
  const rel = await addRelation(sql, 'book', { field: 'tags', kind: 'manyToMany', target: 'tag' });
  const t1 = await insertRow('ct_tag', 'label', 'a');
  const t2 = await insertRow('ct_tag', 'label', 'b');
  await boot();

  const res = await post('book', { title: 'x', tags: { connect: [t1, t2] } });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { data: Record<string, unknown> };
  const newId = body.data.id as number;
  assert.ok(typeof newId === 'number');
  assert.ok(!('tags' in body.data), 'no relation key echoed in the write response');

  assert.deepEqual(await links(rel.link_table), [{ owner_id: newId, related_id: t1 }, { owner_id: newId, related_id: t2 }]);
  const g = await getJson('book', `filters[id][$eq]=${newId}&populate=tags`);
  assert.deepEqual((g.json.data[0]!.tags as { id: number }[]).map((t) => t.id).sort((a, b) => a - b), [t1, t2]);
});

// --- PUT partial --------------------------------------------------------------------------------

test('PUT partial: an absent relation field is unchanged', async () => {
  await createContentType(sql, { apiId: 'tag', fields: [{ name: 'label', cmsType: 'string' }] });
  await createContentType(sql, { apiId: 'book', fields: [{ name: 'title', cmsType: 'string' }] });
  const rel = await addRelation(sql, 'book', { field: 'tags', kind: 'manyToMany', target: 'tag' });
  const t1 = await insertRow('ct_tag', 'label', 'a');
  const b1 = await insertRow('ct_book', 'title', 'B');
  await boot();

  await put('book', b1, { tags: { connect: [t1] } });
  assert.deepEqual(await links(rel.link_table), [{ owner_id: b1, related_id: t1 }]);
  // a scalar-only PUT leaves the relation untouched
  assert.equal((await put('book', b1, { title: 'renamed' })).status, 200);
  assert.deepEqual(await links(rel.link_table), [{ owner_id: b1, related_id: t1 }]);
  const g = await getJson('book', `filters[id][$eq]=${b1}`);
  assert.equal(g.json.data[0]!.title, 'renamed');
  // then explicitly clear it
  assert.equal((await put('book', b1, { tags: { disconnect: [t1] } })).status, 200);
  assert.deepEqual(await links(rel.link_table), []);
});

// --- inverse-field write ------------------------------------------------------------------------

test('writing via the INVERSE field orients link columns correctly; visible both directions', async () => {
  await createContentType(sql, { apiId: 'author', fields: [{ name: 'name', cmsType: 'string' }] });
  await createContentType(sql, { apiId: 'book', fields: [{ name: 'title', cmsType: 'string' }] });
  // OWNING side book.author (manyToOne); inverse author.books (oneToMany).
  const rel = await addRelation(sql, 'book', { field: 'author', kind: 'manyToOne', target: 'author', inverseField: 'books' });
  const a1 = await insertRow('ct_author', 'name', 'A');
  const b1 = await insertRow('ct_book', 'title', 'B1');
  const b2 = await insertRow('ct_book', 'title', 'B2');
  await boot();

  // Write via the INVERSE field author.books: body-owner = author (id a1), op ids = book ids.
  // Physical link row is anchored to the OWNING ct_book: owner_id = book id, related_id = author id.
  assert.equal((await put('author', a1, { books: { connect: [b1, b2] } })).status, 200);
  assert.deepEqual(await links(rel.link_table), [{ owner_id: b1, related_id: a1 }, { owner_id: b2, related_id: a1 }]);

  // both directions agree
  const fwd = await getJson('book', `filters[id][$eq]=${b1}&populate=author`);
  assert.equal((fwd.json.data[0]!.author as { id: number }).id, a1);
  const back = await getJson('author', `filters[id][$eq]=${a1}&populate=books`);
  assert.deepEqual((back.json.data[0]!.books as { id: number }[]).map((b) => b.id).sort((x, y) => x - y), [b1, b2]);
});

test('inverse-field {set} + cross-owner reassign: book moves to the new author, columns oriented to owning ct_', async () => {
  await createContentType(sql, { apiId: 'author', fields: [{ name: 'name', cmsType: 'string' }] });
  await createContentType(sql, { apiId: 'book', fields: [{ name: 'title', cmsType: 'string' }] });
  // OWNING side book.author (manyToOne); inverse author.books (oneToMany).
  const rel = await addRelation(sql, 'book', { field: 'author', kind: 'manyToOne', target: 'author', inverseField: 'books' });
  const a1 = await insertRow('ct_author', 'name', 'A1');
  const a2 = await insertRow('ct_author', 'name', 'A2');
  const b1 = await insertRow('ct_book', 'title', 'B1');
  const b2 = await insertRow('ct_book', 'title', 'B2');
  await boot();

  // seed: a1 owns [b1]; a2 owns [b2] (via the inverse field).
  assert.equal((await put('author', a1, { books: { set: [b1] } })).status, 200);
  assert.equal((await put('author', a2, { books: { set: [b2] } })).status, 200);
  // inverse {set} on a1 -> [b1, b2]: clears WHERE related_id=a1, then re-inserts; b2 moves off a2
  // (ON CONFLICT(related_id) reassign). Link rows stay oriented owner_id=book, related_id=author.
  assert.equal((await put('author', a1, { books: { set: [b1, b2] } })).status, 200);
  assert.deepEqual(await links(rel.link_table), [{ owner_id: b1, related_id: a1 }, { owner_id: b2, related_id: a1 }]);
  const g2 = await getJson('author', `filters[id][$eq]=${a2}&populate=books`);
  assert.deepEqual(g2.json.data[0]!.books, []);
});

test('inverse-field connect reassign maintains cardinality (manyToOne via the inverse oneToMany side)', async () => {
  await createContentType(sql, { apiId: 'author', fields: [{ name: 'name', cmsType: 'string' }] });
  await createContentType(sql, { apiId: 'book', fields: [{ name: 'title', cmsType: 'string' }] });
  const rel = await addRelation(sql, 'book', { field: 'author', kind: 'manyToOne', target: 'author', inverseField: 'books' });
  const a1 = await insertRow('ct_author', 'name', 'A1');
  const a2 = await insertRow('ct_author', 'name', 'A2');
  const b1 = await insertRow('ct_book', 'title', 'B1');
  await boot();

  // b1 already linked to a1 (owning side).
  assert.equal((await put('book', b1, { author: a1 })).status, 200);
  // connect b1 under a2 via the INVERSE field -> b1 moves to a2 (related_id reassign), a1 loses it.
  assert.equal((await put('author', a2, { books: { connect: [b1] } })).status, 200);
  assert.deepEqual(await links(rel.link_table), [{ owner_id: b1, related_id: a2 }]);
  const g1 = await getJson('author', `filters[id][$eq]=${a1}&populate=books`);
  assert.deepEqual(g1.json.data[0]!.books, []);
});

test('oneToOne write via the INVERSE field orients owner_id/related_id to the owning ct_', async () => {
  await createContentType(sql, { apiId: 'person', fields: [{ name: 'name', cmsType: 'string' }] });
  await createContentType(sql, { apiId: 'passport', fields: [{ name: 'code', cmsType: 'string' }] });
  // OWNING side person.passport (oneToOne); inverse passport.holder.
  const rel = await addRelation(sql, 'person', { field: 'passport', kind: 'oneToOne', target: 'passport', inverseField: 'holder' });
  const p1 = await insertRow('ct_person', 'name', 'P1');
  const pp1 = await insertRow('ct_passport', 'code', 'X1');
  await boot();

  // Write via the inverse passport.holder: body-owner = passport pp1, op id = person p1.
  // Physical row anchored to the OWNING ct_person: owner_id = person id, related_id = passport id.
  assert.equal((await put('passport', pp1, { holder: { set: [p1] } })).status, 200);
  assert.deepEqual(await links(rel.link_table), [{ owner_id: p1, related_id: pp1 }]);
  const fwd = await getJson('person', `filters[id][$eq]=${p1}&populate=passport`);
  assert.equal((fwd.json.data[0]!.passport as { id: number }).id, pp1);
  const back = await getJson('passport', `filters[id][$eq]=${pp1}&populate=holder`);
  assert.equal((back.json.data[0]!.holder as { id: number }).id, p1);
});

// --- scalar+relation atomic success -------------------------------------------------------------

test('scalar + relation in one body apply atomically', async () => {
  await createContentType(sql, { apiId: 'tag', fields: [{ name: 'label', cmsType: 'string' }] });
  await createContentType(sql, { apiId: 'book', fields: [{ name: 'title', cmsType: 'string' }] });
  const rel = await addRelation(sql, 'book', { field: 'tags', kind: 'manyToMany', target: 'tag' });
  const t1 = await insertRow('ct_tag', 'label', 'a');
  const b1 = await insertRow('ct_book', 'title', 'orig');
  await boot();

  assert.equal((await put('book', b1, { title: 'new', tags: { connect: [t1] } })).status, 200);
  const g = await getJson('book', `filters[id][$eq]=${b1}`);
  assert.equal(g.json.data[0]!.title, 'new');
  assert.deepEqual(await links(rel.link_table), [{ owner_id: b1, related_id: t1 }]);
});

// --- DELETE owner cascade -----------------------------------------------------------------------

test('DELETE owner cascades its link rows (both columns); populated GET of the other type omits it', async () => {
  await createContentType(sql, { apiId: 'author', fields: [{ name: 'name', cmsType: 'string' }] });
  await createContentType(sql, { apiId: 'book', fields: [{ name: 'title', cmsType: 'string' }] });
  const rel = await addRelation(sql, 'book', { field: 'author', kind: 'manyToOne', target: 'author', inverseField: 'books' });
  const a1 = await insertRow('ct_author', 'name', 'A');
  const b1 = await insertRow('ct_book', 'title', 'B');
  await boot();

  await put('book', b1, { author: a1 });
  assert.deepEqual(await links(rel.link_table), [{ owner_id: b1, related_id: a1 }]);

  // Delete the book (owner_id side).
  assert.equal((await del('book', b1)).status, 200);
  const remaining = await sql.unsafe<{ c: string }[]>(`SELECT count(*)::text c FROM "${rel.link_table}" WHERE owner_id = $1 OR related_id = $1`, [b1]);
  assert.equal(remaining[0]!.c, '0');

  const back = await getJson('author', `filters[id][$eq]=${a1}&populate=books`);
  assert.deepEqual(back.json.data[0]!.books, []);
});

// --- self-referential ---------------------------------------------------------------------------

test('self-referential manyToOne parent (+ inverse children): set + visible both directions', async () => {
  await createContentType(sql, { apiId: 'category', fields: [{ name: 'slug', cmsType: 'string' }] });
  const rel = await addRelation(sql, 'category', { field: 'parent', kind: 'manyToOne', target: 'category', inverseField: 'children' });
  const c1 = await insertRow('ct_category', 'slug', 'root');
  const c2 = await insertRow('ct_category', 'slug', 'child');
  await boot();

  // c2.parent = c1; owner_id = c2 (the child, owning manyToOne side), related_id = c1 (the parent).
  assert.equal((await put('category', c2, { parent: { set: [c1] } })).status, 200);
  assert.deepEqual(await links(rel.link_table), [{ owner_id: c2, related_id: c1 }]);

  const childG = await getJson('category', `filters[id][$eq]=${c2}&populate=parent`);
  assert.equal((childG.json.data[0]!.parent as { id: number }).id, c1);
  const parentG = await getJson('category', `filters[id][$eq]=${c1}&populate=children`);
  assert.deepEqual((parentG.json.data[0]!.children as { id: number }[]).map((c) => c.id), [c2]);
});

// --- pure-scalar byte-identical -----------------------------------------------------------------

test('pure-scalar write is byte-identical: relation-less type, AND a type-with-relations omitting them', async () => {
  await createContentType(sql, { apiId: 'note', fields: [{ name: 'text', cmsType: 'string', options: { nullable: false } }] });
  // a type WITH a relation, but the body omits the relation key entirely.
  await createContentType(sql, { apiId: 'tag', fields: [{ name: 'label', cmsType: 'string' }] });
  await createContentType(sql, { apiId: 'book', fields: [{ name: 'title', cmsType: 'string', options: { nullable: false } }] });
  await addRelation(sql, 'book', { field: 'tags', kind: 'manyToMany', target: 'tag' });
  await boot();

  // relation-less POST
  const noteRes = await post('note', { text: 'hi' });
  assert.equal(noteRes.status, 201);
  const noteBuf = Buffer.from(await noteRes.arrayBuffer());
  const noteJson = JSON.parse(noteBuf.toString('utf8')) as { data: Record<string, unknown>; meta: unknown };
  // Re-serialize the SAME shape the slice produces: `{"data":<row>,"meta":{}}`. The row's scalar JSON is
  // a plain object with string/system fields, so JSON.stringify is byte-exact.
  const expected = Buffer.from(`{"data":${JSON.stringify(noteJson.data)},"meta":{}}`, 'utf8');
  assert.ok(noteBuf.equals(expected), 'relation-less POST byte-identical');

  // type-with-relations, body omits the relation
  const bookRes = await post('book', { title: 'b' });
  assert.equal(bookRes.status, 201);
  const bookBuf = Buffer.from(await bookRes.arrayBuffer());
  const bookJson = JSON.parse(bookBuf.toString('utf8')) as { data: Record<string, unknown> };
  assert.ok(!('tags' in bookJson.data), 'no relation key in scalar-only write response');
  const bookExpected = Buffer.from(`{"data":${JSON.stringify(bookJson.data)},"meta":{}}`, 'utf8');
  assert.ok(bookBuf.equals(bookExpected), 'scalar-only write on a relation type byte-identical');

  // PUT pure-scalar
  const putRes = await put('book', bookJson.data.id as number, { title: 'b2' });
  assert.equal(putRes.status, 200);
  const putBuf = Buffer.from(await putRes.arrayBuffer());
  const putJson = JSON.parse(putBuf.toString('utf8')) as { data: Record<string, unknown> };
  const putExpected = Buffer.from(`{"data":${JSON.stringify(putJson.data)},"meta":{}}`, 'utf8');
  assert.ok(putBuf.equals(putExpected), 'scalar-only PUT byte-identical');
});
