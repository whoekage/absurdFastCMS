import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/store/engine.ts';
import type { FieldDef } from '../src/store/table.ts';
import { CursorCodec } from '../src/store/cursor-codec.ts';
import { parseQuery } from '../src/store/query-parser.ts';

/**
 * The ADDITIVE guarantee: offset/page responses are BYTE-IDENTICAL before and after the keyset
 * slice. We assert that an engine WITH a cursor codec wired produces the exact same offset/page
 * Buffer as one WITHOUT it (the keyset machinery never touches the offset path), and that the meta
 * shape is the unchanged `{page,pageSize,pageCount,total}`. PURE-RAM, no DB.
 */

const FIELDS: FieldDef[] = [
  { name: 'id', type: 'i32' },
  { name: 'views', type: 'i32' },
  { name: 'title', type: 'string' },
];

function build(withCodec: boolean): Engine {
  const eng = withCodec ? new Engine({ cursorCodec: new CursorCodec('x') }) : new Engine();
  const t = eng.define('t', FIELDS);
  t.createEqIndex('id');
  t.createSortedIndex('views');
  for (let i = 0; i < 20; i++) eng.insert('t', { id: i + 1, views: (i * 7) % 13, title: `T${i}` });
  t.warmIndexes();
  return eng;
}

const QUERIES = [
  'sort=views:asc&pagination[page]=2&pagination[pageSize]=5',
  'sort=views:desc&pagination[start]=3&pagination[limit]=4',
  'pagination[pageSize]=10', // bare pageSize stays page mode
  'sort=views:asc', // no pagination
  'filters[views][$gt]=5&sort=views:asc&pagination[page]=1&pagination[pageSize]=3',
];

/**
 * GOLDEN bytes for the first query. Comparing the two engines to EACH OTHER only proves the codec
 * wiring doesn't perturb the offset path — a shared regression (e.g. in paginationMeta or the offset
 * walk order) would pass both. Pin the exact response Buffer so a shared regression is caught too.
 */
const GOLDEN_PAGE2 =
  '{"data":[{"id":18,"views":2,"title":"T17"},{"id":7,"views":3,"title":"T6"},' +
  '{"id":20,"views":3,"title":"T19"},{"id":9,"views":4,"title":"T8"},{"id":11,"views":5,"title":"T10"}],' +
  '"meta":{"pagination":{"page":2,"pageSize":5,"pageCount":4,"total":20}}}';

test('offset golden bytes: page=2 pageSize=5 sort views:asc (catches a shared regression)', () => {
  const eng = build(true);
  const buf = eng.respond('t', parseQuery(eng.fields('t'), QUERIES[0]!).options);
  assert.equal(buf.toString('utf8'), GOLDEN_PAGE2);
});

for (const q of QUERIES) {
  test(`offset byte-identical with vs without codec: "${q}"`, () => {
    const a = build(false);
    const b = build(true);
    const ba = a.respond('t', parseQuery(a.fields('t'), q).options);
    const bb = b.respond('t', parseQuery(b.fields('t'), q).options);
    assert.deepEqual(ba, bb);
    // meta shape unchanged (page-mode keys present, no keyset keys).
    const meta = JSON.parse(ba.toString('utf8')).meta.pagination;
    assert.ok('page' in meta && 'pageSize' in meta && 'pageCount' in meta && 'total' in meta);
    assert.ok(!('nextCursor' in meta) && !('hasNextPage' in meta));
  });
}
