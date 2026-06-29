import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Sql } from 'postgres';
import { Registry } from '../src/db/registry.ts';
import { migrate } from '../src/db/schema/migrate.ts';
import { deriveLinkTableName } from '../src/db/ddl.ts';
import { mintId, type Schema } from '../src/db/schema/model.ts';
import { buildEngine, rebuildType } from '../src/db/engine.loader.ts';
import { Engine } from '../src/store/engine.ts';
import { CursorCodec } from '../src/store/cursor.codec.ts';
import { Table } from '../src/store/table.ts';
import { queryKey } from '../src/store/response.cache.ts';
import { handleRequest } from '../src/http/read.router.ts';
import { createFileDatabase, dropFileDatabase } from './db-per-file.ts';
import { cleanCatalog, schema } from './helpers.ts';

/**
 * RELATIONS SLICE 4 — RELATIONAL EXISTS FILTERING, end-to-end against a REAL Postgres (no mocks).
 *
 * `filters[<rel>][<field>][$eq]=v` selects OWNERS that have AT LEAST ONE related row matching the
 * sub-filter (Strapi EXISTS). Deep `filters[a][b][slug][$eq]=Y` is inside-out EXISTS across hops.
 * Composes under `$and`/`$or`/`$not` with scalar leaves; sort + pagination run on the OWNER unchanged;
 * the RESPONSE SHAPE is OWNER SCALARS ONLY (no nested data — that is slice 5).
 *
 * Every expected owner set is computed by an INDEPENDENT brute-force oracle in JS (seeded adjacency +
 * a plain predicate), never by calling scanTree/ownersMatching.
 */

let sql: Sql;
let db: Awaited<ReturnType<typeof createFileDatabase>>;

before(async () => {
  db = await createFileDatabase('relfilter');
  sql = db.sql;
});

beforeEach(async () => {
  await cleanCatalog(sql);
});

after(async () => {
  if (sql) await sql.end();
  if (db) await dropFileDatabase(db.name);
});

// --- seeding helpers ----------------------------------------------------------------------------

async function insertRow(table: string, col: string, value: string): Promise<number> {
  const [r] = await sql.unsafe<{ id: number }[]>(`INSERT INTO "${table}" (${col}) VALUES ($1) RETURNING id`, [value]);
  return r!.id;
}

async function insertEdge(link: string, ownerPk: number, relatedPk: number): Promise<void> {
  await sql.unsafe(`INSERT INTO "${link}" (owner_id, related_id) VALUES ($1, $2)`, [ownerPk, relatedPk]);
}

/** Materialize the ct_ + link tables from in-code IR (files-first, zero meta). */
async function setupCatalog(schemas: Schema[]): Promise<void> {
  await migrate(sql, schemas, { allowDestructive: true });
}

async function boot(schemas: Schema[]): Promise<Engine> {
  // Wire a cursor codec so the keyset (seek) tests have a working codec; harmless for offset tests.
  return buildEngine(sql, Registry.fromSchemas(schemas), { cursorCodec: new CursorCodec('relfilter-secret') });
}

/** Run a GET /:type list query through the pure request core. Returns the CoreResponse. */
function get(engine: Engine, type: string, query: string): { status: number; body: Buffer } {
  const res = handleRequest(engine, { method: 'GET', path: `/${type}`, query });
  return { status: res.status, body: res.body };
}

/** The `data[].id` list of a 200 list response, in returned order (no JSON precision concern: id is i32). */
function idsOf(body: Buffer): number[] {
  const env = JSON.parse(body.toString('utf8')) as { data: { id: number }[] };
  return env.data.map((d) => d.id);
}

function totalOf(body: Buffer): number {
  const env = JSON.parse(body.toString('utf8')) as { meta: { pagination: { total: number } } };
  return env.meta.pagination.total;
}

function pageCountOf(body: Buffer): number {
  const env = JSON.parse(body.toString('utf8')) as { meta: { pagination: { pageCount: number } } };
  return env.meta.pagination.pageCount;
}

const sortedNums = (xs: number[]): number[] => [...xs].sort((a, b) => a - b);

// --- single-hop, each kind, one-way -------------------------------------------------------------

const KINDS = ['oneToOne', 'oneToMany', 'manyToOne', 'manyToMany'] as const;

for (const kind of KINDS) {
  test(`single-hop EXISTS one-way (${kind}): owners with a related name=target`, async () => {
    const schemas = [
      schema({ name: 'author', fields: [{ name: 'name', type: 'string' }] }),
      schema({ name: 'book', fields: [{ name: 'title', type: 'string' }], relations: [{ field: 'authors', kind, target: 'author' }] }),
    ];
    await setupCatalog(schemas);
    const link = deriveLinkTableName('book', 'authors');

    // Per-kind constraints: related_id is UNIQUE for oneToOne/oneToMany (a related belongs to one
    // owner); owner_id is UNIQUE for oneToOne/manyToOne (an owner has one related). Seed a legal
    // adjacency: b1 matches via 'hit', b2 does not, b3 has zero edges. Use DISTINCT related rows so the
    // related-side unique constraint never trips (each author is referenced at most once).
    const aHit = await insertRow('ct_author', 'name', 'hit'); // for b1
    const aMissA = await insertRow('ct_author', 'name', 'miss'); // for b2
    const aMissB = await insertRow('ct_author', 'name', 'miss'); // a second related for b1 when the kind allows
    const b1 = await insertRow('ct_book', 'title', 'b1');
    const b2 = await insertRow('ct_book', 'title', 'b2');
    const b3 = await insertRow('ct_book', 'title', 'b3'); // zero edges

    const multiRelated = kind === 'oneToMany' || kind === 'manyToMany'; // owner may point to many relateds
    const adj = new Map<number, number[]>();
    const addEdge = async (o: number, r: number) => {
      await insertEdge(link, o, r);
      adj.set(o, [...(adj.get(o) ?? []), r]);
    };
    await addEdge(b1, aHit);
    if (multiRelated) await addEdge(b1, aMissB); // b1 has two relateds; still matches via 'hit'
    await addEdge(b2, aMissA); // b2 has only a non-matching related

    const engine = await boot(schemas);

    // ORACLE: owners with >=1 related author whose name === 'hit'.
    const authorName = new Map<number, string>([[aHit, 'hit'], [aMissA, 'miss'], [aMissB, 'miss']]);
    const expected = [b1, b2, b3].filter((b) => (adj.get(b) ?? []).some((a) => authorName.get(a) === 'hit'));

    const res = get(engine, 'book', 'filters[authors][name][$eq]=hit');
    assert.equal(res.status, 200);
    assert.deepEqual(sortedNums(idsOf(res.body)), sortedNums(expected), `${kind} EXISTS owners`);
    assert.equal(totalOf(res.body), expected.length, 'total == |oracle|');
  });
}

