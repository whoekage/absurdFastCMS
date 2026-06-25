import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Sql } from 'postgres';
import { Registry } from '../src/db/registry.ts';
import { migrate } from '../src/db/schema/migrate.ts';
import { SchemaAdaptError } from '../src/db/schema/adapt.ts';
import type { ContentTypeSchema } from '../src/db/schema/model.ts';
import { createFileDatabase, dropFileDatabase } from './db-per-file.ts';
import { cleanCatalog, tableExists, physicalColumns, ct } from './helpers.ts';

/**
 * RELATIONS SLICE 2 (files-first port) — relation declaration via `migrate()` from the in-code IR + the
 * uniform LINK-TABLE runtime DDL, end-to-end against a REAL Postgres (no mocks). The ct_<apiId> arena is
 * NEVER touched. Introspects information_schema + pg_catalog (pg_constraint.contype/confdeltype) to prove the
 * physical link table + per-kind UNIQUE + ON DELETE CASCADE FKs EXACTLY match the locked design, across all
 * four kinds (migrate-edge-relations only covers manyToMany), plus self-ref, the 63-byte truncation, the
 * unknown-target guard, and the registry threading (via Registry.fromSchemas).
 *
 * COVERAGE NOTE (legacy-meta teardown): the original file was a `createContentType`/`addRelation` (meta) test.
 * Its meta-row assertions (content_type_relations / getRelations) are dropped — files + _schema_applied are
 * now the truth, and the relation read-side is covered by relation-load.test.ts. Two legacy GUARDS have NO
 * files-first analog and are intentionally retired: (1) the relation-vs-scalar `FieldExistsError` collision
 * (the legacy `addRelation` re-checked field-name collisions; the files path defers name uniqueness to
 * `resolveFields`/parse and does not re-run it for a relation field), and (2) the `ReservedTableNameError`
 * on a `ct_`-prefixed TARGET (the files path resolves a target by apiId, so `ct_author` simply reads as an
 * unknown type → `SchemaAdaptError`). The drop-relation guards live in migrate-edge-relations.test.ts.
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
/** The expected per-kind UNIQUE column-sets (sorted), matching compileCreateLinkTable. */
const UNIQUE_FOR: Record<string, string[][]> = {
  manyToMany: [['owner_id', 'related_id']],
  oneToMany: [['related_id']],
  manyToOne: [['owner_id']],
  oneToOne: [['owner_id'], ['related_id']],
};

/** author + book schemas, book optionally owning a relation `authors` of `kind` to author. */
function pair(rel?: { kind: (typeof KINDS)[number]; inverseField?: string }): ContentTypeSchema[] {
  const author = ct({ apiId: 'author', fields: [{ name: 'name', cmsType: 'string' }] });
  const book = ct({
    apiId: 'book',
    fields: [{ name: 'title', cmsType: 'string' }],
    ...(rel ? { relations: [{ field: 'authors', kind: rel.kind, target: 'author', ...(rel.inverseField ? { inverseField: rel.inverseField } : {}) }] } : {}),
  });
  return [author, book];
}

// --- R1..R8: the 4 kinds x {one-way, two-way} --------------------------------------------------

for (const kind of KINDS) {
  test(`R the ${kind} one-way relation builds the link table + correct UNIQUE + CASCADE FKs`, async () => {
    const schemas = pair({ kind });
    await migrate(sql, schemas, { allowDestructive: true });
    const link = 'book_authors_lnk';

    // link table shape
    assert.ok(await tableExists(sql, link));
    const cols = await physicalColumns(sql, link);
    assert.deepEqual(cols.map((c) => c.name), ['id', 'owner_id', 'related_id', 'ord']);

    // per-kind UNIQUE
    const uqs = (await uniqueConstraints(link)).sort((a, b) => a.join().localeCompare(b.join()));
    assert.deepEqual(uqs, [...UNIQUE_FOR[kind]!].sort((a, b) => a.join().localeCompare(b.join())));

    // FKs: both ON DELETE CASCADE to the right ct_ tables
    const fks = await foreignKeys(link);
    assert.equal(fks.find((f) => f.col === 'owner_id')!.refTable, 'ct_book');
    assert.equal(fks.find((f) => f.col === 'owner_id')!.delType, 'c');
    assert.equal(fks.find((f) => f.col === 'related_id')!.refTable, 'ct_author');
    assert.equal(fks.find((f) => f.col === 'related_id')!.delType, 'c');

    // registry: exactly ONE owner relation, no inverse on the target.
    const reg = Registry.fromSchemas(schemas);
    assert.equal(reg.get('book')!.relations.length, 1);
    assert.equal(reg.get('book')!.relations[0]!.isOwner, true);
    assert.equal(reg.get('book')!.relations[0]!.kind, kind);
    assert.equal(reg.get('book')!.relations[0]!.targetApiId, 'author');
    assert.equal(reg.get('author')!.relations.length, 0);

    // ct_book arena untouched (no relation column ever).
    assert.deepEqual((await physicalColumns(sql, 'ct_book')).map((c) => c.name), ['id', 'document_id', 'created_at', 'updated_at', 'title']);
  });

  test(`R the ${kind} two-way relation adds an inverse on the target sharing the SAME link table (no extra DDL)`, async () => {
    const schemas = pair({ kind, inverseField: 'books' });
    await migrate(sql, schemas, { allowDestructive: true });
    const link = 'book_authors_lnk';
    assert.ok(await tableExists(sql, link));

    const reg = Registry.fromSchemas(schemas);
    const bookRel = reg.get('book')!.relations[0]!;
    assert.equal(bookRel.isOwner, true);
    assert.equal(bookRel.inverseField, 'books');

    const author = reg.get('author')!;
    assert.equal(author.relations.length, 1);
    assert.equal(author.relations[0]!.isOwner, false);
    assert.equal(author.relations[0]!.field, 'books');
    assert.equal(author.relations[0]!.targetApiId, 'book');
    assert.equal(author.relations[0]!.linkTable, link, 'inverse reads the SAME link table reversed');

    // still exactly ONE physical link table.
    const lnks = await sql<{ table_name: string }[]>`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE '%\\_lnk'`;
    assert.equal(lnks.length, 1);
  });
}

