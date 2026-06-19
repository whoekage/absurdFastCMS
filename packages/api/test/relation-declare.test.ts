import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Sql } from 'postgres';
import {
  createContentType,
  addRelation,
  dropContentType,
  getContentType,
  getRelations,
} from '../src/db/content-type.repository.ts';
import { Registry } from '../src/store/registry.ts';
import { createFileDatabase, dropFileDatabase } from './db-per-file.ts';
import { cleanCatalog, tableExists, physicalColumns } from './helpers.ts';
import {
  ContentTypeNotFoundError,
  FieldExistsError,
  DependentTypesError,
  DuplicateFieldError,
  ReservedTableNameError,
  InvalidIdentifierError,
  UnknownRelationKindError,
} from '../src/db/ddl.ts';

/**
 * RELATIONS SLICE 2 — declaration + content_type_relations meta + the uniform LINK-TABLE runtime DDL +
 * the drop guard, end-to-end against a REAL Postgres (no mocks). The ct_<apiId> arena is NEVER touched.
 * Introspects information_schema + pg_catalog (pg_constraint.contype/confdeltype, pg_index) to prove the
 * physical link table + per-kind UNIQUE + ON DELETE CASCADE FKs EXACTLY match the locked design. Maps to
 * the blueprint R1..R21.
 */

let sql: Sql;
let db: Awaited<ReturnType<typeof createFileDatabase>>;

before(async () => {
  db = await createFileDatabase('rel');
  sql = db.sql;
});

beforeEach(async () => {
  await cleanCatalog(sql);
});

after(async () => {
  if (sql) await sql.end();
  if (db) await dropFileDatabase(db.name);
});

// --- pg_catalog introspection helpers (scoped to this file) ------------------------------------

/** The column NAME sets of every UNIQUE constraint on a table (contype='u'), each sorted. */
async function uniqueConstraints(table: string): Promise<string[][]> {
  const rows = await sql<{ cols: string[] }[]>`
    SELECT array_agg(a.attname ORDER BY k.ord) AS cols
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
    WHERE t.relname = ${table} AND c.contype = 'u'
    GROUP BY c.oid
  `;
  return rows.map((r) => [...r.cols].sort());
}

/** FK rows: the local column, the referenced table, and confdeltype ('c' = ON DELETE CASCADE). */
async function foreignKeys(table: string): Promise<{ col: string; refTable: string; delType: string }[]> {
  const rows = await sql<{ col: string; ref_table: string; del_type: string }[]>`
    SELECT a.attname AS col, rt.relname AS ref_table, c.confdeltype AS del_type
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_class rt ON rt.oid = c.confrelid
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = c.conkey[1]
    WHERE t.relname = ${table} AND c.contype = 'f'
    ORDER BY a.attname
  `;
  return rows.map((r) => ({ col: r.col, refTable: r.ref_table, delType: r.del_type }));
}

const KINDS = ['oneToOne', 'oneToMany', 'manyToOne', 'manyToMany'] as const;
const INVERSE: Record<string, string> = { oneToOne: 'oneToOne', oneToMany: 'manyToOne', manyToOne: 'oneToMany', manyToMany: 'manyToMany' };
/** The expected per-kind UNIQUE column-sets (sorted), matching compileCreateLinkTable. */
const UNIQUE_FOR: Record<string, string[][]> = {
  manyToMany: [['owner_id', 'related_id']],
  oneToMany: [['related_id']],
  manyToOne: [['owner_id']],
  oneToOne: [['owner_id'], ['related_id']],
};

async function makePair(): Promise<void> {
  await createContentType(sql, { apiId: 'author', fields: [{ name: 'name', cmsType: 'string' }] });
  await createContentType(sql, { apiId: 'book', fields: [{ name: 'title', cmsType: 'string' }] });
}

// --- R1..R8: the 4 kinds x {one-way, two-way} --------------------------------------------------

