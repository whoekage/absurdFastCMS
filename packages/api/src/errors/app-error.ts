import { render } from './render.ts';
import { CATALOG, type ErrorCode } from './catalog.ts';

/**
 * The single base class for every typed, catalog-backed error (decision D4 — THIN subclasses map their
 * existing constructor onto a `code` + `params`; they keep their name + any extra public fields handlers
 * read). The `Error.message` (super text) is the DEFAULT-locale (`en`) render — used for logs/stack only;
 * the WIRE message is re-rendered per request at the boundary via {@link toErrorResponse}.
 *
 * NOTE: the locked contract wrote this with constructor parameter properties; this package compiles under
 * `erasableSyntaxOnly`, which forbids them, so the fields are declared + assigned explicitly. The public
 * shape (readonly `code`, readonly `params`, the `status` getter, the `(code, params?, options?)` ctor) is
 * identical.
 */
export class AppError extends Error {
  readonly code: string;
  readonly params: Record<string, unknown>;

  constructor(code: string, params: Record<string, unknown> = {}, options?: { cause?: unknown }) {
    super(render(code, params, 'en'), options);
    this.name = 'AppError';
    this.code = code;
    this.params = params;
  }

  /** The HTTP status for this code (status parity with the boundary); unknown codes -> 500. */
  get status(): number {
    return CATALOG[this.code as ErrorCode]?.status ?? 500;
  }
}
