import type { Hooks, HookContext } from './define.ts';
import { AppError } from '../../errors/app-error.ts';

/**
 * The content-lifecycle hook DISPATCH (pivot phase 4). Hooks are dev-authored, colocated in
 * `schema/<name>.ts` via `defineSchema({ hooks })`, and fire at the content-service seam (`handleWrite`) —
 * per LOGICAL ACTION, not per DB row (the Strapi-v5 lesson: row-level hooks multi-fire on D&P/i18n and lose
 * the semantic event). The two classes split on the COMMIT boundary:
 *
 *   - `before*` — TRANSFORM + VETO. Runs INSIDE the write transaction; returns the (possibly transformed)
 *     data; a throw aborts → rollback → 400. No side-effects (they would be phantom on rollback).
 *   - `after*`  — REACT. Runs AFTER commit + the read-engine rebuild; side-effects only; isolated so a
 *     throw is logged, never fatal (the write is already durable).
 *
 * The cross-ecosystem footgun this avoids by construction: every ORM (TypeORM #2816, Sequelize #8585,
 * Mongoose #8618) fires `after` hooks PRE-commit → side-effects on data that may roll back. Here `after`
 * is strictly post-commit.
 */

/** Throw from a `before*` hook to veto a write with a clean 400 (a generic throw is a 500 / bug). */
export class HookError extends AppError {
  constructor(message: string) {
    super('hook.failed', { detail: message });
  }
}

export type HookOp = 'create' | 'update' | 'delete';
const BEFORE = { create: 'beforeCreate', update: 'beforeUpdate', delete: 'beforeDelete' } as const;
const AFTER = { create: 'afterCreate', update: 'afterUpdate', delete: 'afterDelete' } as const;

/** Resolves a module's hooks by name and runs them with the correct transaction/error semantics. */
export class HookRegistry {
  // NB: a field + assignment, not a constructor parameter-property — the latter is not erasable syntax
  // (it emits runtime code) and Node's type-stripping rejects it.
  private readonly byName: ReadonlyMap<string, Hooks>;
  constructor(byName: ReadonlyMap<string, Hooks> = new Map()) {
    this.byName = byName;
  }

  /** Does this type have any hook for `op`? (lets `handleWrite` skip the dispatch entirely when none). */
  has(name: string, op: HookOp): boolean {
    const h = this.byName.get(name);
    return h !== undefined && (h[BEFORE[op]] !== undefined || h[AFTER[op]] !== undefined);
  }

  /**
   * Run the `before*` hook (TRANSFORM + VETO) INSIDE the caller's write tx. Returns the data to persist —
   * the hook's return value, or the input unchanged when the hook returns nothing / is absent. A throw
   * propagates to abort the transaction.
   */
  async runBefore(name: string, op: HookOp, data: Record<string, unknown>): Promise<Record<string, unknown>> {
    const fn = this.byName.get(name)?.[BEFORE[op]];
    if (fn === undefined) return data;
    const ctx: HookContext = { name, op };
    const result = await fn(data, ctx);
    return (result ?? data) as Record<string, unknown>;
  }

  /**
   * Run the `after*` hook (REACT) AFTER commit + rebuild. ISOLATED: a throw is logged and swallowed — the
   * write is already durable, so an after-hook failure must never unwind it (the TypeORM #2816 lesson).
   */
  async runAfter(name: string, op: HookOp, entry: Record<string, unknown>): Promise<void> {
    const fn = this.byName.get(name)?.[AFTER[op]];
    if (fn === undefined) return;
    const ctx: HookContext = { name, op };
    try {
      await fn(entry, ctx);
    } catch (e) {
      console.error(`conti: ${AFTER[op]} hook for "${name}" failed (post-commit, ignored): ${String(e)}`);
    }
  }
}