for (const kind of KINDS) {
  test(`R the ${kind} one-way relation builds the link table + correct UNIQUE + CASCADE FKs + 1 meta row`, async () => {
    await makePair();
    const ownerCtBefore = await physicalColumns(sql, 'ct_book');
    const row = await addRelation(sql, 'book', { field: 'authors', kind, target: 'author' });
    const link = row.link_table;
    assert.equal(link, 'book_authors_lnk');

    // link table shape
    assert.ok(await tableExists(sql, link));
    const cols = await physicalColumns(sql, link);
    assert.deepEqual(cols.map((c) => c.name), ['id', 'owner_id', 'related_id', 'ord']);

    // per-kind UNIQUE
    const uqs = (await uniqueConstraints(link)).sort((a, b) => a.join().localeCompare(b.join()));
    assert.deepEqual(uqs, [...UNIQUE_FOR[kind]!].sort((a, b) => a.join().localeCompare(b.join())));

    // FKs: both ON DELETE CASCADE to the right ct_ tables
    const fks = await foreignKeys(link);
    const ownerFk = fks.find((f) => f.col === 'owner_id')!;
    const relatedFk = fks.find((f) => f.col === 'related_id')!;
    assert.equal(ownerFk.refTable, 'ct_book');
    assert.equal(ownerFk.delType, 'c');
    assert.equal(relatedFk.refTable, 'ct_author');
    assert.equal(relatedFk.delType, 'c');

    // meta: exactly ONE owner row, no inverse
    const book = await getContentType(sql, 'book');
    const author = await getContentType(sql, 'author');
    const bookRels = await getRelations(sql, book!.id);
    const authorRels = await getRelations(sql, author!.id);
    assert.equal(bookRels.length, 1);
    assert.equal(bookRels[0]!.is_owner, true);
    assert.equal(bookRels[0]!.inverse_field, null);
    assert.equal(bookRels[0]!.kind, kind);
    assert.equal(bookRels[0]!.target_api_id, 'author');
    assert.equal(authorRels.length, 0);

    // ct_book arena untouched (no relation column ever)
    assert.deepEqual(await physicalColumns(sql, 'ct_book'), ownerCtBefore);
  });

  test(`R the ${kind} two-way relation adds an inverse meta row sharing the SAME link table (no extra DDL)`, async () => {
    await makePair();
    const row = await addRelation(sql, 'book', { field: 'authors', kind, target: 'author', inverseField: 'books' });
    const link = row.link_table;
    assert.ok(await tableExists(sql, link));

    const book = await getContentType(sql, 'book');
    const author = await getContentType(sql, 'author');
    const bookRels = await getRelations(sql, book!.id);
    const authorRels = await getRelations(sql, author!.id);

    assert.equal(bookRels.length, 1);
    assert.equal(bookRels[0]!.is_owner, true);
    assert.equal(bookRels[0]!.inverse_field, 'books');

    assert.equal(authorRels.length, 1);
    const inv = authorRels[0]!;
    assert.equal(inv.is_owner, false);
    assert.equal(inv.field_name, 'books');
    assert.equal(inv.kind, INVERSE[kind]);
    assert.equal(inv.target_api_id, 'book');
    assert.equal(inv.inverse_field, 'authors');
    assert.equal(inv.link_table, link, 'inverse reads the SAME link table reversed');

    // still exactly ONE physical link table
    const lnks = await sql<{ table_name: string }[]>`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE '%\\_lnk'`;
    assert.equal(lnks.length, 1);
  });
}

// --- R9: cardinality enforcement (functional) --------------------------------------------------

test('R9 the per-kind UNIQUE is enforced by Postgres (duplicate link row rejected)', async () => {
  await makePair();
  await addRelation(sql, 'book', { field: 'authors', kind: 'manyToMany', target: 'author' });
  const [a] = await sql<{ id: number }[]>`INSERT INTO ct_author (name) VALUES ('a') RETURNING id`;
  const [b] = await sql<{ id: number }[]>`INSERT INTO ct_book (title) VALUES ('b') RETURNING id`;
  await sql`INSERT INTO book_authors_lnk (owner_id, related_id) VALUES (${b!.id}, ${a!.id})`;
  await assert.rejects(() => sql`INSERT INTO book_authors_lnk (owner_id, related_id) VALUES (${b!.id}, ${a!.id})`);
});

// --- R10: ON DELETE CASCADE (functional) -------------------------------------------------------

test('R10 deleting an entry prunes its link rows (CASCADE) but never the opposite entry', async () => {
  await makePair();
  await addRelation(sql, 'book', { field: 'authors', kind: 'manyToMany', target: 'author' });
  const [a] = await sql<{ id: number }[]>`INSERT INTO ct_author (name) VALUES ('a') RETURNING id`;
  const [b] = await sql<{ id: number }[]>`INSERT INTO ct_book (title) VALUES ('b') RETURNING id`;
  await sql`INSERT INTO book_authors_lnk (owner_id, related_id) VALUES (${b!.id}, ${a!.id})`;

  await sql`DELETE FROM ct_author WHERE id = ${a!.id}`;
  assert.equal((await sql`SELECT 1 FROM book_authors_lnk`).length, 0, 'link row pruned');
  assert.equal((await sql`SELECT 1 FROM ct_book WHERE id = ${b!.id}`).length, 1, 'owner entry survives');
});

