import type { ContentTypeDefinition, FieldDefinition, FileAsset, WriteBody } from '@conti/sdk';

// ──────────────────────────────────────────────────────────────────────────────────────────────
// be-04 MEDIA — media-field discovery (API-driven) + write-body helpers, mirroring lib/relations.ts.
//
// A media field is a `cmsType: 'media'` FieldDefinition projected by the API; `multiple` (a conditional
// wire key) is its cardinality. The entry form discovers these from `def.fields` and renders a dedicated
// <MediaPicker> per field (NOT the scalar input handler), then merges the picked asset id(s) straight
// into the flat write body (single -> a number or null; multiple -> a number[] or []). Un-populated reads
// echo the raw id(s); a populate read inlines the FileAsset(s) — used to seed the picker on edit.
// ──────────────────────────────────────────────────────────────────────────────────────────────

/** One media field on a content-type, picker-ready. `multiple` drives single-select vs multi-select. */
export interface MediaFieldConfig {
  field: string;
  multiple: boolean;
  nullable: boolean;
}

/** Is this field a media reference? */
export function isMediaField(field: FieldDefinition): boolean {
  return field.cmsType === 'media';
}

/** Derive the media-field configs for a content-type straight from its projected `def.fields`. */
export function mediaFieldsFromDef(def: ContentTypeDefinition | undefined): MediaFieldConfig[] {
  if (!def) return [];
  return def.fields
    .filter((f) => !f.system && isMediaField(f))
    .map((f) => ({ field: f.name, multiple: f.multiple === true, nullable: f.nullable }));
}

/** The populate names for a def's media fields (so an edit read inlines the current asset(s)). */
export function mediaPopulateFromDef(def: ContentTypeDefinition | undefined): string[] {
  return mediaFieldsFromDef(def).map((m) => m.field);
}

/** The selected asset ids for every media field, keyed by field name. */
export type MediaSelections = Record<string, number[]>;

/** Coerce a (possibly populated) media value to its asset id(s). */
function idsFromValue(value: unknown): number[] {
  if (value === null || value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  const out: number[] = [];
  for (const v of list) {
    if (typeof v === 'number' && Number.isInteger(v) && v > 0) out.push(v);
    else if (v !== null && typeof v === 'object' && 'id' in v) {
      const id = (v as { id: unknown }).id;
      if (typeof id === 'number' && Number.isInteger(id) && id > 0) out.push(id);
    }
  }
  return out;
}

/** Coerce a populated media value into the FileAsset record(s) (to seed the picker thumbnails). */
export function assetsFromValue(value: unknown): FileAsset[] {
  if (value === null || value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.filter((v): v is FileAsset => v !== null && typeof v === 'object' && 'id' in v && 'mime' in v);
}

/** Seed media selections from an edit row (populated) or empties (create). */
export function buildInitialMedia(
  mediaFields: MediaFieldConfig[],
  row?: Record<string, unknown>,
): MediaSelections {
  const out: MediaSelections = {};
  for (const m of mediaFields) out[m.field] = row ? idsFromValue(row[m.field]) : [];
  return out;
}

/** Seed the per-field asset records (to label seeded selections in the picker) from a populated row. */
export function buildInitialMediaAssets(
  mediaFields: MediaFieldConfig[],
  row?: Record<string, unknown>,
): Record<string, FileAsset[]> {
  const out: Record<string, FileAsset[]> = {};
  for (const m of mediaFields) out[m.field] = row ? assetsFromValue(row[m.field]) : [];
  return out;
}

/**
 * Merge media selections into a write body as sibling scalar keys. SINGLE: the first id, or `null` when
 * empty (clears the column). MULTIPLE: the full id array (`[]` clears). This matches the server's media
 * write grammar exactly (see body.parser coerceMedia): a single int4 / a jsonb id array / null.
 */
export function applyMediaValues(
  body: WriteBody,
  mediaFields: MediaFieldConfig[],
  selections: MediaSelections,
): WriteBody {
  for (const m of mediaFields) {
    const ids = selections[m.field] ?? [];
    body[m.field] = m.multiple ? ids : (ids[0] ?? null);
  }
  return body;
}

/** React-query key namespace for the media library (asset list pages + single assets). */
export const mediaKeys = {
  all: ['media'] as const,
  list: (start: number, limit: number) => ['media', 'list', start, limit] as const,
};

/** True when the asset is a previewable image (an <img> thumbnail; else a mime badge). */
export function isImageAsset(asset: Pick<FileAsset, 'mime' | 'url'>): boolean {
  return asset.mime.startsWith('image/') && asset.url !== null;
}

/** Human-readable byte size. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
