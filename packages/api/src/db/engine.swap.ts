import type { Sql } from 'postgres';
import type { Engine } from '../store/engine.ts';
import type { HookRegistry } from './schema/hooks.ts';
import { Registry } from './registry.ts';
import { buildDetached, loadAllRelations } from './engine.loader.ts';
import type { Schema, ComponentSchema } from './schema/model.ts';
import type { Change } from './schema/diff.ts';

/**
 * THE S4 INCREMENTAL IR-DRIVEN SWAP (docs/research/builder-http-route.md §3.3, s3-s4-impl-plan §S4).
 *
 * After an `applySchemaEdit` migrate COMMITS, the served Engine/Registry must reflect the new shape
 * WITHOUT a restart and WITHOUT re-importing files (the apply path rebuilds from the in-memory `next` IR
 * the migrate already reconciled — zero ESM-module leak, zero re-introspect drift). The rebuild is
 * INCREMENTAL (the maintainer decision): only the types the change-set TOUCHED are rebuilt, reusing the
 * same per-type engine primitives boot uses, so untouched types stay hot.
 *
 * Atomicity model:
 *   - The ONLY genuinely-isolated, throwing/async part — building every new {@link DetachedTable} off to
 *     the side from the COMMITTED DB — runs FIRST. A throw there touches nothing on `live`: last-good keeps
 *     serving (true keep-last-good boundary).
 *   - Then a SYNCHRONOUS burst (no await) drops/registers/replaces the per-type storage and reassigns the
 *     `live` registry + hooks. JS is single-threaded, so a concurrent GET sees the whole old or whole new
 *     slot, never a torn state.
 *   - Then ONE `loadAllRelations` re-derives edges against the now-current Tables. This runs AFTER `live`
 *     is already mutated, so it is NOT keep-last-good: a throw here leaves a DEFINED degraded-but-live state
 *     (per-type storage current, some relation edges possibly stale) — surfaced LOUD by rethrow; the next
 *     clean boot rebuilds relations from the consistent files+snapshot. We do NOT attempt a relation
 *     rollback in v1 (single-instance accepted contract).
 */

/** The mutable cell the HTTP server serves through (see server.ts). The swap reassigns its fields. */
export interface LiveCell {
  engine: Engine;
  registry: Registry | undefined;
  hooks: HookRegistry | undefined;
}

export async function swapFromIR(
  sql: Sql,
  live: LiveCell,
  next: Schema[],
  applied: readonly Change[],
  nextHooks: HookRegistry,
  nextComponents: ComponentSchema[] = [],
): Promise<void> {
  // The new registry, built PURELY from the in-memory IR (no DB, no files). A throw here touches nothing.
  const nextReg = Registry.fromSchemas(next, nextComponents);

  // Partition the touched moduleNames by the kind of engine op each needs. `setTypeOption` is intentionally
  // absent: migrate always throws MigrationUnsupportedError for it, so it can never reach a committed
  // change-set (applySchemaEdit throws before any swap runs).
  const creates = new Set<string>();
  const drops = new Set<string>();
  const changes = new Set<string>();
  for (const c of applied) {
    switch (c.kind) {
      case 'addType': creates.add(c.name); break;
      case 'dropType': drops.add(c.name); break;
      case 'renameType': drops.add(c.fromName); creates.add(c.toName); break; // from !== to → no key clash
      case 'addField': case 'dropField': case 'renameField': case 'retypeField':
      case 'setFieldNullable': case 'reorderFields': case 'addRelation': case 'dropRelation':
        changes.add(c.name); break;
      // setTypeOption: unreachable (see above) — deliberately not handled.
    }
  }
  // A created or dropped type is registered/dropped wholesale, never also "changed".
  for (const id of creates) changes.delete(id);
  for (const id of drops) changes.delete(id);

  // PHASE 1 (isolated, off-side, may throw): build every new/changed type's DetachedTable from the
  // COMMITTED post-migrate DB. Nothing on `live` is touched yet → a throw keeps last-good serving.
  const built = new Map<string, Awaited<ReturnType<typeof buildDetached>>>();
  for (const name of [...creates, ...changes]) {
    built.set(name, await buildDetached(sql, nextReg.get(name)!));
  }

  // PHASE 2 (synchronous burst, NO await): swap per-type storage + the registry/hooks refs atomically.
  for (const name of drops) live.engine.dropType(name);
  for (const name of creates) live.engine.registerDetached(name, built.get(name)!);
  for (const name of changes) live.engine.replaceType(name, built.get(name)!);
  live.registry = nextReg; // `live.engine` is the SAME object (per-type storage swapped) — never reassigned.
  live.hooks = nextHooks;

  // PHASE 3 (await, post-burst, NOT keep-last-good): re-derive ALL relations against the now-current Tables.
  await loadAllRelations(sql, live.engine, nextReg);
}
