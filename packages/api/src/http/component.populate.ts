import type { Sql } from 'postgres';
import type { ComponentDef, ModuleDef, Registry } from '../db/registry.ts';
import type { Engine } from '../store/engine.ts';
import type { FilterNode } from '../store/table.ts';
import { getFilesByIds, type FileAsset } from '../db/file.repository.ts';
import { parsePopulateNames } from './media.populate.ts';
import { config } from '../config.ts';
import { JSON_CT, type CoreResponse } from './read.router.ts';

/**
 * be-05 COMPONENT — the READ-side POPULATE post-step for component / component-repeatable / dynamiczone
 * fields, kept ENTIRELY out of the engine (the same architecture as the be-04 media post-step).
 *
 * WHY a post-step: a component field is a PLAIN json column whose value is an inline component tree. The
 * engine emits that tree VERBATIM (RawJson, zero-copy) un-populated — so the structural content is on the
 * hot path with NO parse/re-serialize. The ONLY thing to "populate" inside a component is its INLINE media
 * refs (a `files.id` / `files.id[]`), which are NOT engine relations, so the engine's relation-populate
 * path can't resolve them. This step runs AFTER the engine produced its response: when the request asked to
 * populate a component field, it parses the envelope, walks every targeted component tree (guided by the
 * registry's {@link ComponentDef} schemas), batch-resolves every inline media id across ALL rows in ONE
 * `getFilesByIds` query, and splices the asset object(s) in place of the bare id(s) — then re-serializes.
 *
 * BYTE-IDENTICAL GUARANTEE: invoked ONLY when (a) the type declares >=1 component field AND (b) the request
 * asked to populate at least one of them. Otherwise the engine's response Buffer is returned UNTOUCHED (the
 * zero-copy read path). When it runs it JSON.parse/serializes the envelope (the opt-in, non-default path) —
 * losing the verbatim-bytes splice for >2^53 json fields is acceptable here, exactly like media populate.
 *
 * SHAPE: the component tree itself is unchanged (instance objects keep their assigned `id`, arrays keep
 * order, a dynamiczone keeps each block's `__component`); only the inline media fields inside it are
 * resolved — a single media ref -> the asset OBJECT (or `null` for a dangling/deleted id), a multiple media
 * ref -> an ARRAY of asset objects (a dangling id is DROPPED). A component field NOT asked-to-populate, or
 * a component carrying no media field, is left as its raw inline tree.
 *
 * be-05b RELATION-INSIDE-COMPONENT — the SAME post-step also resolves inline relation refs (an id / id[]
 * to a TARGET module). UNLIKE media (resolved against the `files` table via SQL, because `files` is
 * NOT an engine type), a relation TARGET *is* an engine type, so it is resolved VIA THE ENGINE (the be-01/
 * be-04 read path) — this reuses the RAM source-of-truth so the nested row materializes BYTE-IDENTICALLY to
 * a top-level GET (RawJson json fields, i64/decimal strings) AND lets target VISIBILITY apply: a nested ref
 * resolves AS IF you did a default `GET /:target/:id` — DRAFT/PUBLISH default published-only, i18n default-
 * locale. A draft/missing-locale/dangling target resolves to `null` (single) or is DROPPED (multiple).
 */

/** The component fields of `def` THIS request asked to populate (`*` -> all). Empty -> caller skips. */
export function componentPopulateTargets(def: ModuleDef, query: string): Map<string, { kind: string; component?: string; components?: readonly string[] }> {
  const out = new Map<string, { kind: string; component?: string; components?: readonly string[] }>();
  if (def.componentFields.size === 0) return out;
  const { names, star } = parsePopulateNames(query);
  if (star) return new Map(def.componentFields);
  for (const name of names) {
    const m = def.componentFields.get(name);
    if (m !== undefined) out.set(name, m);
  }
  return out;
}

/**
 * The collect accumulator: inline media `files.id`s (one global Set, resolved against `files`) PLUS inline
 * relation-ref ids BINNED BY TARGET module name (resolved per-target against the engine).
 */
interface CollectAcc {
  media: Set<number>;
  /** target name -> the set of referenced row ids. */
  relations: Map<string, Set<number>>;
}