// --- R11: scalar-collision ---------------------------------------------------------------------

test('R11 a relation field colliding with a scalar field is rejected; no link table, no meta', async () => {
  await createContentType(sql, { apiId: 'author', fields: [{ name: 'name', cmsType: 'string' }] });
  await createContentType(sql, { apiId: 'book', fields: [{ name: 'title', cmsType: 'string' }] });
  await assert.rejects(() => addRelation(sql, 'book', { field: 'title', kind: 'manyToOne', target: 'author' }), FieldExistsError);
  assert.equal(await tableExists(sql, 'book_title_lnk'), false);
  const book = await getContentType(sql, 'book');
  assert.equal((await getRelations(sql, book!.id)).length, 0);
});

// --- R12: relation-vs-relation duplicate -------------------------------------------------------

test('R12 declaring the same relation field twice is rejected', async () => {
  await makePair();
  await addRelation(sql, 'book', { field: 'authors', kind: 'manyToMany', target: 'author' });
  await assert.rejects(() => addRelation(sql, 'book', { field: 'authors', kind: 'manyToOne', target: 'author' }), FieldExistsError);
  await assert.rejects(() => addRelation(sql, 'book', { field: 'Authors', kind: 'manyToOne', target: 'author' }), FieldExistsError);
});

// --- R13: injection / over-63-byte -------------------------------------------------------------

test('R13 injection-y field/target reject pre-DDL; over-63-byte hashes to a distinct <=63-byte name', async () => {
  await makePair();
  // injection-y field name -> InvalidIdentifierError, no DDL
  await assert.rejects(() => addRelation(sql, 'book', { field: 'a"; DROP TABLE ct_book;--', kind: 'manyToOne', target: 'author' }), InvalidIdentifierError);
  // ct_-leading target -> ReservedTableNameError
  await assert.rejects(() => addRelation(sql, 'book', { field: 'x', kind: 'manyToOne', target: 'ct_author' }), ReservedTableNameError);
  assert.equal(await tableExists(sql, 'book_x_lnk'), false);

  // Two long field names sharing a long common prefix -> two distinct hashed link names + tables.
  const longA = 'authors_with_a_very_long_descriptive_field_name_variant_aaaaaa';
  const longB = 'authors_with_a_very_long_descriptive_field_name_variant_bbbbbb';
  const r1 = await addRelation(sql, 'book', { field: longA, kind: 'manyToOne', target: 'author' });
  const r2 = await addRelation(sql, 'book', { field: longB, kind: 'manyToOne', target: 'author' });
  assert.ok(Buffer.byteLength(r1.link_table) <= 63);
  assert.ok(Buffer.byteLength(r2.link_table) <= 63);
  assert.notEqual(r1.link_table, r2.link_table, 'distinct stored link names');
  assert.ok(await tableExists(sql, r1.link_table));
  assert.ok(await tableExists(sql, r2.link_table));

  // the meta catalog + ct_book survive intact.
  assert.ok(await tableExists(sql, 'content_types'));
  assert.ok(await tableExists(sql, 'ct_book'));
});

// --- R14: absent target ------------------------------------------------------------------------

test('R14 a relation to a non-existent target -> ContentTypeNotFoundError; no link table, no meta', async () => {
  await createContentType(sql, { apiId: 'book', fields: [{ name: 'title', cmsType: 'string' }] });
  await assert.rejects(() => addRelation(sql, 'book', { field: 'ghost', kind: 'manyToOne', target: 'nosuchtype' }), ContentTypeNotFoundError);
  assert.equal(await tableExists(sql, 'book_ghost_lnk'), false);
  const book = await getContentType(sql, 'book');
  assert.equal((await getRelations(sql, book!.id)).length, 0);
});

// --- R15: invalid kind -------------------------------------------------------------------------

