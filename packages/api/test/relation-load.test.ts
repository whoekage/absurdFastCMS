import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Sql } from 'postgres';
import { Registry } from '../src/db/registry.ts';
import { migrate } from '../src/db/schema/migrate.ts';
import { mintId, type Schema } from '../src/db/schema/model.ts';
import { buildEngine, rebuildType, loadAllRelations, loadType } from '../src/db/engine.loader.ts';
import { PostgresStore } from '../src/db/postgres.store.ts';
import { Engine } from '../src/store/engine.ts';
import { Bitset } from '../src/store/bitset.ts';
import { createFileDatabase, dropFileDatabase } from './db-per-file.ts';
import { cleanCatalog, schema } from './helpers.ts';

/**
 * RELATIONS SLICE 3 — loading relation EDGES from the link tables into in-memory CSR {@link Relation}
 * objects at boot (two-phase) and per-write, building the inverse for two-way relations, against a REAL
 * Postgres (no mocks). Asserts engine.relation(type,field).relatedRows / ownersMatching match the seeded
 * adjacency (PKs mapped to DENSE rows AFTER boot/rebuild). The unpopulated read arena stays byte-identical.
 */

let sql: Sql;
let db: Awaited<ReturnType<typeof createFileDatabase>>;

before(async () => {
  db = await createFileDatabase('relload');
  sql = db.sql;
});

beforeEach(async () => {
  await cleanCatalog(sql);
});

after(async () => {
  if (sql) await sql.end();
  if (db) await dropFileDatabase(db.name);
});

// --- seeding + assertion helpers ----------------------------------------------------------------

/** Insert one ct_<type> row, returning its real Postgres PK. */
async function insertRow(table: string, col: string, value: string): Promise<number> {
  const [r] = await sql.unsafe<{ id: number }[]>(`INSERT INTO "${table}" (${col}) VALUES ($1) RETURNING id`, [value]);
  return r!.id;
}

/** Insert one link edge (owner PK -> related PK). */
async function insertEdge(link: string, ownerPk: number, relatedPk: number): Promise<void> {
  await sql.unsafe(`INSERT INTO "${link}" (owner_id, related_id) VALUES ($1, $2)`, [ownerPk, relatedPk]);
}

/** Materialize the ct_ + link tables from in-code IR (files-first, zero meta). */
async function setup(schemas: Schema[]): Promise<void> {
  await migrate(sql, schemas, { allowDestructive: true });
}

/** The deterministic link-table name for a declared relation, read off the built registry. */
function linkOf(registry: Registry, type: string, field: string): string {
  return registry.get(type)!.relationsByField.get(field)!.linkTable;
}

/** Build the engine from the given files-first schemas. */
async function boot(schemas: Schema[]): Promise<Engine> {
  return buildEngine(sql, Registry.fromSchemas(schemas));
}

/** Map a Postgres PK -> dense row for a type (AFTER the engine is built/rebuilt). */
function dense(engine: Engine, type: string, pk: number): number {
  const row = engine.table(type).rowIdByEq('id', pk);
  assert.notEqual(row, undefined, `pk ${pk} should resolve to a dense row in ${type}`);
  return row!;
}

/** A Bitset over `type`'s rowCount with exactly the given dense rows set. */
function relatedBitset(engine: Engine, type: string, denseRows: number[]): Bitset {
  const bs = new Bitset(engine.rowCount(type));
  for (const d of denseRows) bs.set(d);
  return bs;
}

/** The dense owner rows flagged by ownersMatching, as a sorted array. */
function matchingOwners(bs: Bitset): number[] {
  const out: number[] = [];
  for (let i = 0; i < bs.capacity; i++) if (bs.get(i)) out.push(i);
  return out;
}

const sorted = (xs: number[]): number[] => [...xs].sort((a, b) => a - b);

// --- 4 kinds, ONE-WAY ---------------------------------------------------------------------------

const KINDS = ['oneToOne', 'oneToMany', 'manyToOne', 'manyToMany'] as const;

