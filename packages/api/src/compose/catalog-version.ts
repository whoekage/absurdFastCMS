import { createHash } from 'node:crypto';
import { loadTypesCacheBusted } from '../db/schema/load.ts';
import type { ContentTypeSchema } from '../db/schema/model.ts';

/**
 * S6 — the Builder catalog VERSION (optimistic-concurrency token). It hashes the catalog ON DISK (the source
 * of truth = the `entities/*` files), NOT the `_schema_applied` snapshot: a snapshot-derived token would not
 * advance when an operator edits a `schema.ts` out-of-band and runs `POST /builder/reload` (reload applies no
 * migrate), letting a stale `PUT` slip the 412. The hash is REORDER-INVARIANT (types sorted by id, each
 * fields/relations array sorted by id, object keys emitted in a fixed order) yet VALUE-SENSITIVE (any real
 * IR change — a field, an attribute, an options key — moves it).
 */

/** A per-process monotonically-changing cache-bust token component (Math.random/Date are fine in runtime code). */
let bustSeq = 0;

/** Recursive stable-key canonical stringify — invariant to object-key order, sensitive to values. */
function canon(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(',')}}`;
}

/** Canonicalize the catalog IR: types by id, fields/relations by id, then stable-key stringify. */
function canonicalIR(schemas: ContentTypeSchema[]): string {
  const byId = <T extends { id: string }>(a: T, b: T): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const sorted = [...schemas].sort(byId).map((s) => ({
    ...s,
    fields: [...s.fields].sort(byId),
    ...(s.relations !== undefined ? { relations: [...s.relations].sort(byId) } : {}),
  }));
  return canon(sorted);
}

/** sha256 of the canonical on-disk catalog IR (cache-busted re-read so an out-of-band edit is reflected). */
export async function computeCatalogVersion(entitiesDir: string): Promise<string> {
  const { schemas } = await loadTypesCacheBusted(entitiesDir, `${process.pid}:${++bustSeq}`);
  return createHash('sha256').update(canonicalIR(schemas)).digest('hex');
}

/** sha256 of an arbitrary value via the SAME canonicalization — the idempotency request_hash basis. */
export function hashRequest(value: unknown): string {
  return createHash('sha256').update(canon(value)).digest('hex');
}
