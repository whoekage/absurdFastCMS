import {
  resolveType,
  resolveComponentField,
  isComponentFieldKind,
  classifyTypeChange,
  type ResolvedType,
} from '../type.catalog.ts';
import { deriveLinkTableName, type RelationKind } from '../ddl.ts';
import type { Schema, FieldSchema, RelationSchema } from './model.ts';

/**
 * THE PURE DIFF ENGINE (§S3) — `diff(prev, next)` over two sets of files-first schemas, matching
 * modules AND fields by their STABLE `id`, never by name. This is the design that removes the
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
  /** The module's STABLE id (identity across renames). */
  readonly typeId: string;
  /** The module's CURRENT (next) apiId — the table is `ct_<apiId>` (post-rename for a renamed type). */
  readonly apiId: string;
  readonly risk: ChangeRisk;
}

/** A whole new module (a fresh empty `ct_` table — its NOT NULL fields are safe: no rows yet). */
export interface AddType extends BaseChange { readonly kind: 'addType'; readonly schema: Schema; }
/** Drop a module entirely (DESTRUCTIVE). */
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
/** A new owner relation → CREATE its link table (after BOTH endpoint tables exist). Additive ⇒ safe. */
export interface AddRelation extends BaseChange { readonly kind: 'addRelation'; readonly relationId: string; readonly field: string; readonly relKind: RelationKind; readonly target: string; readonly inverseField?: string; readonly linkTable: string; }
/** Drop an owner relation → DROP its link table (DESTRUCTIVE: the edges are lost). */
export interface DropRelation extends BaseChange { readonly kind: 'dropRelation'; readonly relationId: string; readonly field: string; readonly linkTable: string; }

export type Change =
  | AddType | DropType | RenameType | SetTypeOption
  | AddField | DropField | RenameField | RetypeField | SetFieldNullable | ReorderFields
  | AddRelation | DropRelation;

export interface ChangeSet {
  readonly changes: readonly Change[];
}

// --- helpers -----------------------------------------------------------------------------------

/** Index schemas by stable id; throws on a duplicate id (corrupt catalog — fail LOUD, never silently merge). */
function indexTypes(schemas: Schema[]): Map<string, Schema> {
  const m = new Map<string, Schema>();
  for (const s of schemas) {
    if (m.has(s.id)) throw new SchemaDiffError(`duplicate module id "${s.id}" (ids are the identity and must be unique)`);
    indexFields(s); // validate field-id uniqueness for EVERY schema (added or matched), not just matched ones.
    indexRelations(s); // and relation-id uniqueness.
    m.set(s.id, s);
  }
  return m;
}

function indexFields(schema: Schema): Map<string, FieldSchema> {
  const m = new Map<string, FieldSchema>();
  for (const f of schema.fields) {
    if (m.has(f.id)) throw new SchemaDiffError(`module "${schema.apiId}" field "${f.name}": duplicate field id "${f.id}"`);
    m.set(f.id, f);
  }
  return m;
}

function indexRelations(schema: Schema): Map<string, RelationSchema> {
  const m = new Map<string, RelationSchema>();
  for (const r of schema.relations ?? []) {
    if (m.has(r.id)) throw new SchemaDiffError(`module "${schema.apiId}" relation "${r.field}": duplicate relation id "${r.id}"`);
    m.set(r.id, r);
  }
  return m;
}

function addRelationChange(owner: Schema, rel: RelationSchema): AddRelation {
  const base: AddRelation = {
    kind: 'addRelation', typeId: owner.id, apiId: owner.apiId, risk: 'safe',
    relationId: rel.id, field: rel.field, relKind: rel.kind, target: rel.target, linkTable: deriveLinkTableName(owner.apiId, rel.field),
  };
  return rel.inverseField !== undefined ? { ...base, inverseField: rel.inverseField } : base;
}

