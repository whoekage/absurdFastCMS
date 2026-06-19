import type { Sql } from 'postgres';
import type { ContentTypeDef } from '../store/registry.ts';
import { getFilesByIds, type FileAsset } from '../db/file.repository.ts';
import { JSON_CT, type CoreResponse } from './read.router.ts';

/**
 * be-04 MEDIA — the READ-side POPULATE post-step for media fields, kept ENTIRELY out of the engine.
 *
 * WHY a post-step (not the CSR relation-populate path): a media field is a PLAIN SCALAR column (an int4
 * single / a jsonb-array multiple) whose value is a `files.id` reference, and `files` is a SYSTEM table
 * that is NOT in the columnar engine. The engine's relation-populate machinery resolves CSR `Relation`
 * objects pinned to live engine Tables — it can only populate engine types, and it 400s any `populate`
 * name that is not a declared relation. So media populate runs AFTER the engine produced its response:
 * we resolve the requested media fields' id(s) against `files` in ONE batched query and splice the asset
 * record(s) into the JSON in place of the bare id(s).
 *
 * BYTE-IDENTICAL GUARANTEE: this step is invoked ONLY when (a) the type declares >=1 media field AND (b)
 * the request asked to populate at least one of them. In every other case the engine's response Buffer
 * is returned UNTOUCHED (the existing zero-copy read path). When it DOES run it JSON.parse/serializes the
 * envelope (media populate already skips the engine's zero-copy cache, exactly like relation populate) —
 * losing the verbatim-bytes splice for >2^53 json fields is acceptable on this OPT-IN, non-default path.
 *
 * SHAPE: Strapi v5 flat — a populated single media field inlines the asset OBJECT (or `null` when the id
 * references a deleted/absent asset); a populated multiple media field inlines an ARRAY of asset objects
 * (a dangling id is DROPPED, never emitted as null inside the array). Un-populated, a media field stays
 * its raw id / raw id[] (emitted byte-identically by the engine).
 */

/** The literal `populate` query keys this step recognizes (Strapi bracket + comma + plain forms). */
const POPULATE_STAR = '*';

/**
 * Parse the raw query string (WITHOUT a leading '?') for the set of top-level field names the request
 * asked to populate. Supports the same surface the engine's parser accepts at depth-1: `populate=a,b`,
 * `populate=*`, `populate[0]=a`, `populate[a]=...`, `populate[a][populate]=...`. We only need the
 * TOP-LEVEL names (media has no sub-populate), so a bracketed `populate[a][...]` contributes `a`. Returns
 * the name set plus whether `*` (populate-everything) was requested.
 */
export function parsePopulateNames(query: string): { names: Set<string>; star: boolean } {
  const names = new Set<string>();
  let star = false;
  const q = query.startsWith('?') ? query.slice(1) : query;
  for (const pair of q.split('&')) {
    if (pair === '') continue;
    const eq = pair.indexOf('=');
    const rawKey = eq === -1 ? pair : pair.slice(0, eq);
    const rawVal = eq === -1 ? '' : pair.slice(eq + 1);
    const key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
    if (key === 'populate') {
      // `populate=a,b,c` or `populate=*` or `populate=a`.
      for (const v of decodeURIComponent(rawVal.replace(/\+/g, ' ')).split(',')) {
        const name = v.trim();
        if (name === POPULATE_STAR) star = true;
        else if (name !== '') names.add(name);
      }
    } else if (key.startsWith('populate[')) {
      // `populate[0]=a` -> value is the name; `populate[a]=...` / `populate[a][populate]=...` -> key `a`.
      const inner = key.slice('populate['.length, key.indexOf(']'));
      if (/^\d+$/.test(inner)) {
        const v = decodeURIComponent(rawVal.replace(/\+/g, ' ')).trim();
        if (v === POPULATE_STAR) star = true;
        else if (v !== '') names.add(v);
      } else if (inner === POPULATE_STAR) {
        star = true;
      } else if (inner !== '') {
        names.add(inner);
      }
    }
  }
  return { names, star };
}

/**
 * The media fields of `def` that THIS request asked to populate. `populate=*` expands to ALL of the
 * type's media fields (mirrors the engine's `*` -> all-relations). An explicit name set populates only
 * the named media fields. Returns an empty Map when nothing media is to be populated => the caller skips
 * the post-step and returns the engine Buffer untouched (byte-identical).
 */
export function mediaPopulateTargets(def: ContentTypeDef, query: string): Map<string, { multiple: boolean }> {
  const out = new Map<string, { multiple: boolean }>();
  if (def.mediaFields.size === 0) return out;
  const { names, star } = parsePopulateNames(query);
  if (star) return new Map(def.mediaFields);
  for (const name of names) {
    const m = def.mediaFields.get(name);
    if (m !== undefined) out.set(name, m);
  }
  return out;
}