// --- R9: cardinality enforcement (functional) --------------------------------------------------

test('R9 the per-kind UNIQUE is enforced by Postgres (duplicate link row rejected)', async () => {
  await migrate(sql, pair({ kind: 'manyToMany' }), { allowDestructive: true });
  const [a] = await sql<{ id: number }[]>`INSERT INTO ct_author (name) VALUES ('a') RETURNING id`;
  const [b] = await sql<{ id: number }[]>`INSERT INTO ct_book (title) VALUES ('b') RETURNING id`;
  await sql`INSERT INTO book_authors_lnk (owner_id, related_id) VALUES (${b!.id}, ${a!.id})`;
  await assert.rejects(() => sql`INSERT INTO book_authors_lnk (owner_id, related_id) VALUES (${b!.id}, ${a!.id})`);
});

// --- R10: ON DELETE CASCADE (functional) -------------------------------------------------------

test('R10 deleting an entry prunes its link rows (CASCADE) but never the opposite entry', async () => {
  await migrate(sql, pair({ kind: 'manyToMany' }), { allowDestructive: true });
  const [a] = await sql<{ id: number }[]>`INSERT INTO ct_author (name) VALUES ('a') RETURNING id`;
  const [b] = await sql<{ id: number }[]>`INSERT INTO ct_book (title) VALUES ('b') RETURNING id`;
  await sql`INSERT INTO book_authors_lnk (owner_id, related_id) VALUES (${b!.id}, ${a!.id})`;

  await sql`DELETE FROM ct_author WHERE id = ${a!.id}`;
  assert.equal((await sql`SELECT 1 FROM book_authors_lnk`).length, 0, 'link row pruned');
  assert.equal((await sql`SELECT 1 FROM ct_book WHERE id = ${b!.id}`).length, 1, 'owner entry survives');
});

// --- R13: over-63-byte link names hash to distinct <=63-byte names ------------------------------

test('R13 two long relation field names sharing a prefix hash to distinct <=63-byte link tables', async () => {
  const longA = 'authors_with_a_very_long_descriptive_field_name_variant_aaaaaa';
  const longB = 'authors_with_a_very_long_descriptive_field_name_variant_bbbbbb';
  const author = ct({ apiId: 'author', fields: [{ name: 'name', cmsType: 'string' }] });
  const book = ct({
    apiId: 'book',
    fields: [{ name: 'title', cmsType: 'string' }],
    relations: [
      { field: longA, kind: 'manyToOne', target: 'author' },
      { field: longB, kind: 'manyToOne', target: 'author' },
    ],
  });
  await migrate(sql, [author, book], { allowDestructive: true });

  const reg = Registry.fromSchemas([author, book]);
  const linkA = reg.get('book')!.relationsByField.get(longA)!.linkTable;
  const linkB = reg.get('book')!.relationsByField.get(longB)!.linkTable;
  assert.ok(Buffer.byteLength(linkA) <= 63);
  assert.ok(Buffer.byteLength(linkB) <= 63);
  assert.notEqual(linkA, linkB, 'distinct link names');
  assert.ok(await tableExists(sql, linkA));
  assert.ok(await tableExists(sql, linkB));
});

