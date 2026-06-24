import {
  resolveType,
  resolveComponentField,
  isComponentFieldKind,
  classifyTypeChange,
  type ResolvedType,
} from '../type.catalog.ts';
import type { ContentTypeSchema, FieldSchema } from './model.ts';

/**
 * THE PURE DIFF ENGINE (§S3) — `diff(prev, next)` over two sets of files-first schemas, matching
 * content-types AND fields by their STABLE `id`, never by name. This is the design that removes the
 * rename-data-loss class that defines every name-pairing differ in the wild (Strapi #12626/#19141 wiped
 * 68k rows; Prisma #4694; Alembic; TypeORM synchronize; Directus): a field with the SAME id and a changed
 * name is a `renameField` → `ALTER ... RENAME COLUMN` (lossless), NOT a drop+add.
 *
 * Cross-ecosystem lessons baked in (see docs/research/schema-source-of-truth.md §1 + the diff-engine
 * survey):
 *   - id-matching makes rename-vs-recreate DECIDABLE (no heuristic, no interactive prompt, no CI footgun).
 *   - a field that renames AND retypes in one step emits BOTH ops — trivial here, impossible for
 *     Django/Drizzle (their name-pairing can't represent "rename + type change" together).
 *   - REORDER is WIRE-ONLY: field order is the projection/wire order (driven by `sort`), never the
 *     physical column position — so a reorder emits no DDL and never rewrites a table.
 *   - PRESENTATION is not structure: `info` (labels/display) and a derived `collectionName` never emit a
 *     change (Directus #10755 diffed presentation into DDL and deleted fields).
 *   - every op carries a `risk` so the S4 lint can gate destructive ops INDIVIDUALLY (not one global
 *     `--force`, which Skeema/Drizzle proved a footgun). Type changes reuse `classifyTypeChange`.
 *   - IDEMPOTENCY is a hard invariant: `diff(x, x)` is empty (kills the TypeORM/Liquibase churn class).
 *
 * PURE: no DB, no fs, no engine. Relations + component-type schemas are DEFERRED (consistent with the S1
 * adapter) — a relation-bearing schema fails LOUD via {@link SchemaDiffError}.
 */

export class SchemaDiffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaDiffError';
  }
}

/**
 * Per-op DATA risk, the seam the S4 lint gates on (mirrors Atlas's analyzer classes):
 *   - `safe`           — no data at risk (rename, reorder, additive create, widening, additive flag).
 *   - `data-dependent` — succeeds or fails depending on EXISTING ROWS (NOT NULL add w/o default →
 *     Atlas MF103; nullable→NOT NULL → MF104; a `rewrite` type change whose cast may fail on real data).
 *   - `destructive`    — irreversibly DROPS data if applied (drop field/type; turning a draft&publish /
 *     i18n flag OFF drops its column — exactly Strapi #19141's silent-loss trigger).
 *   - `forbidden`      — the catalog refuses the type transition outright (`classifyTypeChange` → forbidden).
 */
export type ChangeRisk = 'safe' | 'data-dependent' | 'destructive' | 'forbidden';

interface BaseChange {
  /** The content-type's STABLE id (identity across renames). */
  readonly typeId: string;
  /** The content-type's CURRENT (next) apiId — the table is `ct_<apiId>` (post-rename for a renamed type). */
  readonly apiId: string;
  readonly risk: ChangeRisk;
}

/** A whole new content-type (a fresh empty `ct_` table — its NOT NULL fields are safe: no rows yet). */
export interface AddType extends BaseChange { readonly kind: 'addType'; readonly schema: ContentTypeSchema; }
/** Drop a content-type entirely (DESTRUCTIVE). */
export interface DropType extends BaseChange { readonly kind: 'dropType'; }
/** Same id, changed apiId → `ALTER TABLE ct_<from> RENAME TO ct_<to>` (lossless). */
export interface RenameType extends BaseChange { readonly kind: 'renameType'; readonly fromApiId: string; readonly toApiId: string; }
/** Toggle a per-type structural flag. ON = additive (safe); OFF = drops the system column (destructive). */
export interface SetTypeOption extends BaseChange { readonly kind: 'setTypeOption'; readonly option: 'draftAndPublish' | 'i18n'; readonly from: boolean; readonly to: boolean; }
/** A new field (new id) → `ADD COLUMN`. data-dependent iff NOT NULL with no default (existing rows). */
export interface AddField extends BaseChange { readonly kind: 'addField'; readonly field: FieldSchema; readonly sort: number; }
/** Drop a field (DESTRUCTIVE). */
export interface DropField extends BaseChange { readonly kind: 'dropField'; readonly fieldId: string; readonly name: string; }
/** Same id, changed name → `RENAME COLUMN` (the headline lossless win). */
export interface RenameField extends BaseChange { readonly kind: 'renameField'; readonly fieldId: string; readonly from: string; readonly to: string; }
/** Same id+name, changed resolved TYPE/options → `ALTER COLUMN TYPE`. risk from {@link classifyTypeChange}. */
export interface RetypeField extends BaseChange { readonly kind: 'retypeField'; readonly fieldId: string; readonly name: string; readonly from: ResolvedType; readonly to: ResolvedType; readonly classification: 'metadata-only' | 'rewrite' | 'forbidden'; }
/** Same id+name, changed nullability. → NOT NULL is data-dependent (existing nulls); → NULL is safe. */
export interface SetFieldNullable extends BaseChange { readonly kind: 'setFieldNullable'; readonly fieldId: string; readonly name: string; readonly from: boolean; readonly to: boolean; }
/** The common fields' relative ORDER changed → re-`sort` (WIRE-ONLY, no DDL). `order` = next field ids. */
export interface ReorderFields extends BaseChange { readonly kind: 'reorderFields'; readonly order: readonly string[]; }