// --- single-hop via the INVERSE field (two-way) -------------------------------------------------

test('single-hop via the INVERSE field resolves to the partner type', async () => {
  const schemas = [
    schema({ name: 'author', fields: [{ name: 'name', type: 'string' }] }),
    schema({ name: 'book', fields: [{ name: 'title', type: 'string' }], relations: [{ field: 'authors', kind: 'manyToMany', target: 'author', inverseField: 'books' }] }),
  ];
  await setupCatalog(schemas);
  const link = deriveLinkTableName('book', 'authors');

  const a1 = await insertRow('ct_author', 'name', 'a1');
  const a2 = await insertRow('ct_author', 'name', 'a2');
  const a3 = await insertRow('ct_author', 'name', 'a3'); // zero edges
  const bX = await insertRow('ct_book', 'title', 'X');
  const bY = await insertRow('ct_book', 'title', 'Y');
  // a1 wrote book X; a2 wrote book Y.
  await insertEdge(link, bX, a1);
  await insertEdge(link, bY, a2);

  const engine = await boot(schemas);

  // Filter AUTHORS by their books' title (the inverse field `books` -> target type `book`).
  // ORACLE (transposed adjacency): authors whose books include title 'X'.
  const bookTitle = new Map<number, string>([[bX, 'X'], [bY, 'Y']]);
  const authorBooks = new Map<number, number[]>([[a1, [bX]], [a2, [bY]], [a3, []]]);
  const expected = [a1, a2, a3].filter((a) => (authorBooks.get(a) ?? []).some((b) => bookTitle.get(b) === 'X'));

  const res = get(engine, 'author', 'filters[books][title][$eq]=X');
  assert.equal(res.status, 200);
  assert.deepEqual(sortedNums(idsOf(res.body)), sortedNums(expected));
  assert.deepEqual(expected, [a1], 'only a1 wrote book X');

  // NEGATIVE GUARD: the inverse `books` sub-filter MUST be validated against the PARTNER (book)
  // schema, not the owner (author) schema. `title` is a book field -> 200 (asserted above); `name`
  // is an AUTHOR field, absent on book -> the sub-filter is unknown-field 400. This pins that the
  // resolved target type is `book` and could not pass if the inverse resolved to the owner schema.
  const wrong = get(engine, 'author', 'filters[books][name][$eq]=X');
  assert.equal(wrong.status, 400, 'inverse sub-filter validated against book (name is not a book field)');
});

// --- deep 2-hop ---------------------------------------------------------------------------------

test('deep 2-hop EXISTS: book -> author -> category', async () => {
  const schemas = [
    schema({ name: 'category', fields: [{ name: 'slug', type: 'string' }] }),
    schema({ name: 'author', fields: [{ name: 'name', type: 'string' }], relations: [{ field: 'category', kind: 'manyToOne', target: 'category' }] }),
    schema({ name: 'book', fields: [{ name: 'title', type: 'string' }], relations: [{ field: 'author', kind: 'manyToOne', target: 'author' }] }),
  ];
  await setupCatalog(schemas);
  const linkAC = deriveLinkTableName('author', 'category');
  const linkBA = deriveLinkTableName('book', 'author');

  const cFoo = await insertRow('ct_category', 'slug', 'foo');
  const cBar = await insertRow('ct_category', 'slug', 'bar');
  const a1 = await insertRow('ct_author', 'name', 'a1'); // -> foo
  const a2 = await insertRow('ct_author', 'name', 'a2'); // -> bar
  const a3 = await insertRow('ct_author', 'name', 'a3'); // -> no category
  const b1 = await insertRow('ct_book', 'title', 'b1'); // -> a1 (foo)
  const b2 = await insertRow('ct_book', 'title', 'b2'); // -> a2 (bar)
  const b3 = await insertRow('ct_book', 'title', 'b3'); // -> a3 (none)
  const b4 = await insertRow('ct_book', 'title', 'b4'); // -> no author

  await insertEdge(linkAC, a1, cFoo);
  await insertEdge(linkAC, a2, cBar);
  await insertEdge(linkBA, b1, a1);
  await insertEdge(linkBA, b2, a2);
  await insertEdge(linkBA, b3, a3);

  const engine = await boot(schemas);

  // ORACLE composed hop-by-hop in JS: books whose author has a category with slug 'foo'.
  const catSlug = new Map<number, string>([[cFoo, 'foo'], [cBar, 'bar']]);
  const authorCat = new Map<number, number[]>([[a1, [cFoo]], [a2, [cBar]], [a3, []]]);
  const bookAuthor = new Map<number, number[]>([[b1, [a1]], [b2, [a2]], [b3, [a3]], [b4, []]]);
  const expected = [b1, b2, b3, b4].filter((b) =>
    (bookAuthor.get(b) ?? []).some((a) =>
      (authorCat.get(a) ?? []).some((c) => catSlug.get(c) === 'foo'),
    ),
  );
  assert.deepEqual(expected, [b1], 'only b1 -> a1 -> foo');

  const res = get(engine, 'book', 'filters[author][category][slug][$eq]=foo');
  assert.equal(res.status, 200);
  assert.deepEqual(sortedNums(idsOf(res.body)), sortedNums(expected));

  // $not over the WHOLE 2-hop chain = complement of the EXISTS set over all owners. A book with ZERO
  // author edges (b4) cannot satisfy EXISTS, so it MUST appear in the NOT set. Same oracle, complemented.
  const all = [b1, b2, b3, b4];
  const notExpected = all.filter((b) => !expected.includes(b));
  assert.ok(notExpected.includes(b4), 'oracle: zero-author book is in the NOT set');
  const notRes = get(engine, 'book', 'filters[$not][author][category][slug][$eq]=foo');
  assert.equal(notRes.status, 200);
  assert.deepEqual(sortedNums(idsOf(notRes.body)), sortedNums(notExpected), '2-hop $not = complement over all owners');
  assert.ok(idsOf(notRes.body).includes(b4), 'zero-author-edge book present in the 2-hop $not result');
});