for (const kind of KINDS) {
  test(`${kind} one-way: forward CSR matches the seeded adjacency; no inverse`, async () => {
    const schemas = [
      schema({ name: 'author', fields: [{ name: 'name', type: 'string' }] }),
      schema({ name: 'book', fields: [{ name: 'title', type: 'string' }], relations: [{ field: 'authors', kind, target: 'author' }] }),
    ];
    await setup(schemas);
    const registry = Registry.fromSchemas(schemas);
    const link = linkOf(registry, 'book', 'authors');

    // For oneToMany/oneToOne the related side is UNIQUE; for manyToOne/manyToMany an owner may have many.
    // Seed a per-kind-legal adjacency: book b1 -> a1 (+ a2 when the kind allows multiple relateds).
    const a1 = await insertRow('ct_author', 'name', 'a1');
    const a2 = await insertRow('ct_author', 'name', 'a2');
    const b1 = await insertRow('ct_book', 'title', 'b1');
    const b2 = await insertRow('ct_book', 'title', 'b2');

    // owner_id is UNIQUE for oneToOne/manyToOne (one related per owner); related_id is UNIQUE for
    // oneToOne/oneToMany (a related is not shared across owners).
    const multiRelated = kind === 'oneToMany' || kind === 'manyToMany'; // owner may point to many relateds
    const sharedRelatedOk = kind === 'manyToOne' || kind === 'manyToMany'; // a related may be shared by owners
    await insertEdge(link, b1, a1);
    if (multiRelated) await insertEdge(link, b1, a2);
    if (sharedRelatedOk) await insertEdge(link, b2, a1);

    const engine = await boot(schemas);
    const r = engine.relation('book', 'authors');
    assert.ok(r, 'forward relation present');
    assert.equal(engine.relation('author', 'authors'), undefined, 'no inverse under owner field on target');

    const dB1 = dense(engine, 'book', b1);
    const expectedB1 = multiRelated ? [dense(engine, 'author', a1), dense(engine, 'author', a2)] : [dense(engine, 'author', a1)];
    assert.deepEqual(sorted(r!.relatedRows(dB1)), sorted(expectedB1));

    // ownersMatching: which books point at a1?
    const ownersOfA1 = matchingOwners(r!.ownersMatching(relatedBitset(engine, 'author', [dense(engine, 'author', a1)])));
    const expectedOwners = sharedRelatedOk ? [dense(engine, 'book', b1), dense(engine, 'book', b2)] : [dense(engine, 'book', b1)];
    assert.deepEqual(sorted(ownersOfA1), sorted(expectedOwners));
  });
}

// --- 4 kinds, TWO-WAY (inverse present + correct direction) -------------------------------------

for (const kind of KINDS) {
  test(`${kind} two-way: inverse is the transpose with swapped endpoints`, async () => {
    const schemas = [
      schema({ name: 'author', fields: [{ name: 'name', type: 'string' }] }),
      schema({ name: 'book', fields: [{ name: 'title', type: 'string' }], relations: [{ field: 'authors', kind, target: 'author', inverseField: 'books' }] }),
    ];
    await setup(schemas);
    const registry = Registry.fromSchemas(schemas);
    const link = linkOf(registry, 'book', 'authors');

    // Asymmetric seed: b1 -> a1 ONLY (so an orientation bug is caught — forward != inverse shape).
    const a1 = await insertRow('ct_author', 'name', 'a1');
    await insertRow('ct_author', 'name', 'a2'); // a2 has zero edges
    const b1 = await insertRow('ct_book', 'title', 'b1');
    await insertEdge(link, b1, a1);

    const engine = await boot(schemas);
    const fwd = engine.relation('book', 'authors')!;
    const inv = engine.relation('author', 'books')!;
    assert.ok(fwd, 'forward present');
    assert.ok(inv, 'inverse present');

    // Endpoints swapped: inverse owner === author table, inverse related === book table.
    assert.equal(inv.owner, engine.table('author'));
    assert.equal(inv.related, engine.table('book'));
    assert.equal(fwd.owner, engine.table('book'));
    assert.equal(fwd.related, engine.table('author'));

    const dA1 = dense(engine, 'author', a1);
    const dB1 = dense(engine, 'book', b1);
    assert.deepEqual(fwd.relatedRows(dB1), [dA1], 'forward: b1 -> a1');
    assert.deepEqual(inv.relatedRows(dA1), [dB1], 'inverse: a1 -> b1 (transpose)');
  });
}

// --- self-referential two-way -------------------------------------------------------------------

