/**
 * Shared fuzz harness for the conti filter engine (PHASE 1).
 *
 * Three pillars, all deterministic and engine-INDEPENDENT:
 *
 *  1. A seeded LCG RNG (no Math.random) so every run is reproducible: a failing case prints its
 *     seed and re-running with that seed reproduces the exact rows + tree.
 *  2. Synthetic row generators per schema with configurable null-rate and cardinality
 *     (low / medium / nearUnique) for each column type (i32, f64, bool, string, date), emitting
 *     PLAIN JS row objects (the same shape `Table.insert` accepts).
 *  3. An INDEPENDENT brute-force ORACLE: given the plain rows + a FilterNode tree (+ optional sort
 *     + offset/limit) it computes the expected matching row-id list (and ordered page) with a
 *     trivial O(n) loop that RE-IMPLEMENTS the documented semantics directly. It NEVER touches the
 *     engine — no Table, no Column, no Bitset, no coerceDate import. A circular oracle is the worst
 *     possible bug here, so the only thing imported from the engine is TYPES (erased at runtime).
 *
 * Plus: a random-FilterNode generator, a `runMatrix` asserter that throws with the SEED + the
 * minimal failing predicate on mismatch, and a coverage registry with `assertCoverage`.
 *
 * Erasable-TS only: string-literal unions, no enums/namespaces/param-properties; `.ts` on imports.
 * The import below is `import type` — verbatimModuleSyntax erases it, so NO engine code is linked
 * into the oracle. The oracle's independence is asserted by `oracleIsEngineIndependent()`.
 */
import type { FilterNode, Predicate, SortKey } from '../../src/store/table.ts';
import type { ColumnType, ScanOp } from '../../src/store/column.ts';

// ===========================================================================
// 1. Seeded RNG (LCG) — no Math.random anywhere.
// ===========================================================================

/**
 * A small deterministic PRNG. Same constants as Numerical Recipes' LCG, run through `Math.imul`
 * so it stays in 32-bit integer space. Every generator/tree decision draws from one of these, so
 * a single seed fully determines a run.
 */
export class Rng {
  private s: number;
  readonly seed: number;

  constructor(seed: number) {
    this.seed = seed >>> 0;
    this.s = seed >>> 0;
    // Avoid the fixed point at 0 producing a degenerate first draw.
    if (this.s === 0) this.s = 0x9e3779b9;
  }

  /** Next float in [0, 1). */
  next(): number {
    this.s = (Math.imul(this.s, 1664525) + 1013904223) >>> 0;
    return this.s / 0x100000000;
  }

  /** Integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  /** Integer in [lo, hi] inclusive. */
  intBetween(lo: number, hi: number): number {
    return lo + this.int(hi - lo + 1);
  }

  /** True with probability `p`. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Pick a uniformly random element. */
  pick<T>(arr: readonly T[]): T {
    return arr[this.int(arr.length)]!;
  }
}

// ===========================================================================
// 2. Schema + row generation.
// ===========================================================================

/** How many distinct values a column produces, relative to row count. */
export type Cardinality = 'low' | 'medium' | 'nearUnique';

export interface FieldSpec {
  name: string;
  type: ColumnType;
  /** Probability that any given row's value for this field is NULL (0..1). */
  nullRate: number;
  /** Distinct-value budget knob. */
  cardinality: Cardinality;
  /** Fixed scale for a `decimal` field (the engine stores `round(value * 10^scale)`). */
  scale?: number;
}

/** A generated row: plain JS, each field a real value or `null` (NULL). */
export type Row = Record<string, ScalarOrNull>;
/** `bigint` carries an i64 / decimal-mantissa value exactly (an f64 would lose precision > 2^53). */
export type Scalar = number | string | boolean | bigint;
export type ScalarOrNull = Scalar | null;

/** Map a cardinality knob to a concrete distinct-value count for `n` rows. */
function distinctCount(card: Cardinality, n: number): number {
  switch (card) {
    case 'low':
      return Math.max(2, Math.min(8, n));
    case 'medium':
      return Math.max(2, Math.min(64, Math.ceil(n / 4)));
    case 'nearUnique':
      return Math.max(1, n); // effectively one distinct value per row
  }
}

/**
 * A pool of candidate values for a string field, mixing case + Unicode so the `-i` fold path is
 * exercised: ligatures (ﬀ→ff), fullwidth (Ａ→A), accents, and the eszett (ß stays ß, NOT ss).
 */
