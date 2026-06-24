// @conti/sdk — QUERY COOKBOOK example.
//
// Mirrors the query examples from packages/api/README.md, expressed through the typed SDK instead of
// hand-written bracket-syntax URLs. Each call below serializes to the exact same wire query the api's
// real parser decodes — the SDK is just a readable, type-checked way to spell them.
//
// The api README's headline query was:
//   GET /articles?filters[title][$contains]=intro&filters[views][$gte]=100&sort=views:desc&pagination[limit]=20
//
// Runnable ESM TypeScript (type-strips under Node >= 24):
//   node packages/sdk/examples/query-cookbook.ts
//
// Point it at a live @conti/api server (defaults to http://127.0.0.1:3000; override with BASE_URL).
// Assumes an `article` collection exists (the api's seed type). Reads only — it writes nothing.

import { createClient, f, and, or, isKeysetPagination, type Entry, type ListResponse } from '@conti/sdk';

const baseUrl = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const client = createClient({ baseUrl });

interface Article extends Entry {
  id: number;
  title: string;
  status: 'draft' | 'published' | 'archived';
  views: number;
}

const articles = client.collection<Article>('article');

/** Small helper: print the first few titles + the total from a list response. */
function show(label: string, res: ListResponse<Article>): void {
  const meta = res.meta.pagination;
  const total = isKeysetPagination(meta) ? (meta.total ?? '?') : meta.total;
  const titles = res.data.slice(0, 3).map((a) => a.title);
  console.log(`${label}: ${res.data.length} rows (total ${total}) — ${titles.join(' | ')}`);
}

async function main(): Promise<void> {
  // === The api README's headline query =========================================================
  // filters[title][$contains]=intro & filters[views][$gte]=100 & sort=views:desc & pagination[limit]=20
  show(
    'headline',
    await articles.list({
      filters: { title: { $contains: 'intro' }, views: { $gte: 100 } },
      sort: 'views:desc',
      pagination: { limit: 20 },
    }),
  );

  // === Filter operators ========================================================================
  show('short-form $eq', await articles.list({ filters: { status: 'published' } }));
  show('$ne', await articles.list({ filters: { status: { $ne: 'draft' } } }));
  show('$between', await articles.list({ filters: { views: { $between: [10, 100] } } }));
  show('$in', await articles.list({ filters: { id: { $in: [1, 2, 3] } } }));
  show('$containsi', await articles.list({ filters: { title: { $containsi: 'INTRO' } } }));
  show('$startsWith', await articles.list({ filters: { title: { $startsWith: 'How' } } }));
  show('$notNull', await articles.list({ filters: { title: { $notNull: true } } }));

  // === Logical combinators — $and / $or / $not =================================================
  show(
    '$and',
    await articles.list({
      filters: { $and: [{ status: { $eq: 'published' } }, { views: { $gte: 100 } }] },
    }),
  );
  show(
    '$or',
    await articles.list({
      filters: { $or: [{ status: { $eq: 'draft' } }, { status: { $eq: 'archived' } }] },
    }),
  );
  show('$not', await articles.list({ filters: { $not: { status: { $eq: 'draft' } } } }));

  // === Same queries via the fluent builder =====================================================
  // The builder produces a plain FilterObject — call `.build()` to hand it to `filters`.
  show(
    'builder and()',
    await articles.list({ filters: f('views').gte(100).and(f('status').eq('published')).build() }),
  );
  show(
    'builder or()',
    await articles.list({ filters: or(f('status').eq('draft'), f('status').eq('archived')).build() }),
  );
  show(
    'builder and(...) explicit',
    await articles.list({ filters: and(f('title').containsi('intro'), f('views').gte(100)).build() }),
  );

  // === Pagination — all three modes ============================================================
  show('page mode', await articles.list({ pagination: { page: 1, pageSize: 5 } }));
  show('offset mode', await articles.list({ pagination: { start: 0, limit: 5 } }));
  show('keyset mode', await articles.list({ pagination: { cursor: '', pageSize: 5, withCount: true } }));

  // === Iterators ===============================================================================
  let offsetCount = 0;
  for await (const _ of articles.listAll({ sort: 'id:asc' })) offsetCount++;
  console.log('listAll (offset iterator) yielded', offsetCount, 'rows');

  let keysetCount = 0;
  for await (const _ of articles.listAllKeyset({ pagination: { pageSize: 50 } })) keysetCount++;
  console.log('listAllKeyset (keyset iterator) yielded', keysetCount, 'rows');

  // === Populate ================================================================================
  // '*' = all depth-1 relations; an array = named relations; nested object recurses.
  show('populate *', await articles.list({ populate: '*', pagination: { pageSize: 3 } }));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
