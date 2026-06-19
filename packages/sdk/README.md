# `@absurd/sdk`

A typed, isomorphic, zero-dependency client for [`@absurd/api`](../api/README.md) — the
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

This package ships as part of the absurdFastCMS monorepo (npm workspaces). Inside the repo it is
resolved as `@absurd/sdk` with no build step (Node ≥ 24 type-stripping serves `src/*.ts` directly):

```ts
import { createClient } from '@absurd/sdk';
```

When published it builds to `dist/` (ESM `.js` + `.d.ts`); consumers import it the same way.

## Quickstart

```ts
import { createClient } from '@absurd/sdk';

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

`GET /:type/:id`. Throws `NotFoundError` (404) when the id is unknown. `opts.populate` is the
only read param the single route honors.

```ts
const { data } = await client.findOne('article', 1, { populate: ['author'] });
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

The 16 `cmsType`s: `string`, `text`, `email`, `uid`, `enumeration`, `integer`, `biginteger`,
`float`, `decimal`, `boolean`, `date`, `datetime`, `time`, `json`, `array`, `uuid`. `FieldOptions`
keys: `length` (varchar sizing), `precision` / `scale` (decimal), `values` (enumeration),
`nullable`, `default`.

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
import { f, and, or, not } from '@absurd/sdk';

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
import { isKeysetPagination } from '@absurd/sdk';

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

> `fields` projection is accepted by the server today but not yet applied (forward-compat).

---

## Bound collections

`client.collection<T>(type)` binds the api_id and the row type so you stop repeating them. It
shares the client's transport (retries / timeout / hooks all apply).

```ts
import { type Entry } from '@absurd/sdk';

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
import { decodeEntry, encodeEntry, decodeValue, encodeValue, isLosslessBigDecode } from '@absurd/sdk';

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
import { NotFoundError, BadRequestError, ConflictError, ApiError } from '@absurd/sdk';

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