/** Recursively collect every inline media id + relation-ref id reachable through a component value. */
function collectTree(
  registry: Registry,
  meta: { kind: string; component?: string; components?: readonly string[] },
  value: unknown,
  into: CollectAcc,
): void {
  if (value === null || value === undefined) return;
  if (meta.kind === 'component') {
    if (meta.component !== undefined) collectInstance(registry, meta.component, value, into);
  } else if (meta.kind === 'component-repeatable') {
    if (Array.isArray(value) && meta.component !== undefined) for (const e of value) collectInstance(registry, meta.component, e, into);
  } else if (meta.kind === 'dynamiczone') {
    if (Array.isArray(value)) {
      for (const block of value) {
        const cmp = blockComponent(block);
        if (cmp !== null) collectInstance(registry, cmp, block, into);
      }
    }
  }
}

/** Collect inline media ids + relation-ref ids from one component instance (recursing nested components). */
function collectInstance(registry: Registry, name: string, obj: unknown, into: CollectAcc): void {
  if (typeof obj !== 'object' || obj === null) return;
  const cdef: ComponentDef | undefined = registry.getComponent(name);
  if (cdef === undefined) return;
  const o = obj as Record<string, unknown>;
  for (const [name, { multiple }] of cdef.mediaFields) {
    const v = o[name];
    if (v === undefined || v === null) continue;
    if (multiple) {
      if (Array.isArray(v)) for (const id of v) if (typeof id === 'number') into.media.add(id);
    } else if (typeof v === 'number') {
      into.media.add(v);
    }
  }
  // be-05b: bin relation-ref ids by their declared target module (resolved per-target via the engine).
  for (const [name, { target, multiple }] of cdef.relationRefFields) {
    const v = o[name];
    if (v === undefined || v === null) continue;
    let bin = into.relations.get(target);
    if (bin === undefined) {
      bin = new Set<number>();
      into.relations.set(target, bin);
    }
    if (multiple) {
      if (Array.isArray(v)) for (const id of v) if (typeof id === 'number') bin.add(id);
    } else if (typeof v === 'number') {
      bin.add(v);
    }
  }
  for (const [name, cmeta] of cdef.componentFields) collectTree(registry, cmeta, o[name], into);
}

/**
 * The resolve accumulator handed to the splice walk: media assets by `files.id` PLUS, per relation TARGET
 * name, the visible resolved rows by id (a missing key/id => dangling/invisible => null/dropped).
 */
interface ResolveAcc {
  media: Map<number, FileAsset>;
  /** target name -> (row id -> the resolved, visibility-filtered row object). */
  relations: Map<string, Map<number, Record<string, unknown>>>;
}

/** Splice resolved asset/relation object(s) into every inline media/relation field of a component value. */
function inlineTree(
  registry: Registry,
  meta: { kind: string; component?: string; components?: readonly string[] },
  value: unknown,
  resolved: ResolveAcc,
): void {
  if (value === null || value === undefined) return;
  if (meta.kind === 'component') {
    if (meta.component !== undefined) inlineInstance(registry, meta.component, value, resolved);
  } else if (meta.kind === 'component-repeatable') {
    if (Array.isArray(value) && meta.component !== undefined) for (const e of value) inlineInstance(registry, meta.component, e, resolved);
  } else if (meta.kind === 'dynamiczone') {
    if (Array.isArray(value)) {
      for (const block of value) {
        const cmp = blockComponent(block);
        if (cmp !== null) inlineInstance(registry, cmp, block, resolved);
      }
    }
  }
}

/** Resolve every inline media + relation field of one component instance (recursing nested components). */
function inlineInstance(registry: Registry, name: string, obj: unknown, resolved: ResolveAcc): void {
  if (typeof obj !== 'object' || obj === null) return;
  const cdef: ComponentDef | undefined = registry.getComponent(name);
  if (cdef === undefined) return;
  const o = obj as Record<string, unknown>;
  const byId = resolved.media;
  for (const [name, { multiple }] of cdef.mediaFields) {
    const v = o[name];
    if (v === undefined) continue;
    if (multiple) {
      if (v === null) o[name] = [];
      else if (Array.isArray(v)) o[name] = v.map((id) => (typeof id === 'number' ? byId.get(id) : undefined)).filter((a): a is FileAsset => a !== undefined);
    } else {
      o[name] = typeof v === 'number' ? (byId.get(v) ?? null) : null;
    }
  }
  // be-05b: splice resolved target rows. single -> the row OBJECT or null (dangling/invisible); multiple ->
  // an ARRAY of rows with dangling/invisible ids DROPPED (the byte-identical shape rule to multiple-media).
  for (const [name, { target, multiple }] of cdef.relationRefFields) {
    const v = o[name];
    if (v === undefined) continue;
    const rows = resolved.relations.get(target);
    if (multiple) {
      if (v === null) o[name] = [];
      else if (Array.isArray(v)) o[name] = v.map((id) => (typeof id === 'number' ? rows?.get(id) : undefined)).filter((r): r is Record<string, unknown> => r !== undefined);
    } else {
      o[name] = typeof v === 'number' ? (rows?.get(v) ?? null) : null;
    }
  }
  for (const [name, cmeta] of cdef.componentFields) inlineTree(registry, cmeta, o[name], resolved);
}

