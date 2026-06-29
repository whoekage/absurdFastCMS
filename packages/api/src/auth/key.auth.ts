import type { Auth } from './auth.ts';
import type { Principal } from './session.cache.ts';
import type { TeamView } from './team.view.ts';

/**
 * be-09c — API-KEY request authentication. The session path stays the high-RPS interactive surface (cookie
 * → {@link SessionCache.validate}, zero-PG warm). THIS is the orthogonal server-to-server surface: a raw
 * key presented in the `x-api-key` header resolves to a {@link Principal} whose `userId` is the KEY OWNER
 * (`apikey.referenceId`) plus the key's SCOPE (a `ReadonlySet<string>` of CMS perm actions).
 *
 * PERFORMANCE DECISION — verify-per-request, NO RAM cache of verified keys (this slice). A
 * `verifyApiKey` is ONE indexed lookup on the SHA-256 digest (unique index `apikey_key_idx`), and the
 * authz that follows is pure-RAM ({@link RbacRegistry.checkPermission}) + off-heap ({@link TeamView.get}).
 * The single PG touch on the key path is that one digest probe; everything authz stays zero-PG. We do NOT
 * cache verified keys because a cache reintroduces exactly the revocation-lag CVE class (Directus
 * GHSA-g65h-35f3-x2w3): with no cache, a `deleteApiKey`/SQL-revoke is durable in PG and the very NEXT
 * `verifyApiKey` misses → 401, with a ZERO TTL window. Keys are a low-RPS surface where correctness
 * (instant revoke) dominates; the cache seam is documented for a future high-RPS workload, not built here.
 *
 * A session and a key are NEVER confusable: the session path reads ONLY the cookie; the key path reads ONLY
 * the `x-api-key` header. We use `verifyApiKey` EXPLICITLY (not `getSession`-with-key, whose before-hook
 * sets `session.token = <RAW key>` and would cache the raw secret as a session key). The synthetic
 * `sessionToken` we attach is a constant sentinel — never a real session token — so a key can never be
 * evicted by a session-delete hook and vice-versa.
 */

/**
 * A SENTINEL `sessionToken` for a key-resolved {@link Principal}. It is NOT a real session token (it never
 * keys the SessionCache and is never written to PG) — it only satisfies the Principal shape so the same
 * `RbacRegistry.checkPermission(principal, perm)` (which reads ONLY `principal.userId`) authorizes a key
 * request. The '!' chars are illegal in a base64url session token, so it can never collide with one.
 */
const SYNTHETIC_KEY_TOKEN = '!api-key!';

/** The result of a successful key resolution: the owner Principal + the key's effective scope set. */
export interface KeyResolution {
  principal: Principal;
  /** The CMS perm actions the key was minted with. Empty set = the key narrows to nothing. */
  scope: ReadonlySet<string>;
}

/**
 * The single resource bucket under which we store ALL flat CMS perm actions inside better-auth's
 * `Record<resource, action[]>` permissions shape. A scope `{ cms: ['content.read'] }` flattens to
 * `Set{'content.read'}`. We also tolerate actions stored under ANY resource key (flatten every bucket), so
 * a hand-written scope is never silently dropped.
 */
const KEY_SCOPE_RESOURCE = 'cms';

/**
 * Flatten better-auth's parsed permissions object (`Record<resource, action[]>`, or null/undefined) into a
 * flat `Set<string>` of CMS perm actions. Absent/empty → an EMPTY set (grants nothing — NEVER a silent
 * `*`). Non-string entries are ignored defensively. The set is the token's SCOPE: the runtime rule
 * (effective = owner RBAC ∩ scope) can only NARROW the owner's authority.
 */
function parseScope(permissions: unknown): ReadonlySet<string> {
  const out = new Set<string>();
  if (permissions === null || typeof permissions !== 'object') return out;
  for (const value of Object.values(permissions as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    for (const action of value) if (typeof action === 'string' && action.length > 0) out.add(action);
  }
  return out;
}

/** Build the `permissions` object better-auth persists for a given flat set of CMS perm actions. */
export function buildScopePermissions(actions: readonly string[]): Record<string, string[]> {
  return { [KEY_SCOPE_RESOURCE]: [...actions] };
}

/**
 * be-09c — resolve a raw `x-api-key` value to a {@link KeyResolution}, or null (→ 401). Steps:
 *   1. `verifyApiKey` — enforces the hashed lookup, `enabled=false` (KEY_DISABLED), and expiry (KEY_EXPIRED
 *      + row delete) UPSTREAM. `valid === false` (or a thrown error) → null.
 *   2. owner = `key.referenceId`; scope = {@link parseScope}(`key.permissions`).
 *   3. SUSPENDED-OWNER DENY (belt): when a teamView is wired AND the owner is a team member whose status is
 *      'suspended', deny (null). A non-team owner (plain content-API consumer) is `teamView.get === null`
 *      legitimately and is NOT denied here — the RBAC ∩ in `can()` is the authority gate for them (a
 *      removed/demoted owner has an EMPTY permission set, so every check denies regardless).
 * The raw secret is NEVER logged here; the caller logs only non-secret key fields.
 */
export async function resolveKey(
  auth: Auth,
  rawKey: string,
  teamView: TeamView | undefined,
): Promise<KeyResolution | null> {
  let result: Awaited<ReturnType<Auth['api']['verifyApiKey']>>;
  try {
    result = await auth.api.verifyApiKey({ body: { key: rawKey } });
  } catch {
    return null;
  }
  if (!result.valid || result.key === null || result.key === undefined) return null;
  const owner = result.key.referenceId;
  if (typeof owner !== 'string' || owner.length === 0) return null;
  // Suspended-owner deny (belt — the RBAC ∩ is the primary gate). Only applies to a team member.
  if (teamView !== undefined) {
    const row = teamView.get(owner);
    if (row !== null && row.status === 'suspended') return null;
  }
  const scope = parseScope(result.key.permissions);
  return { principal: { userId: owner, sessionToken: SYNTHETIC_KEY_TOKEN }, scope };
}