test('self-referential two-way: parent/children resolve against the SAME table, asymmetric', async () => {
  // parent is manyToOne (a child has one parent); children is the inverse.
  const schemas = [schema({ name: 'comment', fields: [{ name: 'body', type: 'text' }], relations: [{ field: 'parent', kind: 'manyToOne', target: 'comment', inverseField: 'children' }] })];
  await setup(schemas);
  const registry = Registry.fromSchemas(schemas);
  const link = linkOf(registry, 'comment', 'parent');

  const root = await insertRow('ct_comment', 'body', 'root');
  const child = await insertRow('ct_comment', 'body', 'child');
  // child's parent is root: owner=child, related=root (owner side is the "parent" field on the child).
  await insertEdge(link, child, root);

  const engine = await boot(schemas);
  const parent = engine.relation('comment', 'parent')!;
  const children = engine.relation('comment', 'children')!;
  assert.ok(parent && children);
  assert.equal(parent.owner, engine.table('comment'));
  assert.equal(parent.related, engine.table('comment'));
  assert.equal(children.owner, engine.table('comment'));

  const dRoot = dense(engine, 'comment', root);
  const dChild = dense(engine, 'comment', child);
  assert.deepEqual(parent.relatedRows(dChild), [dRoot], 'child -> root via parent');
  assert.deepEqual(children.relatedRows(dRoot), [dChild], 'root -> child via children');
  assert.deepEqual(parent.relatedRows(dRoot), [], 'root has no parent');
  assert.deepEqual(children.relatedRows(dChild), [], 'child has no children');
});

// --- zero-edge ----------------------------------------------------------------------------------

test('zero-edge relation is a PRESENT, valid, empty Relation (not undefined)', async () => {
  const schemas = [
    schema({ name: 'author', fields: [{ name: 'name', type: 'string' }] }),
    schema({ name: 'book', fields: [{ name: 'title', type: 'string' }], relations: [{ field: 'authors', kind: 'manyToMany', target: 'author', inverseField: 'books' }] }),
  ];
  await setup(schemas);
  await insertRow('ct_author', 'name', 'a1');
  await insertRow('ct_book', 'title', 'b1'); // rows exist; NO link edges

  const engine = await boot(schemas);
  const fwd = engine.relation('book', 'authors')!;
  const inv = engine.relation('author', 'books')!;
  assert.ok(fwd, 'present even with zero edges');
  assert.ok(inv, 'inverse present even with zero edges');
  assert.deepEqual(fwd.relatedRows(0), []);
  assert.equal(fwd.ownersMatching(relatedBitset(engine, 'author', [0])).count(), 0);
});

test('mixed: one owner has edges, one has none', async () => {
  const schemas = [
    schema({ name: 'author', fields: [{ name: 'name', type: 'string' }] }),
    schema({ name: 'book', fields: [{ name: 'title', type: 'string' }], relations: [{ field: 'authors', kind: 'manyToMany', target: 'author' }] }),
  ];
  await setup(schemas);
  const link = linkOf(Registry.fromSchemas(schemas), 'book', 'authors');
  const a1 = await insertRow('ct_author', 'name', 'a1');
  const b1 = await insertRow('ct_book', 'title', 'b1');
  const b2 = await insertRow('ct_book', 'title', 'b2'); // no edges
  await insertEdge(link, b1, a1);

  const engine = await boot(schemas);
  const r = engine.relation('book', 'authors')!;
  assert.deepEqual(r.relatedRows(dense(engine, 'book', b1)), [dense(engine, 'author', a1)]);
  assert.deepEqual(r.relatedRows(dense(engine, 'book', b2)), []);
});

// --- write-then-rebuild against NEW dense rows --------------------------------------------------

test('rebuild of the OWNER type leaves the relation + inverse correct against the NEW dense rows', async () => {
  const schemas = [
    schema({ name: 'author', fields: [{ name: 'name', type: 'string' }] }),
    schema({ name: 'book', fields: [{ name: 'title', type: 'string' }], relations: [{ field: 'authors', kind: 'manyToMany', target: 'author', inverseField: 'books' }] }),
  ];
  await setup(schemas);
  const registry = Registry.fromSchemas(schemas);
  const link = linkOf(registry, 'book', 'authors');
  const a1 = await insertRow('ct_author', 'name', 'a1');
  const b1 = await insertRow('ct_book', 'title', 'b1');
  await insertEdge(link, b1, a1);

  const engine = await buildEngine(sql, registry);

  // A fresh write: new book + new edge.
  const b2 = await insertRow('ct_book', 'title', 'b2');
  await insertEdge(link, b2, a1);
  await rebuildType(sql, engine, registry.get('book')!, registry);

  const r = engine.relation('book', 'authors')!;
  const inv = engine.relation('author', 'books')!;
  const dA1 = dense(engine, 'author', a1);
  // Both the pre-existing edge AND the new edge resolve against the post-rebuild dense numbering.
  assert.deepEqual(r.relatedRows(dense(engine, 'book', b1)), [dA1]);
  assert.deepEqual(r.relatedRows(dense(engine, 'book', b2)), [dA1]);
  // Inverse: a1 -> {b1, b2}.
  assert.deepEqual(sorted(inv.relatedRows(dA1)), sorted([dense(engine, 'book', b1), dense(engine, 'book', b2)]));
  // The relation references the NEW owner table object.
  assert.equal(r.owner, engine.table('book'));
});

