/**
 * The `@conti/api` errors module barrel (decision D6 — api-only for now). Re-exports the public surface:
 * the {@link AppError} base + the {@link CATALOG} / {@link ErrorCode} contract, the {@link render} /
 * {@link interpolate} primitives + {@link LOCALES} / {@link Locale}, and the two boundary helpers
 * {@link toErrorResponse} + {@link localeFromAcceptLanguage}.
 */
export { AppError } from './app-error.ts';
export { CATALOG, type ErrorCode } from './catalog.ts';
export { LOCALES, render, interpolate, type Locale } from './render.ts';
export { toErrorResponse } from './http.ts';
export { localeFromAcceptLanguage } from './locale.ts';
