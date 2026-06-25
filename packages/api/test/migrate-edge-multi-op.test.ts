import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Sql } from 'postgres';
import { migrate, MigrationBlockedError } from '../src/db/schema/migrate.ts';
import type { Schema, FieldSchema, FieldType } from '../src/db/schema/model.ts';
import type { FieldOptions } from '../src/db/type.catalog.ts';
import { createFileDatabase, dropFileDatabase } from './db-per-file.ts';
import { cleanCatalog, physicalColumns, tableExists } from './helpers.ts';

/**
 * S4 migrate engine — MULTI-OP edge cases against REAL Postgres (no mocks). Goes deeper than
 * schema-migrate.test.ts (single-op happy path): MANY ops in ONE migrate applied atomically with the
 * topological order intact, TWO new types created in one migrate, and ONE migrate touching MULTIPLE
 * existing types at once. Cardinal rule: INSERT REAL ROWS, migrate, then SELECT and ASSERT the actual
 * data survived (renamed + retyped values + backfilled new columns) — never "a column exists".
 */

const f = (id: string, name: string, type: FieldType, options?: FieldOptions): FieldSchema =>
  options ? { id, name, type, options } : { id, name, type };
const schema = (id: string, apiId: string, fields: FieldSchema[]): Schema => ({ id, apiId, fields });

let sql: Sql;
let db: Awaited<ReturnType<typeof createFileDatabase>>;

before(async () => {
  db = await createFileDatabase('edgemulti-op');
  sql = db.sql;
});
beforeEach(async () => {
  await cleanCatalog(sql); // drops ct_ tables (CASCADE also drops their link tables)
  await sql`DROP TABLE IF EXISTS _schema_applied`;
});
after(async () => {
  if (sql) await sql.end();
  if (db) await dropFileDatabase(db.name);
});

test('ONE migrate: rename A + add B(default) + retype C — applied atomically, ALL data preserved', async () => {
  // Seed: title (string), note (text), views (integer). Insert one real row.
  await migrate(sql, [
    schema('ct_a', 'thing', [
      f('f_t', 'title', 'string', { nullable: true }),
      f('f_n', 'note', 'text', { nullable: true }),
      f('f_v', 'views', 'integer', { nullable: true }),
    ]),
  ]);
  await sql.unsafe(`INSERT INTO ct_thing (title, note, views) VALUES ('seed-title', 'seed-note', 7)`);

  // One migrate that: renames f_t title->headline, ADDS f_a active boolean NOT NULL DEFAULT false,
  // RETYPES f_v views integer->biginteger (widening). retype is data-dependent => needs the ack.
  const next = [
    schema('ct_a', 'thing', [
      f('f_t', 'headline', 'string', { nullable: true }), // rename (same id f_t)
      f('f_n', 'note', 'text', { nullable: true }),
      f('f_v', 'views', 'biginteger', { nullable: true }), // retype (same id f_v)
      f('f_a', 'active', 'boolean', { nullable: false, default: false }), // add with default (backfill)
    ]),
  ];
  const r = await migrate(sql, next, { allowDestructive: true });
  const kinds = r.applied.map((c) => c.kind);
  assert.ok(kinds.includes('renameField'), 'emitted renameField');
  assert.ok(kinds.includes('retypeField'), 'emitted retypeField');
  assert.ok(kinds.includes('addField'), 'emitted addField');
  assert.equal(kinds.length, 3, 'exactly the three ops, nothing spurious');

  // Physical shape: renamed away from title, gained headline + active; note + views still there.
  const cols = (await physicalColumns(sql, 'ct_thing')).map((c) => c.name);
  assert.ok(cols.includes('headline') && !cols.includes('title'), 'renamed, not dropped+added');
  assert.ok(cols.includes('active') && cols.includes('note') && cols.includes('views'));

  // THE DATA: the renamed value, the retyped value, the untouched value, and the backfilled new column.
  const [row] = await sql<{ headline: string; note: string; views: string; active: boolean }[]>`
    SELECT headline, note, views, active FROM ct_thing
  `;
  assert.equal(row?.headline, 'seed-title'); // survived the RENAME
  assert.equal(row?.note, 'seed-note'); // untouched
  assert.equal(String(row?.views), '7'); // survived the RETYPE cast (int -> bigint)
  assert.equal(row?.active, false); // existing row BACKFILLED to the default

  // views is now genuinely a bigint: a value beyond int4 range must round-trip.
  await sql.unsafe(`UPDATE ct_thing SET views = 5000000000 WHERE headline = 'seed-title'`);
  const [big] = await sql<{ views: string }[]>`SELECT views FROM ct_thing`;
  assert.equal(String(big?.views), '5000000000');
});

