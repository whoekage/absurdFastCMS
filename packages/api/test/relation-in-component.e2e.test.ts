import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Sql } from 'postgres';
import type { ComponentSchema, Schema, FieldSchema, FieldType } from '../src/db/schema/model.ts';
import type { FieldOptions } from '../src/db/type.catalog.ts';

const { runMigrations } = await import('../src/db/migration.runner.ts');
const { createFileDatabase, dropFileDatabase } = await import('./db-per-file.ts');
const { cleanCatalog, schema, startTestServerFromSchemas } = await import('./helpers.ts');
const { mintId } = await import('../src/db/schema/model.ts');
const { migrate } = await import('../src/db/schema/migrate.ts');

/**
 * be-05b RELATION-INSIDE-COMPONENT — INLINE relation refs inside components, end-to-end over a REAL uWS
 * server + REAL Postgres (per-file clone), NO MOCKS. Proves:
 *  - a `relation` field inside a SINGLE / REPEATABLE / DYNAMIC-ZONE component stores inline id ref(s) to a
 *    TARGET content-type (NOT a link table) and reads back VERBATIM un-populated;
 *  - write existence-check: a dangling id -> 400; a wrong-target id (exists in another type, not the
 *    declared target) -> 400; single vs many cardinality enforced;
 *  - read populate: a single ref -> the resolved target OBJECT (or null when dangling), a many ref -> an
 *    ARRAY of resolved objects (a dangling/invisible id DROPPED);
 *  - target VISIBILITY: a DRAFT target resolves to null/dropped (default published-only); an i18n target
 *    resolves in the default locale;
 *  - a component WITHOUT a relation-ref field + a non-component type read byte-identically (untouched);
 *  - the files-first migrate REJECTS a top-level `relation` field (the be-05b component-only guard).
 *
 * MIGRATION NOTE (legacy-meta teardown): the original R0 ('a component relation field whose target
 * content-type does not exist is rejected at component-type DEFINITION') asserted the legacy
 * POST /component-types controller's definition-time validation. The files-first path (Registry.fromSchemas)
 * does not re-validate a component relation target at definition; runtime safety is instead covered by the
 * write-time existence checks below (R2 dangling id, R2b wrong-target id). R0 had no files-first analog and
 * retired with its controller. R0b (top-level relation field) DID survive — it is ported to a migrate()
 * rejection via the kept `rejectTopLevelRelation` guard.
 */

let sql: Sql;
let db: Awaited<ReturnType<typeof createFileDatabase>>;
let base: string;
let close: (token: unknown) => void;
let token: unknown;

/** Build an in-memory ComponentSchema (mints the component + field ids). Fields use the files-first `type`. */
function component(apiId: string, fields: { name: string; type: FieldType; options?: FieldOptions }[]): ComponentSchema {
  return { id: mintId('cmp'), apiId, fields: fields.map((f): FieldSchema => ({ id: mintId('f'), ...f })) };
}

/** Per-test files-first server: each test owns its host modules + in-memory components. */
async function boot(schemas: Schema[], components: ComponentSchema[] = []): Promise<void> {
  const srv = await startTestServerFromSchemas(sql, schemas, { components });
  base = srv.base;
  close = srv.close;
  token = srv.token;
}

before(async () => {
  db = await createFileDatabase('relincmp');
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
});

const POST = (p: string, body: unknown) => fetch(`${base}${p}`, { method: 'POST', body: JSON.stringify(body) });
const GET = (p: string) => fetch(`${base}${p}`);

/** The `author` target content-type as a files-first IR. */
const authorType = schema({ apiId: 'author', fields: [{ name: 'name', cmsType: 'string', options: { nullable: false } }] });

/** Create two `author` rows over the live write path; returns their ids (the type is pre-built per test). */
async function seedAuthorRows(): Promise<{ a1: number; a2: number }> {
  const a1 = ((await (await POST('/author', { name: 'Ada' })).json()) as { data: { id: number } }).data.id;
  const a2 = ((await (await POST('/author', { name: 'Alan' })).json()) as { data: { id: number } }).data.id;
  return { a1, a2 };
}

// --- R0b: a `relation` field is COMPONENT-ONLY (no top-level content-type form) -----------------
// be-05b GUARD ported to the files-first path: `relation` is a ComponentFieldKind, but unlike
// component/component-repeatable/dynamiczone it has NO top-level form — an inline ref only lives inside a
// component json. A top-level `relation` field is rejected by resolveFields -> rejectTopLevelRelation,
// which migrate() runs (replacing the legacy POST /modules + addField controller guards).
test('R0b a top-level `relation` field is rejected by the files-first migrate (component-only kind)', async () => {
  const bad = schema({ apiId: 'post', fields: [{ name: 'writer', cmsType: 'relation', options: { target: 'author' } }] });
  await assert.rejects(migrate(sql, [bad], { allowDestructive: true }), /relation/i);
});

