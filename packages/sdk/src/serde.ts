// @conti/sdk — WIRE FIDELITY: schema-aware value (de)serialization (Slice 7).
//
// PURE module — NO client dependency. These functions map between the wire JSON shapes the api emits
// and richer JS values, driven by a {@link ModuleDefinition} (the `projectDef` shape from Slice 1).
// The client (Slice 4) optionally composes them; nothing here imports the client.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WIRE FACTS (verified against the REAL server — packages/api, postgres.js parsing contract documented
// in packages/api/src/db/type.catalog.ts; pinned by test/serde.test.ts with real values, NO MOCKS):
//
//   • biginteger (pg int8)  → emitted as a QUOTED STRING. Lossless above 2^53. Stays `string` here.
//   • decimal    (pg numeric) → emitted as a QUOTED STRING. Preserves fixed scale (e.g. "1.50").
//   • json / array (pg jsonb) → round-trips BYTE-EXACT as an already-parsed JS value (nested verbatim).
//   • date       (pg date)     → ISO string "YYYY-MM-DD".
//   • datetime   (pg timestamptz) → full ISO-8601 string.
//   • integer/float/boolean/string/text/email/uid/enumeration/time/uuid → plain JSON scalars.
//
// ANTI PRECISION-LOSS GUARANTEE: a `biginteger` or `decimal` value is NEVER passed through `Number()`
// anywhere in this module. `JSON.parse` (in the client) already keeps the QUOTED wire value as the
// string it is on the wire — we keep it a string by default, and the ONLY richer form we offer for a
// biginteger is `BigInt(...)` (exact for arbitrary magnitude), never the lossy IEEE-754 `Number`. A
// `decimal` is never widened at all (no JS primitive is both exact-scale AND arbitrary-magnitude), so
// it stays the lossless wire string. See {@link assertNoNumberCoercion} for the pinned invariant.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

import type { CmsType, ModuleDefinition, Entry } from './types.ts';

// === 7.1 — decode options =======================================================================

/**
 * Opt-in richer-type conversions for {@link decodeEntry}. Both default to OFF so the decoded entry is,
 * by default, byte-faithful to the wire (the safest, lossless representation):
 *
 *   • `bigints` — convert a `biginteger` field's wire string to a native `bigint`. EXACT for any
 *     magnitude (this is the whole point of the field). A `decimal` is deliberately NOT converted: no
 *     JS primitive preserves both its fixed scale AND arbitrary magnitude, so it stays the wire string.
 *   • `dates` — convert a `date` / `datetime` field's ISO string to a JS `Date`.
 *
 * A `json` field is always left as its already-parsed value (`unknown`); there is nothing richer to do.
 */
export interface DecodeOptions {
  /** Convert `biginteger` wire strings to native `bigint` (exact). Default `false` → stays `string`. */
  bigints?: boolean;
  /** Convert `date`/`datetime` ISO strings to `Date`. Default `false` → stays `string`. */
  dates?: boolean;
}

// === 7.3 — anti precision-loss guarantee ========================================================

/**
 * The pinned invariant behind the precision-loss guarantee: a `biginteger` / `decimal` wire value must
 * survive a round trip THROUGH THE STRING, never through `Number()`. Given the original wire string and
 * a candidate decoded value, returns `true` when the decode is provably lossless:
 *
 *   • the value was kept as the SAME string (decimal, or biginteger with `bigints:false`), or
 *   • the value is a `bigint` whose own `.toString()` re-canonicalises to the wire string (biginteger
 *     with `bigints:true`).
 *
 * It returns `false` for ANY `number` — passing a big wire value through `Number()` is exactly the
 * lossy path this module forbids. Used by the test suite to PIN the guarantee against the real server;
 * exported so consumers can assert it on their own hot paths.
 */
export function isLosslessBigDecode(wire: string, decoded: unknown): boolean {
  if (typeof decoded === 'string') return decoded === wire;
  if (typeof decoded === 'bigint') return decoded.toString() === normalizeIntString(wire);
  return false; // number (or anything else) — NOT lossless.
}

/**
 * Guard helper: throw if a value destined for a `biginteger` / `decimal` slot is a `number` (the lossy
 * `Number()` path). Pure; throws a descriptive `RangeError`. Belt-and-braces for callers building write
 * bodies by hand — the SDK itself never coerces, but a caller might.
 */
export function assertNoNumberCoercion(field: string, value: unknown): void {
  if (typeof value === 'number') {
    throw new RangeError(
      `@conti/sdk: field "${field}" is a biginteger/decimal and must not be a JS number ` +
        `(IEEE-754 loses precision above 2^53 and drops fixed scale). Pass a string${''} or bigint instead.`,
    );
  }
}

/** Canonicalise a decimal-integer wire string for comparison (strip a leading `+`, fold `-0` → `0`). */
function normalizeIntString(s: string): string {
  let t = s.trim();
  if (t.startsWith('+')) t = t.slice(1);
  // Strip a single leading sign for zero-folding, then re-attach unless the magnitude is zero.
  const neg = t.startsWith('-');
  const mag = neg ? t.slice(1) : t;
  const trimmed = mag.replace(/^0+(?=\d)/, '');
  if (trimmed === '0') return '0';
  return neg ? `-${trimmed}` : trimmed;
}