/** A dynamiczone block's component name, or null when the block is malformed. */
function blockComponent(block: unknown): string | null {
  if (typeof block !== 'object' || block === null) return null;
  const cmp = (block as Record<string, unknown>)['__component'];
  return typeof cmp === 'string' ? cmp : null;
}

/**
 * be-05b — resolve ONE relation TARGET's referenced ids into visible row objects via the ENGINE, applying
 * the SAME default visibility a top-level `GET /:target/:id` would: DRAFT/PUBLISH -> published-only
 * (`published_at IS NOT NULL`), i18n -> default-locale (`locale = config.defaultLocale`). A draft / wrong-
 * locale / dangling id simply produces no entry in the returned map (the splice then emits null / drops it).
 * Resolution reuses {@link Engine.respondById} so the nested row materializes BYTE-IDENTICALLY to a real
 * top-level read (RawJson json fields, i64/decimal strings); we parse its `.data` back out for the splice.
 * A target type unknown to the engine (dropped post-definition) yields an empty map (everything -> null).
 */
function resolveTargetRows(engine: Engine, target: string, ids: number[]): Map<number, Record<string, unknown>> {
  const out = new Map<number, Record<string, unknown>>();
  if (!engine.has(target)) return out;
  // Build the default visibility predicate (AND of published-only + default-locale, each only when opted-in).
  const leaves: FilterNode[] = [];
  if (engine.isDraftPublish(target)) leaves.push({ leaf: { field: 'published_at', op: 'notNull', value: true } });
  if (engine.isI18n(target)) leaves.push({ leaf: { field: 'locale', op: 'eq', value: config.defaultLocale } });
  const where: FilterNode | undefined = leaves.length === 0 ? undefined : leaves.length === 1 ? leaves[0] : { op: 'and', children: leaves };
  for (const id of ids) {
    const buf = engine.respondById(target, id, [], where);
    if (buf === null) continue; // no such id, or invisible at default status/locale -> dangling (null/drop).
    const data = (JSON.parse(buf.toString('utf8')) as { data: Record<string, unknown> }).data;
    out.set(id, data);
  }
  return out;
}

/**
 * Apply component populate to an engine LIST/SINGLE response Buffer. Parses the `{data,meta}` envelope,
 * batch-resolves every inline media id (ONE `getFilesByIds` query) + every inline relation-ref id (per
 * target module, via the engine with default visibility) across all rows + targeted component fields,
 * splices the resolved object(s) into each component tree, and re-serializes. The caller guarantees
 * `targets` is non-empty (otherwise the engine Buffer is returned untouched).
 */
export async function applyComponentPopulate(
  sql: Sql,
  engine: Engine,
  registry: Registry,
  body: Buffer,
  targets: Map<string, { kind: string; component?: string; components?: readonly string[] }>,
): Promise<CoreResponse> {
  const envelope = JSON.parse(body.toString('utf8')) as { data: unknown; meta: unknown };
  const rows: Record<string, unknown>[] = Array.isArray(envelope.data)
    ? (envelope.data as Record<string, unknown>[])
    : envelope.data !== null && typeof envelope.data === 'object'
      ? [envelope.data as Record<string, unknown>]
      : [];

  const acc: CollectAcc = { media: new Set<number>(), relations: new Map<string, Set<number>>() };
  for (const row of rows) for (const [name, meta] of targets) collectTree(registry, meta, row[name], acc);

  const resolved: ResolveAcc = {
    media: await getFilesByIds(sql, [...acc.media]),
    relations: new Map<string, Map<number, Record<string, unknown>>>(),
  };
  for (const [target, idSet] of acc.relations) resolved.relations.set(target, resolveTargetRows(engine, target, [...idSet]));

  for (const row of rows) for (const [name, meta] of targets) inlineTree(registry, meta, row[name], resolved);

  return { status: 200, contentType: JSON_CT, body: Buffer.from(JSON.stringify(envelope), 'utf8') };
}