// --- $or mixing relation + scalar ---------------------------------------------------------------

test('$or mixing a scalar leaf and a relation leaf (union)', async () => {
  const schemas = [
    schema({ name: 'author', fields: [{ name: 'name', type: 'string' }] }),
    schema({ name: 'book', fields: [{ name: 'title', type: 'string' }], relations: [{ field: 'authors', kind: 'manyToMany', target: 'author' }] }),
  ];
  await setupCatalog(schemas);
  const link = deriveLinkTableName('book', 'authors');

  const aHit = await insertRow('ct_author', 'name', 'hit');
  const aMiss = await insertRow('ct_author', 'name', 'miss');
  const b1 = await insertRow('ct_book', 'title', 'keep'); // matches scalar only
  const b2 = await insertRow('ct_book', 'title', 'drop'); // matches relation only
  const b3 = await insertRow('ct_book', 'title', 'drop'); // matches neither
  const b4 = await insertRow('ct_book', 'title', 'keep'); // matches both
  await insertEdge(link, b2, aHit);
  await insertEdge(link, b4, aHit);
  await insertEdge(link, b3, aMiss);

  const engine = await boot(schemas);

  const title = new Map<number, string>([[b1, 'keep'], [b2, 'drop'], [b3, 'drop'], [b4, 'keep']]);
  const adj = new Map<number, number[]>([[b1, []], [b2, [aHit]], [b3, [aMiss]], [b4, [aHit]]]);
  const expected = [b1, b2, b3, b4].filter(
    (b) => title.get(b) === 'keep' || (adj.get(b) ?? []).some((a) => a === aHit),
  );

  const res = get(engine, 'book', 'filters[$or][0][title][$eq]=keep&filters[$or][1][authors][name][$eq]=hit');
  assert.equal(res.status, 200);
  assert.deepEqual(sortedNums(idsOf(res.body)), sortedNums(expected));
});

// --- logical combinators INSIDE a relation sub-filter -------------------------------------------

test('relation sub-filter led by $or parses and matches (logical combinator inside the relation)', async () => {
  const schemas = [
    schema({ name: 'author', fields: [{ name: 'name', type: 'string' }] }),
    schema({ name: 'book', fields: [{ name: 'title', type: 'string' }], relations: [{ field: 'authors', kind: 'manyToMany', target: 'author' }] }),
  ];
  await setupCatalog(schemas);
  const link = deriveLinkTableName('book', 'authors');

  const aX = await insertRow('ct_author', 'name', 'X');
  const aY = await insertRow('ct_author', 'name', 'Y');
  const aZ = await insertRow('ct_author', 'name', 'Z');
  const b1 = await insertRow('ct_book', 'title', 'b1'); // -> X (matches X or Y)
  const b2 = await insertRow('ct_book', 'title', 'b2'); // -> Y (matches X or Y)
  const b3 = await insertRow('ct_book', 'title', 'b3'); // -> Z (matches neither)
  const b4 = await insertRow('ct_book', 'title', 'b4'); // zero edges
  await insertEdge(link, b1, aX);
  await insertEdge(link, b2, aY);
  await insertEdge(link, b3, aZ);

  const engine = await boot(schemas);

  const nameById = new Map<number, string>([[aX, 'X'], [aY, 'Y'], [aZ, 'Z']]);
  const adj = new Map<number, number[]>([[b1, [aX]], [b2, [aY]], [b3, [aZ]], [b4, []]]);
  // EXISTS an author whose name is X OR Y.
  const expected = [b1, b2, b3, b4].filter((b) =>
    (adj.get(b) ?? []).some((a) => nameById.get(a) === 'X' || nameById.get(a) === 'Y'),
  );
  assert.deepEqual(sortedNums(expected), sortedNums([b1, b2]), 'oracle: b1,b2');

  // The relation value LEADS with $or (valid Strapi). Before the fix this 400'd (isOpShaped over-rejected).
  const q = 'filters[authors][$or][0][name][$eq]=X&filters[authors][$or][1][name][$eq]=Y';
  const res = get(engine, 'book', q);
  assert.equal(res.status, 200, 'relation sub-filter led by $or must parse (200), not 400');
  assert.deepEqual(sortedNums(idsOf(res.body)), sortedNums(expected));
});

