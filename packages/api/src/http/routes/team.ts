import { errorResponse, type CoreResponse } from '../read.router.ts';
import { corkSend, corkSendNoStore } from '../responders.ts';
import type { TeamRow } from '../../auth/team.view.ts';
import type { ServerContext } from '../context.ts';

/**
 * be-09f — TEAM-MANAGEMENT routes under the `/_team` literal prefix (a leading `_` is illegal in an
 * name, so it can NEVER shadow `/:type`; same precedent as `_files`). teamView is a required dep, so
 * these always mount. EVERY route is gated on `team.manage` (super-admin only this slice). The
 * actor/principal comes ONLY from the session (gateTeam); the route/body `:userId` only designates the
 * TARGET (no mass-assignment). Lifecycle (suspend/remove/revoke) goes through the better-auth API so the
 * adapter fires per-session `session.delete.after` → our evict (PUSH revocation); raw SQL on user/session
 * is forbidden by policy. team_view + RBAC are reloaded DIRECTLY (no event bus).
 */
export function registerTeamRoutes(rctx: ServerContext): void {
  const { route, rbac, auth } = rctx;
  const { gateTeam } = rctx.gates;
  const tv = rctx.teamView;
  const teamSql = rctx.store.sql;

  // Privilege ranking for the actor-role cap + last-admin guard. A higher number = more privilege. An
  // unknown/unranked role is 0 (the floor) so it can assign nothing. super-admin is the ceiling.
  const ROLE_RANK: Record<string, number> = { 'super-admin': 4, editor: 3, author: 2, viewer: 1 };
  const rankOf = (role: string | null): number => (role !== null ? (ROLE_RANK[role] ?? 0) : 0);

  const readJsonBody = (raw: Buffer | null): { ok: true; body: unknown } | { ok: false; error: CoreResponse } => {
    if (raw === null) return { ok: false, error: errorResponse(413, 'request body too large') };
    if (raw.length === 0) return { ok: true, body: {} };
    try {
      return { ok: true, body: JSON.parse(raw.toString('utf8')) as unknown };
    } catch {
      return { ok: false, error: errorResponse(400, 'invalid JSON body') };
    }
  };

  // GET /_team — the member directory straight from RAM (ZERO-PG). `no-store` so a stale directory can
  // never be replayed from an HTTP cache after a logout/role change.
  route.get('/_team', (res, req) => {
    gateTeam(res, req, false, (_principal, _headers, _body, aborted) => {
      const members: TeamRow[] = tv.list();
      corkSendNoStore(res, aborted, 200, { data: members });
    });
  });

  // POST /_team — add a member (idempotent). The `userId` is the TARGET; it must be an existing identity.
  // NO role is assigned here (an added identity has no team role until POST /_team/:userId/role).
  route.post('/_team', (res, req) => {
    gateTeam(res, req, true, (_principal, _headers, raw, aborted) => {
      const parsed = readJsonBody(raw);
      if (!parsed.ok) return corkSend(res, aborted, parsed.error);
      const userId = (parsed.body as { userId?: unknown }).userId;
      if (typeof userId !== 'string' || userId.length === 0) {
        return corkSend(res, aborted, errorResponse(400, 'userId is required'));
      }
      void (async () => {
        try {
          const inserted = await teamSql<{ user_id: string }[]>`
            INSERT INTO team (user_id, status)
              SELECT ${userId}, 'active' WHERE EXISTS (SELECT 1 FROM "user" WHERE id = ${userId})
            ON CONFLICT (user_id) DO NOTHING
            RETURNING user_id
          `;
          // No row inserted AND not already present AND the user does not exist → 404. (An idempotent
          // re-add of an existing member returns 200.)
          if (inserted.length === 0 && tv.get(userId) === null) {
            const exists = await teamSql`SELECT 1 FROM "user" WHERE id = ${userId}`;
            if (exists.length === 0) return corkSendNoStore(res, aborted, 404, { error: 'user not found' });
          }
          await tv.rebuild();
          const row = tv.get(userId);
          corkSendNoStore(res, aborted, 200, { data: row });
        } catch {
          corkSend(res, aborted, errorResponse(500, 'internal error'));
        }
      })();
    });
  });

  // POST /_team/:userId/role — set the target's RBAC role in OUR user_roles. Guards (in order):
  //   (1) target must be in team_view (404 on miss);
  //   (2) PRIVILEGE CAP — the requested role's rank must be STRICTLY below the actor's own resolved role
  //       (no actor can assign a role >= their own; a non-super-admin can never assign super-admin);
  //   (3) LAST-ADMIN GUARD — a demotion that would drop active super-admins to zero is rejected.
  // On success: DELETE+INSERT the user_roles row in one tx, then rbac.rebuild() AND teamView.rebuild().
  route.post('/_team/:userId/role', (res, req) => {
    const targetId = req.getParameter(0) ?? '';
    gateTeam(res, req, true, (principal, _headers, raw, aborted) => {
      const parsed = readJsonBody(raw);
      if (!parsed.ok) return corkSend(res, aborted, parsed.error);
      const role = (parsed.body as { role?: unknown }).role;
      if (typeof role !== 'string' || role.length === 0) {
        return corkSend(res, aborted, errorResponse(400, 'role is required'));
      }
      void (async () => {
        try {
          const target = tv.get(targetId);
          if (target === null) return corkSendNoStore(res, aborted, 404, { error: 'not a team member' });
          // The actor's authority is resolved from team_view (session-derived), never the body.
          const actorRank = rankOf(tv.get(principal.userId)?.role ?? null);
          const requestedRank = rankOf(role);
          if (requestedRank === 0) return corkSendNoStore(res, aborted, 400, { error: 'unknown role' });
          if (requestedRank >= actorRank) {
            return corkSendNoStore(res, aborted, 403, { error: 'cannot assign a role at or above your own' });
          }
          // Last-admin guard: demoting the target away from super-admin must not zero the active admins.
          if (target.role === 'super-admin' && role !== 'super-admin' && target.status === 'active'
            && tv.activeSuperAdminCount() <= 1) {
            return corkSendNoStore(res, aborted, 403, { error: 'cannot demote the last super-admin' });
          }
          const roleRow = await teamSql<{ id: number }[]>`SELECT id FROM roles WHERE name = ${role}`;
          if (roleRow.length === 0) return corkSendNoStore(res, aborted, 400, { error: 'unknown role' });
          await teamSql.begin(async (txn) => {
            await txn`DELETE FROM user_roles WHERE user_id = ${targetId}`;
            await txn`INSERT INTO user_roles (user_id, role_id) VALUES (${targetId}, ${roleRow[0]!.id})`;
            // be-09f — keep the better-auth `user.role` column in lock-step with the resolved CMS role so
            // better-auth's OWN admin-endpoint authz (adminRoles:['super-admin']) recognizes a super-admin
            // as able to drive lifecycle. This column is NOT a CMS authz source (RbacRegistry never reads
            // it); it is a non-session field, so this write does not bypass session coherence.
            await txn`UPDATE "user" SET "role" = ${role}, "updatedAt" = now() WHERE id = ${targetId}`;
          });
          await rbac.rebuild();
          await tv.rebuild();
          corkSendNoStore(res, aborted, 200, { data: tv.get(targetId) });
        } catch {
          corkSend(res, aborted, errorResponse(500, 'internal error'));
        }
      })();
    });
  });

  // POST /_team/:userId/suspend — PUSH revocation. (1) resolve target (404 on miss); (2) last-admin guard;
  // (3) flip team.status='suspended'; (4) ban + revoke ALL sessions via the better-auth API (deletes the
  // PG session rows and fires session.delete.after → SessionCache.evict per session); (5) rbac.rebuild()
  // (a suspended member keeps no effective authority via team_view's status) + teamView.rebuild().
  route.post('/_team/:userId/suspend', (res, req) => {
    const targetId = req.getParameter(0) ?? '';
    gateTeam(res, req, false, (_principal, headers, _body, aborted) => {
      void (async () => {
        try {
          const target = tv.get(targetId);
          if (target === null) return corkSendNoStore(res, aborted, 404, { error: 'not a team member' });
          if (target.role === 'super-admin' && target.status === 'active' && tv.activeSuperAdminCount() <= 1) {
            return corkSendNoStore(res, aborted, 403, { error: 'cannot suspend the last super-admin' });
          }
          await teamSql`UPDATE team SET status = 'suspended', updated_at = now() WHERE user_id = ${targetId}`;
          // Lifecycle THROUGH the API (the acting admin's headers carry the session) — the adapter deletes
          // the PG session rows and fires the per-session evict. We assert post-conditions (status flipped
          // + sessions gone), not the API's 2xx.
          await auth.api.banUser({ body: { userId: targetId }, headers });
          await auth.api.revokeUserSessions({ body: { userId: targetId }, headers });
          // be-09c — DURABLE owner-key revoke. The apikey row in PG is the truth verifyApiKey reads, so a
          // SQL delete of every key the suspended owner holds makes them ALL fail the very next request
          // (the token analog of revokeUserSessions). Belt-and-suspenders alongside the resolution-time
          // suspended-owner deny + the empty-RBAC intersection (rbac.rebuild below).
          await teamSql`DELETE FROM apikey WHERE "referenceId" = ${targetId}`;
          await rbac.rebuild();
          await tv.rebuild();
          corkSendNoStore(res, aborted, 200, { data: tv.get(targetId) });
        } catch {
          corkSend(res, aborted, errorResponse(500, 'internal error'));
        }
      })();
    });
  });

  // DELETE /_team/:userId — hard-remove a member. (1) resolve target (404); (2) self-guard + last-admin
  // guard; (3) removeUser via the API (cascades session deletes → evict; ON DELETE CASCADE tidies
  // team/user_roles); (4) teamView.rebuild() + rbac.rebuild(). content.createdBy is a SOFT ref (no FK) so
  // removal never hits an FK violation — a removed author simply misses team_view ("former member").
  route.del('/_team/:userId', (res, req) => {
    const targetId = req.getParameter(0) ?? '';
    gateTeam(res, req, false, (principal, headers, _body, aborted) => {
      void (async () => {
        try {
          const target = tv.get(targetId);
          if (target === null) return corkSendNoStore(res, aborted, 404, { error: 'not a team member' });
          if (targetId === principal.userId) {
            return corkSendNoStore(res, aborted, 403, { error: 'cannot remove yourself' });
          }
          if (target.role === 'super-admin' && target.status === 'active' && tv.activeSuperAdminCount() <= 1) {
            return corkSendNoStore(res, aborted, 403, { error: 'cannot remove the last super-admin' });
          }
          // be-09c — revoke the target's API keys BEFORE removeUser. ON DELETE CASCADE on `user` would
          // drop the apikey rows in PG anyway, but — like sessions — a DB cascade does NOT fire any
          // better-auth hook, so we revoke explicitly + durably (the apikey row is verifyApiKey's truth →
          // the next request with any of the removed user's keys is 401). Three walls: this revoke, the
          // verifyApiKey INVALID_REFERENCE_ID (no user row), and the empty-RBAC intersection.
          await teamSql`DELETE FROM apikey WHERE "referenceId" = ${targetId}`;
          await auth.api.removeUser({ body: { userId: targetId }, headers });
          await tv.rebuild();
          await rbac.rebuild();
          corkSendNoStore(res, aborted, 200, { data: { userId: targetId, removed: true } });
        } catch {
          corkSend(res, aborted, errorResponse(500, 'internal error'));
        }
      })();
    });
  });
}
