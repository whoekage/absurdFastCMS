# `@conti/sdk`

A typed, isomorphic, zero-dependency client for [`@conti/api`](../api/README.md) — the
*absurdly fast* headless CMS. It covers everything the api exposes over HTTP: the Strapi-v5
query surface (filters / sort / pagination / populate), writes (create / update / delete +
relation ops), and the runtime content-type Builder (DDL at runtime).

- **Isomorphic.** The only runtime dependency is a `fetch` implementation. Runs on Node ≥ 24,
  browsers, Deno, and Bun. `fetch` is injectable for tests / custom transports.
- **Zero-dependency.** Never bundles the server — the contract types are hand-written here, so
  importing the SDK does not drag postgres.js / uWebSockets.js into a browser bundle.
- **Lossless wire fidelity.** `biginteger` and `decimal` arrive as quoted strings and stay
  strings by default (no `Number()` rounding above 2⁵³); opt into `bigint` / `Date`.

> **Status:** in development, in lockstep with the api. The api Builder and writes are currently
> **unauthenticated**; the auth seam (`token` / `getHeaders` / `onUnauthorized`) is wired and
> forward-compatible but a no-op against today's open server.

---

## Install

This package ships as part of the conti monorepo (npm workspaces). Inside the repo it is
resolved as `@conti/sdk` with no build step (Node ≥ 24 type-stripping serves `src/*.ts` directly):

```ts
import { createClient } from '@conti/sdk';
```

When published it builds to `dist/` (ESM `.js` + `.d.ts`); consumers import it the same way.

## Quickstart

```ts
import { createClient } from '@conti/sdk';

const client = createClient({ baseUrl: 'http://127.0.0.1:3000' });

// List published articles, most-viewed first.
const { data, meta } = await client.list('article', {
  filters: { status: { $eq: 'published' }, views: { $gte: 100 } },
  sort: ['views:desc', 'id:asc'],
  pagination: { page: 1, pageSize: 20 },
});

console.log(data, meta.pagination);
```

