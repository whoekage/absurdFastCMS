import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ColumnType } from './column.ts';
import { coerceDecimal, coerceI64, formatDecimal } from './column.ts';
import type { BoundaryValue } from './indexes/composite-sorted.index.ts';

/**
 * A typed, generic invalid-cursor failure. The HTTP layer maps it to 400; the message is
 * GENERIC for every reject mode (bad base64, non-JSON, HMAC mismatch, sig mismatch, bad version,
 * bad shape) so a tampered cursor leaks NOTHING about the secret, sig, or expected values.
 */
export class InvalidCursorError extends Error {
  constructor() {
    super('invalid or expired pagination cursor');
    this.name = 'InvalidCursorError';
  }
}

/** The decoded cursor body: the boundary's sort-tuple values + the stable PK `id`. v = format version. */
export interface CursorPayload {
  v: number;
  sortValues: BoundaryValue[];
  id: number;
}

/**
 * The CONTEXT a cursor is bound to. `sortCanonical` is the resolved sort spec (client keys +
 * appended id:asc + the null rule), `filterCanonical` the canonical filter shape, `schemaVersion`
 * the field-shape counter. Any mismatch vs the live request flips the sig and rejects the cursor.
 */
export interface SigInput {
  /** The content-type (collection) name — binds a cursor to ITS collection so a cursor minted on
   * type A cannot be replayed against type B that happens to share the sort/filter/schemaVersion. */
  typeName: string;
  sortCanonical: string;
  filterCanonical: string;
  schemaVersion: number;
}

/**
 * The per-key field TYPES of the resolved client sort keys (NOT including the appended id), in
 * order. Drives lossless per-type encode/decode of each `sortValues[i]`. A `decimal` key carries
 * its scale + precision so a mantissa string round-trips to the SAME bigint the column stored.
 */
export interface SortFieldType {
  type: ColumnType;
  scale?: number;
  precision?: number;
}

const CURSOR_VERSION = 1;

/** Reject an oversized token before any decode work (DoS / abuse guard). */
const MAX_TOKEN_LEN = 8192;

/** Strict base64url alphabet (no padding) — a token outside it is rejected before decode. */
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

/**
 * The HMAC-signed, tamper-evident pagination cursor codec. Pure: the secret is INJECTED (no env
 * read here). `node:crypto` only — no runtime dependency.
 *
 * Token = base64url(JSON.stringify({ v, sig, sortValues, id })) where
 *   sig = HMAC-SHA256(secret, contextCanonical + '|' + bodyCanonical) hex.
 *
 * `contextCanonical` binds sort + null-rule + filter shape + schemaVersion + version; `bodyCanonical`
 * binds the boundary body itself (v, sortValues with bigint as string, id) — so tampering EITHER the
 * context (wrong sort/filter) OR the body (a flipped sortValue / id) flips the sig and is rejected.
 */
export class CursorCodec {
  private readonly secret: string;

  constructor(secret: string) {
    this.secret = secret;
  }

  /**
   * Map compare-form sortValues to their LOSSLESS JSON-ready form per field type:
   *   - i64    -> decimal string of the bigint (`bigint.toString()`)
   *   - decimal-> `formatDecimal(mantissa, scale)` string (NOT the bare bigint)
   *   - date/i32/f64 -> number; bool -> boolean; string/text -> string; NULL -> null
   * Symmetric on encode and decode (decode re-derives the SAME array for the sig recompute).
   */
  private toJsonValues(fieldTypes: SortFieldType[], sortValues: BoundaryValue[]): (number | string | boolean | null)[] {
    return sortValues.map((v, i) => {
      if (v === null) return null;
      const ft = fieldTypes[i]!;
      if (ft.type === 'i64') return (v as bigint).toString();
      if (ft.type === 'decimal') return formatDecimal(v as bigint, ft.scale ?? 0);
      return v as number | string | boolean;
    });
  }

  /** Canonical, stable serialization of the signed body (key order [v, sortValues, id]). */
  private bodyCanonical(fieldTypes: SortFieldType[], payload: CursorPayload): string {
    const sv = this.toJsonValues(fieldTypes, payload.sortValues);
    return JSON.stringify({ v: payload.v, sortValues: sv, id: payload.id });
  }

  private contextCanonical(sig: SigInput): string {
    // NOTE: this signs the compile-time `CURSOR_VERSION`, not the payload `v`. Safe ONLY because
    // `decode` hard-rejects any token whose `obj.v !== CURSOR_VERSION` BEFORE the sig is recomputed,
    // so `v` is always pinned to 1 at signing time (and is additionally covered by bodyCanonical). If
    // multi-version support is ever added (relaxing that strict equality gate), switch this to sign
    // the actual `payload.v` so the signature itself binds the version.
    return (
      String(CURSOR_VERSION) +
      '|' + JSON.stringify(sig.typeName) +
      '|' + sig.sortCanonical +
      '|' + sig.filterCanonical +
      '|' + String(sig.schemaVersion)
    );
  }