test('$not INSIDE a relation sub-filter = EXISTS a related row NOT matching (inside-out)', async () => {
  const schemas = [
    schema({ name: 'author', fields: [{ name: 'name', type: 'string' }] }),
    schema({ name: 'book', fields: [{ name: 'title', type: 'string' }], relations: [{ field: 'authors', kind: 'manyToMany', target: 'author' }] }),
  ];
  await setupCatalog(schemas);
  const link = deriveLinkTableName('book', 'authors');

  const aHit = await insertRow('ct_author', 'name', 'hit');
  const aOther = await insertRow('ct_author', 'name', 'other');
  const bOnlyHit = await insertRow('ct_book', 'title', 'onlyHit'); // -> hit only (NO author != hit)
  const bMixed = await insertRow('ct_book', 'title', 'mixed'); // -> hit + other (HAS author != hit)
  const bOnlyOther = await insertRow('ct_book', 'title', 'onlyOther'); // -> other (HAS author != hit)
  const bZero = await insertRow('ct_book', 'title', 'zero'); // zero edges (no author at all)
  await insertEdge(link, bOnlyHit, aHit);
  await insertEdge(link, bMixed, aHit);
  await insertEdge(link, bMixed, aOther);
  await insertEdge(link, bOnlyOther, aOther);

  const engine = await boot(schemas);

  const nameById = new Map<number, string>([[aHit, 'hit'], [aOther, 'other']]);
  const adj = new Map<number, number[]>([
    [bOnlyHit, [aHit]], [bMixed, [aHit, aOther]], [bOnlyOther, [aOther]], [bZero, []],
  ]);
  // Inside-out: owners with AT LEAST ONE author whose name is NOT 'hit'. The complement happens on the
  // TARGET (per related row), NOT on the owner plane. bOnlyHit -> no such author; bZero -> no author.
  const expected = [bOnlyHit, bMixed, bOnlyOther, bZero].filter((b) =>
    (adj.get(b) ?? []).some((a) => nameById.get(a) !== 'hit'),
  );
  assert.deepEqual(sortedNums(expected), sortedNums([bMixed, bOnlyOther]), 'oracle: mixed,onlyOther');

  const res = get(engine, 'book', 'filters[authors][$not][name][$eq]=hit');
  assert.equal(res.status, 200, 'relation sub-filter led by $not must parse');
  assert.deepEqual(sortedNums(idsOf(res.body)), sortedNums(expected), 'inside-out $not, not owner-plane complement');
  // Distinct from "owner has NO matching author" (that would also include bZero): bZero is EXCLUDED here.
  assert.ok(!idsOf(res.body).includes(bZero), 'zero-edge owner excluded: $not is inside the sub-filter, not on the owner');
});

// --- manyToOne shared related row (EXISTS fan-out) ----------------------------------------------

test('manyToOne: two owners pointing to the SAME related row both match (shared-related EXISTS)', async () => {
  // manyToOne: owner_id is UNIQUE (each book has one author) but related_id MAY repeat (one author,
  // many books) — the defining shared-related case.
  const schemas = [
    schema({ name: 'author', fields: [{ name: 'name', type: 'string' }] }),
    schema({ name: 'book', fields: [{ name: 'title', type: 'string' }], relations: [{ field: 'author', kind: 'manyToOne', target: 'author' }] }),
  ];
  await setupCatalog(schemas);
  const link = deriveLinkTableName('book', 'author');

  const aShared = await insertRow('ct_author', 'name', 'shared');
  const aOther = await insertRow('ct_author', 'name', 'other');
  const b1 = await insertRow('ct_book', 'title', 'b1'); // -> shared
  const b2 = await insertRow('ct_book', 'title', 'b2'); // -> shared (SAME related as b1)
  const b3 = await insertRow('ct_book', 'title', 'b3'); // -> other
  await insertEdge(link, b1, aShared);
  await insertEdge(link, b2, aShared); // legal: owner_id unique, related_id repeats
  await insertEdge(link, b3, aOther);

  const engine = await boot(schemas);

  const nameById = new Map<number, string>([[aShared, 'shared'], [aOther, 'other']]);
  const adj = new Map<number, number[]>([[b1, [aShared]], [b2, [aShared]], [b3, [aOther]]]);
  const expected = [b1, b2, b3].filter((b) => (adj.get(b) ?? []).some((a) => nameById.get(a) === 'shared'));
  assert.deepEqual(sortedNums(expected), sortedNums([b1, b2]), 'oracle: both owners sharing the related match');

  const res = get(engine, 'book', 'filters[author][name][$eq]=shared');
  assert.equal(res.status, 200);
  assert.deepEqual(sortedNums(idsOf(res.body)), sortedNums(expected), 'shared-related manyToOne EXISTS fan-out');
});

// --- $not over a relation leaf (zero-edge owners included) ---------------------------------------

test('$not over a relation leaf includes zero-edge owners; excluded without $not', async () => {
  const schemas = [
    schema({ name: 'author', fields: [{ name: 'name', type: 'string' }] }),
    schema({ name: 'book', fields: [{ name: 'title', type: 'string' }], relations: [{ field: 'authors', kind: 'manyToMany', target: 'author' }] }),
  ];
  await setupCatalog(schemas);
  const link = deriveLinkTableName('book', 'authors');

  const aHit = await insertRow('ct_author', 'name', 'hit');
  const aMiss = await insertRow('ct_author', 'name', 'miss');
  const bWith = await insertRow('ct_book', 'title', 'with'); // -> hit
  const bOther = await insertRow('ct_book', 'title', 'other'); // -> miss
  const bZero = await insertRow('ct_book', 'title', 'zero'); // zero edges
  await insertEdge(link, bWith, aHit);
  await insertEdge(link, bOther, aMiss);

  const engine = await boot(schemas);

  const adj = new Map<number, number[]>([[bWith, [aHit]], [bOther, [aMiss]], [bZero, []]]);
  const all = [bWith, bOther, bZero];
  const exists = all.filter((b) => (adj.get(b) ?? []).some((a) => a === aHit));
  const notExists = all.filter((b) => !exists.includes(b));

  const posRes = get(engine, 'book', 'filters[authors][name][$eq]=hit');
  assert.deepEqual(sortedNums(idsOf(posRes.body)), sortedNums(exists), 'positive EXISTS');
  assert.ok(!idsOf(posRes.body).includes(bZero), 'zero-edge owner NOT in positive set');

  const notRes = get(engine, 'book', 'filters[$not][authors][name][$eq]=hit');
  assert.equal(notRes.status, 200);
  assert.deepEqual(sortedNums(idsOf(notRes.body)), sortedNums(notExists), '$not = complement');
  assert.ok(idsOf(notRes.body).includes(bZero), 'zero-edge owner IS in the $not set');
});

// --- relation filter + sort + offset pagination -------------------------------------------------