`createClient(options)` is sugar for `new AbsurdClient(options)`. See
[Client options](#client-options) for the full constructor.

---

## Table of contents

- [Client options](#client-options)
- [Read methods](#read-methods)
- [Write methods](#write-methods)
- [Media library & media fields](#media-library--media-fields)
- [Content-type Builder](#content-type-builder)
- [Filter cookbook](#filter-cookbook) — every operator + `$and`/`$or`/`$not` + relation filters
- [Fluent filter builder](#fluent-filter-builder)
- [Pagination](#pagination) — the 3 modes + iterators
- [Populate](#populate)
- [Bound collections](#bound-collections)
- [Wire fidelity](#wire-fidelity) — bigint / decimal / json / date
- [Errors](#errors)

---

## Client options

`createClient(options)` / `new AbsurdClient(options)`:

```ts
const client = createClient({
  baseUrl: 'http://127.0.0.1:3000', // trailing slash is stripped
  // fetch:        globalThis.fetch,   // injectable for tests / custom transport
  // token:        'abc',              // static Bearer token (forward-compat; see auth seam)
  // getHeaders:   async () => ({ authorization: `Bearer ${await mint()}` }), // dynamic per-request
  // onUnauthorized: ({ status, url }) => { /* clear token / redirect */ },   // 401 hook
  // onRequest:    ({ method, url, headers, attempt }) => { /* inject correlation id */ },
  // onResponse:   ({ response, url }) => { /* logging / metrics (do not read the body) */ },
  // timeout:      5000,               // ms; aborts the in-flight fetch
  // retry:        { retries: 2 },     // idempotent GET only; default backoff 2^(n-1)*100 ms
});
```

| Option | Type | Notes |
| --- | --- | --- |
| `baseUrl` | `string` | required; trailing `/` stripped |
| `fetch` | `typeof fetch` | defaults to `globalThis.fetch` |
| `token` | `string` | static Bearer; mutable via `client.setToken(token)` |
| `getHeaders` | `() => Record<string,string> \| Promise<…>` | merged AFTER built-ins + token (can override) |
| `onUnauthorized` | `(ctx) => void \| Promise<void>` | fired on 401 before the error throws |
| `onRequest` / `onResponse` | hooks | run on every attempt (incl. retries) |
| `timeout` | `number` (ms) | per-call `RequestOptions.timeout` overrides it |
| `retry` | `RetryOptions` | `{ retries, backoff?, retryStatuses? }` — GET only |

```ts
client.setToken('new-token'); // set/clear the static bearer after a login/logout
```

---

## Read methods

Every read returns the raw Strapi-v5 envelope: a list is `{ data, meta: { pagination } }`, a
single item is `{ data, meta: {} }`. Pass a row type `T` to type `data`.

### `list<T>(type, params?, signal?)`

`GET /:type` with the full query (filters / sort / pagination / fields / populate).

```ts
const res = await client.list('article', {
  filters: { title: { $containsi: 'intro' } },
  sort: 'views:desc',
  pagination: { pageSize: 20 },
});
res.data;            // Entry[]
res.meta.pagination; // OffsetPaginationMeta | KeysetPaginationMeta
```

### `findOne<T>(type, id, opts?, signal?)`

`GET /:type/:id`. Throws `NotFoundError` (404) when the id is unknown. The single route honors
`opts.populate`, `opts.fields` (sparse selection — see below), and `opts.status` / `opts.locale`.

```ts
const { data } = await client.findOne('article', 1, { populate: ['author'] });
// sparse selection on the single route: only id + the requested scalar columns come back.
const { data: slim } = await client.findOne('article', 1, { fields: ['title', 'views'] });
```

### `findOneOrNull<T>(type, id, opts?, signal?)`

As `findOne`, but returns `null` instead of throwing on 404.

```ts
const res = await client.findOneOrNull('article', 999);
if (res === null) console.log('no such article');
```

### `count(type, filters?, signal?)`

The total matching rows, derived from the pagination meta WITHOUT fetching rows.

```ts
const total = await client.count('article', { status: { $eq: 'published' } });
```

### `listAll<T>(type, params?, signal?)` — offset iterator

Async generator yielding one ENTRY at a time, advancing offset pages until a short page ends it.

```ts
for await (const article of client.listAll('article', { sort: 'id:asc' })) {
  console.log(article.id);
}
```

### `listAllKeyset<T>(type, params?, signal?)` — keyset iterator

Async generator following `meta.pagination.nextCursor` until `hasNextPage === false`.

```ts
for await (const article of client.listAllKeyset('article', { pagination: { pageSize: 50 } })) {
  console.log(article.id);
}
```

### `listDecoded<T>(type, def, params?, opts?, signal?)` / `findOneDecoded<T>(type, id, def, opts?, signal?)`

As `list` / `findOne`, but each row is passed through schema-aware decode against a
`ContentTypeDefinition` (see [Wire fidelity](#wire-fidelity)).

```ts
const def = await client.contentTypes.get('article');
const res = await client.listDecoded('article', def, {}, { bigints: true, dates: true });
```

---

## Write methods

The write body is ONE flat JSON object (NOT a `{ data }` envelope): writable scalar fields and
relation-op fields are sibling keys. `id` and system columns (`created_at` / `updated_at`) are
rejected. Pass a row type `T` to type the scalar fields; relation fields also accept a
`RelationInput`.

### `create<T>(type, data, signal?)`

`POST /:type` → the created row (201). Every NOT-NULL-without-default field is required. Throws
`BadRequestError` (400) on a bad body or a nonexistent relation FK (the whole tx rolls back), and
`PayloadTooLargeError` (413) on an oversized body.

```ts
const { data } = await client.create('article', {
  title: 'Hello',
  status: 'published',
  views: 0,
  author: 7,        // to-one relation: shorthand id
  tags: [1, 2, 3],  // to-many relation: shorthand ids
});
```

### `update<T>(type, id, data, signal?)`

`PUT /:type/:id` — partial (Strapi semantics): only the keys present in `data` are touched. The
body must carry at least one writable scalar OR one relation op. Returns the updated row (200);
404 / 400 / 413 as above.

```ts
await client.update('article', 1, { title: 'Hello (edited)' });
```

### `delete<T>(type, id, signal?)`

`DELETE /:type/:id` → the deleted row (200). Throws `NotFoundError` (404).

```ts
const { data } = await client.delete('article', 1);
```

### Relation ops

A relation field's value takes one of:

```ts
// 1) shorthand set — a bare id (to-one) or array of ids (to-many)
await client.update('article', 1, { author: 7 });
await client.update('article', 1, { tags: [1, 2, 3] });

// 2) explicit { set } — REPLACES the whole related set; { set: [] } clears it
await client.update('article', 1, { tags: { set: [4, 5] } });
await client.update('article', 1, { tags: { set: [] } });

// 3) { connect, disconnect } — ADD / REMOVE edges (combinable; disconnect-then-connect)
await client.update('article', 1, { tags: { connect: [6], disconnect: [1] } });
```

`set` is mutually exclusive with `connect`/`disconnect`. `null` is rejected — clear with
`{ set: [] }`. Ids are deduped (first-seen order kept); a to-one relation accepts at most one id.

---

## Media library & media fields

The media library stores uploaded files in a dedicated asset registry (the `files` table) served by
its own `/_files` endpoints — **not** the columnar read engine. A **media field** on a content-type is
a plain reference to one or more assets by id.

### Upload — `client.upload(file, filename?, signal?)`

`POST /_files/upload` as `multipart/form-data`. Accepts a `Blob`/`File` (browsers + Node 24) or raw
bytes (`Uint8Array`/`ArrayBuffer`/Node `Buffer`) plus a `filename`. Returns the stored `FileAsset`
(`201`, or `200` when the same bytes were already uploaded — content-addressed dedup). The server
sniffs the real mime + image dimensions from the bytes, so a wrong declared type is harmless.

```ts
// Browser: from an <input type="file">
const asset = await client.upload(fileInput.files[0]);

// Node 24: raw bytes + filename
const asset = await client.upload(await fs.readFile('photo.png'), 'photo.png');

asset.id;            // -> put this in a media-field write
asset.mime;          // 'image/png' (sniffed)
asset.width;         // 800  (null for a non-image)
asset.url;           // public URL for the bytes
```

`BadRequestError` (400, empty / no file part) and `PayloadTooLargeError` (413, over the server's
upload cap) are the failure cases. Uploads are not retried (a non-idempotent POST).

### Asset library — `client.assets.{list,get,delete}`

```ts
const page = await client.assets.list({ start: 0, limit: 25 }); // { data: FileAsset[], meta }
const one  = await client.assets.get(asset.id);                 // FileAsset (404 if absent)
await client.assets.delete(asset.id);                            // removes the record AND the bytes
```

Deleting an asset that a media field still references is allowed — the reference is left dangling, and
a later **populate** read resolves it to `null` (single) or drops it from the array (multiple), never
an error.

### Declaring a media field

A media field is the `media` `cmsType` (see the Builder section). `options.multiple` picks the
cardinality — `false` (default) = a single asset reference, `true` = an ordered array.

```ts
await client.contentTypes.create({
  apiId: 'product',
  fields: [
    { name: 'title',  cmsType: 'string', options: { nullable: false } },
    { name: 'cover',  cmsType: 'media' },                          // single
    { name: 'photos', cmsType: 'media', options: { multiple: true } }, // multiple
  ],
});
```

### Writing & reading a media field

Write the asset **id(s)** (a `MediaInput`: a positive int4 for single, an array for multiple, `null`
to clear). The id must reference an existing asset or the write is a `400` (the whole tx rolls back).

```ts
const cover  = await client.upload(coverBlob);
const photoA = await client.upload(aBlob);
const photoB = await client.upload(bBlob);

await client.create('product', {
  title: 'Widget',
  cover: cover.id,                 // single: a bare id
  photos: [photoA.id, photoB.id],  // multiple: an array of ids (order preserved)
});
```

Un-populated reads echo the raw id / id array. A `populate` read inlines the full `FileAsset`
object(s) — a single media field becomes the asset object (or `null`), a multiple becomes an array of
asset objects:

```ts
// raw ids
const { data } = await client.findOne('product', 1);
data.cover;   // 12        (raw id)
data.photos;  // [7, 9]    (raw ids)

// populated -> inlined asset records (Strapi v5 flat shape)
const { data: full } = await client.findOne('product', 1, { populate: ['cover', 'photos'] });
full.cover;        // { id: 12, mime: 'image/png', width: 800, url: '…', … }  (or null)
full.photos;       // [{ id: 7, … }, { id: 9, … }]
// `populate: '*'` expands media fields too (alongside relations).
```

---

## Draft & Publish

Draft & Publish is a **per-type opt-in** (Strapi v5 Model A). Enable it at create time with
`draftPublish: true` (see the Builder section). When enabled, the type gains a `published_at`
system field on the wire (an ISO string when published, `null` when a draft):

- **create → draft.** A new entry starts as a draft (`published_at` is `null`) and is hidden from
  the default read.
- **default read = published-only.** A `list` / `findOne` with no `status` returns only published
  entries. Pass `status` to switch:

```ts
await client.list('post');                       // published only (default)
await client.list('post', { status: 'published' });
await client.list('post', { status: 'draft' });  // drafts only
await client.findOne('post', 1, { status: 'draft' }); // resolve a specific draft (else 404)
```

- **publish / unpublish.** Set or clear `published_at` (200 → the updated row):

```ts
await client.publish('post', 1);    // POST /post/1/actions/publish   → now visible by default
await client.unpublish('post', 1);  // POST /post/1/actions/unpublish → back to draft
```

`publish`/`unpublish` throw `BadRequestError` (400) on a type without Draft & Publish enabled, and
`NotFoundError` (404) when no row carries the id. `status` is a no-op (silently ignored) on a non-D&P
type. A bound `client.collection('post')` exposes `.publish(id)` / `.unpublish(id)` too. You can
never set `published_at` through `create`/`update` — it is server-managed (rejected as a system field).

---

## Internationalization (i18n)

i18n is a **per-type opt-in**. Enable it at create time with `i18n: true` (see the Builder section).
An i18n type gains two server-managed system fields on the wire — `document_id` (a **number**, the
key that groups every locale variant of one document) and `locale` (the variant's locale slug) — and a
`UNIQUE(document_id, locale)` so a document has at most one row per locale.

Each field is either **localized** (per-variant value) or **shared** (one value across every variant),
controlled by `localized` on the `FieldSpec` (defaults to `true` = localized). A write to a shared
field on any variant **fans out** to every sibling variant in one transaction; a write to a localized
field stays scoped to the addressed variant. Reads never merge — each variant row is self-contained.

- **plain `create` → a NEW document in the default locale.** A normal `create` starts a fresh document
  (`document_id` auto-allocated) under the server's `DEFAULT_LOCALE`. `locale` is server-set, never a
  body key.

```ts
const en = await client.create('page', { title: 'Home', slug: 'home' });
// en.data.locale === 'en' (DEFAULT_LOCALE), en.data.document_id === <new number>
```

- **`createVariant(type, id, locale, data?)` → a NEW locale of an EXISTING document.** `POST
  /:type/:id/locales/:locale` clones the document the entry `id` belongs to into a new `locale`:
  shared fields are **copied** from the sibling, the `data` you pass supplies the **localized** fields
  (a shared key in `data` is a 400). Returns the created variant (201).

```ts
const fr = await client.createVariant('page', en.data.id, 'fr', { title: 'Accueil' });
// fr.data.document_id === en.data.document_id, fr.data.locale === 'fr', fr.data.slug copied from en
```

- **read by locale.** Pass `locale` on `list` / `findOne`. Omitted → `DEFAULT_LOCALE`; a slug → only
  that locale (**no fallback** — a missing variant returns nothing); `'*'` → all variants. Composes
  with `status` (Draft & Publish) and `filters`/`populate`.

```ts
await client.list('page');                              // DEFAULT_LOCALE variants
await client.list('page', { locale: 'fr' });            // fr variants only
await client.list('page', { locale: '*' });             // every variant
await client.list('page', { locale: 'fr', status: 'published' }); // composes with Draft & Publish
await client.findOne('page', id, { locale: 'fr' });
```

A bound `client.collection('page')` exposes `.createVariant(id, locale, data?)` and accepts `locale`
on `.list` / `.findOne`. `locale` is a no-op (silently ignored) on a non-i18n type; `document_id` /
`locale` are NOT emitted for a non-i18n type. **Relations are per-variant in v1** — a relation set on
one variant is independent of the others (shared-relation sync across siblings is a documented future
item).

---

## Content-type Builder

`client.contentTypes` covers the runtime-DDL routes. Every 2xx body is a `ContentTypeDefinition`
(`{ apiId, fields, relations }`) except a type drop, which returns `{ apiId, dropped: true }`.
Errors surface as the typed subclasses: `ConflictError` (409 exists / clash), `NotFoundError` (404),
`BadRequestError` (400 invalid identifier / unknown cmsType / bad enum or option / forbidden
type-change / unknown relation kind).

> The Builder routes are only mounted when the server runs with a store + registry.

```ts
// list / get
const all = await client.contentTypes.list();
const def = await client.contentTypes.get('article');

// create (201) — apiId is canonicalised by the server and reflected back. Optionally declare
// relations at create time (the owner table is created before any link-table FK).
const created = await client.contentTypes.create({
  apiId: 'product',
  fields: [
    { name: 'name', cmsType: 'string', options: { length: 200 } },
    { name: 'price', cmsType: 'decimal', options: { precision: 12, scale: 2 } },
    { name: 'sku', cmsType: 'uid' },
    { name: 'kind', cmsType: 'enumeration', options: { values: ['physical', 'digital'] } },
    { name: 'meta', cmsType: 'json', options: { nullable: true } },
  ],
  relations: [{ field: 'vendor', kind: 'manyToOne', target: 'vendor', inverseField: 'products' }],
  // Opt into Draft & Publish (entries start as drafts; see the Draft & Publish section). Cannot be
  // toggled after create.
  draftPublish: true,
});

// An i18n type — `i18n: true` plus per-field `localized` (defaults true). A `shared` field is synced
// across every locale variant; a localized field is per-variant. See the i18n section.
await client.contentTypes.create({
  apiId: 'page',
  fields: [
    { name: 'title', cmsType: 'string', localized: true },          // per-locale
    { name: 'slug', cmsType: 'uid', localized: false },             // shared across variants
  ],
  i18n: true,
});

// add / update / drop a field
await client.contentTypes.addField('product', { name: 'stock', cmsType: 'integer' });
await client.contentTypes.updateField('product', 'stock', { newName: 'inventory' });
await client.contentTypes.updateField('product', 'price', {
  cmsType: 'decimal',
  options: { precision: 14, scale: 4 },
});
await client.contentTypes.dropField('product', 'meta');

// drop the type
await client.contentTypes.drop('product'); // -> { apiId: 'product', dropped: true }
```

`updateField` applies a rename FIRST, then a type change on the new name; at least one of
`newName` / `cmsType` is required.

### Relations

Declare a relation on an existing type with `addRelation` — `POST /content-types/:apiId/relations`.
It returns the owner's updated `ContentTypeDefinition`; the new relation goes **live immediately** for
deep filtering (`filters[field][...]`) and `populate=field`, with no restart.

```ts
// one-way many-to-many
await client.contentTypes.addRelation('article', { field: 'tags', kind: 'manyToMany', target: 'tag' });

// two-way: an inverse field appears on the target type's definition
const def = await client.contentTypes.addRelation('article', {
  field: 'author',
  kind: 'manyToOne',
  target: 'user',
  inverseField: 'articles', // omit for a one-way relation
});
// def.relations -> [{ field: 'author', kind: 'manyToOne', target: 'user', owner: true, inverseField: 'articles' }]
```

`kind` is one of `oneToOne | oneToMany | manyToOne | manyToMany` (the `RelationKind` union — distinct
from `CmsType`). `target` may equal `:apiId` for a self-reference (a two-way self relation needs
`field` ≠ `inverseField`). Every `ContentTypeDefinition` now carries a `relations: RelationDefinition[]`
array (`{ field, kind, target, owner, inverseField? }`); a scalar-only type returns `relations: []`.
Errors: `NotFoundError` (404 unknown owner/target), `ConflictError` (409 field/relation name clash),
`BadRequestError` (400 invalid identifier / reserved name / unknown kind).

The 17 `cmsType`s: `string`, `text`, `email`, `uid`, `enumeration`, `integer`, `biginteger`,
`float`, `decimal`, `boolean`, `date`, `datetime`, `time`, `json`, `array`, `uuid`, `media`.
`FieldOptions` keys: `length` (varchar sizing), `precision` / `scale` (decimal), `values`
(enumeration), `multiple` (media single-vs-array), `component` / `components` (be-05 component
fields), `nullable`, `default`. See [Media library & media fields](#media-library--media-fields)
for the `media` type and [Components & dynamic zones](#components--dynamic-zones) below.

---

## Components & dynamic zones

A **component** is a reusable field group (no physical table of its own). Define one with
`client.componentTypes`, then attach it to a content type (or another component) via a `component`
(single), `component-repeatable` (array), or `dynamiczone` (heterogeneous array) field — each stored
as a single jsonb column on the owner. The `cmsType` union for these three is `ComponentFieldKind`
(distinct from `CmsType`, like `RelationKind`).

```ts
// define a reusable component (meta-only — no table)
await client.componentTypes.create({
  apiId: 'seo',
  fields: [
    { name: 'metaTitle', cmsType: 'string', options: { nullable: false } },
    { name: 'metaDescription', cmsType: 'text' },
  ],
});
await client.componentTypes.create({ apiId: 'hero', fields: [{ name: 'headline', cmsType: 'string' }] });

// attach single / repeatable / dynamic-zone component fields to a content type
await client.contentTypes.create({
  apiId: 'page',
  fields: [
    { name: 'title', cmsType: 'string', options: { nullable: false } },
    { name: 'seo', cmsType: 'component', options: { component: 'seo' } },
    { name: 'sections', cmsType: 'component-repeatable', options: { component: 'hero' } },
    { name: 'blocks', cmsType: 'dynamiczone', options: { components: ['seo', 'hero'] } },
  ],
});
```

The component-builder surface mirrors `contentTypes`: `list()`, `get(apiId)`, `create(input)`,
`drop(apiId)`, `addField(apiId, field)`, `dropField(apiId, name)`. Each 2xx body is a
`ComponentTypeDefinition` (`{ apiId, fields }`) except a drop (`{ apiId, dropped: true }`). A
content-type / component field's projection carries `component` (single/repeatable ref) or
`components` (dynamic-zone allowed-set) conditionally.

Definition-time guards (all `BadRequestError` 400 unless noted): a referenced component must already
exist; a reference **cycle** (A → B → A, including via a dynamic-zone allowed-set) is rejected; a
malformed spec (a `component` with no ref, an empty `dynamiczone` allowed-set) is rejected. Dropping a
component still referenced by a content-type or another component is a `ConflictError` (409).

### Writing component values

A write to a component field is validated **recursively** against the referenced component schema(s)
and stored as jsonb. Each instance is field-by-field type-checked (reusing the same scalar coercion as
a top-level field, so wire fidelity holds **inside** a component too — biginteger / decimal as strings,
datetime ISO, nested json verbatim), and the server assigns each instance a stable integer `id`.

```ts
await client.create('page', {
  title: 'Home',
  seo: { metaTitle: 'Welcome', metaDescription: null },        // single
  sections: [{ headline: 'A' }, { headline: 'B' }],            // repeatable (order preserved)
  blocks: [                                                    // dynamic zone (tag each block)
    { __component: 'hero', headline: 'Big' },
    { __component: 'seo', metaTitle: 'X' },
  ],
});
```

Validation rejects (all `BadRequestError` 400, with a **scoped path** like `field "hero.cta.label"`):
an unknown nested field; a missing required nested field; a dynamic-zone block with a missing,
disallowed, or unknown `__component`; nesting deeper than the depth cap; and an oversized instance. A
**media** field inside a component is an inline `files.id` ref (single id / id array) — it is
existence-checked in the same write transaction (a dangling id 400s and rolls the whole write back); no
link table is created.

### Relation refs inside a component

A component (only — there is no top-level form) may declare a `relation` field that holds an **inline id
ref** (or array of ids, with `options.multiple`) to a **target content-type**. This is a `ComponentFieldKind`,
**not** a top-level `RelationKind`, and the two are **semantically distinct**:

- a top-level (be-01) relation is a **link table** — a separately-queryable edge set, with an optional
  inverse side, mutated via `set` / `connect` / `disconnect` ops;
- an inline relation ref inside a component is **set-by-value**: the id(s) live directly in the component
  json (no link table, no CSR, no inverse side, not independently queryable), exactly like a media ref.

The target content-type must already exist when the component field is defined (else `BadRequestError`
400). On write, every referenced id is **existence-checked against the target table** in the same
transaction — a dangling id, or an id that exists in some *other* type but not the declared target, 400s.

```ts
await client.contentTypes.create({ apiId: 'author', fields: [{ name: 'name', cmsType: 'string', options: { nullable: false } }] });
// target must exist BEFORE the component field referencing it is declared
await client.componentTypes.create({
  apiId: 'byline',
  fields: [
    { name: 'role', cmsType: 'string' },
    { name: 'writer', cmsType: 'relation', options: { target: 'author' } },          // single id ref
    { name: 'editors', cmsType: 'relation', options: { target: 'author', multiple: true } }, // id[] ref
  ],
});
await client.create('post', { by: { role: 'lead', writer: 7, editors: [3, 4] } });
```

On a `populate` read, each inline relation ref is resolved into the target row object(s) — a single ref
→ the row object (or `null` when dangling/invisible), a many ref → an array of rows (dangling/invisible
ids dropped). Resolution uses the **same default visibility a top-level `GET /:target/:id` would**:
**published-only** for a draft/publish target (a draft resolves to `null`/dropped) and the **default
locale** for an i18n target. Un-populated, the field echoes the bare id(s) verbatim (zero-copy).

### Reading component values

Un-populated, a component field echoes its raw stored tree **verbatim** (zero-copy — instance ids and
array order preserved, `> 2^53` ints intact). A `populate` read of a component field inlines any
**media** refs inside the tree (single → the asset object or `null`, multiple → an array with dangling
ids dropped), resolved in one batched lookup:

```ts
const { data } = await client.findOne('page', 1, { populate: ['seo', 'blocks'] });
// data.seo.image -> the FileAsset object (was a bare id un-populated)
```

---

## Filter cookbook

`filters` is a tree. A field maps to an operator object (`{ field: { $op: value } }`), a bare
value (short form → `$eq`), or a nested object (a relation sub-filter). All 21 operators below
round-trip against the api's real parser.

### Value comparison

```ts
client.list('article', { filters: { status: 'published' } });            // short form → $eq
client.list('article', { filters: { status: { $eq: 'published' } } });   // $eq
client.list('article', { filters: { status: { $ne: 'draft' } } });       // $ne
client.list('article', { filters: { views: { $gt: 100 } } });            // $gt
client.list('article', { filters: { views: { $gte: 100 } } });           // $gte
client.list('article', { filters: { views: { $lt: 100 } } });            // $lt
client.list('article', { filters: { views: { $lte: 100 } } });           // $lte
client.list('article', { filters: { status: { $eqi: 'PUBLISHED' } } });  // $eqi (case-insensitive)
client.list('article', { filters: { status: { $nei: 'DRAFT' } } });      // $nei (case-insensitive)
```

### Set / range

```ts
client.list('article', { filters: { id: { $in: [1, 2, 3] } } });         // $in
client.list('article', { filters: { id: { $notIn: [4, 5] } } });         // $notIn
client.list('article', { filters: { views: { $between: [10, 100] } } }); // $between (inclusive [lo, hi])
```

### Null presence

```ts
client.list('article', { filters: { author: { $null: true } } });        // $null    (IS NULL)
client.list('article', { filters: { author: { $notNull: true } } });     // $notNull (IS NOT NULL)
```

`$null` / `$notNull` take a boolean flag; only `true` emits a clause (`false` omits it).

### Text (string / text fields only)

```ts
client.list('article', { filters: { title: { $contains: 'intro' } } });       // $contains
client.list('article', { filters: { title: { $containsi: 'INTRO' } } });      // $containsi
client.list('article', { filters: { title: { $notContains: 'draft' } } });    // $notContains
client.list('article', { filters: { title: { $notContainsi: 'DRAFT' } } });   // $notContainsi
client.list('article', { filters: { title: { $startsWith: 'How' } } });       // $startsWith
client.list('article', { filters: { title: { $startsWithi: 'how' } } });      // $startsWithi
client.list('article', { filters: { title: { $endsWith: 'guide' } } });       // $endsWith
client.list('article', { filters: { title: { $endsWithi: 'GUIDE' } } });      // $endsWithi
```

### Logical combinators — `$and` / `$or` / `$not`

```ts
// AND — published AND views >= 100
client.list('article', {
  filters: { $and: [{ status: { $eq: 'published' } }, { views: { $gte: 100 } }] },
});

// OR — draft OR archived
client.list('article', {
  filters: { $or: [{ status: { $eq: 'draft' } }, { status: { $eq: 'archived' } }] },
});

// NOT — not draft
client.list('article', { filters: { $not: { status: { $eq: 'draft' } } } });

// Nested — published AND (views >= 100 OR featured)
client.list('article', {
  filters: {
    $and: [
      { status: { $eq: 'published' } },
      { $or: [{ views: { $gte: 100 } }, { featured: { $eq: true } }] },
    ],
  },
});
```

### Relation filters

A nested object that is NOT an operator object recurses as a relation sub-filter
(`filters[rel][field][$op]`), up to 3 hops deep.

```ts
// articles whose author's name contains 'Ada'
client.list('article', { filters: { author: { name: { $containsi: 'ada' } } } });

// two hops: articles whose author belongs to an org named 'Acme'
client.list('article', { filters: { author: { org: { name: { $eq: 'Acme' } } } } });
```

---

## Fluent filter builder

`f(field)` opens a chainable field builder; `and` / `or` / `not` combine nodes. It produces the
exact same plain `FilterObject` — call `.build()` to hand it to `filters`.

```ts
import { f, and, or, not } from '@conti/sdk';

// f('views').gte(100).and(f('status').eq('published'))
client.list('article', {
  filters: f('views').gte(100).and(f('status').eq('published')).build(),
});

// or(...) / not(...)
client.list('article', {
  filters: or(f('status').eq('draft'), f('status').eq('archived')).build(),
});
client.list('article', { filters: not(f('status').eq('draft')).build() });

// the field builder covers every operator (each closes into a FilterBuilder; .build() unwraps it)
f('title').containsi('intro').build();
f('id').in([1, 2, 3]).build();
f('views').between(10, 100).build();
f('author').null().build();
f('title').startsWithi('how').build();
```

`.and(...)` / `.or(...)` flatten a same-operator chain, so `a.and(b).and(c)` is a single
3-element `$and`.

---

## Pagination

The api speaks three mutually-exclusive pagination modes; the list `meta.pagination` is
discriminated by the `isKeysetPagination(meta)` guard.

### 1. Page-based (`page` / `pageSize`)

```ts
const res = await client.list('article', { pagination: { page: 2, pageSize: 20 } });
// meta.pagination: { page, pageSize, pageCount, total }
```

### 2. Offset-based (`start` / `limit`)

```ts
const res = await client.list('article', { pagination: { start: 40, limit: 20 } });
// meta.pagination: { page, pageSize, pageCount, total }
```

### 3. Keyset / cursor (`cursor` / `before` / `pageSize` / `withCount`)

Forward with an opaque `cursor` (empty string bootstraps the first page); backward with `before`.
`total` / `pageCount` are present only when `withCount: true`.

```ts
import { isKeysetPagination } from '@conti/sdk';

const first = await client.list('article', {
  pagination: { cursor: '', pageSize: 20, withCount: true },
});
const meta = first.meta.pagination;
if (isKeysetPagination(meta) && meta.hasNextPage && meta.nextCursor) {
  const next = await client.list('article', {
    pagination: { cursor: meta.nextCursor, pageSize: 20 },
  });
}
```

### Iterators

`listAll` (offset) and `listAllKeyset` (keyset) hide the paging loop and yield one entry at a time:

```ts
for await (const a of client.listAll('article', { sort: 'id:asc' })) { /* ... */ }
for await (const a of client.listAllKeyset('article', { pagination: { pageSize: 50 } })) { /* ... */ }
```

---

## Populate

`populate` accepts `'*'` (all depth-1 relations), a single name, an array of names, or a nested
object that recurses (`populate[rel][populate][...]`).

```ts
client.list('article', { populate: '*' });
client.list('article', { populate: 'author' });
client.list('article', { populate: ['author', 'tags'] });

// nested: populate author AND that author's org
client.list('article', { populate: { author: { populate: ['org'] } } });

// leaf marker in object form
client.list('article', { populate: { author: true, tags: true } });

// single route honors populate too
client.findOne('article', 1, { populate: ['author', 'tags'] });
```

### Sparse field selection (`fields`)

`fields` projects the response down to the requested **scalar** columns (Strapi v5). `id` is always
returned (the row stays addressable); `documentId` and timestamps are not added by a projection.
Relations are NOT projected — they stay governed by `populate`, so a projected owner can still carry
fully-shaped related rows. Wire fidelity is preserved on projected rows (biginteger / decimal stay
quoted strings, datetime ISO, json verbatim). An unknown field name 400s (the same gate as filters).

```ts
// list: only id + title + views per row
client.list('article', { fields: ['title', 'views'] });

// single route honors fields too
client.findOne('article', 1, { fields: ['title'] });

// compose with populate: projected owner scalars + the FULL related author row
client.list('book', { fields: ['title'], populate: ['author'] });
```

---

## Bound collections

`client.collection<T>(type)` binds the api_id and the row type so you stop repeating them. It
shares the client's transport (retries / timeout / hooks all apply).

```ts
import { type Entry } from '@conti/sdk';

// `extends Entry` (an open record) satisfies the `T extends Entry` method constraint.
interface Article extends Entry {
  id: number;
  title: string;
  status: 'draft' | 'published' | 'archived';
  views: number;
}

const articles = client.collection<Article>('article');

const { data } = await articles.list({ filters: { status: { $eq: 'published' } } });
const one = await articles.findOne(1);
const total = await articles.count({ status: { $eq: 'published' } });
await articles.create({ title: 'Hi', status: 'draft', views: 0 });
await articles.update(1, { views: 1 });
await articles.delete(1);
for await (const a of articles.listAll()) { /* ... */ }
```

---

## Wire fidelity

The api emits `biginteger` (pg `int8`) and `decimal` (pg `numeric`) as **quoted strings** — `JSON.parse`
keeps them as the strings they are on the wire, so a value above 2⁵³ or with a fixed scale is never
silently rounded. `json` / `array` round-trip byte-exact as already-parsed JS values. `date` is
`"YYYY-MM-DD"`; `datetime` is full ISO-8601.

By default the SDK keeps these lossless representations. The schema-aware (de)serialization helpers
opt into richer JS types:

```ts
import { decodeEntry, encodeEntry, decodeValue, encodeValue, isLosslessBigDecode } from '@conti/sdk';

const def = await client.contentTypes.get('product');

// decode a raw wire row → typed values; defaults are lossless (bigint/decimal stay strings)
const { data } = await client.list('product');
const typed = decodeEntry(def, data[0]);                       // biginteger/decimal → string (lossless)
const rich  = decodeEntry(def, data[0], { bigints: true, dates: true }); // → bigint / Date

// or in one call
const res = await client.listDecoded('product', def, {}, { bigints: true });
```

Decode options:

| Option | Effect |
| --- | --- |
| `bigints: true` | `biginteger` wire string → native `bigint` (exact for any magnitude) |
| `dates: true` | `date` / `datetime` ISO string → `Date` |

`decimal` is never widened — no JS primitive keeps both fixed scale AND arbitrary magnitude, so it
stays the wire string.

### Encode for writes

`Date` → ISO string and `bigint` → decimal string are the two JS types not directly serializable
into the api's accepted wire form; `encodeEntry` lowers them (everything else passes through,
including `{ connect: [...] }` relation ops). The SDK itself never coerces a `biginteger` / `decimal`
through `Number()`.

```ts
const body = encodeEntry({
  releasedAt: new Date('2026-06-18T00:00:00Z'), // → "2026-06-18T00:00:00.000Z"
  bigCount: 9007199254740993n,                  // → "9007199254740993"
  price: '19.99',                               // decimal: pass a string
});
await client.create('product', body);
```

`isLosslessBigDecode(wire, decoded)` returns `true` when a decode is provably lossless (the same
string, or a `bigint` whose `.toString()` re-canonicalises to the wire) and `false` for any
`number`. `assertNoNumberCoercion(field, value)` throws if a `biginteger` / `decimal` slot is given
a JS `number`.

---

## Errors

Every non-2xx response throws an `ApiError` (or a status-specific subclass) carrying `status`,
`message` (the api's `{ error }` field), and the raw parsed `body`.

```ts
import { NotFoundError, BadRequestError, ConflictError, ApiError } from '@conti/sdk';

try {
  await client.findOne('article', 999);
} catch (e) {
  if (e instanceof NotFoundError) console.log('404', e.status, e.message);
  else if (e instanceof ApiError) console.log(e.status, e.body);
  else throw e;
}
```

| Status | Class |
| --- | --- |
| 400 | `BadRequestError` |
| 401 | `UnauthorizedError` (forward-compat; api has no auth yet) |
| 403 | `ForbiddenError` (forward-compat) |
| 404 | `NotFoundError` |
| 405 | `MethodNotAllowedError` |
| 409 | `ConflictError` |
| 413 | `PayloadTooLargeError` |
| 5xx | `ServerError` |
| other | `ApiError` |

`errorFromResponse(status, message, body)` is the factory that maps a status to the right subclass.

---

## Examples

Runnable ESM TypeScript examples (type-strip under Node ≥ 24) live in
[`examples/`](examples/):

- [`examples/quickstart.ts`](examples/quickstart.ts) — define a type, write rows, query them back.
- [`examples/query-cookbook.ts`](examples/query-cookbook.ts) — the api README's query examples,
  expressed through the SDK (filters, sort, pagination, populate).

Run against a live server:

```bash
node packages/sdk/examples/quickstart.ts      # needs BASE_URL (default http://127.0.0.1:3000)
```
