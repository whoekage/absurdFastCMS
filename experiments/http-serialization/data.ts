/**
 * Shared experiment data: a real columnar Table seeded with 10k articles, plus the two
 * response builders we are measuring — naive JSON.stringify vs pre-serialized buffer concat.
 *
 * The buffer strategy is the architectural bet: per-row JSON is serialized ONCE at seed time
 * (serialize-on-write); a request just concatenates the page's precomputed buffers + envelope.
 * The stringify strategy does the realistic per-request cost: materialize objects + JSON.stringify.
 *
 * Both MUST emit byte-identical JSON (asserted at module load), so any throughput difference is
 * purely the serialization strategy, not the payload.
 */
import { Table } from '../../src/store/table.ts';

const N = 10_000;
const PAGE = 25;
const STATUSES = ['draft', 'published', 'archived'];
const AUTHORS = ['alice', 'bob', 'carol', 'dave', 'erin'];

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904229) >>> 0;
    return s / 0x100000000;
  };
}
const rnd = lcg(42);

const WORDS =
  'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud'.split(
    ' ',
  );
function makeBody(): string {
  const out: string[] = [];
  let len = 0;
  while (len < 1000) {
    const w = WORDS[(rnd() * WORDS.length) | 0]!;
    out.push(w);
    len += w.length + 1;
  }
  return out.join(' ');
}

export const table = new Table([
  { name: 'title', type: 'string' },
  { name: 'slug', type: 'string' },
  { name: 'status', type: 'string' },
  { name: 'author', type: 'string' },
  { name: 'publishedAt', type: 'date' },
  { name: 'views', type: 'i32' },
  { name: 'body', type: 'string' },
]);
table.createEqIndex('status');
table.createSortedIndex('publishedAt');

const base = Date.UTC(2020, 0, 1);
for (let i = 0; i < N; i++) {
  table.insert({
    title: `Article number ${i}`,
    slug: `article-${i}`,
    status: STATUSES[i % 3]!,
    author: AUTHORS[i % 5]!,
    publishedAt: base + i * 3_600_000,
    views: (rnd() * 100000) | 0,
    body: makeBody(),
  });
}
table.warmIndexes();

// Fixed read: published, newest first, page 1 of 25 — the canonical CMS list request.
export const pageRowIds = table.query({
  filters: [{ field: 'status', op: 'eq', value: 'published' }],
  sort: [{ field: 'publishedAt', dir: 'desc' }],
  offset: 0,
  limit: PAGE,
});

const total = table.scan([{ field: 'status', op: 'eq', value: 'published' }]).count();
export const meta = {
  pagination: { page: 1, pageSize: PAGE, pageCount: Math.ceil(total / PAGE), total },
};

// Serialize-on-write: every row's JSON bytes are built ONCE here, not per request.
const rowBuffers: Buffer[] = new Array(table.rowCount);
for (let r = 0; r < table.rowCount; r++) {
  rowBuffers[r] = Buffer.from(JSON.stringify(table.materialize(r)), 'utf8');
}

const HEAD = Buffer.from('{"data":[', 'utf8');
const COMMA = Buffer.from(',', 'utf8');
const TAIL = Buffer.from(`],"meta":${JSON.stringify(meta)}}`, 'utf8');

/** Naive path: materialize 25 row objects every request, then JSON.stringify the envelope. */
export function buildStringify(): string {
  const data = pageRowIds.map((r) => table.materialize(r));
  return JSON.stringify({ data, meta });
}

/** Buffer path: concat the page's precomputed per-row buffers + envelope framing. */
export function buildBuffer(): Buffer {
  const parts: Buffer[] = [HEAD];
  for (let i = 0; i < pageRowIds.length; i++) {
    if (i > 0) parts.push(COMMA);
    parts.push(rowBuffers[pageRowIds[i]!]!);
  }
  parts.push(TAIL);
  return Buffer.concat(parts);
}

/** For Fastify's fast-json-stringify path: the materialized objects + a matching JSON schema. */
export function buildObject(): { data: Record<string, unknown>[]; meta: typeof meta } {
  return { data: pageRowIds.map((r) => table.materialize(r)), meta };
}

export const responseSchema = {
  type: 'object',
  properties: {
    data: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          slug: { type: 'string' },
          status: { type: 'string' },
          author: { type: 'string' },
          publishedAt: { type: 'string' },
          views: { type: 'integer' },
          body: { type: 'string' },
        },
      },
    },
    meta: {
      type: 'object',
      properties: {
        pagination: {
          type: 'object',
          properties: {
            page: { type: 'integer' },
            pageSize: { type: 'integer' },
            pageCount: { type: 'integer' },
            total: { type: 'integer' },
          },
        },
      },
    },
  },
};

// Invariant: the two strategies we compare head-to-head emit identical bytes.
{
  const a = Buffer.from(buildStringify(), 'utf8');
  const b = buildBuffer();
  if (!a.equals(b)) throw new Error('stringify and buffer produce different bytes — unfair comparison');
}

export const PAYLOAD_BYTES = buildBuffer().length;