test('R15 an invalid relation kind -> UnknownRelationKindError, no DDL', async () => {
  await makePair();
  await assert.rejects(() => addRelation(sql, 'book', { field: 'authors', kind: 'manyMany' as never, target: 'author' }), UnknownRelationKindError);
  assert.equal(await tableExists(sql, 'book_authors_lnk'), false);
});

// --- R16: self-referential ---------------------------------------------------------------------

test('R16 self-referential two-way: one link table, both FKs to ct_self, two meta rows', async () => {
  await createContentType(sql, { apiId: 'comment', fields: [{ name: 'body', cmsType: 'text' }] });
  const row = await addRelation(sql, 'comment', { field: 'parent', kind: 'manyToOne', target: 'comment', inverseField: 'children' });
  const link = row.link_table;
  assert.ok(await tableExists(sql, link));
  const fks = await foreignKeys(link);
  assert.equal(fks.find((f) => f.col === 'owner_id')!.refTable, 'ct_comment');
  assert.equal(fks.find((f) => f.col === 'related_id')!.refTable, 'ct_comment');
  const uqs = await uniqueConstraints(link);
  assert.deepEqual(uqs, [['owner_id']]);
  const comment = await getContentType(sql, 'comment');
  const rels = await getRelations(sql, comment!.id);
  assert.equal(rels.length, 2, 'owner + inverse both on the same content_type_id');
  assert.deepEqual(rels.map((r) => r.field_name).sort(), ['children', 'parent']);
});

test('R16b self-referential two-way with identical field names -> DuplicateFieldError', async () => {
  await createContentType(sql, { apiId: 'comment', fields: [{ name: 'body', cmsType: 'text' }] });
  await assert.rejects(() => addRelation(sql, 'comment', { field: 'rel', kind: 'manyToMany', target: 'comment', inverseField: 'rel' }), DuplicateFieldError);
  assert.equal(await tableExists(sql, 'comment_rel_lnk'), false);
});

// --- R17: reserved name ------------------------------------------------------------------------

test('R17 createContentType({apiId: content_type_relations}) -> ReservedTableNameError', async () => {
  await assert.rejects(() => createContentType(sql, { apiId: 'content_type_relations', fields: [] }), ReservedTableNameError);
});

// --- R18: targeted-drop guard ------------------------------------------------------------------

test('R18 dropping a TARGETED type -> DependentTypesError; the type + its inbound link survive', async () => {
  await makePair();
  await addRelation(sql, 'book', { field: 'authors', kind: 'manyToMany', target: 'author' });
  await assert.rejects(() => (async () => { const { dropContentType } = await import('../src/db/content-type.repository.ts'); return dropContentType(sql, 'author'); })(), DependentTypesError);
  assert.ok(await tableExists(sql, 'ct_author'));
  assert.ok(await tableExists(sql, 'book_authors_lnk'));
});

// --- R19: owner-drop cascade -------------------------------------------------------------------

test('R19 dropping the OWNER drops its link tables + both meta rows; the target survives', async () => {
  const { dropContentType } = await import('../src/db/content-type.repository.ts');
  await makePair();
  await addRelation(sql, 'book', { field: 'authors', kind: 'manyToMany', target: 'author', inverseField: 'books' });
  await dropContentType(sql, 'book');
  assert.equal(await tableExists(sql, 'ct_book'), false);
  assert.equal(await tableExists(sql, 'book_authors_lnk'), false);
  // both meta rows gone (owner on book + inverse on author).
  assert.equal((await sql`SELECT 1 FROM content_type_relations`).length, 0);
  assert.ok(await tableExists(sql, 'ct_author'), 'target type survives');
});

test('R19b a self-referential owner drops its own link table without a self-DependentTypesError', async () => {
  const { dropContentType } = await import('../src/db/content-type.repository.ts');
  await createContentType(sql, { apiId: 'comment', fields: [{ name: 'body', cmsType: 'text' }] });
  const row = await addRelation(sql, 'comment', { field: 'parent', kind: 'manyToOne', target: 'comment', inverseField: 'children' });
  await dropContentType(sql, 'comment');
  assert.equal(await tableExists(sql, 'ct_comment'), false);
  assert.equal(await tableExists(sql, row.link_table), false);
  assert.equal((await sql`SELECT 1 FROM content_type_relations`).length, 0);
});

// --- R20: atomic rollback ----------------------------------------------------------------------

