import { CATALOG, type ErrorCode } from './catalog.ts';

/**
 * The supported locales, in preference order. `en` is the default + the byte-identical log/throw locale.
 * (`ky` = Kyrgyz — the ISO 639-1 code, not the country code `kg`; `kk` Kazakh, `uz` Uzbek (Latin), `es`
 * Spanish, `ja` Japanese, `ko` Korean.)
 */
export const LOCALES = ['en', 'ru', 'ky', 'kk', 'uz', 'es', 'ja', 'ko'] as const;
export type Locale = (typeof LOCALES)[number];

/**
 * Bespoke `{param}` interpolator (decision D2 — NO i18n lib). Replaces each `{name}` token (name = one or
 * more word chars) with `String(params[name])`; an UNKNOWN `{x}` (no such key) is left verbatim. Single
 * pass — a replacement value that itself contains `{...}` is NEVER re-scanned, so a freeform `{detail}`
 * whose message happens to contain braces stays byte-identical.
 */
export function interpolate(tpl: string, params: Record<string, unknown>): string {
  return tpl.replace(/\{(\w+)\}/g, (match: string, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}

/**
 * Render a code's message in `locale`: pick `CATALOG[code].messages[locale]`, falling back to the `en`
 * template, then to the bare `code` (for an unknown/not-yet-cataloged code), and interpolate it. The
 * `en` render of a cataloged code is BYTE-IDENTICAL to the message its class historically threw.
 */
export function render(code: string, params: Record<string, unknown>, locale: Locale): string {
  const entry = CATALOG[code as ErrorCode] as { status: number; messages: Record<Locale, string> } | undefined;
  const tpl = entry?.messages[locale] ?? entry?.messages.en ?? code;
  return interpolate(tpl, params);
}