test('rebuild of the TARGET type leaves the relation + inverse correct against the NEW dense rows', async () => {
  const schemas = [
    schema({ name: 'author', fields: [{ name: 'name', type: 'string' }] }),
    schema({ name: 'book', fields: [{ name: 'title', type: 'string' }], relations: [{ field: 'authors', kind: 'manyToMany', target: 'author', inverseField: 'books' }] }),
  ];
  await setup(schemas);
  const registry = Registry.fromSchemas(schemas);
  const link = linkOf(registry, 'book', 'authors');
  const a1 = await insertRow('ct_author', 'name', 'a1');
  const b1 = await insertRow('ct_book', 'title', 'b1');
  await insertEdge(link, b1, a1);

  const engine = await buildEngine(sql, registry);

  // Write to the TARGET (author) type: a new author + a new edge from b1 to it.
  const a2 = await insertRow('ct_author', 'name', 'a2');
  await insertEdge(link, b1, a2);
  await rebuildType(sql, engine, registry.get('author')!, registry);

  const r = engine.relation('book', 'authors')!;
  const inv = engine.relation('author', 'books')!;
  // The forward relation now references the NEW author table (target rebuilt).
  assert.equal(r.related, engine.table('author'));
  assert.equal(inv.owner, engine.table('author'));
  const dB1 = dense(engine, 'book', b1);
  assert.deepEqual(sorted(r.relatedRows(dB1)), sorted([dense(engine, 'author', a1), dense(engine, 'author', a2)]));
  assert.deepEqual(inv.relatedRows(dense(engine, 'author', a2)), [dB1]);
});

// --- dangling-edge skip -------------------------------------------------------------------------

test('a dangling link edge (owner PK absent from the loaded snapshot) is SKIPPED, valid edges intact', async () => {
  // manyToMany so the unique constraint never blocks our two edges.
  const schemas = [
    schema({ name: 'author', fields: [{ name: 'name', type: 'string' }] }),
    schema({ name: 'book', fields: [{ name: 'title', type: 'string' }], relations: [{ field: 'authors', kind: 'manyToMany', target: 'author' }] }),
  ];
  await setup(schemas);
  const link = linkOf(Registry.fromSchemas(schemas), 'book', 'authors');
  const a1 = await insertRow('ct_author', 'name', 'a1');
  const b1 = await insertRow('ct_book', 'title', 'b1');
  const bGone = await insertRow('ct_book', 'title', 'gone');
  await insertEdge(link, b1, a1); // valid
  await insertEdge(link, bGone, a1); // about-to-dangle

  // Dropping the ct_ owner row would CASCADE-prune the link row, so to FORCE a true dangling edge in the
  // snapshot we detach the owner_id FK (looked up by its real name), delete the ct_ row leaving the link
  // row orphaned, then load.
  const fk = await sql<{ conname: string }[]>`
    SELECT c.conname FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = c.conkey[1]
    WHERE t.relname = ${link} AND c.contype = 'f' AND a.attname = 'owner_id'
  `;
  assert.equal(fk.length, 1, 'owner_id FK found');
  await sql.unsafe(`ALTER TABLE "${link}" DROP CONSTRAINT "${fk[0]!.conname}"`);
  await sql.unsafe(`DELETE FROM ct_book WHERE id = $1`, [bGone]);
  assert.equal((await sql.unsafe(`SELECT 1 FROM "${link}" WHERE owner_id = $1`, [bGone])).length, 1, 'dangling link row still present');

  const engine = await boot(schemas); // must NOT throw
  const r = engine.relation('book', 'authors')!;
  assert.ok(r);
  // Only the valid edge survives; the dangling one was skipped.
  assert.deepEqual(r.relatedRows(dense(engine, 'book', b1)), [dense(engine, 'author', a1)]);
  assert.equal(r.edgeCount, 1, 'exactly one edge loaded (dangling skipped)');
});