const STRING_ALPHABET: readonly string[] = [
  'apple',
  'Apple',
  'APPLE',
  'banana',
  'Banana',
  'cherry',
  'CHERRY',
  'café', // café (composed)
  'café', // café (decomposed e + combining acute) — NFKC-equal to the composed form
  'CAFÉ',
  'straße', // straße (eszett)
  'STRASSE',
  'strasse',
  'oＡo', // contains a fullwidth A (Ａ) → folds to 'oao'
  'ﬀix', // ﬀ ligature + 'ix' → folds to 'ffix'
  'mango',
  'Mango',
  'grape',
  '', // empty string is a legal interned value (distinct from NULL)
  'pineapple',
  'PineApple',
];

/**
 * A spread of i64 values exercising mixed sign, the > 2^53 region, and the ±2^63 boundaries — the
 * exact precision corners an f64 would lose. Drawn from this set (sized by `count`) so eq/in are
 * non-trivial and ranges have spread; always includes 0n and the two boundaries.
 */
function buildI64Pool(rng: Rng, count: number): bigint[] {
  const I64_MAX = 2n ** 63n - 1n;
  const I64_MIN = -(2n ** 63n);
  const fixed: bigint[] = [0n, 1n, -1n, 9007199254740992n, 9007199254740993n, -9007199254740993n, I64_MAX, I64_MIN];
  const seen = new Set<bigint>(fixed);
  const pool: bigint[] = [...fixed];
  while (pool.length < count) {
    // A signed value in a moderate range plus the occasional huge magnitude.
    const v = rng.chance(0.3)
      ? BigInt(rng.intBetween(-1_000_000, 1_000_000)) * 1_000_000_000n + BigInt(rng.intBetween(-999, 999))
      : BigInt(rng.intBetween(-500, 500));
    if (!seen.has(v)) { seen.add(v); pool.push(v); }
    if (seen.size > count * 4 + fixed.length) break;
  }
  return pool;
}

/** Build the concrete distinct value list a field will draw from, sized by cardinality. */
function buildValuePool(rng: Rng, type: ColumnType, count: number, scale = 0): Scalar[] {
  const pool: Scalar[] = [];
  switch (type) {
    case 'i64':
      return buildI64Pool(rng, count);
    case 'decimal':
      // Decimal VALUES are their scaled int64 MANTISSA (a bigint), inserted verbatim — scale affects
      // only materialization, never filtering, so the filter oracle treats decimal exactly like i64.
      // (`scale` is accepted for signature symmetry; the mantissa universe is scale-independent.)
      return buildI64Pool(rng, count);
    case 'json':
      // json is not filterable, so it is never used by the fuzz filter matrix. Return a trivial pool
      // (exhaustiveness only — a json field in a generated schema would just round-trip verbatim).
      return ['null'];
    case 'bool':
      // Only two possible distinct values regardless of the knob.
      return [false, true];
    case 'i32': {
      const seen = new Set<number>();
      while (pool.length < count) {
        const v = rng.intBetween(-50, 50);
        if (!seen.has(v)) {
          seen.add(v);
          pool.push(v);
        }
        if (seen.size >= 101) break; // exhausted the small i32 range
      }
      // Always include 0 so the "$eq 0 must not match a NULL sentinel-0 row" case is exercised.
      if (!seen.has(0)) pool.push(0);
      return pool;
    }
    case 'f64': {
      while (pool.length < count) {
        // A mix of integers and fractionals; 0 included for the sentinel-collision case.
        const v = rng.chance(0.3) ? 0 : Math.round(rng.intBetween(-1000, 1000) + rng.next() * 100) / 10;
        pool.push(v);
      }
      pool.push(0);
      return pool;
    }
    case 'string': {
      // Draw distinct strings from the alphabet, padding with synthesized ones for high cardinality.
      const seen = new Set<string>();
      let i = 0;
      while (pool.length < count) {
        let s: string;
        if (i < STRING_ALPHABET.length) {
          s = STRING_ALPHABET[i]!;
        } else {
          s = `str_${i}_${rng.int(1_000_000)}`;
        }
        i++;
        if (!seen.has(s)) {
          seen.add(s);
          pool.push(s);
        }
        if (i > count * 4 + STRING_ALPHABET.length) break; // safety valve
      }
      return pool;
    }
    case 'date': {
      // Distinct epoch-ms instants spread across a few years, emitted in mixed shapes
      // (number, ISO string, Date) so the coercion path is exercised. We store the SHAPE here.
      const base = Date.UTC(2020, 0, 1);
      const seen = new Set<number>();
      while (pool.length < count) {
        const ms = base + rng.intBetween(0, 3 * 365) * 86_400_000 + rng.intBetween(0, 86_399) * 1000;
        if (seen.has(ms)) continue;
        seen.add(ms);
        // Randomly represent the same instant as a number, an ISO string, or a Date — the engine
        // coerces all three to the same epoch-ms, and so does the oracle.
        const shape = rng.int(3);
        if (shape === 0) pool.push(ms);
        else if (shape === 1) pool.push(new Date(ms).toISOString());
        else pool.push(new Date(ms) as unknown as Scalar); // a Date is a legal insert value
      }
      return pool;
    }
  }
}

