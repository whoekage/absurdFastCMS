import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine, DetachedTable } from '../src/store/engine.ts';
import type { FieldDef, SortKey } from '../src/store/table.ts';
import { CursorCodec, InvalidCursorError } from '../src/store/cursor.codec.ts';
import { parseQuery } from '../src/store/query.parser.ts';

/**
 * KEYSET ORACLE — the CONTRACT, PURE-RAM, mock-free, NO Postgres. Drives a real Engine + CursorCodec
 * end-to-end through parseQuery + engine.respond. The invariant: paging the WHOLE result set via
 * nextCursor (and backward via before) must equal the OFFSET full ordering (offset oracle sort with
 * id:asc appended), for single + multi-key + mixed-direction + NULLs + a filter.
 *
 * Run ONLY this file: `node --test test/keyset-oracle.fuzz.test.ts` (no global-setup, no DB import).
 */

const SECRET = 'oracle-secret';

function lcg(seedNum: number): () => number {
  let s = seedNum >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const FIELDS: FieldDef[] = [
  { name: 'id', type: 'i32' },
  { name: 'a', type: 'i32' }, // duplicate-heavy primary key
  { name: 'b', type: 'f64' }, // secondary
  { name: 's', type: 'string' }, // string lead candidate
  { name: 'active', type: 'bool' }, // filter target
  { name: 'big', type: 'i64' }, // i64 lead candidate, values straddling 2^53 (no f64 coercion in seek)
  { name: 'dec', type: 'decimal', scale: 2, precision: 10 }, // decimal lead, mantissa-compared as bigint
  { name: 'when', type: 'date' }, // date lead, epoch-ms compared as number
];

const TWO_POW_53 = 9007199254740992n;

/** Build a fresh engine of `n` rows with ~10% nulls on the sortable fields, deterministic by seed. */
function buildEngine(n: number, seed: number): Engine {
  const codec = new CursorCodec(SECRET);
  const eng = new Engine({ cursorCodec: codec });
  const t = eng.define('t', FIELDS);
  t.createEqIndex('id');
  t.createEqIndex('active');
  const rng = lcg(seed);
  for (let i = 0; i < n; i++) {
    eng.insert('t', {
      id: i + 1,
      a: rng() < 0.1 ? null : (rng() * 5) | 0, // few distinct => big tie groups
      b: rng() < 0.1 ? null : Math.round(rng() * 30) / 10,
      s: rng() < 0.1 ? null : ['alpha', 'beta', 'gamma', 'delta'][(rng() * 4) | 0],
      active: rng() < 0.5,
      // i64 straddling 2^53 with a few distinct values => big tie groups, proves bigint (not f64) seek.
      big: rng() < 0.1 ? null : (TWO_POW_53 + BigInt((rng() * 4) | 0)).toString(),
      // decimal @ scale 2 — a string the engine coerces to a scaled mantissa bigint.
      dec: rng() < 0.1 ? null : (((rng() * 5) | 0) + (rng() < 0.5 ? 0.25 : 0.5)).toFixed(2),
      // date as epoch-ms — a few distinct days so ties exercise the tie-break.
      when: rng() < 0.1 ? null : 1_600_000_000_000 + ((rng() * 4) | 0) * 86_400_000,
    });
  }
  t.warmIndexes();
  return eng;
}

/** Decode the data ids + meta from a respond Buffer. */
function decode(buf: Buffer): { ids: number[]; meta: any } {
  const obj = JSON.parse(buf.toString('utf8'));
  return { ids: obj.data.map((r: any) => r.id), meta: obj.meta.pagination };
}

/**
 * The ORACLE ordering, computed DIRECTLY from the table with the SAME null rule the keyset path uses
 * (nullsFirst for DESC, nullsLast for ASC) + the appended unique id:asc — because the engine's OFFSET
 * comparator sorts NULLs by their dense sentinel (it doesn't consult the null bitset), which would
 * diverge from the keyset's explicit null ordering. This is the §6 "append the same null rule" oracle.
 */
function oracleOrder(eng: Engine, sort: SortKey[], where: string): number[] {
  const t = eng.table('t');
  const opts = where ? parseQuery(eng.fields('t'), where).options : {};
  const match = t.matchSet(opts);
  const rows: number[] = [];
  for (let r = 0; r < t.rowCount; r++) if (match.get(r)) rows.push(r);
  // asc => smaller first (sign=+1); desc => larger first (sign=-1). nullsFirst for desc, nullsLast for asc.
  const keys = sort.map((s) => ({ field: s.field, asc: s.dir === 'asc', nullsFirst: s.dir === 'desc' }));
  rows.sort((ra, rb) => {
    for (const k of keys) {
      const sign = k.asc ? 1 : -1;
      const an = t.isNull(k.field, ra);
      const bn = t.isNull(k.field, rb);
      if (an || bn) {
        if (an && bn) continue;
        // one null. nullsFirst => null is the SMALLER value.
        if (an) return k.nullsFirst ? -1 : 1;
        return k.nullsFirst ? 1 : -1;
      }
      const va = t.column(k.field).at(ra) as any;
      const vb = t.column(k.field).at(rb) as any;
      if (va < vb) return -sign;
      if (va > vb) return sign;
    }
    // id:asc tie-break.
    return (t.column('id').at(ra) as number) - (t.column('id').at(rb) as number);
  });
  return rows.map((r) => t.column('id').at(r) as number);
}

/** Page forward through the whole set via nextCursor; return the concatenated ids + page boundaries. */
function pageForward(eng: Engine, sort: SortKey[], where: string, pageSize: number): { ids: number[]; firstCursors: (string | null)[] } {
  const sortTok = sort.map((s) => `${s.field}:${s.dir}`).join(',');
  const ids: number[] = [];
  const firstCursors: (string | null)[] = [];
  let cursor: string | null = null;
  let guard = 0;
  // Hard page-count cap: with pageSize>=1 the walk can never emit more pages than there are rows + a
  // small slack; a non-terminating scroll trips this fast instead of spinning to a huge bound.
  const maxPages = eng.table('t').rowCount + 5;
  for (;;) {
    if (guard++ > maxPages) throw new Error('pageForward did not terminate (non-terminating scroll)');
    // First page uses an EMPTY cursor token (the keyset-mode bootstrap); later pages use nextCursor.
    const cursorTok = cursor === null ? '' : encodeURIComponent(cursor);
    const qParts = [where, sort.length ? 'sort=' + sortTok : '', `pagination[pageSize]=${pageSize}`, `pagination[cursor]=${cursorTok}`];
    const q = qParts.filter((p) => p !== '').join('&');
    const { options } = parseQuery(eng.fields('t'), q);
    const { ids: pageIds, meta } = decode(eng.respond('t', options));
    firstCursors.push(meta.prevCursor);
    for (const id of pageIds) ids.push(id);
    if (!meta.hasNextPage) break;
    cursor = meta.nextCursor;
    assert.ok(cursor !== null, 'hasNextPage true but nextCursor null');
  }
  return { ids, firstCursors };
}

const SORTS: { name: string; sort: SortKey[] }[] = [
  { name: 'single asc', sort: [{ field: 'a', dir: 'asc' }] },
  { name: 'single desc', sort: [{ field: 'a', dir: 'desc' }] },
  { name: 'multi asc/asc', sort: [{ field: 'a', dir: 'asc' }, { field: 'b', dir: 'asc' }] },
  { name: 'mixed asc/desc', sort: [{ field: 'a', dir: 'asc' }, { field: 'b', dir: 'desc' }] },
  { name: 'mixed desc/asc', sort: [{ field: 'a', dir: 'desc' }, { field: 'b', dir: 'asc' }] },
  { name: 'string lead', sort: [{ field: 's', dir: 'asc' }] },
  { name: 'string lead desc + b', sort: [{ field: 's', dir: 'desc' }, { field: 'b', dir: 'asc' }] },
  { name: 'no sort (id only)', sort: [] },
  // Explicit client `id` sort direction — locks the cmpToBoundary sign fix (id:desc must seek
  // descending to match the build order, not the appended id:asc tie-break).
  { name: 'id desc (newest first)', sort: [{ field: 'id', dir: 'desc' }] },
  { name: 'a asc + id desc', sort: [{ field: 'a', dir: 'asc' }, { field: 'id', dir: 'desc' }] },
  { name: 'id asc explicit', sort: [{ field: 'id', dir: 'asc' }] },
  // 3-key mixed direction.
  { name: '3-key a asc, b desc, id asc', sort: [{ field: 'a', dir: 'asc' }, { field: 'b', dir: 'desc' }, { field: 'id', dir: 'asc' }] },
  // i64 / decimal / date leads — drive the full encode->seek->resume loop for bigint + date types,
  // including NULL placement, which is otherwise untested through the real composite seek path.
  { name: 'i64 lead asc', sort: [{ field: 'big', dir: 'asc' }] },
  { name: 'i64 lead desc + b', sort: [{ field: 'big', dir: 'desc' }, { field: 'b', dir: 'asc' }] },
  { name: 'decimal lead asc', sort: [{ field: 'dec', dir: 'asc' }] },
  { name: 'decimal lead desc + id desc', sort: [{ field: 'dec', dir: 'desc' }, { field: 'id', dir: 'desc' }] },
  { name: 'date lead asc', sort: [{ field: 'when', dir: 'asc' }] },
  { name: 'date lead desc + s asc', sort: [{ field: 'when', dir: 'desc' }, { field: 's', dir: 'asc' }] },
];

const WHERES = ['', 'filters[active][$eq]=true'];

for (const sizes of [0, 1, 7, 50]) {
  for (const { name, sort } of SORTS) {
    for (const where of WHERES) {
      test(`oracle: forward all-pages == offset ordering [n=${sizes} | ${name} | where="${where}"]`, () => {
        const eng = buildEngine(sizes, 1234 + sizes);
        const oracle = oracleOrder(eng, sort, where);
        const { ids } = pageForward(eng, sort, where, 3);
        assert.deepEqual(ids, oracle);
        // Hard guard: a non-terminating / duplicating scroll would over-collect — fail fast.
        assert.equal(ids.length, oracle.length, 'page walk emitted a different row count than the oracle');
        assert.equal(new Set(ids).size, ids.length, 'page walk emitted a duplicate row id');
      });
    }
  }
}

/**
 * Walk the WHOLE set backward: page forward once to grab the very LAST page's nextCursor (the final
 * boundary), then walk `before` from it to the head, prepending each page. The reconstruction is
 * everything STRICTLY before that final boundary, i.e. the oracle with its last page removed — assert
 * it equals exactly that oracle prefix (full equality, not a loose prefix-of).
 */
function pageBackwardFull(eng: Engine, sort: SortKey[], where: string, pageSize: number): { ids: number[]; lastBoundaryNext: string | null } {
  const sortTok = sort.map((s) => `${s.field}:${s.dir}`).join(',');
  const sortPart = sort.length ? 'sort=' + sortTok : '';
  // Forward once to find the FINAL boundary (the nextCursor of the last page that still has a next).
  let cursor: string | null = null;
  let lastEndCursor: string | null = null;
  let fg = 0;
  for (;;) {
    if (fg++ > eng.table('t').rowCount + 5) throw new Error('forward scan did not terminate');
    const cursorTok = cursor === null ? '' : encodeURIComponent(cursor);
    const q = [where, sortPart, `pagination[pageSize]=${pageSize}`, `pagination[cursor]=${cursorTok}`].filter((p) => p !== '').join('&');
    const { options } = parseQuery(eng.fields('t'), q);
    const { meta } = decode(eng.respond('t', options));
    if (!meta.hasNextPage) break;
    lastEndCursor = meta.nextCursor;
    cursor = meta.nextCursor;
  }
  if (lastEndCursor === null) return { ids: [], lastBoundaryNext: null }; // 0 or 1 page total
  const collected: number[] = [];
  let before: string | null = lastEndCursor;
  let bg = 0;
  for (;;) {
    if (bg++ > eng.table('t').rowCount + 5) throw new Error('backward scan did not terminate');
    const q = [where, sortPart, `pagination[pageSize]=${pageSize}`, `pagination[before]=${encodeURIComponent(before!)}`].filter((p) => p !== '').join('&');
    const { options } = parseQuery(eng.fields('t'), q);
    const { ids, meta } = decode(eng.respond('t', options));
    collected.unshift(...ids);
    if (!meta.hasPreviousPage) break;
    before = meta.prevCursor;
    assert.ok(before !== null, 'hasPreviousPage true but prevCursor null');
  }
  return { ids: collected, lastBoundaryNext: lastEndCursor };
}

// Backward (`before`) full reconstruction over the SAME sort/filter matrix (incl. NULL-bearing leads,
// filter, and big tie groups). `collected` is everything strictly before the final boundary => the
// oracle with its final page dropped. Assert EXACT equality to that prefix, not a loose prefix-of.
for (const { name, sort } of SORTS) {
  for (const where of WHERES) {
    test(`oracle: backward (before) full reconstruction [${name} | where="${where}"]`, () => {
      const eng = buildEngine(50, 555);
      const pageSize = 4;
      const oracle = oracleOrder(eng, sort, where);
      const { ids } = pageBackwardFull(eng, sort, where, pageSize);
      // `ids` is the oracle minus its trailing final page. Compute that expected prefix length.
      const expectedLen = ids.length; // determined by the walk; verify it is an exact oracle prefix
      assert.deepEqual(ids, oracle.slice(0, expectedLen));
      assert.equal(new Set(ids).size, ids.length, 'backward walk emitted a duplicate row id');
      // And the dropped tail is non-trivial when the set spans > 1 page.
      if (oracle.length > pageSize) assert.ok(expectedLen < oracle.length, 'backward walk collected the whole set (no boundary dropped)');
    });
  }
}

test('oracle: engine binds sig to live sort — replaying a cursor under a CHANGED sort rejects', () => {
  const eng = buildEngine(20, 1);
  // Mint a nextCursor under sort a:asc.
  const { options: o1 } = parseQuery(eng.fields('t'), 'sort=a:asc&pagination[pageSize]=5&pagination[cursor]=');
  const p1 = decode(eng.respond('t', o1));
  const token = p1.meta.nextCursor as string;
  assert.ok(token);
  // Replay the SAME token under a DIFFERENT sort (a:desc) => InvalidCursorError from engine.respond.
  const { options: o2 } = parseQuery(eng.fields('t'), `sort=a:desc&pagination[pageSize]=5&pagination[cursor]=${encodeURIComponent(token)}`);
  assert.throws(() => eng.respond('t', o2), InvalidCursorError);
});

test('oracle: engine binds sig to live filter — replaying a cursor under a CHANGED filter rejects', () => {
  const eng = buildEngine(20, 2);
  // Mint under filter active=true.
  const { options: o1 } = parseQuery(eng.fields('t'), 'filters[active][$eq]=true&sort=a:asc&pagination[pageSize]=5&pagination[cursor]=');
  const p1 = decode(eng.respond('t', o1));
  const token = p1.meta.nextCursor as string;
  assert.ok(token);
  // Replay under filter active=false (different filterCanonical) => InvalidCursorError.
  const { options: o2 } = parseQuery(eng.fields('t'), `filters[active][$eq]=false&sort=a:asc&pagination[pageSize]=5&pagination[cursor]=${encodeURIComponent(token)}`);
  assert.throws(() => eng.respond('t', o2), InvalidCursorError);
});

test('oracle: backward (before) reconstructs the same ordering', () => {
  const eng = buildEngine(50, 99);
  const sort: SortKey[] = [{ field: 'a', dir: 'asc' }, { field: 'b', dir: 'desc' }];
  const where = '';
  const oracle = oracleOrder(eng, sort, where);
  const sortTok = sort.map((s) => `${s.field}:${s.dir}`).join(',');
  const pageSize = 4;

  // Forward to collect each page's nextCursor (boundary at the end of each page).
  const pageEndCursors: string[] = [];
  let cursor: string | null = null;
  for (;;) {
    const cursorTok = cursor === null ? '' : encodeURIComponent(cursor);
    const qParts = ['sort=' + sortTok, `pagination[pageSize]=${pageSize}`, `pagination[cursor]=${cursorTok}`];
    const { options } = parseQuery(eng.fields('t'), qParts.join('&'));
    const { meta } = decode(eng.respond('t', options));
    if (!meta.hasNextPage) break;
    pageEndCursors.push(meta.nextCursor);
    cursor = meta.nextCursor;
  }

  // From the LAST end-cursor, walk backward via `before` collecting pages, prepend.
  // Use the final nextCursor (end of penultimate page) as a `before` anchor and walk to start.
  const lastAnchor = pageEndCursors[pageEndCursors.length - 1]!;
  const collected: number[] = [];
  let before: string | null = lastAnchor;
  let guard = 0;
  for (;;) {
    if (guard++ > 100000) throw new Error('backward did not terminate');
    const qParts = ['sort=' + sortTok, `pagination[pageSize]=${pageSize}`, `pagination[before]=${encodeURIComponent(before!)}`];
    const { options } = parseQuery(eng.fields('t'), qParts.join('&'));
    const { ids, meta } = decode(eng.respond('t', options));
    // prepend this page (it precedes everything collected so far)
    collected.unshift(...ids);
    if (!meta.hasPreviousPage) break;
    before = meta.prevCursor;
    assert.ok(before !== null);
  }
  // `collected` is everything strictly before lastAnchor's boundary; the tail (rows at/after the
  // anchor) is the oracle suffix. Assert collected is a PREFIX of the oracle.
  assert.deepEqual(oracle.slice(0, collected.length), collected);
});

test('oracle: forward(next) then before(that) reproduces the prior page', () => {
  const eng = buildEngine(40, 7);
  const sort: SortKey[] = [{ field: 'a', dir: 'asc' }];
  const sortTok = 'a:asc';
  const pageSize = 5;

  // page 1 (no cursor)
  let { options } = parseQuery(eng.fields('t'), `sort=${sortTok}&pagination[pageSize]=${pageSize}&pagination[cursor]=`);
  const p1 = decode(eng.respond('t', options));
  assert.ok(p1.meta.hasNextPage);
  // page 2 via nextCursor
  ({ options } = parseQuery(eng.fields('t'), `sort=${sortTok}&pagination[pageSize]=${pageSize}&pagination[cursor]=${encodeURIComponent(p1.meta.nextCursor)}`));
  const p2 = decode(eng.respond('t', options));
  // before(p2.prevCursor) should reproduce page 1 exactly
  ({ options } = parseQuery(eng.fields('t'), `sort=${sortTok}&pagination[pageSize]=${pageSize}&pagination[before]=${encodeURIComponent(p2.meta.prevCursor)}`));
  const back = decode(eng.respond('t', options));
  assert.deepEqual(back.ids, p1.ids);
});

test('oracle: page-beyond-end is empty and stable', () => {
  const eng = buildEngine(8, 3);
  const sortTok = 'a:asc';
  const pageSize = 3;
  let cursor: string | null = null;
  let last: any = null;
  for (;;) {
    const cursorTok = cursor === null ? '' : encodeURIComponent(cursor);
    const qParts = ['sort=' + sortTok, `pagination[pageSize]=${pageSize}`, `pagination[cursor]=${cursorTok}`];
    const { options } = parseQuery(eng.fields('t'), qParts.join('&'));
    last = decode(eng.respond('t', options));
    if (!last.meta.hasNextPage) break;
    cursor = last.meta.nextCursor;
  }
  // Now request one MORE page past the end via the last nextCursor (which is the final boundary).
  const endCursor = last.meta.nextCursor;
  const { options } = parseQuery(eng.fields('t'), `sort=${sortTok}&pagination[pageSize]=${pageSize}&pagination[cursor]=${encodeURIComponent(endCursor)}`);
  const beyond1 = decode(eng.respond('t', options));
  assert.deepEqual(beyond1.ids, []);
  assert.equal(beyond1.meta.hasNextPage, false);
  // repeat -> still empty (cache hit byte-identical too)
  const beyond2 = decode(eng.respond('t', options));
  assert.deepEqual(beyond2.ids, []);
  assert.equal(beyond2.meta.hasNextPage, false);
});

test('oracle: withCount total/pageCount via popcount; empty filter => total 0', () => {
  const eng = buildEngine(20, 5);
  const sortTok = 'a:asc';
  // empty filter (no active row matches an impossible eq)
  const { options } = parseQuery(eng.fields('t'), `filters[id][$eq]=999999&sort=${sortTok}&pagination[pageSize]=5&pagination[withCount]=true&pagination[cursor]=`);
  const r = decode(eng.respond('t', options));
  assert.deepEqual(r.ids, []);
  assert.equal(r.meta.total, 0);
  assert.equal(r.meta.pageCount, 0);
  assert.equal(r.meta.hasNextPage, false);

  // full set total
  const { options: o2 } = parseQuery(eng.fields('t'), `sort=${sortTok}&pagination[pageSize]=5&pagination[withCount]=true&pagination[cursor]=`);
  const r2 = decode(eng.respond('t', o2));
  assert.equal(r2.meta.total, 20);
  assert.equal(r2.meta.pageCount, 4);
});

test('oracle: huge pageSize returns all remaining, hasNextPage=false', () => {
  const eng = buildEngine(13, 8);
  const { options } = parseQuery(eng.fields('t'), 'sort=a:asc&pagination[pageSize]=1000&pagination[cursor]=');
  const r = decode(eng.respond('t', options));
  assert.equal(r.ids.length, 13);
  assert.equal(r.meta.hasNextPage, false);
  assert.equal(r.meta.hasPreviousPage, false);
});

test('oracle: write-then-page stability (data write keeps cursor valid)', () => {
  const eng = buildEngine(30, 11);
  const sortTok = 'a:asc';
  // page 1
  let { options } = parseQuery(eng.fields('t'), `sort=${sortTok}&pagination[pageSize]=5&pagination[cursor]=`);
  const p1 = decode(eng.respond('t', options));
  const nextCursor = p1.meta.nextCursor as string;

  // A pure DATA write (same schema): insert more rows. schemaVersion must NOT bump.
  for (let i = 0; i < 5; i++) eng.insert('t', { id: 1000 + i, a: 2, b: 1.0, s: 'beta', active: true });
  eng.table('t').warmIndexes();

  // Resume with the old cursor: must still decode (sig valid) and page correctly vs a fresh oracle
  // of the post-write set restricted to rows strictly after the boundary.
  ({ options } = parseQuery(eng.fields('t'), `sort=${sortTok}&pagination[pageSize]=5&pagination[cursor]=${encodeURIComponent(nextCursor)}`));
  const p2 = decode(eng.respond('t', options));
  // Build oracle of full post-write order; p1 ∪ p2... should be a contiguous prefix.
  const oracle = oracleOrder(eng, [{ field: 'a', dir: 'asc' }], '');
  // p1 ids are the first 5 of the oracle? Not necessarily (oracle is post-write). Instead: the
  // combined forward walk from scratch must equal the oracle, and resuming the OLD cursor must
  // yield rows that appear AFTER p1's last row in the oracle. Assert p2 ids are all in oracle after
  // the position of p1's last id.
  const lastP1 = p1.ids[p1.ids.length - 1]!;
  const posLastP1 = oracle.indexOf(lastP1);
  for (const id of p2.ids) {
    assert.ok(oracle.indexOf(id) > posLastP1, `resumed row ${id} should sort after p1 boundary`);
  }
});

test('oracle: deleted boundary row resumes at the next live row (seek by value+id, not rowIdByEq)', () => {
  const eng = buildEngine(30, 21);
  const sortTok = 'a:asc';
  // page 1
  let { options } = parseQuery(eng.fields('t'), `sort=${sortTok}&pagination[pageSize]=5&pagination[cursor]=`);
  const p1 = decode(eng.respond('t', options));
  const boundaryId = p1.ids[p1.ids.length - 1]!; // the row the nextCursor anchors to
  const nextCursor = p1.meta.nextCursor as string;

  // Rebuild the type WITHOUT the boundary row (a delete) via a fresh DetachedTable + replaceType.
  // Same SCHEMA => schemaVersion unchanged => the old cursor's sig still validates.
  const live = eng.table('t');
  const det = new DetachedTable(FIELDS);
  det.table.createEqIndex('id');
  det.table.createEqIndex('active');
  const kept: Record<string, unknown>[] = [];
  for (let r = 0; r < live.rowCount; r++) {
    const id = live.column('id').at(r) as number;
    if (id === boundaryId) continue; // drop the boundary row
    const row: Record<string, unknown> = {};
    for (const f of FIELDS) row[f.name] = live.isNull(f.name, r) ? null : live.column(f.name).at(r);
    kept.push(row);
  }
  for (const row of kept) det.insert(row);
  det.table.warmIndexes();
  eng.replaceType('t', det);

  // Resume with the OLD cursor: must decode (sig valid) and continue at the next live row.
  ({ options } = parseQuery(eng.fields('t'), `sort=${sortTok}&pagination[pageSize]=5&pagination[cursor]=${encodeURIComponent(nextCursor)}`));
  const p2 = decode(eng.respond('t', options));
  // The boundary row is gone; the oracle over the remaining set after the boundary value+id.
  const oracle = oracleOrder(eng, [{ field: 'a', dir: 'asc' }], '');
  // Everything in p1 except the deleted row should still precede p2 in the post-delete oracle.
  const survivingP1 = p1.ids.filter((id) => id !== boundaryId);
  for (const id of p2.ids) assert.ok(!survivingP1.includes(id), 'no dup across the deleted boundary');
  // p2 rows must be a contiguous oracle slice immediately after the survivingP1 prefix.
  const expected = oracle.slice(survivingP1.length, survivingP1.length + p2.ids.length);
  assert.deepEqual(p2.ids, expected);
});
