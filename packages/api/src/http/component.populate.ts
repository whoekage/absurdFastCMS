import type { Sql } from 'postgres';
import type { ComponentDef, ContentTypeDef, Registry } from '../store/registry.ts';
import { getFilesByIds, type FileAsset } from '../db/file.repository.ts';
import { parsePopulateNames } from './media.populate.ts';
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
 */

/** The component fields of `def` THIS request asked to populate (`*` -> all). Empty -> caller skips. */
export function componentPopulateTargets(def: ContentTypeDef, query: string): Map<string, { kind: string; component?: string; components?: readonly string[] }> {
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

/** Recursively collect every inline media id reachable through a component value (for the batch lookup). */
function collectTree(
  registry: Registry,
  meta: { kind: string; component?: string; components?: readonly string[] },
  value: unknown,
  into: Set<number>,
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

/** Collect inline media ids from one component instance (recursing nested component fields). */
function collectInstance(registry: Registry, apiId: string, obj: unknown, into: Set<number>): void {
  if (typeof obj !== 'object' || obj === null) return;
  const cdef: ComponentDef | undefined = registry.getComponent(apiId);
  if (cdef === undefined) return;
  const o = obj as Record<string, unknown>;
  for (const [name, { multiple }] of cdef.mediaFields) {
    const v = o[name];
    if (v === undefined || v === null) continue;
    if (multiple) {
      if (Array.isArray(v)) for (const id of v) if (typeof id === 'number') into.add(id);
    } else if (typeof v === 'number') {
      into.add(v);
    }
  }
  for (const [name, cmeta] of cdef.componentFields) collectTree(registry, cmeta, o[name], into);
}

/** Splice resolved asset object(s) into every inline media field of a component value (in place). */
function inlineTree(
  registry: Registry,
  meta: { kind: string; component?: string; components?: readonly string[] },
  value: unknown,
  byId: Map<number, FileAsset>,
): void {
  if (value === null || value === undefined) return;
  if (meta.kind === 'component') {
    if (meta.component !== undefined) inlineInstance(registry, meta.component, value, byId);
  } else if (meta.kind === 'component-repeatable') {
    if (Array.isArray(value) && meta.component !== undefined) for (const e of value) inlineInstance(registry, meta.component, e, byId);
  } else if (meta.kind === 'dynamiczone') {
    if (Array.isArray(value)) {
      for (const block of value) {
        const cmp = blockComponent(block);
        if (cmp !== null) inlineInstance(registry, cmp, block, byId);
      }
    }
  }
}

/** Resolve every inline media field of one component instance (recursing nested component fields). */
function inlineInstance(registry: Registry, apiId: string, obj: unknown, byId: Map<number, FileAsset>): void {
  if (typeof obj !== 'object' || obj === null) return;
  const cdef: ComponentDef | undefined = registry.getComponent(apiId);
  if (cdef === undefined) return;
  const o = obj as Record<string, unknown>;
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
  for (const [name, cmeta] of cdef.componentFields) inlineTree(registry, cmeta, o[name], byId);
}

/** A dynamiczone block's component api_id, or null when the block is malformed. */
function blockComponent(block: unknown): string | null {
  if (typeof block !== 'object' || block === null) return null;
  const cmp = (block as Record<string, unknown>)['__component'];
  return typeof cmp === 'string' ? cmp : null;
}

/**
 * Apply component populate to an engine LIST/SINGLE response Buffer. Parses the `{data,meta}` envelope,
 * batch-resolves every inline media id across all rows + all targeted component fields in ONE
 * `getFilesByIds` query, splices the asset object(s) into each component tree, and re-serializes. The
 * caller guarantees `targets` is non-empty (otherwise the engine Buffer is returned untouched).
 */
export async function applyComponentPopulate(
  sql: Sql,
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

  const ids = new Set<number>();
  for (const row of rows) for (const [name, meta] of targets) collectTree(registry, meta, row[name], ids);
  const byId = await getFilesByIds(sql, [...ids]);
  for (const row of rows) for (const [name, meta] of targets) inlineTree(registry, meta, row[name], byId);

  return { status: 200, contentType: JSON_CT, body: Buffer.from(JSON.stringify(envelope), 'utf8') };
}
