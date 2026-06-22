import type { Sql } from 'postgres';

/**
 * be-09f — the TEAM VIEW: an admin-internal, off-heap-discipline read projection. PG is truth, RAM is
 * served (mirrors {@link RbacRegistry}). At boot + on EVERY invalidation it FULL-RELOADs a JOIN(team ⋈
 * user ⋈ resolved super-most role) into a fresh Map<userId,row>, swapped in atomically (replace-not-patch)
 * so a concurrent read sees the old OR the new map, never a half-built one. A {@link get} is the O(1)
 * created-by lookup (the EqIndex-equivalent) — ZERO Postgres on the lookup. NEVER wired into the public
 * content read router — only the gated `/_team` routes + created-by rendering consume it.
 *
 * Why a dedicated Map and not the columnar engine: the team is small (hundreds/thousands), and the
 * RbacRegistry is the proven local pattern. Reusing Engine.define + createEqIndex would drag the columnar
 * write machinery + engine-registry coupling into an admin-internal projection for zero benefit at this
 * cardinality. The Map IS the EqIndex-equivalent.
 *
 * avatar = user.image (a URL/ref STRING, NOT bytes); a no-avatar row carries avatar:null and the admin
 * renders initials.
 */
export interface TeamRow {
  userId: string;
  name: string;
  avatar: string | null; // user.image
  role: string | null; // resolved RBAC role name (highest-privilege), null if none granted yet
  status: string; // 'active' | 'suspended'
}

interface TeamViewRow {
  user_id: string;
  name: string;
  avatar: string | null;
  role: string | null;
  status: string;
}

export class TeamView {
  /** userId -> the projected team row. Swapped atomically on rebuild (never mutated in place). */
  private byUser = new Map<string, TeamRow>();
  private readonly sql: Sql;

  constructor(sql: Sql) {
    this.sql = sql;
  }

  /**
   * FULL-RELOAD from PG with ONE query: team ⋈ user, with a correlated sub-select picking the resolved
   * role (super-admin ranked first, else alphabetical). Built into a NEW map and swapped in atomically.
   * Empty team is valid (empty map). A team row whose user was hard-deleted simply does not appear (the
   * INNER JOIN to "user" drops it) — no dangling render.
   */
  async rebuild(): Promise<void> {
    const rows = await this.sql<TeamViewRow[]>`
      SELECT t.user_id,
             u.name,
             u.image AS avatar,
             t.status,
             (
               SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id
               WHERE ur.user_id = t.user_id
               ORDER BY (r.name = 'super-admin') DESC, r.name ASC
               LIMIT 1
             ) AS role
      FROM team t
      JOIN "user" u ON u.id = t.user_id
    `;
    const next = new Map<string, TeamRow>();
    for (const r of rows) {
      next.set(r.user_id, {
        userId: r.user_id,
        name: r.name,
        avatar: r.avatar,
        role: r.role,
        status: r.status,
      });
    }
    this.byUser = next;
  }

  /** O(1) created-by lookup. A MISS (former member / non-team consumer) returns null → "former member" fallback. */
  get(userId: string): TeamRow | null {
    return this.byUser.get(userId) ?? null;
  }

  /** The member directory (RAM, ZERO-PG) for GET /_team. */
  list(): TeamRow[] {
    return [...this.byUser.values()];
  }

  /** Active super-admin count — the last-admin guard's primitive (status='active' AND role='super-admin'). */
  activeSuperAdminCount(): number {
    let n = 0;
    for (const r of this.byUser.values()) if (r.status === 'active' && r.role === 'super-admin') n++;
    return n;
  }

  size(): number {
    return this.byUser.size;
  }
}