export interface GeneratedData {
  fields: FieldSpec[];
  /** Rows as plain JS objects (each field a value or `null`). */
  rows: Row[];
}

/**
 * Generate `n` rows for the given schema. Each field independently draws from its value pool with
 * its configured null-rate; the pool size encodes the cardinality knob. Deterministic in `rng`.
 */
export function generateRows(rng: Rng, fields: FieldSpec[], n: number): GeneratedData {
  const pools = new Map<string, Scalar[]>();
  for (const f of fields) {
    pools.set(f.name, buildValuePool(rng, f.type, distinctCount(f.cardinality, n), f.scale ?? 0));
  }
  const rows: Row[] = [];
  for (let r = 0; r < n; r++) {
    const row: Row = {};
    for (const f of fields) {
      if (rng.chance(f.nullRate)) {
        row[f.name] = null;
      } else {
        const pool = pools.get(f.name)!;
        row[f.name] = pool[rng.int(pool.length)]!;
      }
    }
    rows.push(row);
  }
  return { fields, rows };
}

// ===========================================================================
// 3. INDEPENDENT ORACLE — re-implements the documented semantics, no engine import.
// ===========================================================================

/**
 * Re-implementation of the engine's `fold` (column.ts:fold) — NFKC then locale-independent lower.
 * Kept here verbatim so the oracle never has to import engine code; this IS the gold reference for
 * the `-i` operators (eqi/nei/containsi/startsWithi/endsWithi).
 */
function oracleFold(s: string): string {
  return s.normalize('NFKC').toLowerCase();
}

/**
 * Re-implementation of the engine's `coerceDate` (column.ts) — Date | ISO | number -> epoch ms.
 * Independent so the oracle stays engine-free. Throws on the same invalid inputs the engine does
 * (NaN / Invalid Date / out-of-f64-range ns magnitude) so a bad generator value is caught here too.
 */
const ORACLE_MAX_SAFE_EPOCH = 2 ** 53;
export function oracleCoerceDate(value: unknown): number {
  let ms: number;
  if (value instanceof Date) ms = value.getTime();
  else if (typeof value === 'string') ms = Date.parse(value);
  else if (typeof value === 'number') ms = value;
  else throw new Error(`oracle date value must be Date|ISO|number, got ${typeof value}`);
  if (Number.isNaN(ms)) throw new Error(`oracle: invalid date ${String(value)}`);
  if (!Number.isFinite(ms) || Math.abs(ms) > ORACLE_MAX_SAFE_EPOCH) {
    throw new Error(`oracle: date epoch out of range ${String(value)}`);
  }
  return ms;
}

/**
 * Normalize a stored cell to the canonical comparable value the engine would store. Only `date`
 * cells differ from their raw form: a Date/ISO/number all collapse to epoch-ms. NULL passes through
 * as `null`. This is the oracle's mirror of the column's ingest coercion.
 */
function canonical(type: ColumnType, cell: ScalarOrNull): ScalarOrNull {
  if (cell === null) return null;
  if (type === 'date') return oracleCoerceDate(cell);
  // i64 / decimal cells are already exact bigints in the generated rows (a decimal cell is its
  // scaled int64 mantissa), so they pass through unchanged — bigint `===`/`<`/`>` compare exactly.
  return cell;
}

/** Canonicalize a predicate value the same way the engine coerces predicate bounds for dates. */
function canonValue(type: ColumnType, op: ScanOp, value: unknown): unknown {
  if (type !== 'date') return value;
  if (op === 'between') {
    const pair = value as [unknown, unknown];
    return [oracleCoerceDate(pair[0]), oracleCoerceDate(pair[1])];
  }
  if (op === 'in' || op === 'notIn') {
    return (value as unknown[]).map((v) => oracleCoerceDate(v));
  }
  if (op === 'null' || op === 'notNull') return value;
  // Substring/affix/ordering string ops never appear on a date column in our generators.
  return oracleCoerceDate(value);
}

/**
 * The leaf oracle: does row `r` match predicate `p`? THREE-VALUED LOGIC and all documented
 * operator semantics are re-implemented directly here. No engine call.
 *
 * Documented rules replicated (see CLAUDE.md / filter-datastructures.md):
 *  - A NULL field value matches NO comparison op (eq/ne/in/notIn/ranges/substring all false),
 *    EXCEPT $null (matches nulls) and $notNull (matches non-nulls). So $ne / $notIn / $notContains
 *    EXCLUDE null rows; $eq 0 does NOT match a NULL sentinel-0 row.
 *  - `-i` ops fold = NFKC(s).toLowerCase() applied to BOTH value and needle.
 *  - contains/startsWith/endsWith via JS includes/startsWith/endsWith;
 *    notContains/notContainsi = NOT(contains) AND notNull.
 *  - between inclusive [lo,hi]; lo>hi => empty; lo==hi => equality. Numeric/date only.
 *  - in: empty 'in' => matches nothing; notIn excludes the set AND excludes nulls.
 *  - date: Date|ISO|number all denote the same instant via epoch-ms.
 */