test('ONE migrate gated as a whole: a data-dependent op blocks WITHOUT ack — nothing changes', async () => {
  await migrate(sql, [
    schema('ct_a', 'thing', [
      f('f_t', 'title', 'string', { nullable: true }),
      f('f_v', 'views', 'integer', { nullable: true }),
    ]),
  ]);
  await sql.unsafe(`INSERT INTO ct_thing (title, views) VALUES ('keep', 3)`);

  // Mix a SAFE rename with a DATA-DEPENDENT retype. Without allowDestructive the whole migrate blocks,
  // and (critically) the safe rename must NOT have applied — the apply is all-or-nothing.
  const next = [
    schema('ct_a', 'thing', [
      f('f_t', 'headline', 'string', { nullable: true }), // safe rename
      f('f_v', 'views', 'biginteger', { nullable: true }), // data-dependent retype -> blocks
    ]),
  ];
  await assert.rejects(migrate(sql, next), MigrationBlockedError);

  const cols = (await physicalColumns(sql, 'ct_thing')).map((c) => c.name);
  assert.ok(cols.includes('title') && !cols.includes('headline'), 'safe rename did NOT leak through the block');
  const [row] = await sql<{ title: string; views: number }[]>`SELECT title, views FROM ct_thing`;
  assert.equal(row?.title, 'keep');
  assert.equal(row?.views, 3);
});

test('ONE migrate creates TWO new types at once — both tables exist, both take rows independently', async () => {
  const next = [
    schema('ct_a', 'author', [
      f('f_n', 'name', 'string', { nullable: false, default: 'anon' }),
      f('f_b', 'bio', 'text', { nullable: true }),
    ]),
    schema('ct_b', 'tag', [
      f('f_l', 'label', 'string', { nullable: true }),
      f('f_c', 'count', 'integer', { nullable: false, default: 0 }),
    ]),
  ];
  const r = await migrate(sql, next);
  const addTypes = r.applied.filter((c) => c.kind === 'addType');
  assert.equal(addTypes.length, 2, 'both addType ops in one change-set');
  assert.equal(await tableExists(sql, 'ct_author'), true);
  assert.equal(await tableExists(sql, 'ct_tag'), true);

  // Each table is independently writable with its declared columns + defaults.
  const [a] = await sql<{ name: string; bio: string | null }[]>`
    INSERT INTO ct_author (bio) VALUES ('a writer') RETURNING name, bio
  `;
  assert.equal(a?.name, 'anon'); // NOT NULL default backfill on a brand-new type
  assert.equal(a?.bio, 'a writer');
  const [t] = await sql<{ label: string; count: number }[]>`
    INSERT INTO ct_tag (label) VALUES ('news') RETURNING label, count
  `;
  assert.equal(t?.label, 'news');
  assert.equal(t?.count, 0);

  // Idempotent re-run after both creates.
  assert.equal((await migrate(sql, next)).noop, true);
});