test('relation filter + sort + offset pagination on the OWNER', async () => {
  const schemas = [
    schema({ name: 'author', fields: [{ name: 'name', type: 'string' }] }),
    schema({ name: 'book', fields: [{ name: 'title', type: 'string' }], relations: [{ field: 'authors', kind: 'manyToMany', target: 'author' }] }),
  ];
  await setupCatalog(schemas);
  const link = deriveLinkTableName('book', 'authors');

  const aHit = await insertRow('ct_author', 'name', 'hit');
  const matching: number[] = [];
  for (let i = 0; i < 7; i++) {
    const b = await insertRow('ct_book', 'title', `b${i}`);
    await insertEdge(link, b, aHit);
    matching.push(b);
  }
  // some non-matching owners interleaved
  for (let i = 0; i < 3; i++) await insertRow('ct_book', 'title', `n${i}`);

  const engine = await boot(schemas);

  // ORACLE: matching owners sorted by id DESC, page slice [start=2, limit=3].
  const orderedDesc = sortedNums(matching).reverse();
  const slice = orderedDesc.slice(2, 5);

  const res = get(engine, 'book', 'filters[authors][name][$eq]=hit&sort=id:desc&pagination[start]=2&pagination[limit]=3');
  assert.equal(res.status, 200);
  assert.deepEqual(idsOf(res.body), slice, 'ordered+sliced owner ids');
  assert.equal(totalOf(res.body), matching.length, 'total reflects the full EXISTS set');
  assert.equal(pageCountOf(res.body), Math.ceil(matching.length / 3), 'pageCount = ceil(total/pageSize)');
});

// --- relation filter + keyset pagination --------------------------------------------------------

test('relation filter + keyset pagination: pages union to the full EXISTS set, withCount correct', async () => {
  const schemas = [
    schema({ name: 'author', fields: [{ name: 'name', type: 'string' }] }),
    schema({ name: 'book', fields: [{ name: 'title', type: 'string' }], relations: [{ field: 'authors', kind: 'manyToMany', target: 'author' }] }),
  ];
  await setupCatalog(schemas);
  const link = deriveLinkTableName('book', 'authors');

  const aHit = await insertRow('ct_author', 'name', 'hit');
  const matching: number[] = [];
  for (let i = 0; i < 5; i++) {
    const b = await insertRow('ct_book', 'title', `b${i}`);
    await insertEdge(link, b, aHit);
    matching.push(b);
  }
  await insertRow('ct_book', 'title', 'n0'); // non-matching

  const engine = await boot(schemas);

  // Walk keyset pages of size 2 (forward), collecting ids in order.
  const collected: number[] = [];
  let cursor = '';
  let total = -1;
  for (let guard = 0; guard < 10; guard++) {
    const q = `filters[authors][name][$eq]=hit&sort=id:asc&pagination[cursor]=${encodeURIComponent(cursor)}&pagination[pageSize]=2&pagination[withCount]=true`;
    const res = get(engine, 'book', q);
    assert.equal(res.status, 200, `keyset page ${guard}`);
    const env = JSON.parse(res.body.toString('utf8')) as {
      data: { id: number }[];
      meta: { pagination: { total: number; nextCursor: string | null; hasNextPage: boolean } };
    };
    for (const d of env.data) collected.push(d.id);
    total = env.meta.pagination.total;
    if (!env.meta.pagination.hasNextPage || env.meta.pagination.nextCursor === null) break;
    cursor = env.meta.pagination.nextCursor;
  }
  assert.deepEqual(collected, sortedNums(matching), 'pages union to the full EXISTS set, in order, no dup/gap');
  assert.equal(total, matching.length, 'withCount total correct');
});

test('a keyset cursor minted under relation filter A is rejected under filter B', async () => {
  const schemas = [
    schema({ name: 'author', fields: [{ name: 'name', type: 'string' }] }),
    schema({ name: 'book', fields: [{ name: 'title', type: 'string' }], relations: [{ field: 'authors', kind: 'manyToMany', target: 'author' }] }),
  ];
  await setupCatalog(schemas);
  const link = deriveLinkTableName('book', 'authors');
  const aA = await insertRow('ct_author', 'name', 'A');
  const aB = await insertRow('ct_author', 'name', 'B');
  for (let i = 0; i < 4; i++) {
    const b = await insertRow('ct_book', 'title', `b${i}`);
    await insertEdge(link, b, aA);
    await insertEdge(link, b, aB);
  }
  const engine = await boot(schemas);

  const first = get(engine, 'book', 'filters[authors][name][$eq]=A&sort=id:asc&pagination[cursor]=&pagination[pageSize]=2');
  const env = JSON.parse(first.body.toString('utf8')) as { meta: { pagination: { nextCursor: string } } };
  const cursor = env.meta.pagination.nextCursor;
  assert.ok(cursor, 'minted a cursor under filter A');

  // Replay that cursor under filter B (different relation sub-filter) -> the sig binds the relation leaf -> 400.
  const replay = get(engine, 'book', `filters[authors][name][$eq]=B&sort=id:asc&pagination[cursor]=${encodeURIComponent(cursor)}&pagination[pageSize]=2`);
  assert.equal(replay.status, 400, 'cursor rejected under a different relation filter');
});

// --- zero-match + empty / zero-edge relation ----------------------------------------------------

test('zero-match relation filter returns an empty, well-formed envelope', async () => {
  const schemas = [
    schema({ name: 'author', fields: [{ name: 'name', type: 'string' }] }),
    schema({ name: 'book', fields: [{ name: 'title', type: 'string' }], relations: [{ field: 'authors', kind: 'manyToMany', target: 'author' }] }),
  ];
  await setupCatalog(schemas);
  const link = deriveLinkTableName('book', 'authors');
  const a1 = await insertRow('ct_author', 'name', 'a1');
  const b1 = await insertRow('ct_book', 'title', 'b1');
  await insertEdge(link, b1, a1);

  const engine = await boot(schemas);
  const res = get(engine, 'book', 'filters[authors][name][$eq]=nobody');
  assert.equal(res.status, 200);
  assert.deepEqual(idsOf(res.body), [], 'no matches');
  assert.equal(totalOf(res.body), 0, 'total 0');
});

