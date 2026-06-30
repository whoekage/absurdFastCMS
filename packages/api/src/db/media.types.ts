/**
 * be-04 MEDIA — the `allowedTypes` vocabulary shared by the SCHEMA-AUTHOR validator (type.catalog, which
 * checks each entry is well-formed at resolve) and the WRITE-TIME enforcer (http/write.handler, which
 * matches a referenced asset's STORED mime against the field's allowedTypes). Kept in one module so the two
 * sides can never drift. An `allowedTypes` entry is either a Strapi-style CATEGORY bucket (images / videos /
 * audios / files) or an explicit MIME — exact (`image/png`) or a `type/*` wildcard (`image/*`).
 */

/** The category buckets a media field's `allowedTypes` may name (besides an explicit MIME). */
const MEDIA_CATEGORIES: ReadonlySet<string> = new Set(['images', 'videos', 'audios', 'files']);

/** Well-formedness gate (schema-author time): a known category OR an explicit MIME (must contain a `/`). */
export function isValidAllowedType(t: string): boolean {
  return MEDIA_CATEGORIES.has(t) || t.includes('/');
}

/** Whether a category bucket matches a mime. `files` = anything that is NOT image/video/audio (the catch-all). */
function categoryMatch(mime: string, category: string): boolean {
  const m = mime.toLowerCase();
  switch (category) {
    case 'images': return m.startsWith('image/');
    case 'videos': return m.startsWith('video/');
    case 'audios': return m.startsWith('audio/');
    case 'files': return !(m.startsWith('image/') || m.startsWith('video/') || m.startsWith('audio/'));
    default: return false;
  }
}

/**
 * Does a STORED mime satisfy at least one allowedTypes entry? (write-time gate). A category bucket matches
 * by family; an explicit MIME matches exactly (case-insensitive); a `type/*` entry matches by prefix. The
 * mime MUST come from the content-addressed registry (detected at upload), NEVER from client-declared input.
 */
export function mimeAllowed(mime: string, allowed: readonly string[]): boolean {
  for (const a of allowed) {
    if (a.includes('/')) {
      if (a.endsWith('/*')) {
        if (mime.toLowerCase().startsWith(a.slice(0, -1).toLowerCase())) return true;
      } else if (mime.toLowerCase() === a.toLowerCase()) {
        return true;
      }
    } else if (categoryMatch(mime, a)) {
      return true;
    }
  }
  return false;
}
