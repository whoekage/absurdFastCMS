import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Sql } from 'postgres';

const { runMigrations } = await import('../src/db/migration.runner.ts');
const { createFileDatabase, dropFileDatabase } = await import('./db-per-file.ts');
const { cleanCatalog, freePort } = await import('./helpers.ts');
const { PostgresStore } = await import('../src/db/postgres.store.ts');
const { createServer } = await import('../src/http/uws.adapter.ts');

/**
 * be-05b RELATION-INSIDE-COMPONENT — INLINE relation refs inside components, end-to-end over a REAL uWS
 * server + REAL Postgres (per-file clone), NO MOCKS. Proves:
 *  - a `relation` field inside a SINGLE / REPEATABLE / DYNAMIC-ZONE component stores inline id ref(s) to a
 *    TARGET content-type (NOT a link table) and reads back VERBATIM un-populated;
 *  - the target must exist at component-type DEFINITION (a missing target -> 400);
 *  - write existence-check: a dangling id -> 400; a wrong-target id (exists in another type, not the
 *    declared target) -> 400; single vs many cardinality enforced;
 *  - read populate: a single ref -> the resolved target OBJECT (or null when dangling), a many ref -> an
 *    ARRAY of resolved objects (a dangling/invisible id DROPPED);
 *  - target VISIBILITY: a DRAFT target resolves to null/dropped (default published-only); an i18n target
 *    resolves in the default locale;
 *  - a component WITHOUT a relation-ref field + a non-component type read byte-identically (untouched).
 */

let sql: Sql;
let db: Awaited<ReturnType<typeof createFileDatabase>>;
let base: string;
let close: (token: unknown) => void;
let token: unknown;

async function boot(): Promise<void> {
  const store = new PostgresStore(sql);
  const built = await store.loadWithRegistry();
  const server = createServer(built.engine, store, built.registry);
  const port = await freePort();
  token = await server.listen(port);
  base = `http://127.0.0.1:${port}`;
  close = server.close;
}