function dropRelationChange(owner: Schema, rel: RelationSchema): DropRelation {
  return { kind: 'dropRelation', typeId: owner.id, apiId: owner.apiId, risk: 'destructive', relationId: rel.id, field: rel.field, linkTable: deriveLinkTableName(owner.apiId, rel.field) };
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
export function diff(prev: Schema[], next: Schema[]): ChangeSet {
  const prevTypes = indexTypes(prev);
  const nextTypes = indexTypes(next);
  const creates: Change[] = []; // CREATE TABLE (all tables first)
  const relAdds: Change[] = []; // CREATE link table (after every endpoint table exists)
  const alters: Change[] = []; // column add/rename/retype/nullable/reorder + type rename
  const relDrops: Change[] = []; // DROP link table (before any endpoint table is dropped)
  const drops: Change[] = []; // DROP column / DROP TABLE (last)

  // New modules (id only in next) — a fresh empty table; its relations become link tables in relAdds.
  for (const [id, n] of nextTypes) {
    if (prevTypes.has(id)) continue;
    creates.push({ kind: 'addType', typeId: id, apiId: n.apiId, risk: 'safe', schema: n });
    for (const rel of n.relations ?? []) relAdds.push(addRelationChange(n, rel));
  }
  // Dropped modules (id only in prev) — DROP its link tables first, then the table.
  for (const [id, p] of prevTypes) {
    if (nextTypes.has(id)) continue;
    for (const rel of p.relations ?? []) relDrops.push(dropRelationChange(p, rel));
    drops.push({ kind: 'dropType', typeId: id, apiId: p.apiId, risk: 'destructive' });
  }
  // Matched modules (same id) — diff labels, flags, fields, and relations.
  for (const [id, n] of nextTypes) {
    const p = prevTypes.get(id);
    if (!p) continue;
    diffMatchedType(id, p, n, alters, drops, relAdds, relDrops);
  }

  // Topological order: tables → link tables → column alters → drop link tables → drop columns/tables.
  return { changes: [...creates, ...relAdds, ...alters, ...relDrops, ...drops] };
}

function diffMatchedType(typeId: string, p: Schema, n: Schema, alters: Change[], drops: Change[], relAdds: Change[], relDrops: Change[]): void {
  const apiId = n.apiId;
  // apiId rename → table rename (lossless). collectionName/info are presentation-only → no DDL.
  if (p.apiId !== n.apiId) {
    // Link-table names derive from the owner apiId, so renaming a type that owns relations would orphan
    // them. Deferred (loud) until link tables carry a stable name independent of the apiId.
    if ((p.relations?.length ?? 0) > 0 || (n.relations?.length ?? 0) > 0) {
      throw new SchemaDiffError(`renaming a module that owns relations ("${p.apiId}" -> "${n.apiId}") is deferred — link-table names derive from the apiId`);
    }
    alters.push({ kind: 'renameType', typeId, apiId, risk: 'safe', fromApiId: p.apiId, toApiId: n.apiId });
  }

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

  // Dropped fields (id only in prev) → DROP COLUMN (DESTRUCTIVE). Emitted FIRST among the field ops (still
  // inside `alters`, after renameType) so a rename/add that REUSES a name this drop frees has it available —
  // e.g. drop `legacy` + rename `current`→`legacy`, or drop `headline` + add a new field named `headline`,
  // in ONE migrate. (A pure name SWAP of two surviving fields still needs intermediate staging; deferred.)
  for (const [fid, pf] of pFields) {
    if (!nFields.has(fid)) alters.push({ kind: 'dropField', typeId, apiId, risk: 'destructive', fieldId: fid, name: pf.name });
  }
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

  // REORDER (wire-only): the relative order of COMMON fields changed. Pure add/drop does NOT trigger it.
  const commonPrev = p.fields.filter((f) => nFields.has(f.id)).map((f) => f.id);
  const commonNext = n.fields.filter((f) => pFields.has(f.id)).map((f) => f.id);
  if (commonPrev.length === commonNext.length && commonPrev.some((id, i) => id !== commonNext[i])) {
    alters.push({ kind: 'reorderFields', typeId, apiId, risk: 'safe', order: n.fields.map((f) => f.id) });
  }

  // Relations matched by stable id: add (id only in next) / drop (id only in prev). A relation that
  // CHANGES (field rename / kind / target / inverse-flip) is deferred — drop and re-add it instead.
  const prevRels = indexRelations(p);
  const nextRels = indexRelations(n);
  for (const [rid, nr] of nextRels) {
    const pr = prevRels.get(rid);
    if (!pr) {
      relAdds.push(addRelationChange(n, nr));
      continue;
    }
    if (pr.field !== nr.field || pr.kind !== nr.kind || pr.target.toLowerCase() !== nr.target.toLowerCase() || (pr.inverseField ?? null) !== (nr.inverseField ?? null)) {
      throw new SchemaDiffError(`module "${n.apiId}" relation "${nr.field}": changing a relation (rename / kind / target / inverse) is deferred — drop and re-add it`);
    }
  }
  for (const [rid, pr] of prevRels) {
    if (!nextRels.has(rid)) relDrops.push(dropRelationChange(p, pr));
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