  private computeSig(sig: SigInput, fieldTypes: SortFieldType[], payload: CursorPayload): string {
    const material = this.contextCanonical(sig) + '|' + this.bodyCanonical(fieldTypes, payload);
    return createHmac('sha256', this.secret).update(material).digest('hex');
  }

  /**
   * Mint an opaque cursor token for the boundary `payload` under the live request `sig` context.
   * The payload's `sortValues` are already in lossless compare-form (number / bigint / string /
   * boolean / null); they are serialized with bigint -> decimal string for the JSON body.
   */
  encode(sig: SigInput, fieldTypes: SortFieldType[], payload: CursorPayload): string {
    const signature = this.computeSig(sig, fieldTypes, payload);
    const sv = this.toJsonValues(fieldTypes, payload.sortValues);
    const json = JSON.stringify({ v: payload.v, sig: signature, sortValues: sv, id: payload.id });
    return Buffer.from(json, 'utf8').toString('base64url');
  }

  /**
   * Decode + verify a cursor token against the live request `sig` context and the resolved client
   * sort-key `fieldTypes` (for lossless per-type coercion). EVERY failure mode throws the SAME
   * {@link InvalidCursorError}. On success returns the {@link CursorPayload} whose `sortValues` are
   * back in compare-form (bigint for i64/decimal, number for date, etc.).
   */
  decode(sig: SigInput, fieldTypes: SortFieldType[], token: string): CursorPayload {
    if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LEN) {
      throw new InvalidCursorError();
    }
    if (!BASE64URL_RE.test(token)) throw new InvalidCursorError();

    let parsed: unknown;
    try {
      const json = Buffer.from(token, 'base64url').toString('utf8');
      parsed = JSON.parse(json);
    } catch {
      throw new InvalidCursorError();
    }

    if (typeof parsed !== 'object' || parsed === null) throw new InvalidCursorError();
    const obj = parsed as Record<string, unknown>;

    // Version.
    if (obj.v !== CURSOR_VERSION) throw new InvalidCursorError();
    // Body shape.
    const rawSig = obj.sig;
    const rawSortValues = obj.sortValues;
    const id = obj.id;
    if (typeof rawSig !== 'string') throw new InvalidCursorError();
    if (!Array.isArray(rawSortValues)) throw new InvalidCursorError();
    if (rawSortValues.length !== fieldTypes.length) throw new InvalidCursorError();
    if (typeof id !== 'number' || !Number.isInteger(id) || id < 0) throw new InvalidCursorError();

    // Decode each sortValue to compare-form per the resolved field type (lossless).
    const sortValues: BoundaryValue[] = new Array(fieldTypes.length);
    for (let i = 0; i < fieldTypes.length; i++) {
      sortValues[i] = this.decodeValue(fieldTypes[i]!, rawSortValues[i]);
    }

    const payload: CursorPayload = { v: CURSOR_VERSION, sortValues, id };

    // Recompute the sig over the live context + the canonical re-serialization of the decoded body.
    const expected = this.computeSig(sig, fieldTypes, payload);
    if (!this.sigEquals(expected, rawSig)) throw new InvalidCursorError();

    return payload;
  }

  /** Per-type lossless decode of one raw JSON sortValue back to compare-form. */
  private decodeValue(ft: SortFieldType, raw: unknown): BoundaryValue {
    if (raw === null) return null; // explicit NULL marker — comparator applies the null rule.
    switch (ft.type) {
      case 'i32':
      case 'f64':
      case 'date':
        if (typeof raw !== 'number' || !Number.isFinite(raw)) throw new InvalidCursorError();
        return raw;
      case 'bool':
        if (typeof raw !== 'boolean') throw new InvalidCursorError();
        return raw;
      case 'string':
      case 'text':
        if (typeof raw !== 'string') throw new InvalidCursorError();
        return raw;
      case 'i64':
        if (typeof raw !== 'string') throw new InvalidCursorError();
        try {
          return coerceI64(raw);
        } catch {
          throw new InvalidCursorError();
        }
      case 'decimal':
        if (typeof raw !== 'string') throw new InvalidCursorError();
        try {
          return coerceDecimal(raw, ft.scale ?? 0, ft.precision);
        } catch {
          throw new InvalidCursorError();
        }
      case 'json':
        // json is rejected as a sort key before any cursor is minted; defensively reject.
        throw new InvalidCursorError();
    }
  }

  /** Constant-time hex-sig compare with a length guard (uniform failure either way). */
  private sigEquals(expected: string, actual: string): boolean {
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(actual, 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }
}
