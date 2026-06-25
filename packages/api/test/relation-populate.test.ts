import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Sql } from 'postgres';
import { Registry } from '../src/db/registry.ts';
import { migrate } from '../src/db/schema/migrate.ts';
import { deriveLinkTableName } from '../src/db/ddl.ts';
import type { Schema } from '../src/db/schema/model.ts';
import { buildEngine } from '../src/db/engine.loader.ts';
import { Engine } from '../src/store/engine.ts';
import { CursorCodec } from '../src/store/cursor.codec.ts';
import { handleRequest } from '../src/http/read.router.ts';
import { createFileDatabase, dropFileDatabase } from './db-per-file.ts';
import { cleanCatalog, ct, rawField } from './helpers.ts';

/**
 * RELATIONS SLICE 5 — POPULATE EXECUTION, end-to-end against a REAL Postgres (no mocks).
 *
 * `?populate=<rel>` nests related rows into the response (Strapi v5 FLAT shape): a to-one relation is
 * a nested OBJECT (or null) directly under the field key, a to-many is an ARRAY (possibly []). The
 * assembled Buffer must JSON.parse to a hand-built nested ORACLE and (for a spot case) be byte-
 * identical to JSON.stringify of that oracle (the frozen related slices are spliced verbatim, never
 * re-stringified). A NON-populated request stays byte-identical to before this slice.
 */

let sql: Sql;
let db: Awaited<ReturnType<typeof createFileDatabase>>;