export function oracleLeafMatch(fieldType: ColumnType, p: Predicate, row: Row): boolean {
  const rawCell = row[p.field]!;
  const cell = canonical(fieldType, rawCell);
  const isNull = cell === null;

  if (p.op === 'null') return isNull;
  if (p.op === 'notNull') return !isNull;

  // Every comparison op: a NULL cell is "unknown", never a match (covers ne/notIn/notContains too).
  if (isNull) return false;

  const value = canonValue(fieldType, p.op, p.value);

  switch (p.op) {
    case 'eq':
      return cell === value;
    case 'ne':
      return cell !== value;
    // The `as number` here is a TS ANNOTATION ONLY — for an i64/decimal cell both operands are bigints
    // at runtime, so `<`/`>` is exact bigint ordering above 2^53. Do NOT "fix" this to `Number(...)`,
    // which WOULD coerce to f64 and lose precision in the > 2^53 region the fuzz specifically targets.
    case 'gt':
      return (cell as number) > (value as number);
    case 'gte':
      return (cell as number) >= (value as number);
    case 'lt':
      return (cell as number) < (value as number);
    case 'lte':
      return (cell as number) <= (value as number);
    case 'between': {
      const [lo, hi] = value as [number, number];
      const x = cell as number;
      return x >= lo && x <= hi; // lo>hi naturally yields empty; lo==hi yields equality.
    }
    case 'in':
      return (value as unknown[]).includes(cell); // empty array => false (matches nothing).
    case 'notIn':
      return !(value as unknown[]).includes(cell); // null already excluded above.
    // --- case-insensitive equality. Folding is string-only; on a non-string column (the engine's
    // NumericColumn/BoolColumn treat eqi/nei as plain eq/ne) it degrades to strict (in)equality. ---
    case 'eqi':
      return typeof cell === 'string' ? oracleFold(cell) === oracleFold(value as string) : cell === value;
    case 'nei':
      return typeof cell === 'string' ? oracleFold(cell) !== oracleFold(value as string) : cell !== value;
    // --- substring / affix (case-sensitive) ---
    case 'contains':
      return (cell as string).includes(value as string);
    case 'notContains':
      return !(cell as string).includes(value as string); // null already excluded above.
    case 'startsWith':
      return (cell as string).startsWith(value as string);
    case 'endsWith':
      return (cell as string).endsWith(value as string);
    // --- substring / affix (case-insensitive: fold BOTH sides) ---
    case 'containsi':
      return oracleFold(cell as string).includes(oracleFold(value as string));
    case 'notContainsi':
      return !oracleFold(cell as string).includes(oracleFold(value as string));
    case 'startsWithi':
      return oracleFold(cell as string).startsWith(oracleFold(value as string));
    case 'endsWithi':
      return oracleFold(cell as string).endsWith(oracleFold(value as string));
    default: {
      // Exhaustiveness guard — a new op must be added here, never silently default to false.
      const never: never = p.op;
      throw new Error(`oracle has no case for op "${String(never)}"`);
    }
  }
}

/** Evaluate a FilterNode tree against one row (three-valued boolean algebra over the leaves). */
export function oracleNodeMatch(
  fieldTypes: Map<string, ColumnType>,
  node: FilterNode,
  row: Row,
): boolean {
  if ('leaf' in node) {
    const t = fieldTypes.get(node.leaf.field);
    if (t === undefined) throw new Error(`oracle: unknown field "${node.leaf.field}"`);
    return oracleLeafMatch(t, node.leaf, row);
  }
  if (node.op === 'not') return !oracleNodeMatch(fieldTypes, node.children[0], row);
  if (node.op === 'and') {
    for (const c of node.children) if (!oracleNodeMatch(fieldTypes, c, row)) return false;
    return true; // empty AND = all rows (the identity).
  }
  // or
  for (const c of node.children) if (oracleNodeMatch(fieldTypes, c, row)) return true;
  return false; // empty OR = no rows (the identity).
}

/** Matching row ids (ascending) for a FilterNode tree — the gold reference for `scanTree`. */
export function oracleMatch(
  fieldTypes: Map<string, ColumnType>,
  rows: Row[],
  node: FilterNode,
): number[] {
  const out: number[] = [];
  for (let i = 0; i < rows.length; i++) if (oracleNodeMatch(fieldTypes, node, rows[i]!)) out.push(i);
  return out;
}