test('relation with rows but ZERO edges: positive [], $not all owners', async () => {
  const schemas = [
    schema({ name: 'author', fields: [{ name: 'name', type: 'string' }] }),
    schema({ name: 'book', fields: [{ name: 'title', type: 'string' }], relations: [{ field: 'authors', kind: 'manyToMany', target: 'author' }] }),
  ];
  await setupCatalog(schemas);
  await insertRow('ct_author', 'name', 'a1');
  const b1 = await insertRow('ct_book', 'title', 'b1');
  const b2 = await insertRow('ct_book', 'title', 'b2'); // no edges anywhere

  const engine = await boot(schemas);
  const pos = get(engine, 'book', 'filters[authors][name][$eq]=a1');
  assert.deepEqual(idsOf(pos.body), [], 'positive empty (no edges)');
  const not = get(engine, 'book', 'filters[$not][authors][name][$eq]=a1');
  assert.deepEqual(sortedNums(idsOf(not.body)), sortedNums([b1, b2]), '$not = all owners (none have edges)');
});

// --- word-boundary sizing + $and (probe true/false byte-identical) ------------------------------

test('tiny-lead probe BAILS on a relation child: probeHits stays 0, byte-identical on/off, oracle-correct', async () => {
  const schemas = [
    schema({ name: 'author', fields: [{ name: 'name', type: 'string' }] }),
    schema({
      name: 'book',
      fields: [{ name: 'title', type: 'string' }, { name: 'tag', type: 'string' }],
      relations: [{ field: 'authors', kind: 'manyToMany', target: 'author' }],
    }),
  ];
  await setupCatalog(schemas);
  const link = deriveLinkTableName('book', 'authors');

  const aHit = await insertRow('ct_author', 'name', 'hit');
  const aMiss = await insertRow('ct_author', 'name', 'miss');

  // 70 books (> 64 so a 1-row lead clears the tiny-lead gate 1/64). EXACTLY ONE book has title 'lead'
  // (the tiny scalar lead). That one book ALSO links to the matching author -> it is the single answer.
  // Every other book has title 'bulk'. Half link to aHit (so the residual relation leaf is non-trivial).
  const books: number[] = [];
  const titleByBook = new Map<number, string>();
  const adj = new Map<number, number[]>();
  const N = 70;
  for (let i = 0; i < N; i++) {
    const title = i === 0 ? 'lead' : 'bulk';
    const b = await insertRow('ct_book', 'title', title);
    books.push(b);
    titleByBook.set(b, title);
    const a = i % 2 === 0 ? aHit : aMiss; // book 0 (the lead) is even -> links to aHit
    await insertEdge(link, b, a);
    adj.set(b, [a]);
  }

  const engine = await boot(schemas);
  const table = engine.table('book');
  // An eq index on `title` is what makes `title=lead` a cheap-exact lead for the probe planner.
  table.createEqIndex('title');
  table.warmIndexes();

  // ORACLE: title='lead' AND EXISTS author name='hit'.
  const expected = books.filter(
    (b) => titleByBook.get(b) === 'lead' && (adj.get(b) ?? []).some((a) => a === aHit),
  );
  assert.deepEqual(expected, [books[0]!], 'oracle: the single lead book');

  const q = 'filters[$and][0][title][$eq]=lead&filters[$and][1][authors][name][$eq]=hit';

  // SANITY: an ALL-SCALAR AND with the SAME tiny lead DOES take the probe path (probeHits increments).
  // This proves the lead/gate selection is real, so the 0-increment below is the relation-child BAIL,
  // not the gate simply never firing. tag='t<even>' on book 0 (i=0 -> 't0').
  // (book 0 has no tag set -> tag is NULL; use a scalar residual that book 0 satisfies: title!='x'.)
  table.probeHits = 0;
  const scalarOnly = get(engine, 'book', 'filters[$and][0][title][$eq]=lead&filters[$and][1][title][$ne]=x');
  assert.equal(scalarOnly.status, 200);
  assert.ok(table.probeHits > 0, 'tiny-lead probe FIRES for an all-scalar AND (gate + lead selection are real)');

  // Now the AND with a RELATION child. tryProbeAnd must BAIL (relation child is not a leaf) -> probeHits
  // does NOT increment -> the combiner path runs. Result must still be oracle-correct.
  table.probeHits = 0;
  table.probeEnabled = true;
  const on = get(engine, 'book', q);
  assert.equal(table.probeHits, 0, 'probe BAILS on the relation child (no increment) -> combiner path used');

  table.probeEnabled = false;
  const off = get(engine, 'book', q);
  table.probeEnabled = true;

  assert.equal(on.status, 200);
  assert.deepEqual(sortedNums(idsOf(on.body)), sortedNums(expected), 'probe-on AND(scalar,relation) matches oracle');
  assert.ok(on.body.equals(off.body), 'probe true/false byte-identical for AND(scalar, relation)');
});

// --- output shape unchanged (no nested data leaks: slice 5 must NOT appear) ---------------------

