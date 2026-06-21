import type { Sql } from 'postgres';
import type { ChangeBus } from '../store/response.cache.ts';
import type { Principal } from './session.cache.ts';

/**
 * The RBAC REGISTRY — mirrors the content {@link Registry} shape one-for-one: PG is truth, RAM is
 * served, rebuild-on-change via the SAME {@link ChangeBus} seam. Permission rules live in PG
 * (`roles` / `permissions` / `role_permissions` / `user_roles`); at boot (and on any RBAC mutation) a
 * SINGLE join query folds them into a `Map<userId, Set<action>>`. A {@link checkPermission} call is then
 * a pure in-memory `Map.get(userId).has(action)` set test → ZERO Postgres on the hot path (asserted by a
 * query-counter test).
 *
 * Invalidation reuses the content-registry seam: any mutation to an RBAC table publishes
 * `'rbac:invalidate'` on the bus → {@link rebuild} re-reads PG. (Mutation ROUTES are a later slice; the
 * seam exists now so this slice is byte-stable and the future slice flips it on with no shape change.)
 */

const INVALIDATE_TOPIC = 'rbac:invalidate';

interface PermRow {
  user_id: string;
  action: string;
}

export class RbacRegistry {
  /** userId -> the resolved set of permission action strings (e.g. 'content.read'). Frozen on rebuild. */
  private byUser = new Map<string, ReadonlySet<string>>();

  private readonly sql: Sql;

  constructor(sql: Sql, bus: ChangeBus) {
    this.sql = sql;
    // Same invalidation seam as the content registry: a single `rbac:invalidate` topic triggers a full
    // rebuild. Other topics (content-type names, session:evict:*) are ignored. Fire-and-forget like the
    // response-cache subscriber; a rebuild failure is surfaced by the rebuild's own error, not swallowed
    // silently into a corrupt map (the old map stays served until a successful rebuild replaces it).
    bus.subscribe((topic) => {
      if (topic === INVALIDATE_TOPIC) void this.rebuild();
    });
  }

  /**
   * Rebuild the WHOLE registry from PG with ONE join query (`user_roles ⋈ role_permissions ⋈
   * permissions`), folded into a fresh `Map<userId, Set<action>>`. Built into a NEW map and swapped in
   * atomically (never mutated in place) so a concurrent read sees either the old or the new map, never a
   * half-built one — exactly the content Registry's replace-not-patch discipline. Empty tables are valid
   * (an empty map → every check is false).
   */
  async rebuild(): Promise<void> {
    const rows = await this.sql<PermRow[]>`
      SELECT ur.user_id, p.action
      FROM user_roles ur
      JOIN role_permissions rp ON rp.role_id = ur.role_id
      JOIN permissions p ON p.id = rp.permission_id
    `;
    const next = new Map<string, Set<string>>();
    for (const r of rows) {
      let set = next.get(r.user_id);
      if (set === undefined) {
        set = new Set<string>();
        next.set(r.user_id, set);
      }
      set.add(r.action);
    }
    this.byUser = next;
  }

  /**
   * THE HOT PATH — a pure in-memory set test, ZERO Postgres. true iff `principal`'s user holds `perm`.
   * An unknown user or an unknown permission is false (deny by default).
   */
  checkPermission(principal: Principal, perm: string): boolean {
    return this.byUser.get(principal.userId)?.has(perm) ?? false;
  }

  /** Test/diagnostic: the resolved permission set for a user (a copy is unnecessary; it is read-only). */
  permissionsOf(userId: string): ReadonlySet<string> {
    return this.byUser.get(userId) ?? EMPTY;
  }
}

const EMPTY: ReadonlySet<string> = new Set<string>();