export type Change =
  | AddType | DropType | RenameType | SetTypeOption
  | AddField | DropField | RenameField | RetypeField | SetFieldNullable | ReorderFields;

export interface ChangeSet {
  readonly changes: readonly Change[];
}

// --- helpers -----------------------------------------------------------------------------------

/** Index schemas by stable id; throws on a duplicate id (corrupt catalog — fail LOUD, never silently merge). */
function indexTypes(schemas: ContentTypeSchema[]): Map<string, ContentTypeSchema> {
  const m = new Map<string, ContentTypeSchema>();
  for (const s of schemas) {
    if (s.relations && s.relations.length > 0) throw new SchemaDiffError(`content-type "${s.apiId}": relations in schema files are deferred to a later slice`);
    if (m.has(s.id)) throw new SchemaDiffError(`duplicate content-type id "${s.id}" (ids are the identity and must be unique)`);
    indexFields(s); // validate field-id uniqueness for EVERY schema (added or matched), not just matched ones.
    m.set(s.id, s);
  }
  return m;
}

function indexFields(schema: ContentTypeSchema): Map<string, FieldSchema> {
  const m = new Map<string, FieldSchema>();
  for (const f of schema.fields) {
    if (m.has(f.id)) throw new SchemaDiffError(`content-type "${schema.apiId}" field "${f.name}": duplicate field id "${f.id}"`);
    m.set(f.id, f);
  }
  return m;
}

/** Resolve a field's physical type through the SAME catalog the meta writer uses (scalar or component kind). */
function resolveField(f: FieldSchema): ResolvedType {
  return isComponentFieldKind(f.type) ? resolveComponentField(f.type, f.options) : resolveType(f.type, f.options);
}

const nullableOf = (f: FieldSchema): boolean => f.options?.nullable ?? true;
const hasDefault = (f: FieldSchema): boolean => f.options?.default !== undefined;

/** Canonical JSON (object keys sorted) so a params compare is insensitive to key order. */
function canon(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
      : val,
  );
}

/** Resolved-type equality (the physical column shape) — NULLABILITY is NOT part of it (handled separately). */
function resolvedEqual(a: ResolvedType, b: ResolvedType): boolean {
  return a.cmsType === b.cmsType && a.pgType === b.pgType && a.engineType === b.engineType && canon(a.params) === canon(b.params);
}

const typeOptionRisk = (to: boolean): ChangeRisk => (to ? 'safe' : 'destructive');
const retypeRisk = (c: 'metadata-only' | 'rewrite' | 'forbidden'): ChangeRisk => (c === 'metadata-only' ? 'safe' : c === 'rewrite' ? 'data-dependent' : 'forbidden');

// --- the diff ----------------------------------------------------------------------------------

/**
 * Diff two files-first schema catalogs into an ordered {@link ChangeSet}, matching by stable id. The order
 * is creates → per-type alters (rename type, then field renames, retypes, nullability, adds, reorder, flag
 * toggles-on) → destructive (drop field, flag toggles-off, drop type) — a sensible default; S4 owns the
 * final transactional/topological apply order.
 */