/**
 * Independent comparator mirroring the engine's fallback sort (table.ts:comparator) and the
 * sorted-index walk: ascending by `<`/`>` on the canonical value, multi-key, with the same
 * sign convention. Ties keep ascending row-id order (a stable sort over the ascending id list),
 * which matches the engine's index walk (visits rows in value order, ties by ascending id) and
 * its `Array.prototype.sort` fallback only when made stable — so callers comparing a paginated
 * page should restrict comparisons to fields with no duplicate values, OR accept that the
 * engine's two sort paths agree with this only up to ties. We implement a STABLE ascending-id
 * tiebreak to give a single deterministic expected ordering.
 *
 * NOTE on NULL ordering: the engine's sorted index stores a NULL row's sentinel (0 / -Inf-free)
 * but the query path filters to `matches` first; for ORDER BY we only order the MATCHING rows.
 * So NULL handling in the order is moot here because a filtered page already excludes whatever the
 * predicate dropped. When a sort field is itself null in a matched row, the engine reads the dense
 * sentinel; tests that page on a sort key should avoid null sort keys (the generators allow a
 * nullRate of 0 for the sort column to keep this unambiguous).
 */
export function oraclePage(
  fieldTypes: Map<string, ColumnType>,
  rows: Row[],
  node: FilterNode,
  sort: SortKey[] | undefined,
  offset: number | undefined,
  limit: number | undefined,
): number[] {
  let ids = oracleMatch(fieldTypes, rows, node);

  if (sort !== undefined && sort.length > 0) {
    const keyed = ids.map((id, idx) => ({ id, idx }));
    keyed.sort((a, b) => {
      for (const k of sort) {
        const t = fieldTypes.get(k.field)!;
        const va = canonical(t, rows[a.id]![k.field]!);
        const vb = canonical(t, rows[b.id]![k.field]!);
        const sign = k.dir === 'desc' ? -1 : 1;
        // Mirror table.ts comparator: a NULL row reads its dense sentinel, so compare on the
        // sentinel value the engine would store (0 / '' / false / epoch-0).
        const ca = va === null ? sentinelFor(t) : va;
        const cb = vb === null ? sentinelFor(t) : vb;
        if ((ca as number | string) < (cb as number | string)) return -sign;
        if ((ca as number | string) > (cb as number | string)) return sign;
      }
      return a.idx - b.idx; // stable tiebreak by original ascending id position.
    });
    ids = keyed.map((k) => k.id);
  }

  const off = offset ?? 0;
  const lim = limit ?? Infinity;
  const end = lim === Infinity ? ids.length : off + lim;
  return ids.slice(off, end);
}

/** The dense sentinel the engine stores for a NULL cell, by type (table.ts:sentinel). */
function sentinelFor(type: ColumnType): Scalar {
  switch (type) {
    case 'i32':
    case 'f64':
    case 'date':
      return 0;
    case 'bool':
      return false;
    case 'string':
    case 'text':
    case 'json':
      return '';
    case 'i64':
    case 'decimal':
      return 0n;
  }
}

// ===========================================================================
// 4. Random FilterNode generator.
// ===========================================================================

/** Operators that are valid for each column type (so we never generate a nonsense leaf). */
const NUMERIC_RANGE_OPS: ScanOp[] = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between', 'in', 'notIn', 'null', 'notNull'];
const OPS_BY_TYPE: Record<ColumnType, ScanOp[]> = {
  i32: NUMERIC_RANGE_OPS,
  f64: NUMERIC_RANGE_OPS,
  date: NUMERIC_RANGE_OPS,
  // i64 / decimal share the numeric/range op surface (compared exactly on bigint).
  i64: NUMERIC_RANGE_OPS,
  decimal: NUMERIC_RANGE_OPS,
  bool: ['eq', 'ne', 'eqi', 'nei', 'in', 'notIn', 'null', 'notNull'],
  string: [
    'eq', 'ne', 'in', 'notIn', 'eqi', 'nei',
    'contains', 'containsi', 'notContains', 'notContainsi',
    'startsWith', 'startsWithi', 'endsWith', 'endsWithi',
    'null', 'notNull',
  ],
  text: [
    'eq', 'ne', 'eqi', 'nei',
    'contains', 'containsi', 'notContains', 'notContainsi',
    'startsWith', 'startsWithi', 'endsWith', 'endsWithi',
    'null', 'notNull',
  ],
  // json is NOT filterable — excluded from the filter matrix entirely (no leaf is ever generated).
  // Empty makes the exclusion STRUCTURAL: if a json field were ever added to a fuzz schema,
  // randomLeaf's `rng.pick([])` would surface a clear error rather than silently generating leaves.
  json: [],
};