test('R20 a forced mid-tx failure leaves neither the link table nor any meta row', async () => {
  await makePair();
  // Pre-seed a physical table at the resolved link name so the in-tx CREATE TABLE throws (42P07) AFTER
  // the meta INSERTs -> the whole tx rolls back.
  await sql.unsafe(`CREATE TABLE "book_authors_lnk" (id serial primary key)`);
  await assert.rejects(() => addRelation(sql, 'book', { field: 'authors', kind: 'manyToMany', target: 'author', inverseField: 'books' }));
  // No relation meta survived (owner on book NOR inverse on author).
  assert.equal((await sql`SELECT 1 FROM content_type_relations`).length, 0);
  // The pre-seeded table is still the one-column shape (the runtime CREATE rolled back).
  const cols = await physicalColumns(sql, 'book_authors_lnk');
  assert.deepEqual(cols.map((c) => c.name), ['id']);
  // ct_book arena unchanged (never has a relation column).
  const bookCols = await physicalColumns(sql, 'ct_book');
  assert.deepEqual(bookCols.map((c) => c.name), ['id', 'document_id', 'created_at', 'updated_at', 'title']);
  await sql.unsafe(`DROP TABLE "book_authors_lnk"`);
});

// --- R21: registry threading -------------------------------------------------------------------

test('R21 Registry.build surfaces relation metadata without touching fields/columnPlan', async () => {
  // Baseline: a type with NO relations.
  await createContentType(sql, { apiId: 'author', fields: [{ name: 'name', cmsType: 'string' }] });
  const baseReg = await Registry.build(sql);
  const baseDef = baseReg.get('author')!;
  const baseFields = baseDef.fields.map((f) => f.name);
  const baseColumnPlan = baseDef.columnPlan.map((c) => `${c.name}:${c.kind}`);
  assert.deepEqual(baseDef.relations, []);

  await createContentType(sql, { apiId: 'book', fields: [{ name: 'title', cmsType: 'string' }] });
  await addRelation(sql, 'book', { field: 'authors', kind: 'manyToMany', target: 'author', inverseField: 'books' });

  const reg = await Registry.build(sql);
  const book = reg.get('book')!;
  assert.equal(book.relations.length, 1);
  const rel = book.relations[0]!;
  assert.equal(rel.field, 'authors');
  assert.equal(rel.kind, 'manyToMany');
  assert.equal(rel.targetApiId, 'author');
  assert.equal(rel.isOwner, true);
  assert.equal(rel.inverseField, 'books');
  assert.equal(rel.linkTable, 'book_authors_lnk');
  assert.equal(book.relationsByField.get('authors'), rel);

  // inverse side surfaced on author
  const author = reg.get('author')!;
  assert.equal(author.relations.length, 1);
  assert.equal(author.relations[0]!.isOwner, false);
  assert.equal(author.relations[0]!.field, 'books');

  // author's fields/columnPlan are byte-identical to the no-relation baseline (read arena unchanged).
  assert.deepEqual(author.fields.map((f) => f.name), baseFields);
  assert.deepEqual(author.columnPlan.map((c) => `${c.name}:${c.kind}`), baseColumnPlan);
});

// --- createContentType-with-relations atomicity ------------------------------------------------

test('R createContentType with a self-referential relation creates the owner + link table atomically', async () => {
  await createContentType(sql, {
    apiId: 'node',
    fields: [{ name: 'label', cmsType: 'string' }],
    relations: [{ field: 'parent', kind: 'manyToOne', target: 'node', inverseField: 'children' }],
  });
  assert.ok(await tableExists(sql, 'ct_node'));
  assert.ok(await tableExists(sql, 'node_parent_lnk'));
  const fks = await foreignKeys('node_parent_lnk');
  assert.equal(fks.find((f) => f.col === 'owner_id')!.refTable, 'ct_node');
  assert.equal(fks.find((f) => f.col === 'related_id')!.refTable, 'ct_node');
  const node = await getContentType(sql, 'node');
  assert.equal((await getRelations(sql, node!.id)).length, 2);
});

test('R createContentType rejects a relation field colliding with a scalar field in the same call', async () => {
  await assert.rejects(
    () =>
      createContentType(sql, {
        apiId: 'page',
        fields: [{ name: 'slug', cmsType: 'string' }],
        relations: [{ field: 'slug', kind: 'manyToOne', target: 'page' }],
      }),
    FieldExistsError,
  );
  assert.equal(await tableExists(sql, 'ct_page'), false);
  assert.equal(await getContentType(sql, 'page'), null);
});
