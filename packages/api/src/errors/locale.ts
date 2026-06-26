import { LOCALES, type Locale } from './render.ts';

/**
 * Resolve a {@link Locale} from an `Accept-Language` header (decision D5). Returns the FIRST listed tag
 * whose base subtag is supported (`ru-RU` -> `ru`), ignoring q-weights/order beyond list position; falls
 * back to `en` when the header is absent or names no supported locale. Deterministic + allocation-light;
 * never throws.
 */
export function localeFromAcceptLanguage(header: string | undefined): Locale {
  if (header === undefined) return 'en';
  for (const part of header.split(',')) {
    const tag = part.split(';')[0]?.trim().toLowerCase() ?? '';
    const base = tag.split('-')[0] ?? '';
    const hit = LOCALES.find((l) => l === base);
    if (hit !== undefined) return hit;
  }
  return 'en';
}