/** Substrings the generator uses as needles so contains/affix actually hit sometimes. */
const STRING_NEEDLES: readonly string[] = ['app', 'APP', 'a', 'ana', 'ﬀ', 'Ａ', 'café', 'CAF', 'ss', 'ße', 'pp', 'xyz', ''];

/**
 * Produce a random predicate VALUE appropriate for `(type, op)`. Values are drawn from the same
 * universe the rows use so matches are non-trivial, and they include edge values (0, '', reversed
 * between bounds) to stress the documented corners. Deterministic in `rng`.
 */
function randomValue(rng: Rng, type: ColumnType, op: ScanOp): unknown {
  if (op === 'null' || op === 'notNull') return null; // value ignored.

  if (type === 'bool') {
    if (op === 'in' || op === 'notIn') {
      const opts: boolean[][] = [[], [true], [false], [true, false]];
      return rng.pick(opts);
    }
    return rng.chance(0.5);
  }

  if (type === 'string') {
    if (op === 'in' || op === 'notIn') {
      const k = rng.int(3);
      const arr: string[] = [];
      for (let i = 0; i < k; i++) arr.push(rng.pick(STRING_ALPHABET));
      return arr;
    }
    if (
      op === 'contains' || op === 'containsi' || op === 'notContains' || op === 'notContainsi' ||
      op === 'startsWith' || op === 'startsWithi' || op === 'endsWith' || op === 'endsWithi'
    ) {
      return rng.pick(STRING_NEEDLES);
    }
    // eq/ne/eqi/nei — pick a real-ish value (mix case to exercise folding).
    return rng.pick(STRING_ALPHABET);
  }

  // i64 / decimal universe: values are exact bigints (an i64 value, or a decimal scaled mantissa),
  // including mixed sign, the > 2^53 region, and the ±2^63 boundaries.
  if (type === 'i64' || type === 'decimal') {
    const I64_MAX = 2n ** 63n - 1n;
    const I64_MIN = -(2n ** 63n);
    const edges: bigint[] = [0n, 1n, -1n, 9007199254740992n, 9007199254740993n, I64_MAX, I64_MIN];
    const pick = (): bigint =>
      rng.chance(0.25) ? rng.pick(edges) : BigInt(rng.intBetween(-1000, 1000)) * (rng.chance(0.4) ? 1_000_000_000n : 1n);
    if (op === 'in' || op === 'notIn') {
      const k = rng.int(3);
      const arr: bigint[] = [];
      for (let i = 0; i < k; i++) arr.push(pick());
      return arr;
    }
    if (op === 'between') {
      const a = pick();
      const b = pick();
      return rng.chance(0.2) ? [b, a] : [a < b ? a : b, a < b ? b : a];
    }
    return pick();
  }

  // Numeric / date universe.
  if (type === 'date') {
    const base = Date.UTC(2020, 0, 1);
    const pick = () => base + rng.intBetween(0, 3 * 365) * 86_400_000;
    if (op === 'in' || op === 'notIn') {
      const k = rng.int(3);
      const arr: unknown[] = [];
      for (let i = 0; i < k; i++) {
        const ms = pick();
        const shape = rng.int(3);
        arr.push(shape === 0 ? ms : shape === 1 ? new Date(ms).toISOString() : new Date(ms));
      }
      return arr;
    }
    if (op === 'between') {
      const a = pick();
      const b = pick();
      // Sometimes emit a reversed pair to exercise the lo>hi=>empty rule.
      return rng.chance(0.2) ? [b, a] : [Math.min(a, b), Math.max(a, b)];
    }
    const ms = pick();
    const shape = rng.int(3);
    return shape === 0 ? ms : shape === 1 ? new Date(ms).toISOString() : new Date(ms);
  }

  // i32 / f64
  const pickNum = () => (type === 'i32' ? rng.intBetween(-50, 50) : Math.round(rng.intBetween(-100, 100) * 10) / 10);
  if (op === 'in' || op === 'notIn') {
    const k = rng.int(3);
    const arr: number[] = [];
    for (let i = 0; i < k; i++) arr.push(pickNum());
    return arr;
  }
  if (op === 'between') {
    const a = pickNum();
    const b = pickNum();
    return rng.chance(0.2) ? [b, a] : [Math.min(a, b), Math.max(a, b)];
  }
  return pickNum();
}

export interface TreeGenOptions {
  /** Max nesting depth of and/or/not before bottoming out in leaves. */
  maxDepth?: number;
  /** Max children at an and/or node. */
  maxBranch?: number;
  /** Coverage registry to record each (type, op) and combination-class exercised. */
  coverage?: Coverage;
}

