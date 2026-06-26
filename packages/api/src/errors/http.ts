import { AppError } from './app-error.ts';
import { render } from './render.ts';
import type { Locale } from './render.ts';

/**
 * Per-code whitelist of structured params copied from `e.params` onto the wire body. ONLY these codes
 * expose extras; every other code ships just `{ error, code }`. This is deliberately NOT "spread all
 * params" — params can carry render-only / internal values (e.g. `detail`, `reason`, the raw `value`),
 * and leaking them would regress the boundary. Mirrors exactly what the existing builder envelope carries:
 *   - `db.migration.data_loss` -> `table`, `column`, `affected`
 *   - `db.migration.blocked`   -> `blocked` (the raw Change[])
 */
const WIRE_EXTRAS: Record<string, readonly string[]> = {
  'db.migration.data_loss': ['table', 'column', 'affected'],
  'db.migration.blocked': ['blocked'],
};

/** Codes that carry a `Retry-After` hint — the transient schema-lock 409 (`SchemaChangeConflictError`). */
const RETRY_AFTER: Record<string, string> = {
  'db.schema.conflict': '1',
};

/**
 * Map ANY thrown value to its HTTP shape at the boundary (decision D1 — additive wire: `code` is added
 * alongside the existing `error` string).
 *
 * - `AppError`: `status` = the catalog status; `body.error` = the per-request localized render; `body.code`
 *   = the stable code; plus the whitelisted structured extras (above) copied from `e.params`; plus a
 *   `Retry-After` header for the schema-lock code.
 * - anything else: a flat 500 `{ error: "internal error", code: "internal" }` — NEVER leak an arbitrary
 *   message (an unexpected throw must not surface PG/stack text on the wire).
 *
 * WHAT THE BUILDER ENVELOPE CALLER GETS (to stay byte-identical): see the module README / boundaryNotes —
 * `status`, `headers` (Retry-After), and the structured extras are everything the `{ ok:false, ... }`
 * routes need; those routes keep their own fixed `error` strings for the two codes where the envelope text
 * historically differs from the rendered message.
 */
export function toErrorResponse(
  e: unknown,
  locale: Locale,
): { status: number; body: Record<string, unknown>; headers?: Record<string, string> } {
  if (e instanceof AppError) {
    const body: Record<string, unknown> = { error: render(e.code, e.params, locale), code: e.code };
    const extras = WIRE_EXTRAS[e.code];
    if (extras !== undefined) {
      for (const key of extras) {
        if (Object.prototype.hasOwnProperty.call(e.params, key)) body[key] = e.params[key];
      }
    }
    const retryAfter = RETRY_AFTER[e.code];
    return retryAfter !== undefined
      ? { status: e.status, body, headers: { 'Retry-After': retryAfter } }
      : { status: e.status, body };
  }
  return { status: 500, body: { error: 'internal error', code: 'internal' } };
}