// --- R14: absent target ------------------------------------------------------------------------

test('R14 a relation to a non-existent target is rejected: SchemaAdaptError at registry build, no link table materialized', async () => {
  const book = ct({ apiId: 'book', fields: [{ name: 'title', cmsType: 'string' }], relations: [{ field: 'ghost', kind: 'manyToOne', target: 'nosuchtype' }] });
  // The typed guard lives at registry build (the cross-type relation pass resolves targets by apiId).
  assert.throws(() => Registry.fromSchemas([book]), SchemaAdaptError);
  // migrate also fails (the link-table FK references a missing ct_ table) and materializes nothing.
  await assert.rejects(() => migrate(sql, [book], { allowDestructive: true }));
  assert.equal(await tableExists(sql, 'book_ghost_lnk'), false);
});

// --- R16: self-referential ---------------------------------------------------------------------

test('R16 self-referential two-way: one link table, both FKs to ct_comment, owner + inverse in the registry', async () => {
  const comment = ct({ apiId: 'comment', fields: [{ name: 'body', cmsType: 'text' }], relations: [{ field: 'parent', kind: 'manyToOne', target: 'comment', inverseField: 'children' }] });
  await migrate(sql, [comment], { allowDestructive: true });
  const link = 'comment_parent_lnk';
  assert.ok(await tableExists(sql, link));
  const fks = await foreignKeys(link);
  assert.equal(fks.find((f) => f.col === 'owner_id')!.refTable, 'ct_comment');
  assert.equal(fks.find((f) => f.col === 'related_id')!.refTable, 'ct_comment');
  assert.deepEqual(await uniqueConstraints(link), [['owner_id']]);

  const rels = Registry.fromSchemas([comment]).get('comment')!.relations;
  assert.equal(rels.length, 2, 'owner + inverse both on comment');
  assert.deepEqual(rels.map((r) => r.field).sort(), ['children', 'parent']);
});

// --- R20: atomic rollback ----------------------------------------------------------------------

test('R20 a forced mid-tx failure (pre-existing link table) rolls back: no snapshot, ct_book unchanged', async () => {
  await migrate(sql, pair(), { allowDestructive: true }); // author + book, no relation yet
  // Pre-seed a physical table at the resolved link name so the in-tx CREATE TABLE throws (42P07) → rollback.
  await sql.unsafe(`CREATE TABLE "book_authors_lnk" (id serial primary key)`);
  await assert.rejects(() => migrate(sql, pair({ kind: 'manyToMany', inverseField: 'books' }), { allowDestructive: true }));
  // The pre-seeded table is still the one-column shape (the runtime CREATE rolled back).
  assert.deepEqual((await physicalColumns(sql, 'book_authors_lnk')).map((c) => c.name), ['id']);
  // ct_book arena unchanged (never has a relation column).
  assert.deepEqual((await physicalColumns(sql, 'ct_book')).map((c) => c.name), ['id', 'document_id', 'created_at', 'updated_at', 'title']);
  await sql.unsafe(`DROP TABLE "book_authors_lnk"`);
});

// --- R21: registry threading -------------------------------------------------------------------

test('R21 Registry.fromSchemas surfaces relation metadata without touching the target fields/columnPlan', async () => {
  // Baseline: author with NO relations.
  const authorOnly = [ct({ apiId: 'author', fields: [{ name: 'name', cmsType: 'string' }] })];
  const baseDef = Registry.fromSchemas(authorOnly).get('author')!;
  const baseFields = baseDef.fields.map((f) => f.name);
  const baseColumnPlan = baseDef.columnPlan.map((c) => `${c.name}:${c.kind}`);
  assert.deepEqual(baseDef.relations, []);

  const schemas = pair({ kind: 'manyToMany', inverseField: 'books' });
  const reg = Registry.fromSchemas(schemas);
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

// --- self-referential create atomicity ---------------------------------------------------------

test('R a content-type with a self-referential relation materializes the owner + link table atomically', async () => {
  const node = ct({ apiId: 'node', fields: [{ name: 'label', cmsType: 'string' }], relations: [{ field: 'parent', kind: 'manyToOne', target: 'node', inverseField: 'children' }] });
  await migrate(sql, [node], { allowDestructive: true });
  assert.ok(await tableExists(sql, 'ct_node'));
  assert.ok(await tableExists(sql, 'node_parent_lnk'));
  const fks = await foreignKeys('node_parent_lnk');
  assert.equal(fks.find((f) => f.col === 'owner_id')!.refTable, 'ct_node');
  assert.equal(fks.find((f) => f.col === 'related_id')!.refTable, 'ct_node');
  assert.equal(Registry.fromSchemas([node]).get('node')!.relations.length, 2);
});