// --- R1: SINGLE relation ref inside a single component — store, read verbatim, populate --------
test('R1 single relation ref inside a single component: stored inline, read verbatim, populated on read', async () => {
  const byline = component('byline', [
    { name: 'role', type: 'string' },
    { name: 'writer', type: 'relation', options: { target: 'author' } },
  ]);
  const post = schema({ apiId: 'post', fields: [{ name: 'by', cmsType: 'component', options: { component: 'byline' } }] });
  await boot([authorType, post], [byline]);
  const { a1 } = await seedAuthorRows();

  // A valid ref -> stored as the bare id un-populated.
  const created = (await (await POST('/post', { by: { role: 'lead', writer: a1 } })).json()) as {
    data: { id: number; by: { id: number; writer: number } };
  };
  assert.equal(created.data.by.writer, a1);

  const plain = (await (await GET(`/post/${created.data.id}`)).json()) as { data: { by: { writer: number } } };
  assert.equal(plain.data.by.writer, a1); // un-populated: raw id.

  // Populated GET: the target OBJECT inlined inside the component, in place of the id.
  const pop = (await (await GET(`/post/${created.data.id}?populate=by`)).json()) as {
    data: { by: { writer: { id: number; name: string } } };
  };
  assert.equal(pop.data.by.writer.id, a1);
  assert.equal(pop.data.by.writer.name, 'Ada');
});

// --- R2: dangling id -> 400 --------------------------------------------------------------------
test('R2 a dangling relation id is rejected on write (400)', async () => {
  const byline = component('byline', [{ name: 'writer', type: 'relation', options: { target: 'author' } }]);
  const post = schema({ apiId: 'post', fields: [{ name: 'by', cmsType: 'component', options: { component: 'byline' } }] });
  await boot([authorType, post], [byline]);
  await seedAuthorRows();
  const dangling = await POST('/post', { by: { writer: 999999 } });
  const dText = await dangling.text();
  assert.equal(dangling.status, 400, dText);
  assert.match((JSON.parse(dText) as { error: string }).error, /unknown author id/i);
});

// --- R2b: wrong-target id deterministically rejected -------------------------------------------
test('R2b a wrong-target id that does not exist in the declared target is rejected (400)', async () => {
  const byline = component('byline', [{ name: 'writer', type: 'relation', options: { target: 'author' } }]);
  const tag = schema({ apiId: 'tag', fields: [{ name: 'slug', cmsType: 'string', options: { nullable: false } }] });
  const post = schema({ apiId: 'post', fields: [{ name: 'by', cmsType: 'component', options: { component: 'byline' } }] });
  await boot([authorType, tag, post], [byline]);
  await seedAuthorRows(); // authors have ids 1,2.
  // Make a tag with an id guaranteed beyond the author id space (insert 5 tags -> ids 1..5).
  let tagId = 0;
  for (let i = 0; i < 5; i++) tagId = ((await (await POST('/tag', { slug: `t${i}` })).json()) as { data: { id: number } }).data.id;
  assert.ok(tagId > 2, `expected a tag id beyond author ids, got ${tagId}`);

  const wrong = await POST('/post', { by: { writer: tagId } }); // exists in `tag`, NOT in `author`.
  const wText = await wrong.text();
  assert.equal(wrong.status, 400, wText);
  assert.match((JSON.parse(wText) as { error: string }).error, /unknown author id/i);
});

// --- R3: MANY relation refs (cardinality) ------------------------------------------------------
test('R3 many relation refs inside a component: array stored, populated to an array of objects', async () => {
  const credits = component('credits', [{ name: 'writers', type: 'relation', options: { target: 'author', multiple: true } }]);
  const one = component('one', [{ name: 'w', type: 'relation', options: { target: 'author' } }]);
  const post = schema({ apiId: 'post', fields: [{ name: 'credits', cmsType: 'component', options: { component: 'credits' } }] });
  const solo = schema({ apiId: 'solo', fields: [{ name: 'one', cmsType: 'component', options: { component: 'one' } }] });
  await boot([authorType, post, solo], [credits, one]);
  const { a1, a2 } = await seedAuthorRows();

  const created = (await (await POST('/post', { credits: { writers: [a1, a2] } })).json()) as {
    data: { id: number; credits: { writers: number[] } };
  };
  assert.deepEqual(created.data.credits.writers, [a1, a2]);

  const pop = (await (await GET(`/post/${created.data.id}?populate=credits`)).json()) as {
    data: { credits: { writers: { id: number; name: string }[] } };
  };
  assert.deepEqual(pop.data.credits.writers.map((w) => w.name), ['Ada', 'Alan']);

  // A single id supplied to a MANY field is accepted (coerceRelationRef accepts a bare id for many).
  const single = await POST('/post', { credits: { writers: a1 } });
  assert.ok(single.status === 201, await single.text());

  // A single-valued field receiving an array of 2 -> 400.
  const tooMany = await POST('/solo', { one: { w: [a1, a2] } });
  assert.equal(tooMany.status, 400, await tooMany.text());
});