test('a dangling RELATED edge (related PK absent from the loaded snapshot) is SKIPPED, valid edges intact', async () => {
  const schemas = [
    schema({ name: 'author', fields: [{ name: 'name', type: 'string' }] }),
    schema({ name: 'book', fields: [{ name: 'title', type: 'string' }], relations: [{ field: 'authors', kind: 'manyToMany', target: 'author' }] }),
  ];
  await setup(schemas);
  const link = linkOf(Registry.fromSchemas(schemas), 'book', 'authors');
  const a1 = await insertRow('ct_author', 'name', 'a1');
  const aGone = await insertRow('ct_author', 'name', 'gone');
  const b1 = await insertRow('ct_book', 'title', 'b1');
  await insertEdge(link, b1, a1); // valid
  await insertEdge(link, b1, aGone); // about-to-dangle on the RELATED side

  // Symmetric to the owner-side test: detach the related_id FK, delete the ct_ TARGET row, leave the
  // link row orphaned, then load — exercising the `r === undefined` arm of the skip condition.
  const fk = await sql<{ conname: string }[]>`
    SELECT c.conname FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = c.conkey[1]
    WHERE t.relname = ${link} AND c.contype = 'f' AND a.attname = 'related_id'
  `;
  assert.equal(fk.length, 1, 'related_id FK found');
  await sql.unsafe(`ALTER TABLE "${link}" DROP CONSTRAINT "${fk[0]!.conname}"`);
  await sql.unsafe(`DELETE FROM ct_author WHERE id = $1`, [aGone]);
  assert.equal((await sql.unsafe(`SELECT 1 FROM "${link}" WHERE related_id = $1`, [aGone])).length, 1, 'dangling link row still present');

  const engine = await boot(schemas); // must NOT throw
  const r = engine.relation('book', 'authors')!;
  assert.ok(r);
  assert.deepEqual(r.relatedRows(dense(engine, 'book', b1)), [dense(engine, 'author', a1)]);
  assert.equal(r.edgeCount, 1, 'exactly one edge loaded (dangling related skipped)');
});

test('a dangling edge on a TWO-WAY relation is skipped on BOTH forward AND inverse', async () => {
  const schemas = [
    schema({ name: 'author', fields: [{ name: 'name', type: 'string' }] }),
    schema({ name: 'book', fields: [{ name: 'title', type: 'string' }], relations: [{ field: 'authors', kind: 'manyToMany', target: 'author', inverseField: 'books' }] }),
  ];
  await setup(schemas);
  const link = linkOf(Registry.fromSchemas(schemas), 'book', 'authors');
  const a1 = await insertRow('ct_author', 'name', 'a1');
  const b1 = await insertRow('ct_book', 'title', 'b1');
  const bGone = await insertRow('ct_book', 'title', 'gone');
  await insertEdge(link, b1, a1); // valid
  await insertEdge(link, bGone, a1); // about-to-dangle on the OWNER side

  const fk = await sql<{ conname: string }[]>`
    SELECT c.conname FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = c.conkey[1]
    WHERE t.relname = ${link} AND c.contype = 'f' AND a.attname = 'owner_id'
  `;
  assert.equal(fk.length, 1, 'owner_id FK found');
  await sql.unsafe(`ALTER TABLE "${link}" DROP CONSTRAINT "${fk[0]!.conname}"`);
  await sql.unsafe(`DELETE FROM ct_book WHERE id = $1`, [bGone]);

  const engine = await boot(schemas); // must NOT throw
  const fwd = engine.relation('book', 'authors')!;
  const inv = engine.relation('author', 'books')!;
  assert.ok(fwd && inv);
  // The dangling edge is dropped from BOTH directions, so the two stay consistent (a regression that
  // pushed inv BEFORE the skip guard would leave inv.edgeCount === 2 here).
  assert.equal(fwd.edgeCount, 1, 'forward dropped the dangling edge');
  assert.equal(inv.edgeCount, 1, 'inverse ALSO dropped the dangling edge (skip both directions)');
  // The valid edge resolves in both directions.
  const dA1 = dense(engine, 'author', a1);
  const dB1 = dense(engine, 'book', b1);
  assert.deepEqual(fwd.relatedRows(dB1), [dA1], 'forward: b1 -> a1 survives');
  assert.deepEqual(inv.relatedRows(dA1), [dB1], 'inverse: a1 -> b1 survives');
});

// --- endpoint-missing defensive skip ------------------------------------------------------------