before(async () => {
  db = await createFileDatabase('relpop');
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
async function applySchemas(schemas: Schema[]): Promise<void> {
  await migrate(sql, schemas, { allowDestructive: true });
}

async function boot(schemas: Schema[]): Promise<Engine> {
  return buildEngine(sql, Registry.fromSchemas(schemas), { cursorCodec: new CursorCodec('relpop-secret') });
}

function get(engine: Engine, path: string, query = ''): { status: number; body: Buffer } {
  const res = handleRequest(engine, { method: 'GET', path, query });
  return { status: res.status, body: res.body };
}

function parsed(body: Buffer): unknown {
  return JSON.parse(body.toString('utf8'));
}

/** The full materialized record of a row from an UNPOPULATED single-item fetch (the frozen scalars). */
function recordOf(engine: Engine, type: string, id: number): Record<string, unknown> {
  const res = get(engine, `/${type}/${id}`);
  assert.equal(res.status, 200, `record fetch ${type}/${id}`);
  return (parsed(res.body) as { data: Record<string, unknown> }).data;
}

// --- 1. to-one OBJECT ---------------------------------------------------------------------------

test('to-one (manyToOne) populate nests a single OBJECT', async () => {
  const schemas = [
    ct({ apiId: 'author', fields: [{ name: 'name', cmsType: 'string' }] }),
    ct({ apiId: 'book', fields: [{ name: 'title', cmsType: 'string' }], relations: [{ field: 'author', kind: 'manyToOne', target: 'author' }] }),
  ];
  await applySchemas(schemas);
  const link = deriveLinkTableName('book', 'author');
  const a1 = await insertRow('ct_author', 'name', 'Le Guin');
  const b1 = await insertRow('ct_book', 'title', 'The Dispossessed');
  await insertEdge(link, b1, a1);

  const engine = await boot(schemas);
  const authorRec = recordOf(engine, 'author', a1);
  const bookRec = recordOf(engine, 'book', b1);

  const res = get(engine, '/book', 'populate=author');
  assert.equal(res.status, 200);
  const oracle = { data: [{ ...bookRec, author: authorRec }], meta: { pagination: { page: 1, pageSize: 1, pageCount: 1, total: 1 } } };
  assert.deepEqual(parsed(res.body), oracle);
  // Byte-identity: the assembled buffer equals JSON.stringify of the hand-built oracle (scalar-only
  // related rows => JSON.stringify is byte-exact). Catches misplaced/extra commas, key reorder, etc.
  assert.ok(res.body.equals(Buffer.from(JSON.stringify(oracle), 'utf8')), 'to-one object byte-identical to oracle');
});

// --- 2. to-one NULL (manyToOne with no edge, and oneToOne with no edge) --------------------------

test('to-one populate with no edge emits null (key present), both manyToOne and oneToOne', async () => {
  const schemas = [
    ct({ apiId: 'author', fields: [{ name: 'name', cmsType: 'string' }] }),
    ct({
      apiId: 'book',
      fields: [{ name: 'title', cmsType: 'string' }],
      relations: [
        { field: 'author', kind: 'manyToOne', target: 'author' },
        { field: 'editor', kind: 'oneToOne', target: 'author' },
      ],
    }),
  ];
  await applySchemas(schemas);
  const b1 = await insertRow('ct_book', 'title', 'Orphan'); // no edges at all

  const engine = await boot(schemas);
  const bookRec = recordOf(engine, 'book', b1);

  const res = get(engine, '/book', 'populate[0]=author&populate[1]=editor');
  assert.equal(res.status, 200);
  const env = parsed(res.body) as { data: Record<string, unknown>[] };
  assert.equal(env.data.length, 1);
  assert.ok('author' in env.data[0]!, 'author key present');
  assert.ok('editor' in env.data[0]!, 'editor key present');
  assert.equal(env.data[0]!.author, null);
  assert.equal(env.data[0]!.editor, null);
  const oracle = { data: [{ ...bookRec, author: null, editor: null }], meta: { pagination: { page: 1, pageSize: 1, pageCount: 1, total: 1 } } };
  assert.deepEqual(parsed(res.body), oracle);
  assert.ok(res.body.equals(Buffer.from(JSON.stringify(oracle), 'utf8')), 'to-one null byte-identical to oracle');
});

// --- 3. to-many ARRAY (oneToMany + manyToMany) --------------------------------------------------

test('to-many populate nests an ARRAY (oneToMany and manyToMany), members in edge-insertion order', async () => {
  const schemas = [
    ct({ apiId: 'tag', fields: [{ name: 'label', cmsType: 'string' }] }),
    ct({ apiId: 'book', fields: [{ name: 'title', cmsType: 'string' }], relations: [{ field: 'tags', kind: 'manyToMany', target: 'tag' }] }),
  ];
  await applySchemas(schemas);
  const linkT = deriveLinkTableName('book', 'tags');
  const t1 = await insertRow('ct_tag', 'label', 'scifi');
  const t2 = await insertRow('ct_tag', 'label', 'classic');
  const b1 = await insertRow('ct_book', 'title', 'Dune');
  // Insert edges in a known order so CSR/insertion order is deterministic: t1 then t2.
  await insertEdge(linkT, b1, t1);
  await insertEdge(linkT, b1, t2);

  const engine = await boot(schemas);
  const bookRec = recordOf(engine, 'book', b1);
  const tag1 = recordOf(engine, 'tag', t1);
  const tag2 = recordOf(engine, 'tag', t2);

  const res = get(engine, '/book', 'populate=tags');
  assert.equal(res.status, 200);
  const m2mOracle = { data: [{ ...bookRec, tags: [tag1, tag2] }], meta: { pagination: { page: 1, pageSize: 1, pageCount: 1, total: 1 } } };
  assert.deepEqual(parsed(res.body), m2mOracle);
  assert.ok(res.body.equals(Buffer.from(JSON.stringify(m2mOracle), 'utf8')), 'to-many array byte-identical to oracle');

  // oneToMany variant: author has many books.
  await cleanCatalog(sql);
  const schemasB = [
    ct({ apiId: 'author', fields: [{ name: 'name', cmsType: 'string' }], relations: [{ field: 'books', kind: 'oneToMany', target: 'book' }] }),
    ct({ apiId: 'book', fields: [{ name: 'title', cmsType: 'string' }] }),
  ];
  await applySchemas(schemasB);
  const linkO = deriveLinkTableName('author', 'books');
  const a1 = await insertRow('ct_author', 'name', 'Herbert');
  const bk1 = await insertRow('ct_book', 'title', 'Dune');
  const bk2 = await insertRow('ct_book', 'title', 'Messiah');
  await insertEdge(linkO, a1, bk1);
  await insertEdge(linkO, a1, bk2);

  const e2 = await boot(schemasB);
  const authorRec = recordOf(e2, 'author', a1);
  const bookRec1 = recordOf(e2, 'book', bk1);
  const bookRec2 = recordOf(e2, 'book', bk2);
  const res2 = get(e2, '/author', 'populate=books');
  assert.deepEqual(parsed(res2.body), { data: [{ ...authorRec, books: [bookRec1, bookRec2] }], meta: { pagination: { page: 1, pageSize: 1, pageCount: 1, total: 1 } } });
});

// --- 4. to-many EMPTY -> [] ----------------------------------------------------------------------

test('to-many populate with zero edges emits []', async () => {
  const schemas = [
    ct({ apiId: 'tag', fields: [{ name: 'label', cmsType: 'string' }] }),
    ct({ apiId: 'book', fields: [{ name: 'title', cmsType: 'string' }], relations: [{ field: 'tags', kind: 'manyToMany', target: 'tag' }] }),
  ];
  await applySchemas(schemas);
  const b1 = await insertRow('ct_book', 'title', 'Untagged');

  const engine = await boot(schemas);
  const bookRec = recordOf(engine, 'book', b1);
  const res = get(engine, '/book', 'populate=tags');
  const env = parsed(res.body) as { data: Record<string, unknown>[] };
  assert.deepEqual(env.data[0]!.tags, []);
  const oracle = { data: [{ ...bookRec, tags: [] }], meta: { pagination: { page: 1, pageSize: 1, pageCount: 1, total: 1 } } };
  assert.deepEqual(parsed(res.body), oracle);
  assert.ok(res.body.equals(Buffer.from(JSON.stringify(oracle), 'utf8')), 'to-many empty [] byte-identical to oracle');
});

// --- 5. two-way via the INVERSE field -----------------------------------------------------------

test('two-way: populate via the inverse field gives an ARRAY (inverse kind); owner field gives an OBJECT', async () => {
  // book.author manyToOne; inverse author.books -> oneToMany (to-many array).
  const schemas = [
    ct({ apiId: 'author', fields: [{ name: 'name', cmsType: 'string' }] }),
    ct({ apiId: 'book', fields: [{ name: 'title', cmsType: 'string' }], relations: [{ field: 'author', kind: 'manyToOne', target: 'author', inverseField: 'books' }] }),
  ];
  await applySchemas(schemas);
  const link = deriveLinkTableName('book', 'author');
  const a1 = await insertRow('ct_author', 'name', 'Asimov');
  const b1 = await insertRow('ct_book', 'title', 'Foundation');
  const b2 = await insertRow('ct_book', 'title', 'Robots');
  await insertEdge(link, b1, a1);
  await insertEdge(link, b2, a1);

  const engine = await boot(schemas);
  const authorRec = recordOf(engine, 'author', a1);
  const bookRec1 = recordOf(engine, 'book', b1);
  const bookRec2 = recordOf(engine, 'book', b2);

  // Owner side: book.author is a to-one OBJECT.
  const ownerRes = get(engine, '/book', 'populate=author&sort=id:asc');
  const ownerOracle = {
    data: [{ ...bookRec1, author: authorRec }, { ...bookRec2, author: authorRec }],
    meta: { pagination: { page: 1, pageSize: 2, pageCount: 1, total: 2 } },
  };
  assert.deepEqual(parsed(ownerRes.body), ownerOracle);
  assert.ok(ownerRes.body.equals(Buffer.from(JSON.stringify(ownerOracle), 'utf8')), 'owner-side two-way byte-identical');

  // Inverse side: author.books is a to-many ARRAY (proves inverseKind gave oneToMany).
  const invRes = get(engine, '/author', 'populate=books');
  const invOracle = { data: [{ ...authorRec, books: [bookRec1, bookRec2] }], meta: { pagination: { page: 1, pageSize: 1, pageCount: 1, total: 1 } } };
  assert.deepEqual(parsed(invRes.body), invOracle);
  assert.ok(invRes.body.equals(Buffer.from(JSON.stringify(invOracle), 'utf8')), 'inverse-side two-way byte-identical');
});

// --- 6. depth-2 nested --------------------------------------------------------------------------

test('depth-2 nested populate: author -> books (array) each book -> author (object)', async () => {
  const schemas = [
    ct({ apiId: 'author', fields: [{ name: 'name', cmsType: 'string' }] }),
    ct({ apiId: 'book', fields: [{ name: 'title', cmsType: 'string' }], relations: [{ field: 'author', kind: 'manyToOne', target: 'author', inverseField: 'books' }] }),
  ];
  await applySchemas(schemas);
  const link = deriveLinkTableName('book', 'author');
  const a1 = await insertRow('ct_author', 'name', 'Tolkien');
  const b1 = await insertRow('ct_book', 'title', 'Hobbit');
  const b2 = await insertRow('ct_book', 'title', 'LOTR');
  await insertEdge(link, b1, a1);
  await insertEdge(link, b2, a1);

  const engine = await boot(schemas);
  const authorRec = recordOf(engine, 'author', a1);
  const bookRec1 = recordOf(engine, 'book', b1);
  const bookRec2 = recordOf(engine, 'book', b2);

  const res = get(engine, '/author', 'populate[books][populate][author]');
  assert.equal(res.status, 200);
  // author.books = [book1 + author, book2 + author]; the nested author is at the depth-2 frontier
  // (its own relations NOT expanded) -> the bare author record.
  const oracle = {
    data: [{ ...authorRec, books: [{ ...bookRec1, author: authorRec }, { ...bookRec2, author: authorRec }] }],
    meta: { pagination: { page: 1, pageSize: 1, pageCount: 1, total: 1 } },
  };
  assert.deepEqual(parsed(res.body), oracle);
  assert.ok(res.body.equals(Buffer.from(JSON.stringify(oracle), 'utf8')), 'depth-2 nested byte-identical to oracle');
});

// --- 7. depth-cap frontier ----------------------------------------------------------------------

test('depth-cap: a 3-hop request stops at the cap; the depth-3 object equals the frozen related slice', async () => {
  const schemas = [
    ct({ apiId: 'author', fields: [{ name: 'name', cmsType: 'string' }] }),
    ct({ apiId: 'book', fields: [{ name: 'title', cmsType: 'string' }], relations: [{ field: 'author', kind: 'manyToOne', target: 'author', inverseField: 'books' }] }),
  ];
  await applySchemas(schemas);
  const link = deriveLinkTableName('book', 'author');
  const a1 = await insertRow('ct_author', 'name', 'Clarke');
  const b1 = await insertRow('ct_book', 'title', '2001');
  await insertEdge(link, b1, a1);

  const engine = await boot(schemas);
  const authorRec = recordOf(engine, 'author', a1);
  const bookRec = recordOf(engine, 'book', b1);

  // book -> author (hop1) -> books (hop2) -> author (hop3, FRONTIER, NOT expanded). depth=1 is the
  // owner's direct relations; hop2 (books) is at depth 2 = the cap; the books members are at depth 3 >
  // cap, so they are the BARE frozen book records (their `author` is NOT expanded).
  const res = get(engine, '/book', 'populate[author][populate][books][populate][author]');
  assert.equal(res.status, 200);
  const oracle = {
    data: [{ ...bookRec, author: { ...authorRec, books: [bookRec] } }],
    meta: { pagination: { page: 1, pageSize: 1, pageCount: 1, total: 1 } },
  };
  assert.deepEqual(parsed(res.body), oracle);
  // The deepest book object (the frontier) carries NO nested relation key beyond its scalars.
  const deepest = (((parsed(res.body) as { data: { author: { books: Record<string, unknown>[] } }[] }).data[0]!).author).books[0]!;
  assert.deepEqual(Object.keys(deepest).sort(), Object.keys(bookRec).sort(), 'frontier book has only scalar keys');
  // Verbatim splice at the frontier: the frontier book's RAW bytes equal its standalone frozen slice
  // (not merely the same key-set). Extract the `books` array (the single frontier member) and compare
  // to the book's respondById inner slice (`{"data":<slice>,"meta":{}}`).
  const booksRaw = rawField(res.body, 'books'); // `[<frontier book>]`
  assert.equal(booksRaw[0], '[');
  assert.equal(booksRaw[booksRaw.length - 1], ']');
  const frontierBytes = booksRaw.slice(1, booksRaw.length - 1); // the single member's verbatim bytes
  const bookSingle = get(engine, `/book/${b1}`).body.toString('utf8');
  const bookInner = bookSingle.slice('{"data":'.length, bookSingle.length - ',"meta":{}}'.length);
  assert.equal(frontierBytes, bookInner, 'frontier book spliced verbatim (bytes equal the frozen slice)');
});

// --- 8. self-referential terminate --------------------------------------------------------------

test('self-referential populate terminates by the depth cap (no throw, no hang)', async () => {
  const schemas = [
    ct({ apiId: 'category', fields: [{ name: 'slug', cmsType: 'string' }], relations: [{ field: 'parent', kind: 'manyToOne', target: 'category' }] }),
  ];
  await applySchemas(schemas);
  const link = deriveLinkTableName('category', 'parent');
  const root = await insertRow('ct_category', 'slug', 'root');
  const mid = await insertRow('ct_category', 'slug', 'mid');
  const leaf = await insertRow('ct_category', 'slug', 'leaf');
  await insertEdge(link, mid, root);
  await insertEdge(link, leaf, mid);

  const engine = await boot(schemas);
  const rootRec = recordOf(engine, 'category', root);
  const midRec = recordOf(engine, 'category', mid);

  // Request a 3-deep parent chain on leaf; the cap stops at depth 2 (the 2nd parent is the frontier).
  const res = get(engine, '/category', 'filters[slug][$eq]=leaf&populate[parent][populate][parent][populate][parent]');
  assert.equal(res.status, 200);
  // leaf -> parent mid -> parent root(frontier, bare). The 3rd `parent` hop is dropped at the cap.
  const env = parsed(res.body) as { data: { parent: { parent: Record<string, unknown> } }[] };
  assert.equal(env.data.length, 1);
  assert.deepEqual((env.data[0]!).parent.parent, rootRec, 'depth-2 root is the bare record (frontier)');
  void midRec;
});

// --- 9. 2-type cycle terminate ------------------------------------------------------------------

test('2-type cycle A->B->A populate is finite (innermost at the frontier)', async () => {
  const schemas = [
    ct({ apiId: 'author', fields: [{ name: 'name', cmsType: 'string' }] }),
    ct({ apiId: 'book', fields: [{ name: 'title', cmsType: 'string' }], relations: [{ field: 'author', kind: 'manyToOne', target: 'author', inverseField: 'books' }] }),
  ];
  await applySchemas(schemas);
  const link = deriveLinkTableName('book', 'author');
  const a1 = await insertRow('ct_author', 'name', 'Cyclic');
  const b1 = await insertRow('ct_book', 'title', 'Loop');
  await insertEdge(link, b1, a1);

  const engine = await boot(schemas);
  const authorRec = recordOf(engine, 'author', a1);
  const bookRec = recordOf(engine, 'book', b1);

  // book -> author -> books (hop2). hop3 (each book's author) is the frontier and dropped.
  const res = get(engine, '/book', 'populate[author][populate][books]');
  assert.equal(res.status, 200);
  const oracle = {
    data: [{ ...bookRec, author: { ...authorRec, books: [bookRec] } }],
    meta: { pagination: { page: 1, pageSize: 1, pageCount: 1, total: 1 } },
  };
  assert.deepEqual(parsed(res.body), oracle);
});

// --- 10. populate=* -----------------------------------------------------------------------------

test('populate=* expands all declared relations (depth-1); equals explicit naming; relation-less type unchanged + cached', async () => {
  const schemas = [
    ct({ apiId: 'author', fields: [{ name: 'name', cmsType: 'string' }] }),
    ct({ apiId: 'tag', fields: [{ name: 'label', cmsType: 'string' }] }),
    ct({
      apiId: 'book',
      fields: [{ name: 'title', cmsType: 'string' }],
      relations: [
        { field: 'author', kind: 'manyToOne', target: 'author' },
        { field: 'tags', kind: 'manyToMany', target: 'tag' },
      ],
    }),
  ];
  await applySchemas(schemas);
  const linkA = deriveLinkTableName('book', 'author');
  const linkT = deriveLinkTableName('book', 'tags');
  const a1 = await insertRow('ct_author', 'name', 'X');
  const t1 = await insertRow('ct_tag', 'label', 'y');
  const b1 = await insertRow('ct_book', 'title', 'Z');
  await insertEdge(linkA, b1, a1);
  await insertEdge(linkT, b1, t1);

  const engine = await boot(schemas);
  const star = get(engine, '/book', 'populate=*');
  const explicit = get(engine, '/book', 'populate[0]=author&populate[1]=tags');
  assert.equal(star.status, 200);
  assert.deepEqual(parsed(star.body), parsed(explicit.body), 'populate=* equals naming all relations');

  // Relation-less type: populate=* yields an empty effective plan -> byte-identical to no-populate AND cached.
  await cleanCatalog(sql);
  const schemasB = [ct({ apiId: 'note', fields: [{ name: 'text', cmsType: 'string' }] })];
  await applySchemas(schemasB);
  await insertRow('ct_note', 'text', 'hi');
  const e2 = await boot(schemasB);
  const noPop = get(e2, '/note', '');
  const starPop = get(e2, '/note', 'populate=*');
  assert.ok(noPop.body.equals(starPop.body), 'populate=* on a relation-less type is byte-identical to no-populate');
  const hitsBefore = e2.cache.hits;
  get(e2, '/note', 'populate=*'); // second call: must be a cache HIT (empty effective plan IS cached)
  assert.ok(e2.cache.hits > hitsBefore, 'relation-less populate=* response is cached (hit on repeat)');
});

// --- 11. unknown populate -> 400 ----------------------------------------------------------------

test('unknown populate name -> 400 (top-level, nested, and a scalar field name)', async () => {
  const schemas = [
    ct({ apiId: 'author', fields: [{ name: 'name', cmsType: 'string' }] }),
    ct({ apiId: 'book', fields: [{ name: 'title', cmsType: 'string' }], relations: [{ field: 'author', kind: 'manyToOne', target: 'author' }] }),
  ];
  await applySchemas(schemas);
  await insertRow('ct_author', 'name', 'a');
  await insertRow('ct_book', 'title', 'b');

  const engine = await boot(schemas);
  assert.equal(get(engine, '/book', 'populate=bogus').status, 400, 'unknown top-level relation');
  assert.equal(get(engine, '/book', 'populate[author][populate][bogus]').status, 400, 'unknown nested relation');
  assert.equal(get(engine, '/book', 'populate=title').status, 400, 'scalar field name in populate');
});

// --- 12. populate + relation filter + sort + offset ---------------------------------------------

test('populate composed with a relation filter + sort + offset: owner page/meta unchanged, related set FULL', async () => {
  const schemas = [
    ct({ apiId: 'author', fields: [{ name: 'name', cmsType: 'string' }] }),
    ct({ apiId: 'book', fields: [{ name: 'title', cmsType: 'string' }], relations: [{ field: 'author', kind: 'manyToOne', target: 'author' }] }),
  ];
  await applySchemas(schemas);
  const link = deriveLinkTableName('book', 'author');
  const aHit = await insertRow('ct_author', 'name', 'hit');
  const ids: number[] = [];
  for (let i = 0; i < 5; i++) {
    const b = await insertRow('ct_book', 'title', `b${i}`);
    await insertEdge(link, b, aHit);
    ids.push(b);
  }
  await insertRow('ct_book', 'title', 'nomatch'); // no edge

  const engine = await boot(schemas);
  const baseQ = 'filters[author][name][$eq]=hit&sort=id:desc&pagination[start]=1&pagination[limit]=2';
  const withoutPop = get(engine, '/book', baseQ);
  const withPop = get(engine, '/book', baseQ + '&populate=author');
  assert.equal(withPop.status, 200);

  const envNo = parsed(withoutPop.body) as { data: { id: number }[]; meta: unknown };
  const envPop = parsed(withPop.body) as { data: { id: number; author: Record<string, unknown> }[]; meta: unknown };
  // Owner set/order identical.
  assert.deepEqual(envPop.data.map((d) => d.id), envNo.data.map((d) => d.id), 'owner page order identical');
  // meta bytes identical: extract the meta object's raw bytes from both responses.
  assert.equal(rawField(withPop.body, 'meta'), rawField(withoutPop.body, 'meta'), 'meta unchanged by populate');
  // Each owner's populated author is the FULL related set (here a single to-one object, the matching author).
  const authorRec = recordOf(engine, 'author', aHit);
  for (const row of envPop.data) assert.deepEqual(row.author, authorRec, 'related set is full, not filtered');
});

// --- 13. populate + keyset pagination -----------------------------------------------------------

test('populate composed with owner-level keyset pagination: nested data correct, order = keyset order', async () => {
  const schemas = [
    ct({ apiId: 'author', fields: [{ name: 'name', cmsType: 'string' }] }),
    ct({ apiId: 'book', fields: [{ name: 'title', cmsType: 'string' }], relations: [{ field: 'author', kind: 'manyToOne', target: 'author' }] }),
  ];
  await applySchemas(schemas);
  const link = deriveLinkTableName('book', 'author');
  const a1 = await insertRow('ct_author', 'name', 'auth');
  const ids: number[] = [];
  for (let i = 0; i < 5; i++) {
    const b = await insertRow('ct_book', 'title', `b${i}`);
    await insertEdge(link, b, a1);
    ids.push(b);
  }

  const engine = await boot(schemas);
  const authorRec = recordOf(engine, 'author', a1);

  const collected: number[] = [];
  let cursor = '';
  for (let guard = 0; guard < 10; guard++) {
    const q = `sort=id:asc&populate=author&pagination[cursor]=${encodeURIComponent(cursor)}&pagination[pageSize]=2`;
    const res = get(engine, '/book', q);
    assert.equal(res.status, 200, `keyset page ${guard}`);
    const env = parsed(res.body) as { data: { id: number; author: Record<string, unknown> }[]; meta: { pagination: { nextCursor: string | null; hasNextPage: boolean } } };
    for (const d of env.data) {
      collected.push(d.id);
      assert.deepEqual(d.author, authorRec, 'each keyset row carries its populated author');
    }
    if (!env.meta.pagination.hasNextPage || env.meta.pagination.nextCursor === null) break;
    cursor = env.meta.pagination.nextCursor;
  }
  assert.deepEqual(collected, [...ids].sort((a, b) => a - b), 'keyset pages union to all owners in order');
});

// --- 14. i64/decimal/json related scalar byte-exact ---------------------------------------------

test('i64/decimal/json in a related row survive byte-exact through populate (spliced verbatim)', async () => {
  const schemas = [
    ct({
      apiId: 'metric',
      fields: [
        { name: 'big', cmsType: 'biginteger' },
        { name: 'amount', cmsType: 'decimal', options: { precision: 18, scale: 4 } },
        { name: 'blob', cmsType: 'json' },
      ],
    }),
    ct({ apiId: 'book', fields: [{ name: 'title', cmsType: 'string' }], relations: [{ field: 'metric', kind: 'manyToOne', target: 'metric' }] }),
  ];
  await applySchemas(schemas);
  const link = deriveLinkTableName('book', 'metric');

  // A bigint beyond 2^53 + a json object with key order + a fractional decimal.
  const bigVal = '9223372036854775123';
  const jsonVal = '{"z":1,"a":[10000000000000001,2],"n":null}';
  const [m] = await sql.unsafe<{ id: number }[]>(
    `INSERT INTO ct_metric (big, amount, blob) VALUES ($1, $2, $3::jsonb) RETURNING id`,
    [bigVal, '12345.6789', jsonVal],
  );
  const mId = m!.id;
  const b1 = await insertRow('ct_book', 'title', 'withMetric');
  await insertEdge(link, b1, mId);

  const engine = await boot(schemas);
  const bookRec = recordOf(engine, 'book', b1);
  // The related metric's STANDALONE single-item slice (the frozen bytes that must be spliced verbatim).
  const metricSingle = get(engine, `/metric/${mId}`).body.toString('utf8');
  const metricInner = metricSingle.slice('{"data":'.length, metricSingle.length - ',"meta":{}}'.length);

  const res = get(engine, '/book', 'populate=metric');
  assert.equal(res.status, 200);
  const bodyStr = res.body.toString('utf8');
  // The spliced related bytes equal the standalone metric slice (verbatim, no parse/re-stringify).
  assert.equal(rawField(bodyStr, 'metric'), metricInner, 'related metric bytes spliced verbatim');

  // BYTE-IDENTITY against a hand-built oracle: build the metric object from its verbatim slice via
  // string assembly (NOT JSON.parse — that would lose the i64/json precision).
  const oracleStr = '{"data":[' + serializeBook(bookRec, metricInner) + '],"meta":{"pagination":{"page":1,"pageSize":1,"pageCount":1,"total":1}}}';
  assert.ok(res.body.equals(Buffer.from(oracleStr, 'utf8')), 'populated response byte-identical to hand-built oracle');

  // Confirm the i64/decimal/json values survived. i64 + decimal materialize as STRINGS (the
  // interoperable wire form); the json field round-trips as its verbatim text (a JSON-encoded string in
  // this engine's serialization). The byte-exact assertion above already proved the splice is verbatim;
  // here we just confirm the high-value scalars came through.
  const env = parsed(res.body) as { data: { metric: { big: string; amount: string; blob: string } }[] };
  assert.equal(env.data[0]!.metric.big, bigVal, 'i64 beyond 2^53 preserved as a string');
  assert.equal(env.data[0]!.metric.amount, '12345.6789', 'decimal preserved as a string');
  // The blob's verbatim json text still carries the >2^53 integer unmangled (byte-exact, not Number()).
  assert.ok(env.data[0]!.metric.blob.includes('10000000000000001'), 'json >2^53 integer survives byte-exact in the related slice');
});

/** Hand-assemble a book object frame `{...,"metric":<rawSlice>}` byte-for-byte (book scalars via the
 *  type-free JSON.stringify since the book has only a string field + system fields). */
function serializeBook(bookRec: Record<string, unknown>, metricRawSlice: string): string {
  const base = JSON.stringify(bookRec); // book has no i64/decimal/json -> JSON.stringify is byte-exact.
  return base.slice(0, base.length - 1) + ',"metric":' + metricRawSlice + '}';
}

// --- 15. respondById populate -------------------------------------------------------------------

test('respondById honors populate; self-referential single-item terminates and matches the list frame', async () => {
  const schemas = [
    ct({ apiId: 'author', fields: [{ name: 'name', cmsType: 'string' }] }),
    ct({ apiId: 'book', fields: [{ name: 'title', cmsType: 'string' }], relations: [{ field: 'author', kind: 'manyToOne', target: 'author' }] }),
    ct({ apiId: 'category', fields: [{ name: 'slug', cmsType: 'string' }], relations: [{ field: 'parent', kind: 'manyToOne', target: 'category' }] }),
  ];
  await applySchemas(schemas);
  const linkBA = deriveLinkTableName('book', 'author');
  const a1 = await insertRow('ct_author', 'name', 'Solo');
  const b1 = await insertRow('ct_book', 'title', 'OneBook');
  await insertEdge(linkBA, b1, a1);

  const linkCP = deriveLinkTableName('category', 'parent');
  const root = await insertRow('ct_category', 'slug', 'root');
  const child = await insertRow('ct_category', 'slug', 'child');
  await insertEdge(linkCP, child, root);

  const engine = await boot(schemas);
  const authorRec = recordOf(engine, 'author', a1);
  const bookRec = recordOf(engine, 'book', b1);

  const single = get(engine, `/book/${b1}`, 'populate=author');
  assert.equal(single.status, 200);
  assert.deepEqual(parsed(single.body), { data: { ...bookRec, author: authorRec }, meta: {} });

  // Self-referential via respondById: must terminate. child -> parent root (object).
  const rootRec = recordOf(engine, 'category', root);
  const childRec = recordOf(engine, 'category', child);
  const childSingle = get(engine, `/category/${child}`, 'populate[parent][populate][parent]');
  assert.equal(childSingle.status, 200);
  // child -> parent root -> parent (none, root has no parent) = null.
  assert.deepEqual(parsed(childSingle.body), { data: { ...childRec, parent: { ...rootRec, parent: null } }, meta: {} });

  // The single-item framing of the book equals the list framing for the same owner row.
  const list = get(engine, `/book?filters[title][$eq]=OneBook`.split('?')[0]!, 'filters[title][$eq]=OneBook&populate=author');
  const listEnv = parsed(list.body) as { data: Record<string, unknown>[] };
  assert.deepEqual(listEnv.data[0], { ...bookRec, author: authorRec }, 'list frame matches single frame for the same row');

  // unknown populate on the single-item path -> 400.
  assert.equal(get(engine, `/book/${b1}`, 'populate=bogus').status, 400, 'single-item unknown populate -> 400');
});

// --- 16. non-populated byte-identical (the frozen fast path) ------------------------------------

test('a NON-populated request is byte-identical to before this slice and is cached', async () => {
  const schemas = [
    ct({ apiId: 'author', fields: [{ name: 'name', cmsType: 'string' }] }),
    ct({ apiId: 'book', fields: [{ name: 'title', cmsType: 'string' }], relations: [{ field: 'author', kind: 'manyToOne', target: 'author' }] }),
  ];
  await applySchemas(schemas);
  for (let i = 0; i < 4; i++) await insertRow('ct_book', 'title', `t${i}`);

  const engine = await boot(schemas);
  const q = 'sort=id:desc&pagination[start]=1&pagination[limit]=2';
  const first = get(engine, '/book', q);
  assert.equal(first.status, 200);
  // Hand-built oracle from the frozen single-item records (descending, slice [1,3)).
  const recs = [];
  for (let i = 1; i <= 4; i++) recs.push(recordOf(engine, 'book', i));
  const desc = [...recs].sort((a, b) => (b.id as number) - (a.id as number));
  const page = desc.slice(1, 3);
  // paginationMeta(total=4, offset=1, limit=2): page = floor(1/2)+1 = 1, pageCount = ceil(4/2) = 2.
  const oracle = { data: page, meta: { pagination: { page: 1, pageSize: 2, pageCount: 2, total: 4 } } };
  assert.ok(first.body.equals(Buffer.from(JSON.stringify(oracle), 'utf8')), 'non-populated body byte-identical to oracle');

  const hitsBefore = engine.cache.hits;
  const second = get(engine, '/book', q);
  assert.ok(second.body.equals(first.body), 'second identical call byte-identical');
  assert.ok(engine.cache.hits > hitsBefore, 'non-populated response is cached (hit on repeat)');
});

// --- 17. populate= empty ------------------------------------------------------------------------

test('populate= (empty) is byte-identical to no-populate and cached', async () => {
  const schemas = [
    ct({ apiId: 'author', fields: [{ name: 'name', cmsType: 'string' }] }),
    ct({ apiId: 'book', fields: [{ name: 'title', cmsType: 'string' }], relations: [{ field: 'author', kind: 'manyToOne', target: 'author' }] }),
  ];
  await applySchemas(schemas);
  await insertRow('ct_book', 'title', 'x');

  const engine = await boot(schemas);
  const noPop = get(engine, '/book', '');
  const emptyPop = get(engine, '/book', 'populate=');
  const commaPop = get(engine, '/book', 'populate=,');
  assert.ok(emptyPop.body.equals(noPop.body), 'populate= byte-identical to no-populate');
  assert.ok(commaPop.body.equals(noPop.body), 'populate=, byte-identical to no-populate');
  const hitsBefore = engine.cache.hits;
  get(engine, '/book', 'populate=');
  assert.ok(engine.cache.hits > hitsBefore, 'empty populate response is cached');
});

// --- 18. a NON-EMPTY populated response is NOT cached -------------------------------------------

test('a non-empty populated response is NOT cached (no cache hit on identical repeat)', async () => {
  const schemas = [
    ct({ apiId: 'author', fields: [{ name: 'name', cmsType: 'string' }] }),
    ct({ apiId: 'book', fields: [{ name: 'title', cmsType: 'string' }], relations: [{ field: 'author', kind: 'manyToOne', target: 'author' }] }),
  ];
  await applySchemas(schemas);
  const link = deriveLinkTableName('book', 'author');
  const a1 = await insertRow('ct_author', 'name', 'Stale');
  const b1 = await insertRow('ct_book', 'title', 'Book');
  await insertEdge(link, b1, a1);

  const engine = await boot(schemas);
  const first = get(engine, '/book', 'populate=author');
  assert.equal(first.status, 200);
  // Slice 5 cache-correctness invariant: a populated response depends on the TARGET type's bytes that
  // single-type invalidation cannot cover, so it MUST skip get+set (else it serves stale after a related
  // write). A second identical populated GET must register NO cache hit.
  const hitsBefore = engine.cache.hits;
  const second = get(engine, '/book', 'populate=author');
  assert.equal(engine.cache.hits, hitsBefore, 'populated response not served from cache (no hit)');
  assert.ok(second.body.equals(first.body), 'uncached re-assembly is still byte-identical');
});

// --- 19. fail-soft to-one with >1 edge ----------------------------------------------------------

test('to-one with >1 edge fail-softly emits the FIRST related object (not an array, no 500)', async () => {
  // manyToOne link table enforces UNIQUE(owner_id); a second edge for the SAME owner is rejected by the DB,
  // so the fail-soft to-one branch is dead-defensive. We still probe a second edge to document the intent.
  const schemas = [
    ct({ apiId: 'author', fields: [{ name: 'name', cmsType: 'string' }] }),
    ct({ apiId: 'book', fields: [{ name: 'title', cmsType: 'string' }], relations: [{ field: 'author', kind: 'manyToOne', target: 'author' }] }),
  ];
  await applySchemas(schemas);
  const link = deriveLinkTableName('book', 'author');
  const a1 = await insertRow('ct_author', 'name', 'First');
  const a2 = await insertRow('ct_author', 'name', 'Second');
  const b1 = await insertRow('ct_book', 'title', 'Multi');
  await insertEdge(link, b1, a1);
  // A second edge for the SAME owner violates the to-one contract; the link table for manyToOne has
  // UNIQUE(owner_id), so this INSERT is expected to FAIL — if it does, the constraint is the guarantee
  // and the fail-soft branch is unreachable (documented dead-defensive). Probe it:
  let secondEdgeRejected = false;
  try {
    await insertEdge(link, b1, a2);
  } catch {
    secondEdgeRejected = true;
  }

  const engine = await boot(schemas);
  const a1Rec = recordOf(engine, 'author', a1);
  const res = get(engine, '/book', 'populate=author');
  assert.equal(res.status, 200, 'no 500 on a to-one populate');
  const env = parsed(res.body) as { data: { author: unknown }[] };
  // Whether or not the DB accepted a second edge, the to-one MUST emit a single OBJECT (the first
  // related), never an array, never a throw.
  assert.ok(env.data[0]!.author !== null, 'author present');
  assert.ok(!Array.isArray(env.data[0]!.author), 'to-one is a single object, not an array');
  assert.deepEqual(env.data[0]!.author, a1Rec, 'to-one emits the first related object deterministically');
  void secondEdgeRejected;
});

// --- 20. inverse polarity: oneToMany owner => inverse is a to-one OBJECT; manyToMany inverse array

test('inverse cardinality flips: oneToMany owner -> inverse field is a to-one OBJECT/null; manyToMany inverse stays an ARRAY', async () => {
  // OWNER declares author.books = oneToMany; inverse book.author = manyToOne (to-one OBJECT via inverse).
  const schemas = [
    ct({ apiId: 'author', fields: [{ name: 'name', cmsType: 'string' }], relations: [{ field: 'books', kind: 'oneToMany', target: 'book', inverseField: 'author' }] }),
    ct({ apiId: 'book', fields: [{ name: 'title', cmsType: 'string' }] }),
  ];
  await applySchemas(schemas);
  const link = deriveLinkTableName('author', 'books');
  const a1 = await insertRow('ct_author', 'name', 'Owner');
  const b1 = await insertRow('ct_book', 'title', 'B1');
  const b2 = await insertRow('ct_book', 'title', 'B2');
  const b3 = await insertRow('ct_book', 'title', 'Orphan'); // no author edge
  await insertEdge(link, a1, b1);
  await insertEdge(link, a1, b2);

  const engine = await boot(schemas);
  const authorRec = recordOf(engine, 'author', a1);
  const bookRec1 = recordOf(engine, 'book', b1);
  const bookRec2 = recordOf(engine, 'book', b2);
  const bookRec3 = recordOf(engine, 'book', b3);

  // Owner side author.books -> ARRAY.
  const owner = get(engine, '/author', 'populate=books');
  assert.deepEqual(parsed(owner.body), { data: [{ ...authorRec, books: [bookRec1, bookRec2] }], meta: { pagination: { page: 1, pageSize: 1, pageCount: 1, total: 1 } } });

  // Inverse side book.author -> to-one OBJECT (proves inverseKind('oneToMany')='manyToOne'); orphan -> null.
  const inv = get(engine, '/book', 'populate=author&sort=id:asc');
  const invEnv = parsed(inv.body) as { data: Record<string, unknown>[] };
  assert.deepEqual(invEnv.data[0], { ...bookRec1, author: authorRec }, 'inverse to-one is an OBJECT');
  assert.ok(!Array.isArray(invEnv.data[0]!.author), 'inverse to-one not an array');
  assert.deepEqual(invEnv.data[2], { ...bookRec3, author: null }, 'inverse to-one with no edge is null');

  // manyToMany two-way: inverse stays a to-many ARRAY on both sides.
  await cleanCatalog(sql);
  const schemasB = [
    ct({ apiId: 'tag', fields: [{ name: 'label', cmsType: 'string' }] }),
    ct({ apiId: 'post', fields: [{ name: 'title', cmsType: 'string' }], relations: [{ field: 'tags', kind: 'manyToMany', target: 'tag', inverseField: 'posts' }] }),
  ];
  await applySchemas(schemasB);
  const linkM = deriveLinkTableName('post', 'tags');
  const p1 = await insertRow('ct_post', 'title', 'P1');
  const tg1 = await insertRow('ct_tag', 'label', 'T1');
  await insertEdge(linkM, p1, tg1);

  const e2 = await boot(schemasB);
  const postRec = recordOf(e2, 'post', p1);
  const tagRec = recordOf(e2, 'tag', tg1);
  const fwd = get(e2, '/post', 'populate=tags');
  const back = get(e2, '/tag', 'populate=posts');
  assert.deepEqual((parsed(fwd.body) as { data: Record<string, unknown>[] }).data[0]!.tags, [tagRec], 'm2m owner side is an array');
  assert.deepEqual((parsed(back.body) as { data: Record<string, unknown>[] }).data[0]!.posts, [postRec], 'm2m inverse side is also an array');
});

// --- 21. duplicate populate names de-dupe + merge children -------------------------------------

test('duplicate populate names de-dupe to a single key, merging sub-plans', async () => {
  const schemas = [
    ct({ apiId: 'author', fields: [{ name: 'name', cmsType: 'string' }] }),
    ct({ apiId: 'book', fields: [{ name: 'title', cmsType: 'string' }], relations: [{ field: 'author', kind: 'manyToOne', target: 'author', inverseField: 'books' }] }),
  ];
  await applySchemas(schemas);
  const link = deriveLinkTableName('book', 'author');
  const a1 = await insertRow('ct_author', 'name', 'Dup');
  const b1 = await insertRow('ct_book', 'title', 'Single');
  await insertEdge(link, b1, a1);

  const engine = await boot(schemas);
  // populate=author,author -> ONE author key, de-duped (still a single object, not nested twice).
  const dup = get(engine, '/book', 'populate=author,author');
  assert.equal(dup.status, 200);
  const single = get(engine, '/book', 'populate=author');
  assert.deepEqual(parsed(dup.body), parsed(single.body), 'populate=author,author equals single author');
  // Exactly one author key in the emitted bytes (a duplicate would appear as `"author":...,"author":...`).
  const occurrences = dup.body.toString('utf8').split('"author":').length - 1;
  assert.equal(occurrences, 1, 'de-dupe emits the author key exactly once');

  // De-dupe via the `*` wildcard overlapping an explicit name: populate[0]=* expands to {author} and
  // populate[1]=author repeats it; resolvePopulate's byField merge collapses them to a single key.
  const starDup = get(engine, '/book', 'populate[0]=*&populate[1]=author');
  assert.equal(starDup.status, 200);
  assert.deepEqual(parsed(starDup.body), parsed(single.body), 'wildcard+explicit overlap de-dupes to one author');
  assert.equal(starDup.body.toString('utf8').split('"author":').length - 1, 1, 'overlap emits author once');
});

// --- 22. over-deep populate query key -> 400 (no RangeError/500) -------------------------------

test('pathologically deep populate nesting -> clean 400 (not a stack-overflow 500)', async () => {
  const schemas = [
    ct({ apiId: 'category', fields: [{ name: 'slug', cmsType: 'string' }], relations: [{ field: 'parent', kind: 'manyToOne', target: 'category' }] }),
  ];
  await applySchemas(schemas);
  await insertRow('ct_category', 'slug', 'root');

  const engine = await boot(schemas);
  // Build a deeply nested populate query key: populate[parent][populate][parent][populate]...[parent].
  let key = 'populate';
  for (let i = 0; i < 2000; i++) key += '[parent][populate]';
  key += '[parent]';
  const res = get(engine, '/category', key);
  assert.equal(res.status, 400, 'over-deep populate nesting is a clean 400, not a 500');
});