test('ONE migrate touches MULTIPLE existing types at once — each independently migrated, all data intact', async () => {
  // Two pre-existing types, each with a seeded row.
  await migrate(sql, [
    schema('ct_a', 'author', [
      f('f_n', 'name', 'string', { nullable: true }),
      f('f_v', 'visits', 'integer', { nullable: true }),
    ]),
    schema('ct_b', 'tag', [f('f_l', 'label', 'string', { nullable: true })]),
  ]);
  await sql.unsafe(`INSERT INTO ct_author (name, visits) VALUES ('grace', 11)`);
  await sql.unsafe(`INSERT INTO ct_tag (label) VALUES ('eng')`);

  // ONE migrate: author renames name->fullname AND retypes visits->biginteger; tag adds slug(default)
  // AND renames label->title. Different op mixes across two tables, all in one atomic change-set.
  const next = [
    schema('ct_a', 'author', [
      f('f_n', 'fullname', 'string', { nullable: true }), // rename on author
      f('f_v', 'visits', 'biginteger', { nullable: true }), // retype on author (data-dependent)
    ]),
    schema('ct_b', 'tag', [
      f('f_l', 'title', 'string', { nullable: true }), // rename on tag
      f('f_s', 'slug', 'string', { nullable: false, default: 'untitled' }), // add on tag
    ]),
  ];
  const r = await migrate(sql, next, { allowDestructive: true });
  const kinds = r.applied.map((c) => c.kind).sort();
  assert.deepEqual(kinds, ['addField', 'renameField', 'renameField', 'retypeField'].sort());

  // author data survived rename + retype.
  const aCols = (await physicalColumns(sql, 'ct_author')).map((c) => c.name);
  assert.ok(aCols.includes('fullname') && !aCols.includes('name'));
  const [author] = await sql<{ fullname: string; visits: string }[]>`SELECT fullname, visits FROM ct_author`;
  assert.equal(author?.fullname, 'grace');
  assert.equal(String(author?.visits), '11');

  // tag data survived rename, and the new column backfilled.
  const tCols = (await physicalColumns(sql, 'ct_tag')).map((c) => c.name);
  assert.ok(tCols.includes('title') && tCols.includes('slug') && !tCols.includes('label'));
  const [tag] = await sql<{ title: string; slug: string }[]>`SELECT title, slug FROM ct_tag`;
  assert.equal(tag?.title, 'eng');
  assert.equal(tag?.slug, 'untitled');
});

test('ONE migrate touching multiple types where ONE blocks: the OTHER type is NOT partially applied', async () => {
  await migrate(sql, [
    schema('ct_a', 'author', [f('f_n', 'name', 'string', { nullable: true }), f('f_x', 'extra', 'text', { nullable: true })]),
    schema('ct_b', 'tag', [f('f_l', 'label', 'string', { nullable: true })]),
  ]);
  await sql.unsafe(`INSERT INTO ct_author (name, extra) VALUES ('keep-me', 'kept')`);
  await sql.unsafe(`INSERT INTO ct_tag (label) VALUES ('kept-tag')`);

  // author: a SAFE rename (name->handle). tag: a DESTRUCTIVE drop (label removed). Without the ack the
  // whole migrate blocks; the safe rename on the OTHER table must NOT have applied.
  const next = [
    schema('ct_a', 'author', [f('f_n', 'handle', 'string', { nullable: true }), f('f_x', 'extra', 'text', { nullable: true })]),
    schema('ct_b', 'tag', []), // drops f_l -> destructive
  ];
  await assert.rejects(migrate(sql, next), MigrationBlockedError);

  const aCols = (await physicalColumns(sql, 'ct_author')).map((c) => c.name);
  assert.ok(aCols.includes('name') && !aCols.includes('handle'), 'cross-type safe op did not leak through');
  const tCols = (await physicalColumns(sql, 'ct_tag')).map((c) => c.name);
  assert.ok(tCols.includes('label'), 'blocked drop left the column in place');
  const [author] = await sql<{ name: string; extra: string }[]>`SELECT name, extra FROM ct_author`;
  assert.equal(author?.name, 'keep-me');
  assert.equal(author?.extra, 'kept');
});