test('loadAllRelations skips (never throws) when an endpoint Table is absent from the engine', async () => {
  const schemas = [
    schema({ name: 'author', fields: [{ name: 'name', type: 'string' }] }),
    schema({ name: 'book', fields: [{ name: 'title', type: 'string' }], relations: [{ field: 'authors', kind: 'manyToMany', target: 'author', inverseField: 'books' }] }),
  ];
  await setup(schemas);
  await insertRow('ct_author', 'name', 'a1');
  await insertRow('ct_book', 'title', 'b1');

  const registry = Registry.fromSchemas(schemas);
  // Build an engine that is INTENTIONALLY missing the target endpoint: load only the owner type, leaving
  // 'author' absent. This simulates a transient engine/registry membership skew during a drop.
  const engine = new Engine();
  await loadType(sql, engine, registry.get('book')!); // owner present, target 'author' NOT loaded.

  // Must return without throwing (the engine.has endpoint guard skips the relation).
  await loadAllRelations(sql, engine, registry);
  assert.equal(engine.relation('book', 'authors'), undefined, 'relation skipped (endpoint missing)');
  assert.equal(engine.relation('author', 'books'), undefined, 'inverse skipped too');
});

// --- empty catalog ------------------------------------------------------------------------------

test('empty catalog: buildEngine succeeds, every relation lookup is undefined, a no-op rebuild is fine', async () => {
  const registry = Registry.fromSchemas([]);
  const engine = await buildEngine(sql, registry);
  assert.equal(engine.relation('nope', 'x'), undefined);
  // Re-running phase-2 on an empty engine is a clean no-op.
  await loadAllRelations(sql, engine, registry);
  assert.equal(engine.relation('nope', 'x'), undefined);
});

// --- dropType purge -----------------------------------------------------------------------------

test('dropType purges every relation referencing the dropped type (forward + inverse on the partner)', async () => {
  const schemas = [
    schema({ name: 'author', fields: [{ name: 'name', type: 'string' }] }),
    schema({ name: 'book', fields: [{ name: 'title', type: 'string' }], relations: [{ field: 'authors', kind: 'manyToMany', target: 'author', inverseField: 'books' }] }),
  ];
  await setup(schemas);
  const link = linkOf(Registry.fromSchemas(schemas), 'book', 'authors');
  const a1 = await insertRow('ct_author', 'name', 'a1');
  const b1 = await insertRow('ct_book', 'title', 'b1');
  await insertEdge(link, b1, a1);

  const engine = await boot(schemas);
  assert.ok(engine.relation('book', 'authors'));
  assert.ok(engine.relation('author', 'books'));

  // Drop the OWNER type in the engine: BOTH the forward (keyed on book) AND the inverse (keyed on the
  // surviving author) must be purged — the inverse references the dropped book table.
  engine.dropType('book');
  assert.equal(engine.relation('book', 'authors'), undefined, 'forward purged by key');
  assert.equal(engine.relation('author', 'books'), undefined, 'inverse on partner purged by endpoint');
});

// --- multiple owns / multiple targets-of --------------------------------------------------------

test('one owner with two relations: both retrievable independently', async () => {
  const schemas = [
    schema({ name: 'person', fields: [{ name: 'name', type: 'string' }] }),
    schema({
      name: 'book',
      fields: [{ name: 'title', type: 'string' }],
      relations: [
        { field: 'author', kind: 'manyToOne', target: 'person' },
        { field: 'editor', kind: 'manyToOne', target: 'person' },
      ],
    }),
  ];
  await setup(schemas);
  const registry = Registry.fromSchemas(schemas);
  const linkAuthor = linkOf(registry, 'book', 'author');
  const linkEditor = linkOf(registry, 'book', 'editor');
  const p1 = await insertRow('ct_person', 'name', 'p1');
  const p2 = await insertRow('ct_person', 'name', 'p2');
  const b1 = await insertRow('ct_book', 'title', 'b1');
  await insertEdge(linkAuthor, b1, p1);
  await insertEdge(linkEditor, b1, p2);

  const engine = await boot(schemas);
  const author = engine.relation('book', 'author')!;
  const editor = engine.relation('book', 'editor')!;
  assert.ok(author && editor);
  const dB1 = dense(engine, 'book', b1);
  assert.deepEqual(author.relatedRows(dB1), [dense(engine, 'person', p1)]);
  assert.deepEqual(editor.relatedRows(dB1), [dense(engine, 'person', p2)]);
});