test('relation-FILTERED response returns owner scalars ONLY (no nested related data)', async () => {
  const schemas = [
    schema({ name: 'author', fields: [{ name: 'name', type: 'string' }] }),
    schema({
      name: 'book',
      fields: [{ name: 'title', type: 'string' }, { name: 'pages', type: 'integer' }],
      relations: [{ field: 'authors', kind: 'manyToMany', target: 'author', inverseField: 'books' }],
    }),
  ];
  await setupCatalog(schemas);
  const link = deriveLinkTableName('book', 'authors');
  const aHit = await insertRow('ct_author', 'name', 'hit');
  const b1 = await sql.unsafe<{ id: number }[]>(
    `INSERT INTO ct_book (title, pages) VALUES ($1, $2) RETURNING id`, ['b1', '123'],
  ).then((r) => r[0]!.id);
  await insertEdge(link, b1, aHit);

  const engine = await boot(schemas);

  // A relation-FILTERED list (goes through the resolver path).
  const res = get(engine, 'book', 'filters[authors][name][$eq]=hit');
  assert.equal(res.status, 200);
  const env = JSON.parse(res.body.toString('utf8')) as { data: Record<string, unknown>[] };
  assert.equal(env.data.length, 1, 'one matching owner');
  const row = env.data[0]!;
  // Owner SCALARS only: id + the book's own fields (plus engine timestamps). NO relation key (slice 5).
  for (const k of ['id', 'title', 'pages']) assert.ok(k in row, `owner scalar "${k}" present`);
  assert.ok(!('authors' in row), 'no nested related data leaked into the filtered owner row');
  assert.ok(!('books' in row), 'no inverse-field nested data leaked');
  // No key may carry an array/object nested-data payload (the slice-5 shape) — every value is a scalar.
  for (const [k, v] of Object.entries(row)) {
    assert.ok(
      v === null || typeof v !== 'object',
      `owner field "${k}" must be a scalar, got nested ${typeof v} (slice-5 leak)`,
    );
  }
  assert.equal(row.id, b1);

  // BYTE-IDENTITY of the owner record itself: the same owner's bytes from an UNFILTERED list must
  // equal its bytes from the relation-FILTERED list (the filter changes membership, never row shape).
  const unfiltered = get(engine, 'book', 'pagination[pageSize]=100');
  const unEnv = JSON.parse(unfiltered.body.toString('utf8')) as { data: Record<string, unknown>[] };
  const sameOwner = unEnv.data.find((r) => r.id === b1)!;
  assert.deepEqual(row, sameOwner, 'filtered owner record is identical in shape+content to its unfiltered record');
});

// --- validation 400s ----------------------------------------------------------------------------

test('validation: unknown sub-field, unknown op, op-shaped/bare relation, unknown top key', async () => {
  const schemas = [
    schema({ name: 'author', fields: [{ name: 'name', type: 'string' }] }),
    schema({ name: 'book', fields: [{ name: 'title', type: 'string' }], relations: [{ field: 'authors', kind: 'manyToMany', target: 'author' }] }),
  ];
  await setupCatalog(schemas);
  await insertRow('ct_author', 'name', 'a1');
  await insertRow('ct_book', 'title', 'b1');
  const engine = await boot(schemas);

  assert.equal(get(engine, 'book', 'filters[authors][nope][$eq]=x').status, 400, 'unknown sub-field');
  assert.equal(get(engine, 'book', 'filters[authors][name][$bogus]=x').status, 400, 'unknown operator');
  assert.equal(get(engine, 'book', 'filters[authors]=5').status, 400, 'bare relation value');
  assert.equal(get(engine, 'book', 'filters[authors][$eq]=5').status, 400, 'op-shaped relation value');
  assert.equal(get(engine, 'book', 'filters[authors][$null]=true').status, 400, '$null on a relation (out of scope)');
  assert.equal(get(engine, 'book', 'filters[notARelation][x][$eq]=y').status, 400, 'unknown field preserved');
});

// --- depth cap ----------------------------------------------------------------------------------

test('depth cap: 3-hop self-referential parses; 4-hop -> 400 (no hang)', async () => {
  const schemas = [
    schema({ name: 'comment', fields: [{ name: 'body', type: 'string' }], relations: [{ field: 'parent', kind: 'manyToOne', target: 'comment', inverseField: 'children' }] }),
  ];
  await setupCatalog(schemas);
  const link = deriveLinkTableName('comment', 'parent');
  const root = await insertRow('ct_comment', 'body', 'root');
  const mid = await insertRow('ct_comment', 'body', 'mid');
  const leaf = await insertRow('ct_comment', 'body', 'leaf');
  await insertEdge(link, mid, root); // mid.parent = root
  await insertEdge(link, leaf, mid); // leaf.parent = mid

  const engine = await boot(schemas);

  // 2 hops: comment.parent.parent.body — leaf -> mid -> root (body=root). Parses + resolves.
  const ok2 = get(engine, 'comment', 'filters[parent][parent][body][$eq]=root');
  assert.equal(ok2.status, 200, '2-hop chain resolves');
  assert.deepEqual(idsOf(ok2.body), [leaf], 'leaf -> mid -> root matches');

  // 3 hops: at the cap (MAX_RELATION_HOPS=3) — parses + resolves (no 3rd ancestor here, so empty).
  const ok3 = get(engine, 'comment', 'filters[parent][parent][parent][body][$eq]=root');
  assert.equal(ok3.status, 200, '3-hop chain at the cap still parses');
  assert.deepEqual(idsOf(ok3.body), [], 'no comment has a 3rd-degree parent named root');

  // 4 hops: exceeds MAX_RELATION_HOPS (3) -> clear 400, never a stack overflow.
  const tooDeep = get(engine, 'comment', 'filters[parent][parent][parent][parent][body][$eq]=root');
  assert.equal(tooDeep.status, 400, '4-hop chain rejected by the depth cap');
});

// --- cache: key-level same/different + cold byte-identity + cross-type freshness ----------------

test('queryKey: identical relation filters collide, different ones do not', () => {
  const t = new Table([{ name: 'id', type: 'i32' }, { name: 'title', type: 'string' }]);
  void t; // shape parity only; queryKey is a pure function over the tree.

  const treeAuthorA = { relation: 'authors', sub: { leaf: { field: 'name', op: 'eq' as const, value: 'A' } } };
  const treeAuthorA2 = { relation: 'authors', sub: { leaf: { field: 'name', op: 'eq' as const, value: 'A' } } };
  const treeAuthorB = { relation: 'authors', sub: { leaf: { field: 'name', op: 'eq' as const, value: 'B' } } };
  const treeEditorA = { relation: 'editor', sub: { leaf: { field: 'name', op: 'eq' as const, value: 'A' } } };

  const k = (tree: typeof treeAuthorA) => queryKey('book', { where: tree }, tree);
  assert.equal(k(treeAuthorA), k(treeAuthorA2), 'identical relation filters -> same key');
  assert.notEqual(k(treeAuthorA), k(treeAuthorB), 'different sub value -> different key');
  assert.notEqual(k(treeAuthorA), k(treeEditorA), 'different relation field -> different key');
});