// --- R4: relation ref inside a REPEATABLE component + a DYNAMIC ZONE block ----------------------
test('R4 relation refs inside a repeatable component and a dynamic-zone block populate correctly', async () => {
  const row = component('row', [{ name: 'writer', type: 'relation', options: { target: 'author' } }]);
  const authorBlock = component('authorBlock', [{ name: 'writer', type: 'relation', options: { target: 'author' } }]);
  const rep = schema({ apiId: 'rep', fields: [{ name: 'rows', cmsType: 'component-repeatable', options: { component: 'row' } }] });
  const zoned = schema({ apiId: 'zoned', fields: [{ name: 'body', cmsType: 'dynamiczone', options: { components: ['authorBlock'] } }] });
  await boot([authorType, rep, zoned], [row, authorBlock]);
  const { a1, a2 } = await seedAuthorRows();

  const repRow = (await (await POST('/rep', { rows: [{ writer: a1 }, { writer: a2 }] })).json()) as { data: { id: number } };
  const repPop = (await (await GET(`/rep/${repRow.data.id}?populate=rows`)).json()) as {
    data: { rows: { writer: { id: number } | null }[] };
  };
  assert.equal(repPop.data.rows[0]!.writer!.id, a1);
  assert.equal(repPop.data.rows[1]!.writer!.id, a2);

  // Dynamic zone: a block carrying a relation ref.
  const z = (await (await POST('/zoned', { body: [{ __component: 'authorBlock', writer: a1 }] })).json()) as { data: { id: number } };
  const zPop = (await (await GET(`/zoned/${z.data.id}?populate=body`)).json()) as {
    data: { body: { __component: string; writer: { id: number; name: string } }[] };
  };
  assert.equal(zPop.data.body[0]!.__component, 'authorBlock');
  assert.equal(zPop.data.body[0]!.writer.id, a1);
  assert.equal(zPop.data.body[0]!.writer.name, 'Ada');
});

// --- R5: dangling ref resolves to null (single) / dropped (many) on read -----------------------
test('R5 a ref that becomes dangling resolves to null (single) and is dropped (many) on read', async () => {
  const credits = component('credits', [
    { name: 'lead', type: 'relation', options: { target: 'author' } },
    { name: 'team', type: 'relation', options: { target: 'author', multiple: true } },
  ]);
  const post = schema({ apiId: 'post', fields: [{ name: 'credits', cmsType: 'component', options: { component: 'credits' } }] });
  await boot([authorType, post], [credits]);
  const { a1, a2 } = await seedAuthorRows();
  const created = (await (await POST('/post', { credits: { lead: a1, team: [a1, a2] } })).json()) as { data: { id: number } };

  // Delete a2 -> the inline id is now dangling (the stored json still holds it).
  const del = await fetch(`${base}/author/${a2}`, { method: 'DELETE' });
  assert.equal(del.status, 200, await del.text());

  const pop = (await (await GET(`/post/${created.data.id}?populate=credits`)).json()) as {
    data: { credits: { lead: { id: number } | null; team: { id: number }[] } };
  };
  assert.equal(pop.data.credits.lead!.id, a1); // still present.
  assert.deepEqual(pop.data.credits.team.map((w) => w.id), [a1]); // a2 dropped from the array.

  // Now delete a1 too -> the single lead resolves to null.
  await fetch(`${base}/author/${a1}`, { method: 'DELETE' });
  const pop2 = (await (await GET(`/post/${created.data.id}?populate=credits`)).json()) as {
    data: { credits: { lead: unknown; team: unknown[] } };
  };
  assert.equal(pop2.data.credits.lead, null);
  assert.deepEqual(pop2.data.credits.team, []);
});

