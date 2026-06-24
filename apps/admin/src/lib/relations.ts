import type {
  RelationInput,
  RelationId,
  Entry,
  ContentTypeDefinition,
  RelationDefinition,
  RelationKind,
} from '@conti/sdk';

// ──────────────────────────────────────────────────────────────────────────────────────────────
// Relation discovery (API-driven) + relation-op body builders.
//
// The @conti/api server now EXPOSES relations on the content-type schema (`projectDef` folds a
// `relations: RelationDefinition[]` array onto every definition) AND lets a client DECLARE a relation
// over HTTP (`POST /content-types/:apiId/relations`, `client.contentTypes.addRelation`). So the admin
// DISCOVERS relations straight from `def.relations` and the builder declares real ones — no more
// out-of-band/localStorage mirroring.
//
// REMOVED (fe-06 cleanup): the old localStorage relation-config path (the `RelationConfig` map, the
// `loadRelationConfig`/`saveRelationConfig` persistence, the `relationFieldsFor`/`relationFieldMap`/
// `populateFor` config readers, and the `lib/use-relation-config.ts` hook) is GONE. Every consumer now
// derives relations from the API-projected `def.relations` via {@link relationFieldsFromDef} /
// {@link populateFromDef}; the builder ({@link RelationConfigEditor}) declares real ones over HTTP.
// ──────────────────────────────────────────────────────────────────────────────────────────────

/** A relation's cardinality, as the picker needs to know it (to-one selects one id; to-many many). */
export type RelationCardinality = 'toOne' | 'toMany';

/**
 * Map a server {@link RelationKind} (this SIDE's cardinality) to the picker's to-one / to-many split.
 * The picker only cares whether THIS side holds one related row or many: `manyToOne`/`oneToOne` are
 * to-ONE (this owner points at a single target row); `oneToMany`/`manyToMany` are to-MANY.
 */
export function cardinalityOf(kind: RelationKind): RelationCardinality {
  return kind === 'manyToOne' || kind === 'oneToOne' ? 'toOne' : 'toMany';
}

/**
 * Derive the picker-ready relation field configs for a content-type STRAIGHT FROM the API-projected
 * `def.relations` — the single source of truth (replaces the old localStorage mirror). Each declared
 * relation (owner OR inverse side) becomes a pickable field; `cardinality` is derived from this side's
 * `kind`. `labelField` is intentionally omitted (the picker falls back to the target's first stringy
 * field, then `id`).
 */
export function relationFieldsFromDef(
  def: ContentTypeDefinition | undefined,
): RelationFieldConfig[] {
  if (!def) return [];
  return def.relations.map((r: RelationDefinition) => ({
    field: r.field,
    target: r.target,
    cardinality: cardinalityOf(r.kind),
  }));
}

/** The populate spec (relation field names) for a def's declared relations, or undefined when none. */
export function populateFromDef(def: ContentTypeDefinition | undefined): string[] | undefined {
  const names = relationFieldsFromDef(def).map((r) => r.field);
  return names.length > 0 ? names : undefined;
}

/**
 * One configured relation field on a content-type. `field` is the write-body key (and the populate
 * name); `target` is the api_id of the related content-type the picker searches; `cardinality` drives
 * single-select vs multi-select. `labelField` (optional) is the target column the picker shows / searches
 * with `$containsi`; when absent the picker falls back to the target's own search field, then `id`.
 */
export interface RelationFieldConfig {
  field: string;
  target: string;
  cardinality: RelationCardinality;
  labelField?: string;
}

// ── relation-op body builders ───────────────────────────────────────────────────────────────────
//
// The create/update body is ONE flat JSON object: scalar fields and relation fields are sibling keys
// (NOT a `{ data }` envelope). A relation field's value is a `RelationInput`. We build that value here.

/** A positive int4 the API accepts as a related-row id (`> 0`, `<= 2147483647`). */
const MAX_INT4 = 2147483647;

/** True when `n` is a valid related-row id (positive int4 integer). */
export function isValidRelationId(n: number): n is RelationId {
  return Number.isInteger(n) && n > 0 && n <= MAX_INT4;
}