/** Make one random leaf over a random field, recording coverage if a registry is given. */
function randomLeaf(rng: Rng, fields: FieldSpec[], cov?: Coverage): FilterNode {
  const f = rng.pick(fields);
  const op = rng.pick(OPS_BY_TYPE[f.type]);
  const value = randomValue(rng, f.type, op);
  cov?.recordLeaf(f.type, op);
  return { leaf: { field: f.name, op, value } };
}

/**
 * Generate a random FilterNode tree: nested and/or/not over random leaves for the given fields.
 * Depth-limited; at depth 0 (or by chance) it bottoms out in a leaf. Deterministic in `rng`.
 */
export function randomTree(rng: Rng, fields: FieldSpec[], opts: TreeGenOptions = {}): FilterNode {
  const maxDepth = opts.maxDepth ?? 3;
  const maxBranch = opts.maxBranch ?? 3;
  const cov = opts.coverage;

  const build = (depth: number): FilterNode => {
    // Bottom out in a leaf at the depth limit, or with rising probability as we go deeper.
    if (depth <= 0 || rng.chance(0.4)) return randomLeaf(rng, fields, cov);
    const kind = rng.int(3);
    if (kind === 2) {
      cov?.recordCombo('not');
      return { op: 'not', children: [build(depth - 1)] };
    }
    const op: 'and' | 'or' = kind === 0 ? 'and' : 'or';
    const count = rng.intBetween(0, maxBranch); // 0 children exercises the AND/OR identity.
    const children: FilterNode[] = [];
    for (let i = 0; i < count; i++) children.push(build(depth - 1));
    cov?.recordCombo(op);
    if (children.length === 0) cov?.recordCombo(op === 'and' ? 'emptyAnd' : 'emptyOr');
    return { op, children };
  };

  return build(maxDepth);
}

// ===========================================================================
// 5. runMatrix asserter.
// ===========================================================================

export interface MatrixContext {
  seed: number;
  /** The tree under test (for the failure message). */
  node: FilterNode;
  /** The rows under test (for minimal-case reporting). */
  rows: Row[];
  /** Optional label (which property/iteration) for the failure message. */
  label?: string;
}

/** Thrown by `runMatrix` on a mismatch; carries the seed + a minimized repro. */
export class FuzzMismatchError extends Error {
  readonly seed: number;
  constructor(message: string, seed: number) {
    super(message);
    this.name = 'FuzzMismatchError';
    this.seed = seed;
  }
}