export function diff(prev: ContentTypeSchema[], next: ContentTypeSchema[]): ChangeSet {
  const prevTypes = indexTypes(prev);
  const nextTypes = indexTypes(next);
  const creates: Change[] = [];
  const alters: Change[] = [];
  const drops: Change[] = [];

  // New content-types (id present only in next) — a fresh empty table; its NOT NULL fields are safe.
  for (const [id, n] of nextTypes) {
    if (!prevTypes.has(id)) creates.push({ kind: 'addType', typeId: id, apiId: n.apiId, risk: 'safe', schema: n });
  }
  // Dropped content-types (id present only in prev) — DESTRUCTIVE, emitted last.
  for (const [id, p] of prevTypes) {
    if (!nextTypes.has(id)) drops.push({ kind: 'dropType', typeId: id, apiId: p.apiId, risk: 'destructive' });
  }
  // Matched content-types (same id) — diff their labels, flags, and fields.
  for (const [id, n] of nextTypes) {
    const p = prevTypes.get(id);
    if (!p) continue;
    diffMatchedType(id, p, n, alters, drops);
  }

  return { changes: [...creates, ...alters, ...drops] };
}

function diffMatchedType(typeId: string, p: ContentTypeSchema, n: ContentTypeSchema, alters: Change[], drops: Change[]): void {
  const apiId = n.apiId;
  // apiId rename → table rename (lossless). collectionName/info are presentation-only → no DDL.
  if (p.apiId !== n.apiId) alters.push({ kind: 'renameType', typeId, apiId, risk: 'safe', fromApiId: p.apiId, toApiId: n.apiId });

  // Per-type structural flags. ON = additive (safe); OFF = drop the system column (destructive → drops).
  for (const option of ['draftAndPublish', 'i18n'] as const) {
    const from = p.options?.[option] ?? false;
    const to = n.options?.[option] ?? false;
    if (from !== to) {
      const change: SetTypeOption = { kind: 'setTypeOption', typeId, apiId, risk: typeOptionRisk(to), option, from, to };
      (to ? alters : drops).push(change);
    }
  }

  const pFields = indexFields(p);
  const nFields = indexFields(n);

  // Field RENAMES, RETYPES, NULLABILITY (matched by field id) — a single field may emit several ops.
  for (const [fid, nf] of nFields) {
    const pf = pFields.get(fid);
    if (!pf) continue;
    if (pf.name !== nf.name) alters.push({ kind: 'renameField', typeId, apiId, risk: 'safe', fieldId: fid, from: pf.name, to: nf.name });
    const fromT = resolveField(pf);
    const toT = resolveField(nf);
    if (!resolvedEqual(fromT, toT)) {
      const classification = classifyTypeChange(fromT, toT);
      alters.push({ kind: 'retypeField', typeId, apiId, risk: retypeRisk(classification), fieldId: fid, name: nf.name, from: fromT, to: toT, classification });
    }
    if (nullableOf(pf) !== nullableOf(nf)) {
      const to = nullableOf(nf);
      alters.push({ kind: 'setFieldNullable', typeId, apiId, risk: to ? 'safe' : 'data-dependent', fieldId: fid, name: nf.name, from: nullableOf(pf), to });
    }
  }
  // New fields (id only in next) → ADD COLUMN. NOT NULL with no default is data-dependent on existing rows.
  for (const [fid, nf] of nFields) {
    if (pFields.has(fid)) continue;
    const risk: ChangeRisk = !nullableOf(nf) && !hasDefault(nf) ? 'data-dependent' : 'safe';
    alters.push({ kind: 'addField', typeId, apiId, risk, field: nf, sort: n.fields.findIndex((f) => f.id === fid) });
  }
  // Dropped fields (id only in prev) → DROP COLUMN (DESTRUCTIVE, emitted in the drops phase).
  for (const [fid, pf] of pFields) {
    if (!nFields.has(fid)) drops.push({ kind: 'dropField', typeId, apiId, risk: 'destructive', fieldId: fid, name: pf.name });
  }

  // REORDER (wire-only): the relative order of COMMON fields changed. Pure add/drop does NOT trigger it.
  const commonPrev = p.fields.filter((f) => nFields.has(f.id)).map((f) => f.id);
  const commonNext = n.fields.filter((f) => pFields.has(f.id)).map((f) => f.id);
  if (commonPrev.length === commonNext.length && commonPrev.some((id, i) => id !== commonNext[i])) {
    alters.push({ kind: 'reorderFields', typeId, apiId, risk: 'safe', order: n.fields.map((f) => f.id) });
  }
}

// --- lint seam (consumed by S4) ----------------------------------------------------------------

/** The changes that need an explicit ack before apply (would lose data or might fail on real rows). */
export function riskyChanges(cs: ChangeSet): readonly Change[] {
  return cs.changes.filter((c) => c.risk === 'destructive' || c.risk === 'data-dependent' || c.risk === 'forbidden');
}

/** The changes the catalog refuses outright (no ack can allow them) — a `forbidden` type transition. */
export function forbiddenChanges(cs: ChangeSet): readonly Change[] {
  return cs.changes.filter((c) => c.risk === 'forbidden');
}