test('two distinct owner types both two-way-targeting one type: both inverses independently retrievable', async () => {
  const schemas = [
    schema({ name: 'tag', fields: [{ name: 'name', type: 'string' }] }),
    schema({ name: 'book', fields: [{ name: 'title', type: 'string' }], relations: [{ field: 'tags', kind: 'manyToMany', target: 'tag', inverseField: 'books' }] }),
    schema({ name: 'article', fields: [{ name: 'headline', type: 'string' }], relations: [{ field: 'tags', kind: 'manyToMany', target: 'tag', inverseField: 'articles' }] }),
  ];
  await setup(schemas);
  const registry = Registry.fromSchemas(schemas);
  const linkBook = linkOf(registry, 'book', 'tags');
  const linkArticle = linkOf(registry, 'article', 'tags');
  const t1 = await insertRow('ct_tag', 'name', 't1');
  const b1 = await insertRow('ct_book', 'title', 'b1');
  const ar1 = await insertRow('ct_article', 'headline', 'ar1');
  await insertEdge(linkBook, b1, t1);
  await insertEdge(linkArticle, ar1, t1);

  const engine = await boot(schemas);
  const tagBooks = engine.relation('tag', 'books')!;
  const tagArticles = engine.relation('tag', 'articles')!;
  assert.ok(tagBooks && tagArticles, 'both inverses present under distinct fields on tag');
  const dT1 = dense(engine, 'tag', t1);
  assert.deepEqual(tagBooks.relatedRows(dT1), [dense(engine, 'book', b1)]);
  assert.deepEqual(tagArticles.relatedRows(dT1), [dense(engine, 'article', ar1)]);
  assert.equal(tagBooks.related, engine.table('book'));
  assert.equal(tagArticles.related, engine.table('article'));
});

// --- unpopulated read path unchanged ------------------------------------------------------------

test('declaring a relation does NOT change the unpopulated read bytes or schemaVersion', async () => {
  const authorCt = schema({ name: 'author', fields: [{ name: 'name', type: 'string' }] });
  const bookCt = schema({ name: 'book', fields: [{ name: 'title', type: 'string' }] });
  const noRel = [authorCt, bookCt];
  await setup(noRel);
  await insertRow('ct_author', 'name', 'a1');
  const b1 = await insertRow('ct_book', 'title', 'b1');

  const before = await boot(noRel);
  const beforeBytes = Buffer.from(before.respond('book'));
  const beforeVer = before.schemaVersion('book');
  const beforeById = before.respondById('book', b1)!;

  // Add a relation + edge, re-boot (the relation is declared only in this second catalog). Reuse the SAME
  // book schema (stable id/fields) so migrate's diff is exactly "add a relation", not drop+recreate the type.
  const bookWithRel: Schema = { ...bookCt, relations: [{ id: mintId('rel'), field: 'authors', kind: 'manyToMany', target: 'author', inverseField: 'books' }] };
  const withRel = [authorCt, bookWithRel];
  await migrate(sql, withRel, { allowDestructive: true });
  const link = linkOf(Registry.fromSchemas(withRel), 'book', 'authors');
  const a1pk = (await sql.unsafe<{ id: number }[]>(`SELECT id FROM ct_author LIMIT 1`))[0]!.id;
  await insertEdge(link, b1, a1pk);

  const after = await boot(withRel);
  assert.ok(Buffer.from(after.respond('book')).equals(beforeBytes), 'list response byte-identical');
  assert.equal(after.schemaVersion('book'), beforeVer, 'schemaVersion unchanged by relation load');
  assert.ok(after.respondById('book', b1)!.equals(beforeById), 'single response byte-identical');
  // The relation IS loaded though.
  assert.ok(after.relation('book', 'authors'));
});

test('loadAllRelations on an ALREADY-serving engine leaves respond/respondById bytes + schemaVersion untouched', async () => {
  const schemas = [
    schema({ name: 'author', fields: [{ name: 'name', type: 'string' }] }),
    schema({ name: 'book', fields: [{ name: 'title', type: 'string' }], relations: [{ field: 'authors', kind: 'manyToMany', target: 'author', inverseField: 'books' }] }),
  ];
  await setup(schemas);
  const registry = Registry.fromSchemas(schemas);
  const link = linkOf(registry, 'book', 'authors');
  const a1 = await insertRow('ct_author', 'name', 'a1');
  const b1 = await insertRow('ct_book', 'title', 'b1');

  // Boot ONCE and serve from this very engine; capture the unpopulated bytes + cursor sig BEFORE any edge.
  const engine = await buildEngine(sql, registry);
  const liveBytes = Buffer.from(engine.respond('book'));
  const liveVer = engine.schemaVersion('book');
  const liveById = Buffer.from(engine.respondById('book', b1)!);
  assert.equal(engine.relation('book', 'authors')!.edgeCount, 0, 'no edges yet');

  // Insert an edge in Postgres, then re-derive relations on the SAME live engine (the per-write refresh).
  await insertEdge(link, b1, a1);
  await loadAllRelations(sql, engine, registry);

  // The relation now reflects the new edge...
  assert.equal(engine.relation('book', 'authors')!.edgeCount, 1, 'edge picked up by the in-process refresh');
  // ...but the unpopulated serving path is byte-for-byte identical and the cursor sig is unchanged.
  assert.ok(Buffer.from(engine.respond('book')).equals(liveBytes), 'list bytes unchanged by in-process relation refresh');
  assert.ok(Buffer.from(engine.respondById('book', b1)!).equals(liveById), 'single bytes unchanged');
  assert.equal(engine.schemaVersion('book'), liveVer, 'schemaVersion unchanged by in-process relation refresh');
});