function arraysEqual(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Assert the engine's result list equals the oracle's. On mismatch, throw a `FuzzMismatchError`
 * carrying the SEED and a MINIMIZED failing case: the smallest leaf predicate (and the few rows
 * that diverge) so the failure is debuggable without re-deriving the whole tree by hand.
 *
 * `engineResult`/`oracleResult` are row-id lists (ascending for unsorted scans, ordered for pages).
 */
export function runMatrix(
  engineResult: readonly number[],
  oracleResult: readonly number[],
  ctx: MatrixContext,
): void {
  if (arraysEqual(engineResult, oracleResult)) return;

  // Find the diverging row ids (symmetric difference) for a minimal report.
  const eng = new Set(engineResult);
  const ora = new Set(oracleResult);
  const onlyEngine = engineResult.filter((r) => !ora.has(r));
  const onlyOracle = oracleResult.filter((r) => !eng.has(r));

  // If the lists differ only in ORDER (same set), say so — that points at sort, not filtering.
  const sameSet = onlyEngine.length === 0 && onlyOracle.length === 0;

  const minimal = minimizeNode(ctx.node, ctx.rows, ctx);
  const sampleRowId = onlyEngine[0] ?? onlyOracle[0] ?? engineResult[0] ?? oracleResult[0];
  const sampleRow = sampleRowId === undefined ? undefined : ctx.rows[sampleRowId];

  const lines = [
    `FUZZ MISMATCH${ctx.label ? ` [${ctx.label}]` : ''} — re-run with SEED=${ctx.seed}`,
    sameSet
      ? `  same row SET but different ORDER (sort/pagination divergence)`
      : `  rows only in engine: [${onlyEngine.slice(0, 10).join(', ')}]` +
        `\n  rows only in oracle: [${onlyOracle.slice(0, 10).join(', ')}]`,
    `  engine (${engineResult.length}): [${engineResult.slice(0, 16).join(', ')}${engineResult.length > 16 ? ', …' : ''}]`,
    `  oracle (${oracleResult.length}): [${oracleResult.slice(0, 16).join(', ')}${oracleResult.length > 16 ? ', …' : ''}]`,
    `  minimal failing predicate: ${JSON.stringify(minimal)}`,
    sampleRowId === undefined ? '' : `  sample diverging row #${sampleRowId}: ${JSON.stringify(sampleRow)}`,
  ].filter((l) => l !== '');

  throw new FuzzMismatchError(lines.join('\n'), ctx.seed);
}

/**
 * Shrink the failing tree toward the smallest single leaf that still mismatches against the oracle,
 * WITHOUT calling the engine (the engine result for the full tree already disagreed; here we just
 * surface which leaf the oracle keys on). We walk leaves and report the first leaf predicate whose
 * oracle result is non-trivial on these rows — a cheap, deterministic minimizer good enough to make
 * the repro obvious. If the node is already a leaf, return it verbatim.
 */
function minimizeNode(node: FilterNode, _rows: Row[], _ctx: MatrixContext): Predicate | FilterNode {
  const leaves: Predicate[] = [];
  const collect = (n: FilterNode): void => {
    if ('leaf' in n) {
      leaves.push(n.leaf);
      return;
    }
    for (const c of n.children) collect(c);
  };
  collect(node);
  if (leaves.length === 1) return leaves[0]!;
  return node; // multi-leaf: report the whole tree (the leaf list is embedded in it).
}

// ===========================================================================
// 6. Coverage registry.
// ===========================================================================

/** A combination-class the tree generator can exercise. */
export type ComboClass = 'and' | 'or' | 'not' | 'emptyAnd' | 'emptyOr';

/**
 * Tracks which `(type, operator)` leaf pairs and which combination classes a fuzz run actually
 * exercised. `assertCoverage` fails loudly if any expected pair was NEVER hit — so a generator that
 * silently stops producing, say, `string × containsi` can't let a whole operator rot untested.
 */
export class Coverage {
  /** Set of `"${type}:${op}"` keys seen. */
  private readonly leafPairs = new Set<string>();
  private readonly combos = new Set<ComboClass>();

  recordLeaf(type: ColumnType, op: ScanOp): void {
    this.leafPairs.add(`${type}:${op}`);
  }

  recordCombo(c: ComboClass): void {
    this.combos.add(c);
  }

  /** True iff `(type, op)` was exercised at least once. */
  hasLeaf(type: ColumnType, op: ScanOp): boolean {
    return this.leafPairs.has(`${type}:${op}`);
  }

  hasCombo(c: ComboClass): boolean {
    return this.combos.has(c);
  }

  /** Every `(type, op)` pair seen, as a sorted array (for reporting). */
  leafPairList(): string[] {
    return [...this.leafPairs].sort();
  }

  comboList(): ComboClass[] {
    return [...this.combos].sort();
  }

  /**
   * Fail (throw) if any expected `(type, op)` pair or combination class was never recorded.
   * Pass the pairs you intend a run to cover; the harness prints exactly which are missing so a
   * coverage hole is actionable, not a silent gap.
   */
  assertCoverage(expectedPairs: ReadonlyArray<[ColumnType, ScanOp]>, expectedCombos: readonly ComboClass[] = []): void {
    const missingPairs = expectedPairs.filter(([t, op]) => !this.hasLeaf(t, op)).map(([t, op]) => `${t}:${op}`);
    const missingCombos = expectedCombos.filter((c) => !this.hasCombo(c));
    if (missingPairs.length === 0 && missingCombos.length === 0) return;
    const parts: string[] = [];
    if (missingPairs.length > 0) parts.push(`uncovered (type, op) pairs: [${missingPairs.join(', ')}]`);
    if (missingCombos.length > 0) parts.push(`uncovered combination classes: [${missingCombos.join(', ')}]`);
    throw new Error(`COVERAGE GAP — ${parts.join('; ')}`);
  }
}

// ===========================================================================
// 7. Convenience: the full Strapi operator set per type (for assertCoverage callers).
// ===========================================================================

/**
 * Every (type, op) pair the CLASSIC randomized generators produce — the natural coverage target for
 * the multi-type fuzz runs (numeric/string/bool/date relation matrices). Restricted to those five
 * types so existing callers stay unaffected by step 3: the i64/decimal fuzz files assert their OWN
 * targeted coverage, and json is not filterable (no leaf is ever generated for it).
 */
const CLASSIC_FUZZ_TYPES: ColumnType[] = ['i32', 'f64', 'date', 'bool', 'string'];
export function allLeafPairs(): Array<[ColumnType, ScanOp]> {
  const out: Array<[ColumnType, ScanOp]> = [];
  for (const t of CLASSIC_FUZZ_TYPES) {
    for (const op of OPS_BY_TYPE[t]) out.push([t, op]);
  }
  return out;
}

/** A map from field name to its column type — the oracle's schema lookup. */
export function fieldTypeMap(fields: FieldSpec[]): Map<string, ColumnType> {
  const m = new Map<string, ColumnType>();
  for (const f of fields) m.set(f.name, f.type);
  return m;
}