before(async () => {
  db = await createFileDatabase('relincmp');
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

const POST = (p: string, body: unknown) => fetch(`${base}${p}`, { method: 'POST', body: JSON.stringify(body) });
const GET = (p: string) => fetch(`${base}${p}`);

/** Create the `author` target content-type + two rows; returns their ids. */
async function seedAuthors(): Promise<{ a1: number; a2: number }> {
  const r = await POST('/content-types', { apiId: 'author', fields: [{ name: 'name', cmsType: 'string', options: { nullable: false } }] });
  assert.ok(r.status === 201 || r.status === 200, await r.text());
  const a1 = ((await (await POST('/author', { name: 'Ada' })).json()) as { data: { id: number } }).data.id;
  const a2 = ((await (await POST('/author', { name: 'Alan' })).json()) as { data: { id: number } }).data.id;
  return { a1, a2 };
}

// --- R0: target must exist at component-type definition ----------------------------------------
test('R0 a relation field whose target content-type does not exist is rejected at definition (400)', async () => {
  const r = await POST('/component-types', {
    apiId: 'byline',
    fields: [{ name: 'writer', cmsType: 'relation', options: { target: 'ghost' } }],
  });
  const text = await r.text();
  assert.equal(r.status, 400, text);
  assert.match((JSON.parse(text) as { error: string }).error, /target/i);
});

// --- R0b: a `relation` field is COMPONENT-ONLY (no top-level content-type form) -----------------
// be-05b GUARD: `relation` is a ComponentFieldKind, but unlike component/component-repeatable/dynamiczone
// it has NO top-level form — an inline ref only lives inside a component json. Declaring it at the TOP
// LEVEL of a content-type would resolve to a bare json column that is never existence-checked on write nor
// populated on read (a silently-broken field). It must be rejected at definition (400), both on create and
// addField. Top-level relations go through the be-01 relations[] (link-table) API, not the field path.
test('R0b a top-level `relation` field on a content-type is rejected at create (400)', async () => {
  await seedAuthors();
  const r = await POST('/content-types', {
    apiId: 'post',
    fields: [{ name: 'writer', cmsType: 'relation', options: { target: 'author' } }],
  });
  const text = await r.text();
  assert.equal(r.status, 400, text);
  assert.match((JSON.parse(text) as { error: string }).error, /relation/i);
  // The broken type must NOT have been created.
  assert.equal((await GET('/post')).status, 404);
});

test('R0b a top-level `relation` field added via addField is rejected (400); the type is unchanged', async () => {
  await seedAuthors();
  const created = await POST('/content-types', { apiId: 'post', fields: [{ name: 'title', cmsType: 'string' }] });
  assert.ok(created.status === 201 || created.status === 200, await created.text());
  const r = await POST('/content-types/post/fields', { name: 'writer', cmsType: 'relation', options: { target: 'author' } });
  const text = await r.text();
  assert.equal(r.status, 400, text);
  assert.match((JSON.parse(text) as { error: string }).error, /relation/i);
});

// --- R1: SINGLE relation ref inside a single component — store, read verbatim, populate --------
test('R1 single relation ref inside a single component: stored inline, read verbatim, populated on read', async () => {
  const { a1 } = await seedAuthors();
  await POST('/component-types', {
    apiId: 'byline',
    fields: [
      { name: 'role', cmsType: 'string' },
      { name: 'writer', cmsType: 'relation', options: { target: 'author' } },
    ],
  });
  await POST('/content-types', { apiId: 'post', fields: [{ name: 'by', cmsType: 'component', options: { component: 'byline' } }] });

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
  await seedAuthors();
  await POST('/component-types', { apiId: 'byline', fields: [{ name: 'writer', cmsType: 'relation', options: { target: 'author' } }] });
  await POST('/content-types', { apiId: 'post', fields: [{ name: 'by', cmsType: 'component', options: { component: 'byline' } }] });
  const dangling = await POST('/post', { by: { writer: 999999 } });
  const dText = await dangling.text();
  assert.equal(dangling.status, 400, dText);
  assert.match((JSON.parse(dText) as { error: string }).error, /unknown author id/i);
});

// --- R2b: wrong-target id deterministically rejected -------------------------------------------
test('R2b a wrong-target id that does not exist in the declared target is rejected (400)', async () => {
  await seedAuthors(); // authors have ids 1,2.
  await POST('/content-types', { apiId: 'tag', fields: [{ name: 'slug', cmsType: 'string', options: { nullable: false } }] });
  // Make a tag with an id guaranteed beyond the author id space (insert 5 tags -> ids 1..5).
  let tagId = 0;
  for (let i = 0; i < 5; i++) tagId = ((await (await POST('/tag', { slug: `t${i}` })).json()) as { data: { id: number } }).data.id;
  assert.ok(tagId > 2, `expected a tag id beyond author ids, got ${tagId}`);

  await POST('/component-types', { apiId: 'byline', fields: [{ name: 'writer', cmsType: 'relation', options: { target: 'author' } }] });
  await POST('/content-types', { apiId: 'post', fields: [{ name: 'by', cmsType: 'component', options: { component: 'byline' } }] });

  const wrong = await POST('/post', { by: { writer: tagId } }); // exists in `tag`, NOT in `author`.
  const wText = await wrong.text();
  assert.equal(wrong.status, 400, wText);
  assert.match((JSON.parse(wText) as { error: string }).error, /unknown author id/i);
});

// --- R3: MANY relation refs (cardinality) ------------------------------------------------------
test('R3 many relation refs inside a component: array stored, populated to an array of objects', async () => {
  const { a1, a2 } = await seedAuthors();
  await POST('/component-types', {
    apiId: 'credits',
    fields: [{ name: 'writers', cmsType: 'relation', options: { target: 'author', multiple: true } }],
  });
  await POST('/content-types', { apiId: 'post', fields: [{ name: 'credits', cmsType: 'component', options: { component: 'credits' } }] });

  const created = (await (await POST('/post', { credits: { writers: [a1, a2] } })).json()) as {
    data: { id: number; credits: { writers: number[] } };
  };
  assert.deepEqual(created.data.credits.writers, [a1, a2]);

  const pop = (await (await GET(`/post/${created.data.id}?populate=credits`)).json()) as {
    data: { credits: { writers: { id: number; name: string }[] } };
  };
  assert.deepEqual(pop.data.credits.writers.map((w) => w.name), ['Ada', 'Alan']);

  // A single id supplied to a MANY field is rejected? No — coerceRelationRef accepts a bare id for many.
  const single = await POST('/post', { credits: { writers: a1 } });
  assert.ok(single.status === 201, await single.text());

  // A single-valued field receiving an array of 2 -> 400.
  await POST('/component-types', { apiId: 'one', fields: [{ name: 'w', cmsType: 'relation', options: { target: 'author' } }] });
  await POST('/content-types', { apiId: 'solo', fields: [{ name: 'one', cmsType: 'component', options: { component: 'one' } }] });
  const tooMany = await POST('/solo', { one: { w: [a1, a2] } });
  assert.equal(tooMany.status, 400, await tooMany.text());
});

// --- R4: relation ref inside a REPEATABLE component + a DYNAMIC ZONE block ----------------------
test('R4 relation refs inside a repeatable component and a dynamic-zone block populate correctly', async () => {
  const { a1, a2 } = await seedAuthors();
  await POST('/component-types', { apiId: 'row', fields: [{ name: 'writer', cmsType: 'relation', options: { target: 'author' } }] });
  await POST('/content-types', { apiId: 'rep', fields: [{ name: 'rows', cmsType: 'component-repeatable', options: { component: 'row' } }] });
  const rep = (await (await POST('/rep', { rows: [{ writer: a1 }, { writer: a2 }] })).json()) as { data: { id: number } };
  const repPop = (await (await GET(`/rep/${rep.data.id}?populate=rows`)).json()) as {
    data: { rows: { writer: { id: number } | null }[] };
  };
  assert.equal(repPop.data.rows[0]!.writer!.id, a1);
  assert.equal(repPop.data.rows[1]!.writer!.id, a2);

  // Dynamic zone: a block carrying a relation ref.
  await POST('/component-types', { apiId: 'authorBlock', fields: [{ name: 'writer', cmsType: 'relation', options: { target: 'author' } }] });
  await POST('/content-types', { apiId: 'zoned', fields: [{ name: 'body', cmsType: 'dynamiczone', options: { components: ['authorBlock'] } }] });
  const zoned = (await (await POST('/zoned', { body: [{ __component: 'authorBlock', writer: a1 }] })).json()) as { data: { id: number } };
  const zPop = (await (await GET(`/zoned/${zoned.data.id}?populate=body`)).json()) as {
    data: { body: { __component: string; writer: { id: number; name: string } }[] };
  };
  assert.equal(zPop.data.body[0]!.__component, 'authorBlock');
  assert.equal(zPop.data.body[0]!.writer.id, a1);
  assert.equal(zPop.data.body[0]!.writer.name, 'Ada');
});

// --- R5: dangling ref resolves to null (single) / dropped (many) on read -----------------------
test('R5 a ref that becomes dangling resolves to null (single) and is dropped (many) on read', async () => {
  const { a1, a2 } = await seedAuthors();
  await POST('/component-types', {
    apiId: 'credits',
    fields: [
      { name: 'lead', cmsType: 'relation', options: { target: 'author' } },
      { name: 'team', cmsType: 'relation', options: { target: 'author', multiple: true } },
    ],
  });
  await POST('/content-types', { apiId: 'post', fields: [{ name: 'credits', cmsType: 'component', options: { component: 'credits' } }] });
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
  // author opts into draft/publish (draftPublish is a TOP-LEVEL create-body key, sibling of fields).
  await POST('/content-types', { apiId: 'author', fields: [{ name: 'name', cmsType: 'string', options: { nullable: false } }], draftPublish: true });
  const a1 = ((await (await POST('/author', { name: 'Draftee' })).json()) as { data: { id: number } }).data.id; // created as DRAFT.

  await POST('/component-types', { apiId: 'byline', fields: [{ name: 'writer', cmsType: 'relation', options: { target: 'author' } }] });
  await POST('/content-types', { apiId: 'post', fields: [{ name: 'by', cmsType: 'component', options: { component: 'byline' } }] });
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
  // i18n is a TOP-LEVEL create-body key; per-field `localized` is a sibling of name/cmsType/options.
  await POST('/content-types', { apiId: 'author', fields: [{ name: 'name', cmsType: 'string', options: { nullable: false }, localized: true }], i18n: true });
  const a1 = ((await (await POST('/author', { name: 'Ada (en)' })).json()) as { data: { id: number } }).data.id; // default-locale variant.

  await POST('/component-types', { apiId: 'byline', fields: [{ name: 'writer', cmsType: 'relation', options: { target: 'author' } }] });
  await POST('/content-types', { apiId: 'post', fields: [{ name: 'by', cmsType: 'component', options: { component: 'byline' } }] });
  const created = (await (await POST('/post', { by: { writer: a1 } })).json()) as { data: { id: number } };

  const pop = (await (await GET(`/post/${created.data.id}?populate=by`)).json()) as { data: { by: { writer: { id: number; name: string; locale: string } } } };
  assert.equal(pop.data.by.writer.id, a1);
  assert.equal(pop.data.by.writer.name, 'Ada (en)');
});

// --- R8: BYTE-IDENTICAL — un-populated read emits the bare id(s) verbatim -----------------------
test('R8 an un-populated read emits the bare relation id(s) verbatim (zero-copy structural tree)', async () => {
  const { a1, a2 } = await seedAuthors();
  await POST('/component-types', {
    apiId: 'credits',
    fields: [
      { name: 'lead', cmsType: 'relation', options: { target: 'author' } },
      { name: 'team', cmsType: 'relation', options: { target: 'author', multiple: true } },
    ],
  });
  await POST('/content-types', { apiId: 'post', fields: [{ name: 'credits', cmsType: 'component', options: { component: 'credits' } }] });
  const created = (await (await POST('/post', { credits: { lead: a1, team: [a1, a2] } })).json()) as { data: { id: number } };

  const raw = await (await GET(`/post/${created.data.id}`)).text();
  assert.match(raw, new RegExp(`"lead":\\s*${a1}\\b`)); // bare id, not an object.
  assert.match(raw, new RegExp(`"team":\\s*\\[\\s*${a1}\\s*,\\s*${a2}\\s*\\]`)); // bare id array.
});

// --- R9: a component WITHOUT a relation-ref field is unaffected ---------------------------------
test('R9 a component without a relation-ref field reads identically (no relation populate effect)', async () => {
  await POST('/component-types', { apiId: 'seo', fields: [{ name: 'metaTitle', cmsType: 'string' }] });
  await POST('/content-types', { apiId: 'page', fields: [{ name: 'seo', cmsType: 'component', options: { component: 'seo' } }] });
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
  await POST('/content-types', { apiId: 'plain', fields: [{ name: 'title', cmsType: 'string', options: { nullable: false } }] });
  const created = (await (await POST('/plain', { title: 'T' })).json()) as { data: { id: number } };
  const plain = await (await GET(`/plain/${created.data.id}`)).text();
  const withPop = await (await GET(`/plain/${created.data.id}?populate=*`)).text();
  assert.equal(plain, withPop); // identical bytes (no component/media field => post-step skipped).
});