/**
 * Strip the populate entries that name a MEDIA field out of the raw query string, so the engine's
 * populate parser (which only knows relations) never sees them and never 400s. Relation populate entries
 * (and every other query param) survive verbatim. Operates on the same key forms parsePopulateNames reads.
 * `*` is LEFT in place: the engine's `*` legitimately expands to the type's relations (a no-op when there
 * are none), and the media step independently expands `*` to media fields — both honor the wildcard.
 */
export function stripMediaPopulate(query: string, mediaNames: Set<string>): string {
  if (mediaNames.size === 0) return query;
  const q = query.startsWith('?') ? query.slice(1) : query;
  const kept: string[] = [];
  for (const pair of q.split('&')) {
    if (pair === '') continue;
    const eq = pair.indexOf('=');
    const rawKey = eq === -1 ? pair : pair.slice(0, eq);
    const rawVal = eq === -1 ? '' : pair.slice(eq + 1);
    const key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
    if (key === 'populate') {
      // Drop media names from the comma list; keep the rest (incl. `*`). An emptied key is dropped.
      const rest = decodeURIComponent(rawVal.replace(/\+/g, ' '))
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '' && !mediaNames.has(s));
      if (rest.length > 0) kept.push(`populate=${rest.map((s) => encodeURIComponent(s)).join(',')}`);
    } else if (key.startsWith('populate[')) {
      const inner = key.slice('populate['.length, key.indexOf(']'));
      if (/^\d+$/.test(inner)) {
        const v = decodeURIComponent(rawVal.replace(/\+/g, ' ')).trim();
        if (!mediaNames.has(v)) kept.push(pair);
      } else if (!mediaNames.has(inner)) {
        kept.push(pair);
      }
    } else {
      kept.push(pair);
    }
  }
  return kept.join('&');
}

/** Collect every referenced `files.id` across one row's targeted media fields (for the batch lookup). */
function collectIds(row: Record<string, unknown>, targets: Map<string, { multiple: boolean }>, into: Set<number>): void {
  for (const [name, { multiple }] of targets) {
    const v = row[name];
    if (v === undefined || v === null) continue;
    if (multiple) {
      if (Array.isArray(v)) for (const id of v) if (typeof id === 'number') into.add(id);
    } else if (typeof v === 'number') {
      into.add(v);
    }
  }
}

/** Replace a row's targeted media field values with resolved asset object(s) (in place). */
function inlineRow(row: Record<string, unknown>, targets: Map<string, { multiple: boolean }>, byId: Map<number, FileAsset>): void {
  for (const [name, { multiple }] of targets) {
    const v = row[name];
    if (v === undefined) continue;
    if (multiple) {
      if (v === null) {
        row[name] = []; // a cleared multiple media field populates as an empty array.
      } else if (Array.isArray(v)) {
        row[name] = v.map((id) => (typeof id === 'number' ? byId.get(id) : undefined)).filter((a): a is FileAsset => a !== undefined);
      }
    } else {
      // Single: id -> the asset object, or null when the id references a deleted/absent asset (or was null).
      row[name] = typeof v === 'number' ? (byId.get(v) ?? null) : null;
    }
  }
}

/**
 * Apply media populate to an engine LIST/SINGLE response Buffer. Parses the `{data,meta}` envelope,
 * batch-resolves every referenced asset id across all rows in ONE `getFilesByIds` query, inlines the
 * asset object(s) per row, and re-serializes. `data` may be an array (list) or an object (single item).
 * The caller guarantees `targets` is non-empty (otherwise it returns the original Buffer untouched).
 */
export async function applyMediaPopulate(
  sql: Sql,
  body: Buffer,
  targets: Map<string, { multiple: boolean }>,
): Promise<CoreResponse> {
  const envelope = JSON.parse(body.toString('utf8')) as { data: unknown; meta: unknown };
  const rows: Record<string, unknown>[] = Array.isArray(envelope.data)
    ? (envelope.data as Record<string, unknown>[])
    : envelope.data !== null && typeof envelope.data === 'object'
      ? [envelope.data as Record<string, unknown>]
      : [];

  const ids = new Set<number>();
  for (const row of rows) collectIds(row, targets, ids);
  const byId = await getFilesByIds(sql, [...ids]);
  for (const row of rows) inlineRow(row, targets, byId);

  return { status: 200, contentType: JSON_CT, body: Buffer.from(JSON.stringify(envelope), 'utf8') };
}