/** Parse a raw id-ish value (number or numeric string) to a valid relation id, or null if invalid. */
export function parseRelationId(value: unknown): RelationId | null {
  const n = typeof value === 'number' ? value : Number(value);
  return isValidRelationId(n) ? n : null;
}

/** Dedupe ids preserving first-seen order (matches the server's dedupe behavior). */
function dedupe(ids: readonly RelationId[]): RelationId[] {
  const seen = new Set<RelationId>();
  const out: RelationId[] = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * Build a `{ set }` relation op REPLACING the whole related set with `ids` (deduped). `{ set: [] }`
 * clears the relation. For a to-one relation `set` accepts at most ONE id — we keep only the first.
 * This is the op the entry form emits (the picker presents the FULL desired set, so a `set` matches
 * its semantics exactly — no need for connect/disconnect bookkeeping on a form submit).
 */
export function buildSetOp(ids: readonly RelationId[], cardinality: RelationCardinality): RelationInput {
  const deduped = dedupe(ids);
  if (cardinality === 'toOne') {
    return { set: deduped.length > 0 ? [deduped[0] as RelationId] : [] };
  }
  return { set: deduped };
}

/**
 * Build a `{ connect, disconnect }` op (ADD / REMOVE edges) — the surgical alternative to `set`.
 * `connect` adds, `disconnect` removes; combinable (server applies disconnect-THEN-connect). Mutually
 * exclusive with `set`. Empty arrays are omitted. For a to-one relation `connect` keeps at most one id.
 * Returns `null` when there is nothing to do (both empty).
 */
export function buildConnectDisconnectOp(
  connect: readonly RelationId[],
  disconnect: readonly RelationId[],
  cardinality: RelationCardinality,
): RelationInput | null {
  let conn = dedupe(connect);
  if (cardinality === 'toOne' && conn.length > 1) conn = [conn[0] as RelationId];
  const disc = dedupe(disconnect);
  if (conn.length === 0 && disc.length === 0) return null;
  const op: { connect?: RelationId[]; disconnect?: RelationId[] } = {};
  if (conn.length > 0) op.connect = conn;
  if (disc.length > 0) op.disconnect = disc;
  return op;
}

// ── populate display helpers ──────────────────────────────────────────────────────────────────

/** A single populated related row (id + arbitrary scalar columns). */
export type RelatedRow = Entry & { id: number | string };

/**
 * Coerce a populated relation value into an array of related rows. A to-one relation populates as a
 * single object (or null); a to-many populates as an array. We normalize both to `RelatedRow[]` for
 * uniform rendering. Non-object / scalar values (e.g. an un-populated bare id) yield an empty array —
 * the caller can fall back to showing the raw value.
 */
export function asRelatedRows(value: unknown): RelatedRow[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    return value.filter((v): v is RelatedRow => isRelatedRow(v));
  }
  if (isRelatedRow(value)) return [value];
  return [];
}

function isRelatedRow(v: unknown): v is RelatedRow {
  return (
    typeof v === 'object' &&
    v !== null &&
    'id' in v &&
    (typeof (v as { id: unknown }).id === 'number' || typeof (v as { id: unknown }).id === 'string')
  );
}

/**
 * Choose a human label for a related row: the configured `labelField` if present and non-empty,
 * otherwise the first string-ish scalar column, otherwise `#<id>`.
 */
export function relatedRowLabel(row: RelatedRow, labelField?: string): string {
  if (labelField && row[labelField] !== undefined && row[labelField] !== null) {
    return String(row[labelField]);
  }
  for (const [key, val] of Object.entries(row)) {
    if (key === 'id' || key === 'created_at' || key === 'updated_at') continue;
    if (typeof val === 'string' && val.length > 0) return val;
  }
  return `#${String(row.id)}`;
}

/**
 * Pick the best label/search column for a TARGET content-type: an explicitly-configured `labelField`,
 * else the first user-defined string/text field, else `id`. Used by the picker for the `$containsi`
 * search and option labels.
 */
export function targetLabelField(
  def: ContentTypeDefinition | undefined,
  configured?: string,
): string {
  if (configured) return configured;
  if (def) {
    const stringy = def.fields.find(
      (f) => !f.system && (f.cmsType === 'string' || f.cmsType === 'text' || f.cmsType === 'email'),
    );
    if (stringy) return stringy.name;
  }
  return 'id';
}