test('relation-filtered responses BYPASS the cache: byte-identical repeats, TARGET-only write reflected', async () => {
  const schemas = [
    schema({ name: 'author', fields: [{ name: 'name', type: 'string' }] }),
    schema({ name: 'book', fields: [{ name: 'title', type: 'string' }], relations: [{ field: 'authors', kind: 'manyToMany', target: 'author' }] }),
  ];
  await setupCatalog(schemas);
  const link = deriveLinkTableName('book', 'authors');
  const aHit = await insertRow('ct_author', 'name', 'hit');
  const b1 = await insertRow('ct_book', 'title', 'b1');
  const b2 = await insertRow('ct_book', 'title', 'b2'); // exists now, ZERO author edges (the future target of the write)
  await insertEdge(link, b1, aHit);

  const registry = Registry.fromSchemas(schemas);
  const engine = await buildEngine(sql, registry, { cursorCodec: new CursorCodec('relfilter-secret') });

  const q = 'filters[authors][name][$eq]=hit';
  const r1 = get(engine, 'book', q);
  const r2 = get(engine, 'book', q);
  assert.ok(r1.body.equals(r2.body), 'two cold-assembled buffers byte-identical for the same relation query');
  assert.deepEqual(idsOf(r1.body), [b1]);

  // DIRECT proof the relation-filtered response was NEVER cached: after two identical relation queries
  // the cache holds zero entries for them (respond() skips get+set on a relation leaf). A scalar query,
  // by contrast, WOULD populate the cache — so a nonzero hit count below would mean the bypass failed.
  assert.equal(engine.cache.hits, 0, 'no cache HIT served a relation-filtered response');
  const sizeAfterRelQueries = engine.cache.size;

  // Add an edge so the EXISTING zero-edge book b2 now matches, then mutate ONLY the TARGET (author) side
  // by rebuilding the AUTHOR type — NOT book. This publishes 'author', which does NOT invalidate any
  // cached 'book' response. If respond() had cached the book relation-filtered body, the stale [b1] would
  // be served and this assertion would FAIL. The bypass is the only thing that makes it pass.
  await insertEdge(link, b2, aHit);
  await rebuildType(sql, engine, registry.get('author')!, registry); // AUTHOR only -> publishes 'author', not 'book'

  const r3 = get(engine, 'book', q);
  assert.deepEqual(
    sortedNums(idsOf(r3.body)),
    sortedNums([b1, b2]),
    'fresh membership after a TARGET-only write — relation response bypassed the (book-keyed) cache',
  );
  assert.equal(engine.cache.hits, 0, 'still no relation-filtered cache hit after the target write');
  // The book cache was never touched by the author rebuild and the relation query never wrote to it.
  assert.equal(engine.cache.size, sizeAfterRelQueries, 'relation-filtered queries added no cache entries');
});

// --- non-relational byte-identity (additive anchor) ---------------------------------------------

test('non-relational filtered+sorted+paginated query is byte-identical with vs without a relation declared', async () => {
  // Engine A: no relation declared.
  const bookCt = schema({ name: 'book', fields: [{ name: 'title', type: 'string' }] });
  const bookOnly = [bookCt];
  await setupCatalog(bookOnly);
  for (let i = 0; i < 6; i++) await insertRow('ct_book', 'title', `t${i}`);
  const engineA = await boot(bookOnly);
  const q = 'filters[title][$ne]=t0&sort=id:desc&pagination[start]=1&pagination[limit]=2';
  const bytesA = get(engineA, 'book', q).body;

  // Engine B: add an author type + a relation on book. Reuse the SAME book schema (stable id) so migrate's
  // diff only ADDS author + the link table — book rows survive, same query, same data.
  const authorCt = schema({ name: 'author', fields: [{ name: 'name', type: 'string' }] });
  const withRel = [{ ...bookCt, relations: [{ id: mintId('rel'), field: 'authors', kind: 'manyToMany' as const, target: 'author' }] }, authorCt];
  await setupCatalog(withRel);
  const engineB = await boot(withRel);
  const bytesB = get(engineB, 'book', q).body;

  assert.ok(bytesA.equals(bytesB), 'a scalar query is byte-identical whether or not a relation is declared');
});

// --- standalone Table throws without a resolver -------------------------------------------------

test('standalone Table.scanTree on a relation leaf throws without a resolver; resolves via the Engine', async () => {
  const t = new Table([{ name: 'id', type: 'i32' }, { name: 'name', type: 'string' }]);
  t.insert({ id: 1, name: 'x' });
  assert.throws(
    () => t.scanTree({ relation: 'authors', sub: { leaf: { field: 'name', op: 'eq', value: 'x' } } }),
    /requires a RelationResolver/,
    'standalone relation leaf throws',
  );

  // The same shape resolves end-to-end through the Engine (covered by the kind tests above) — assert here
  // that a resolver supplied to scanTree is honored.
  const schemas = [
    schema({ name: 'author', fields: [{ name: 'name', type: 'string' }] }),
    schema({ name: 'book', fields: [{ name: 'title', type: 'string' }], relations: [{ field: 'authors', kind: 'manyToMany', target: 'author' }] }),
  ];
  await setupCatalog(schemas);
  const link = deriveLinkTableName('book', 'authors');
  const aHit = await insertRow('ct_author', 'name', 'hit');
  const b1 = await insertRow('ct_book', 'title', 'b1');
  await insertEdge(link, b1, aHit);
  const engine = await boot(schemas);
  const res = get(engine, 'book', 'filters[authors][name][$eq]=hit');
  assert.deepEqual(idsOf(res.body), [b1], 'engine-supplied resolver resolves the leaf');
});