test('ROLLBACK on a failing cast: a multi-op migrate aborts mid-way, NO op partially applied', async () => {
  // views holds a non-numeric string; retyping string -> integer will fail the USING cast at apply time.
  await migrate(sql, [
    schema('ct_a', 'thing', [
      f('f_t', 'title', 'string', { nullable: true }),
      f('f_v', 'views', 'string', { nullable: true }),
    ]),
  ]);
  await sql.unsafe(`INSERT INTO ct_thing (title, views) VALUES ('orig', 'not-a-number')`);

  // Mix: a safe rename (title->headline), an add (active), and a retype whose cast will EXPLODE on the row.
  // The retype is data-dependent so we must ack it; the failure then comes from Postgres at apply time,
  // which must roll back the WHOLE tx (rename + add included), leaving the table byte-identical.
  const next = [
    schema('ct_a', 'thing', [
      f('f_t', 'headline', 'string', { nullable: true }),
      f('f_v', 'views', 'integer', { nullable: true }), // string -> integer, cast fails on 'not-a-number'
      f('f_a', 'active', 'boolean', { nullable: false, default: false }),
    ]),
  ];
  await assert.rejects(migrate(sql, next, { allowDestructive: true }));

  // Nothing applied: original column names, no new column, original data.
  const cols = (await physicalColumns(sql, 'ct_thing')).map((c) => c.name);
  assert.ok(cols.includes('title') && cols.includes('views'), 'rename rolled back');
  assert.ok(!cols.includes('headline') && !cols.includes('active'), 'add + rename rolled back');
  const [row] = await sql<{ title: string; views: string }[]>`SELECT title, views FROM ct_thing`;
  assert.equal(row?.title, 'orig');
  assert.equal(row?.views, 'not-a-number');

  // _schema_applied must NOT have been advanced — the still-current schema re-migrates cleanly afterwards
  // (proving the snapshot was not corrupted by the rolled-back attempt).
  const recover = await migrate(sql, [
    schema('ct_a', 'thing', [
      f('f_t', 'title', 'string', { nullable: true }),
      f('f_v', 'views', 'string', { nullable: true }),
    ]),
  ]);
  assert.equal(recover.noop, true, 'snapshot intact: original schema is still the applied state');
});

test('ONE migrate: create a NEW type AND alter an EXISTING type together — both land, data on the old type intact', async () => {
  await migrate(sql, [schema('ct_a', 'author', [f('f_n', 'name', 'string', { nullable: true })])]);
  await sql.unsafe(`INSERT INTO ct_author (name) VALUES ('existing')`);

  // One migrate that BOTH creates ct_tag AND renames author.name->handle + adds author.bio(default).
  const next = [
    schema('ct_a', 'author', [
      f('f_n', 'handle', 'string', { nullable: true }), // rename existing
      f('f_b', 'bio', 'text', { nullable: false, default: 'n/a' }), // add to existing
    ]),
    schema('ct_b', 'tag', [f('f_l', 'label', 'string', { nullable: true })]), // brand-new type
  ];
  const r = await migrate(sql, next);
  const kinds = r.applied.map((c) => c.kind);
  assert.ok(kinds.includes('addType') && kinds.includes('renameField') && kinds.includes('addField'));

  assert.equal(await tableExists(sql, 'ct_tag'), true);
  const aCols = (await physicalColumns(sql, 'ct_author')).map((c) => c.name);
  assert.ok(aCols.includes('handle') && aCols.includes('bio') && !aCols.includes('name'));
  const [author] = await sql<{ handle: string; bio: string }[]>`SELECT handle, bio FROM ct_author`;
  assert.equal(author?.handle, 'existing'); // renamed value preserved
  assert.equal(author?.bio, 'n/a'); // existing row backfilled

  assert.equal((await migrate(sql, next)).noop, true); // idempotent across the mixed create+alter
});

test('MANY ops, MANY rows: rename + retype + add over a multi-row table — every row preserved + backfilled', async () => {
  await migrate(sql, [
    schema('ct_a', 'thing', [
      f('f_t', 'title', 'string', { nullable: true }),
      f('f_v', 'views', 'integer', { nullable: true }),
    ]),
  ]);
  await sql.unsafe(`INSERT INTO ct_thing (title, views) VALUES ('one', 1), ('two', 2), ('three', 3)`);

  const next = [
    schema('ct_a', 'thing', [
      f('f_t', 'headline', 'string', { nullable: true }), // rename
      f('f_v', 'views', 'biginteger', { nullable: true }), // retype widening
      f('f_a', 'archived', 'boolean', { nullable: false, default: false }), // add w/ default
    ]),
  ];
  await migrate(sql, next, { allowDestructive: true });

  const rows = await sql<{ headline: string; views: string; archived: boolean }[]>`
    SELECT headline, views, archived FROM ct_thing ORDER BY views
  `;
  assert.equal(rows.length, 3, 'no rows lost across the multi-op migrate');
  assert.deepEqual(rows.map((r) => r.headline), ['one', 'two', 'three']);
  assert.deepEqual(rows.map((r) => String(r.views)), ['1', '2', '3']);
  assert.deepEqual(rows.map((r) => r.archived), [false, false, false]); // every row backfilled
});