// === 7.1 — schema-aware DECODE (raw wire entry → typed values) ==================================

/**
 * Index a definition's fields by name once, so decode/encode are O(keys) not O(keys × fields). A be-05
 * component / dynamic-zone field's type is one of the structured-content kinds (not a scalar
 * {@link CmsType}); it is skipped here so its value passes through {@link decodeValue}'s unknown-type
 * passthrough verbatim (the inline component tree is already-parsed JSON — no scalar decode applies).
 */
function fieldTypeIndex(def: ModuleDefinition): Map<string, CmsType> {
  const idx = new Map<string, CmsType>();
  const scalar = new Set<string>(['string', 'text', 'email', 'uid', 'enumeration', 'integer', 'biginteger', 'float', 'decimal', 'boolean', 'date', 'datetime', 'time', 'json', 'array', 'uuid', 'media']);
  for (const f of def.fields) if (scalar.has(f.type)) idx.set(f.name, f.type as CmsType);
  return idx;
}

/**
 * Decode ONE wire value for a known `type`, honoring {@link DecodeOptions}. Pure, total: a `null`
 * (nullable field, absent value) passes straight through; an unknown/unmapped type is returned as-is.
 *
 * INVARIANT: biginteger/decimal are never sent through `Number()`. The only richer form offered is
 * `BigInt(string)` for biginteger when `opts.bigints` — `decimal` is never widened (stays the string).
 */
export function decodeValue(type: CmsType, value: unknown, opts: DecodeOptions = {}): unknown {
  if (value === null || value === undefined) return value;

  switch (type) {
    case 'biginteger':
      // Wire = quoted string. Keep it a string unless explicitly asked for an EXACT bigint.
      if (opts.bigints === true && typeof value === 'string') return BigInt(value);
      return value;

    case 'decimal':
      // Wire = quoted string. NEVER widened: no JS primitive keeps both scale and magnitude. Stays string.
      return value;

    case 'date':
    case 'datetime':
      if (opts.dates === true && typeof value === 'string') return new Date(value);
      return value;

    case 'json':
    case 'array':
      // Already a parsed JS value (jsonb). Round-trips byte-exact — nothing richer to do.
      return value;

    default:
      // integer / float / boolean / string / text / email / uid / enumeration / time / uuid:
      // plain JSON scalars, already in their natural JS form. Pass through.
      return value;
  }
}

/**
 * 7.1 — Map a RAW wire entry into typed values per a {@link ModuleDefinition}.
 *
 * Defaults are LOSSLESS and conservative: `biginteger` / `decimal` STAY strings, `date` / `datetime`
 * stay ISO strings, `json` stays its parsed value. Opt in to richer JS types with
 * {@link DecodeOptions} (`{ bigints: true }` → `bigint` for biginteger; `{ dates: true }` → `Date`).
 *
 * Keys NOT described by the definition (none today, but forward-compat) are copied through untouched.
 * Pure: returns a NEW object, never mutates `raw`.
 */
export function decodeEntry<T extends Entry = Entry>(
  def: ModuleDefinition,
  raw: Entry,
  opts: DecodeOptions = {},
): T {
  const types = fieldTypeIndex(def);
  const out: Entry = {};
  for (const key in raw) {
    const type = types.get(key);
    out[key] = type === undefined ? raw[key] : decodeValue(type, raw[key], opts);
  }
  return out as T;
}

// === 7.2 — ENCODE (typed input → wire write body) ==============================================

/**
 * Encode ONE value for a write body. Type-driven only where it matters:
 *
 *   • a `Date` → ISO-8601 string (the api accepts ISO for date/datetime);
 *   • a `bigint` → its decimal string (the api accepts the quoted integer-string form for biginteger);
 *
 * everything else passes through verbatim (strings, numbers, booleans, nested json, arrays, `null`).
 * Pure; does not depend on `type` for the universal `Date`/`bigint` lowering (it is value-driven so
 * it stays correct even when a caller omits the field from the definition).
 */
export function encodeValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  return value;
}

/**
 * 7.2 — Encode a write-body input object into its wire form. Walks top-level keys, lowering `Date` →
 * ISO string and `bigint` → decimal string (the two JS types that are NOT directly JSON-serializable
 * into the api's accepted wire form), and passing every other value through unchanged (including
 * relation-op objects like `{ connect: [...] }` — their ids are plain numbers, untouched).
 *
 * The `def` is accepted for symmetry / future per-field encode rules but is not required for the
 * universal Date/bigint lowering. Pure: returns a NEW object, never mutates `input`.
 */
export function encodeEntry<T extends Record<string, unknown> = Record<string, unknown>>(
  defOrInput: ModuleDefinition | T,
  maybeInput?: T,
): Record<string, unknown> {
  // Overload-friendly: encodeEntry(input) OR encodeEntry(def, input). The def carries no encode rules
  // today (Date/bigint lowering is value-driven), so it is accepted and ignored beyond presence.
  const input = (maybeInput ?? defOrInput) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key in input) out[key] = encodeValue(input[key]);
  return out;
}
