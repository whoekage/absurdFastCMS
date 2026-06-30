import { errorResponse, type CoreResponse } from '../read.router.ts';
import { corkSend, corkSendNoStore } from '../responders.ts';
import { buildScopePermissions } from '../../auth/key.auth.ts';
import type { ServerContext } from '../context.ts';

/**
 * be-09c — API-TOKEN management routes under the `/_keys` literal prefix (a leading `_` is illegal in an
 * name → it can NEVER shadow `/:type`; same precedent as `_files`/`_team`). auth + rbac are required
 * deps, so these always mount. ALL self routes (create/list/revoke-own) are SESSION-ONLY (gateKeys rejects ctx.via ===
 * 'key' so a key can never mint/revoke keys → no self-escalation). Owner is ALWAYS principal.userId — a
 * body `userId` is NEVER trusted (and is schema-server-only upstream → CVE-2025-61928 neutralized). The
 * raw secret is returned EXACTLY ONCE at create (corkSendNoStore, no-store, never logged); list/revoke
 * never echo it. Cross-user create/revoke require `token.manage`.
 */
export function registerKeyRoutes(rctx: ServerContext): void {
  const { route } = rctx;
  const { gateKeys } = rctx.gates;
  const keysAuth = rctx.auth;
  const keysRbac = rctx.rbac;
  const keysSql = rctx.store.sql;

  const readJsonBodyKeys = (raw: Buffer | null): { ok: true; body: Record<string, unknown> } | { ok: false; error: CoreResponse } => {
    if (raw === null) return { ok: false, error: errorResponse(413, 'request body too large') };
    if (raw.length === 0) return { ok: true, body: {} };
    try {
      const parsed: unknown = JSON.parse(raw.toString('utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { ok: false, error: errorResponse(400, 'invalid JSON body') };
      }
      return { ok: true, body: parsed as Record<string, unknown> };
    } catch {
      return { ok: false, error: errorResponse(400, 'invalid JSON body') };
    }
  };

  // Project a created/listed key row to the SAFE shape — NEVER the secret (`key`). The plugin already
  // strips `key` from list/verify; this projection is the SECOND wall. The raw secret (`createResult.key`)
  // is included ONLY by the create route, exactly once.
  const projectKey = (k: Record<string, unknown>): Record<string, unknown> => ({
    id: k.id,
    name: k.name ?? null,
    prefix: k.prefix ?? null,
    start: k.start ?? null,
    expiresAt: k.expiresAt ?? null,
    lastRequest: k.lastRequest ?? null,
    enabled: k.enabled ?? null,
    permissions: k.permissions ?? null,
    metadata: k.metadata ?? null,
    createdAt: k.createdAt ?? null,
  });

  // Validate the optional create inputs off a parsed body. `permissions` is the REQUESTED scope (a flat
  // array of CMS perm actions); every requested action MUST be in the OWNER's resolved RBAC set (a key
  // may not be MINTED with a scope its owner lacks — the runtime ∩ denies anyway, but failing at create
  // is honest and avoids a misleading "valid" key). Absent permissions ⇒ a no-scope key (grants nothing).
  type CreateInput =
    | { ok: true; name: string | undefined; prefix: string | undefined; expiresIn: number | undefined; scope: string[]; metadata: Record<string, unknown> | undefined }
    | { ok: false; error: CoreResponse };
  const parseCreateInput = (body: Record<string, unknown>, ownerId: string): CreateInput => {
    const name = typeof body.name === 'string' ? body.name : undefined;
    const prefix = typeof body.prefix === 'string' ? body.prefix : undefined;
    let expiresIn: number | undefined;
    if (body.expiresIn !== undefined) {
      if (typeof body.expiresIn !== 'number' || !Number.isFinite(body.expiresIn) || body.expiresIn < 1) {
        return { ok: false, error: errorResponse(400, 'expiresIn must be a positive number of seconds') };
      }
      expiresIn = body.expiresIn;
    }
    let scope: string[] = [];
    if (body.permissions !== undefined) {
      if (!Array.isArray(body.permissions) || body.permissions.some((a) => typeof a !== 'string')) {
        return { ok: false, error: errorResponse(400, 'permissions must be an array of action strings') };
      }
      scope = body.permissions as string[];
    }
    const owned = keysRbac.permissionsOf(ownerId);
    const exceeds = scope.filter((a) => !owned.has(a));
    if (exceeds.length > 0) {
      return { ok: false, error: errorResponse(400, `scope exceeds owner permissions: ${exceeds.join(', ')}`) };
    }
    let metadata: Record<string, unknown> | undefined;
    if (body.metadata !== undefined) {
      if (typeof body.metadata !== 'object' || body.metadata === null || Array.isArray(body.metadata)) {
        return { ok: false, error: errorResponse(400, 'metadata must be an object') };
      }
      metadata = body.metadata as Record<string, unknown>;
    }
    return { ok: true, name, prefix, expiresIn, scope, metadata };
  };

  // Map a thrown error to a CoreResponse: a better-auth plugin validation error (an APIError with a 4xx
  // `statusCode`, e.g. EXPIRES_IN_IS_TOO_SMALL / INVALID prefix) surfaces as an HONEST 400 with the
  // plugin's message; anything else is an opaque 500. The raw secret is NEVER in an error path.
  const keyError = (err: unknown): CoreResponse => {
    const status = (err as { statusCode?: unknown })?.statusCode;
    const body = (err as { body?: { message?: unknown } })?.body;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      const msg = typeof body?.message === 'string' ? body.message : 'invalid request';
      return errorResponse(400, msg);
    }
    return errorResponse(500, 'internal error');
  };

  // Mint a key for `ownerId`. SERVER call (NO headers) so `permissions` + `userId` are accepted (they are
  // server-only on a client request) — the owner is derived by US, never proxied from a client body. The
  // raw secret is returned ONCE; only non-secret fields are logged (none logged here — no log on this path).
  const mintKey = async (ownerId: string, input: Extract<CreateInput, { ok: true }>): Promise<Record<string, unknown>> => {
    const created = await keysAuth.api.createApiKey({
      body: {
        userId: ownerId,
        name: input.name,
        prefix: input.prefix,
        expiresIn: input.expiresIn,
        permissions: buildScopePermissions(input.scope),
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      },
    });
    return created as unknown as Record<string, unknown>;
  };

  // POST /_keys — create a key for SELF (session-only). owner = principal.userId. Returns the raw secret
  // EXACTLY ONCE (the `key` field of the create result), projected alongside the safe metadata.
  route.post('/_keys', (res, req) => {
    gateKeys(res, req, true, (authCtx, _headers, raw, aborted) => {
      if (authCtx.via !== 'session') return corkSendNoStore(res, aborted, 403, { error: 'key management requires a session' });
      const parsed = readJsonBodyKeys(raw);
      if (!parsed.ok) return corkSend(res, aborted, parsed.error);
      const ownerId = authCtx.principal!.userId;
      const input = parseCreateInput(parsed.body, ownerId);
      if (!input.ok) return corkSend(res, aborted, input.error);
      void (async () => {
        try {
          const created = await mintKey(ownerId, input);
          // The raw secret (`created.key`) is surfaced ONCE here; everything else is the safe projection.
          corkSendNoStore(res, aborted, 200, { data: { ...projectKey(created), key: created.key } });
        } catch (err) {
          corkSend(res, aborted, keyError(err));
        }
      })();
    });
  });

  // POST /_keys/for/:userId — create a key for ANOTHER user (gated `token.manage`). owner = the route
  // `:userId`; the scope-vs-owner check uses the TARGET's resolved RBAC set. Session-only (no key may
  // drive a cross-user mint).
  route.post('/_keys/for/:userId', (res, req) => {
    const targetId = req.getParameter(0) ?? '';
    gateKeys(res, req, true, (authCtx, _headers, raw, aborted) => {
      if (authCtx.via !== 'session') return corkSendNoStore(res, aborted, 403, { error: 'key management requires a session' });
      if (!authCtx.can('token.manage')) return corkSend(res, aborted, errorResponse(403, 'forbidden'));
      const parsed = readJsonBodyKeys(raw);
      if (!parsed.ok) return corkSend(res, aborted, parsed.error);
      if (targetId.length === 0) return corkSend(res, aborted, errorResponse(400, 'userId is required'));
      const input = parseCreateInput(parsed.body, targetId);
      if (!input.ok) return corkSend(res, aborted, input.error);
      void (async () => {
        try {
          const exists = await keysSql`SELECT 1 FROM "user" WHERE id = ${targetId}`;
          if (exists.length === 0) return corkSendNoStore(res, aborted, 404, { error: 'user not found' });
          const created = await mintKey(targetId, input);
          corkSendNoStore(res, aborted, 200, { data: { ...projectKey(created), key: created.key } });
        } catch (err) {
          corkSend(res, aborted, keyError(err));
        }
      })();
    });
  });

  // GET /_keys — list MY keys (session-only, own-only). `listApiKeys` returns the owner's keys with the
  // secret structurally absent; we project to the safe shape (NEVER `key`) as the second wall.
  route.get('/_keys', (res, req) => {
    gateKeys(res, req, false, (authCtx, headers, _body, aborted) => {
      if (authCtx.via !== 'session') return corkSendNoStore(res, aborted, 403, { error: 'key management requires a session' });
      void (async () => {
        try {
          // listApiKeys returns `{ apiKeys, total, limit, offset }` — the secret is already stripped.
          const result = (await keysAuth.api.listApiKeys({ headers })) as unknown as { apiKeys: Record<string, unknown>[] };
          const data = result.apiKeys.map(projectKey);
          corkSendNoStore(res, aborted, 200, { data });
        } catch {
          corkSend(res, aborted, errorResponse(500, 'internal error'));
        }
      })();
    });
  });

  // DELETE /_keys/:id — REVOKE a key. own-only unless `token.manage`. We resolve the key's owner from PG
  // (apikey.referenceId) FIRST, then: an own key → delete via the better-auth API (the plugin enforces
  // referenceId === session.user.id); a NON-own key → require `token.manage`, then SQL-delete the row
  // (the plugin's deleteApiKey is hard own-only, and the apikey row in PG is the DURABLE truth verifyApiKey
  // reads, so a SQL delete is instantly effective). A key id the caller neither owns nor may manage → 403,
  // NEVER a blind delete-by-id (no IDOR). A missing id → 404. Revocation is INSTANT: no key cache, the
  // next verifyApiKey misses → 401.
  route.del('/_keys/:id', (res, req) => {
    const keyId = req.getParameter(0) ?? '';
    gateKeys(res, req, false, (authCtx, headers, _body, aborted) => {
      if (authCtx.via !== 'session') return corkSendNoStore(res, aborted, 403, { error: 'key management requires a session' });
      void (async () => {
        try {
          if (keyId.length === 0) return corkSendNoStore(res, aborted, 404, { error: 'not found' });
          const rows = await keysSql<{ referenceId: string }[]>`SELECT "referenceId" FROM apikey WHERE id = ${keyId}`;
          if (rows.length === 0) return corkSendNoStore(res, aborted, 404, { error: 'not found' });
          const ownerId = rows[0]!.referenceId;
          const isOwn = ownerId === authCtx.principal!.userId;
          if (!isOwn && !authCtx.can('token.manage')) {
            return corkSend(res, aborted, errorResponse(403, 'forbidden'));
          }
          if (isOwn) {
            await keysAuth.api.deleteApiKey({ body: { keyId }, headers });
          } else {
            // Cross-user revoke (token.manage): the plugin API is hard own-only, so delete the durable PG
            // row directly. PG is the truth verifyApiKey consults → the next request with the key is 401.
            await keysSql`DELETE FROM apikey WHERE id = ${keyId}`;
          }
          corkSendNoStore(res, aborted, 200, { data: { id: keyId, revoked: true } });
        } catch {
          corkSend(res, aborted, errorResponse(500, 'internal error'));
        }
      })();
    });
  });
}