// --- R6: draft target resolves to null (default published-only) --------------------------------
test('R6 a DRAFT target resolves to null on read (default published-only visibility)', async () => {
  // author opts into draft/publish.
  const author = schema({ apiId: 'author', fields: [{ name: 'name', cmsType: 'string', options: { nullable: false } }], draftPublish: true });
  const byline = component('byline', [{ name: 'writer', type: 'relation', options: { target: 'author' } }]);
  const post = schema({ apiId: 'post', fields: [{ name: 'by', cmsType: 'component', options: { component: 'byline' } }] });
  await boot([author, post], [byline]);
  const a1 = ((await (await POST('/author', { name: 'Draftee' })).json()) as { data: { id: number } }).data.id; // created as DRAFT.
  const created = (await (await POST('/post', { by: { writer: a1 } })).json()) as { data: { id: number } };

  // Draft target -> resolves to null (a default GET would not see it).
  const draftPop = (await (await GET(`/post/${created.data.id}?populate=by`)).json()) as { data: { by: { writer: unknown } } };
  assert.equal(draftPop.data.by.writer, null);

  // Publish the author -> now it resolves.
  const pub = await POST(`/author/${a1}/actions/publish`, {});
  assert.equal(pub.status, 200, await pub.text());
  const pubPop = (await (await GET(`/post/${created.data.id}?populate=by`)).json()) as { data: { by: { writer: { id: number; name: string } } } };
  assert.equal(pubPop.data.by.writer.id, a1);
  assert.equal(pubPop.data.by.writer.name, 'Draftee');
});

// --- R7: i18n target resolves in the default locale --------------------------------------------
test('R7 an i18n target resolves in the default locale on read', async () => {
  const author = schema({ apiId: 'author', fields: [{ name: 'name', cmsType: 'string', options: { nullable: false }, localized: true }], i18n: true });
  const byline = component('byline', [{ name: 'writer', type: 'relation', options: { target: 'author' } }]);
  const post = schema({ apiId: 'post', fields: [{ name: 'by', cmsType: 'component', options: { component: 'byline' } }] });
  await boot([author, post], [byline]);
  const a1 = ((await (await POST('/author', { name: 'Ada (en)' })).json()) as { data: { id: number } }).data.id; // default-locale variant.
  const created = (await (await POST('/post', { by: { writer: a1 } })).json()) as { data: { id: number } };

  const pop = (await (await GET(`/post/${created.data.id}?populate=by`)).json()) as { data: { by: { writer: { id: number; name: string; locale: string } } } };
  assert.equal(pop.data.by.writer.id, a1);
  assert.equal(pop.data.by.writer.name, 'Ada (en)');
});

// --- R8: BYTE-IDENTICAL — un-populated read emits the bare id(s) verbatim -----------------------
test('R8 an un-populated read emits the bare relation id(s) verbatim (zero-copy structural tree)', async () => {
  const credits = component('credits', [
    { name: 'lead', type: 'relation', options: { target: 'author' } },
    { name: 'team', type: 'relation', options: { target: 'author', multiple: true } },
  ]);
  const post = schema({ apiId: 'post', fields: [{ name: 'credits', cmsType: 'component', options: { component: 'credits' } }] });
  await boot([authorType, post], [credits]);
  const { a1, a2 } = await seedAuthorRows();
  const created = (await (await POST('/post', { credits: { lead: a1, team: [a1, a2] } })).json()) as { data: { id: number } };

  const raw = await (await GET(`/post/${created.data.id}`)).text();
  assert.match(raw, new RegExp(`"lead":\\s*${a1}\\b`)); // bare id, not an object.
  assert.match(raw, new RegExp(`"team":\\s*\\[\\s*${a1}\\s*,\\s*${a2}\\s*\\]`)); // bare id array.
});

// --- R9: a component WITHOUT a relation-ref field is unaffected ---------------------------------
test('R9 a component without a relation-ref field reads identically (no relation populate effect)', async () => {
  const seo = component('seo', [{ name: 'metaTitle', type: 'string' }]);
  const page = schema({ apiId: 'page', fields: [{ name: 'seo', cmsType: 'component', options: { component: 'seo' } }] });
  await boot([page], [seo]);
  const created = (await (await POST('/page', { seo: { metaTitle: 'Hi' } })).json()) as { data: { id: number } };
  const plain = await (await GET(`/page/${created.data.id}`)).text();
  const withPop = await (await GET(`/page/${created.data.id}?populate=seo`)).text();
  // The component tree is parsed/re-serialized when populated, but with no media/relation field inside it,
  // the spliced object is identical -> the data payload matches (key order preserved by serializeRow).
  const plainData = JSON.parse(plain) as { data: unknown };
  const popData = JSON.parse(withPop) as { data: unknown };
  assert.deepEqual(popData.data, plainData.data);
});

// --- R10: a non-component type is byte-identical (relation-ref machinery never runs) ------------
test('R10 a non-component content type is byte-identical (relation-ref machinery never runs)', async () => {
  const plainType = schema({ apiId: 'plain', fields: [{ name: 'title', cmsType: 'string', options: { nullable: false } }] });
  await boot([plainType]);
  const created = (await (await POST('/plain', { title: 'T' })).json()) as { data: { id: number } };
  const plain = await (await GET(`/plain/${created.data.id}`)).text();
  const withPop = await (await GET(`/plain/${created.data.id}?populate=*`)).text();
  assert.equal(plain, withPop); // identical bytes (no component/media field => post-step skipped).
});