// --- production boot path -----------------------------------------------------------------------

test('PostgresStore.loadFromSchemas wires relations on the server boot path', async () => {
  const schemas = [
    schema({ name: 'author', fields: [{ name: 'name', type: 'string' }] }),
    schema({ name: 'book', fields: [{ name: 'title', type: 'string' }], relations: [{ field: 'authors', kind: 'manyToMany', target: 'author', inverseField: 'books' }] }),
  ];
  await setup(schemas);
  const link = linkOf(Registry.fromSchemas(schemas), 'book', 'authors');
  const a1 = await insertRow('ct_author', 'name', 'a1');
  const b1 = await insertRow('ct_book', 'title', 'b1');
  await insertEdge(link, b1, a1);

  const store = new PostgresStore(sql);
  const { engine } = await store.loadFromSchemas(schemas);
  const r = engine.relation('book', 'authors')!;
  assert.ok(r, 'relation loaded via the production loadFromSchemas path');
  assert.deepEqual(r.relatedRows(dense(engine, 'book', b1)), [dense(engine, 'author', a1)]);
  assert.ok(engine.relation('author', 'books'), 'inverse loaded too');
});

// --- boot vs boot-then-rebuild parity -----------------------------------------------------------

test('boot vs boot-then-rebuild parity: identical adjacency for identical data', async () => {
  const schemas = [
    schema({ name: 'author', fields: [{ name: 'name', type: 'string' }] }),
    schema({ name: 'book', fields: [{ name: 'title', type: 'string' }], relations: [{ field: 'authors', kind: 'manyToMany', target: 'author', inverseField: 'books' }] }),
  ];
  await setup(schemas);
  const registry = Registry.fromSchemas(schemas);
  const link = linkOf(registry, 'book', 'authors');
  const a1 = await insertRow('ct_author', 'name', 'a1');
  const a2 = await insertRow('ct_author', 'name', 'a2');
  const b1 = await insertRow('ct_book', 'title', 'b1');
  const b2 = await insertRow('ct_book', 'title', 'b2');
  await insertEdge(link, b1, a1);
  await insertEdge(link, b1, a2);
  await insertEdge(link, b2, a1);

  // Fresh boot.
  const fresh = await boot(schemas);

  // Boot then rebuild book (no DB change) -> the shared routine must land on the SAME adjacency.
  const rebuilt = await buildEngine(sql, registry);
  await rebuildType(sql, rebuilt, registry.get('book')!, registry);

  const asAdj = (engine: Engine): string => {
    const r = engine.relation('book', 'authors')!;
    const inv = engine.relation('author', 'books')!;
    const f = [b1, b2].map((b) => sorted(r.relatedRows(dense(engine, 'book', b))).join(','));
    const i = [a1, a2].map((a) => sorted(inv.relatedRows(dense(engine, 'author', a))).join(','));
    return JSON.stringify({ f, i });
  };
  assert.equal(asAdj(rebuilt), asAdj(fresh), 'rebuild yields identical adjacency to a fresh boot');
});

// --- dropContentType end-to-end (DB drop + engine drop purge) -----------------------------------

test('dropContentType then dropType: catalog + engine relation store both clean', async () => {
  const schemas = [
    schema({ name: 'author', fields: [{ name: 'name', type: 'string' }] }),
    schema({ name: 'book', fields: [{ name: 'title', type: 'string' }], relations: [{ field: 'authors', kind: 'manyToMany', target: 'author', inverseField: 'books' }] }),
  ];
  await setup(schemas);

  const engine = await boot(schemas);
  assert.ok(engine.relation('book', 'authors'));

  // Declarative drop: re-migrate to the author-only catalog -> diff drops ct_book + link + the inverse on author.
  const authorOnly = [schemas[0]!];
  await migrate(sql, authorOnly, { allowDestructive: true });
  engine.dropType('book');

  // A fresh boot reflects the DB drop: author has no relations now.
  const rebooted = await boot(authorOnly);
  assert.equal(rebooted.relation('author', 'books'), undefined, 'inverse gone after owner DB drop');
  assert.equal(rebooted.has('book'), false);
});
