import type uWS from 'uWebSockets.js';
import { isWriteOriginAllowed, type CorsPolicy } from './cors.ts';
import { errorResponse } from './read.router.ts';
import { corkSend, readBody } from './responders.ts';
import { readSessionToken, type SessionCache, type Principal } from '../auth/session.cache.ts';
import { resolveKey } from '../auth/key.auth.ts';
import type { Auth } from '../auth/auth.ts';
import type { RbacRegistry } from '../auth/rbac.registry.ts';
import type { TeamView } from '../auth/team.view.ts';
import { config } from '../config.ts';
import type { AuthContext, AuthVia, Gates } from './context.ts';

/** The deps the gate factory closes over (the auth contour primitives + the CORS/CSRF policy). */
export interface GateDeps {
  sessionCache: SessionCache;
  rbac: RbacRegistry;
  auth: Auth;
  teamView: TeamView;
  corsPolicy: CorsPolicy | null;
}

/**
 * be-09b/be-09c — build the auth GATE primitives. Extracted verbatim from `createServer`; the factory
 * closes over the same `sessionCache`/`rbac`/`auth`/`teamView`/`corsPolicy` the inline gates captured, so
 * behaviour (the 401/403 split, the owner-RBAC ∩ token-scope `can`, the CSRF Origin check) is identical.
 */
export function createGates(deps: GateDeps): Gates {
  const { sessionCache, rbac, auth, teamView, corsPolicy } = deps;

  // CSRF (cross-origin mode only): a state-changing request must carry an allowlisted Origin. Once cookies
  // are SameSite=None (required cross-origin), SameSite no longer blocks a forged cross-site write, so this
  // Origin-check IS the defense. A missing Origin = a non-browser client (no ambient-cookie CSRF vector) →
  // allowed. Null policy (same-origin, SameSite=Lax) → no check at all. Returns true (+ sends 403) if blocked.
  const csrfReject = (res: uWS.HttpResponse, headers: Headers, aborted: () => boolean): boolean => {
    if (corsPolicy && !isWriteOriginAllowed(corsPolicy, headers.get('origin'))) {
      corkSend(res, aborted, errorResponse(403, 'forbidden'));
      return true;
    }
    return false;
  };

  /**
   * be-09c — assemble an {@link AuthContext}. `can()` is where EFFECTIVE perms = owner RBAC ∩ token scope is
   * enforced: the owner MUST hold the perm (pure-RAM checkPermission) AND, on the key path, the scope must
   * include it (`scope === null` ⇒ a SESSION ⇒ no narrowing). better-auth's own `verifyApiKey` only checks
   * request ⊆ stored scope — it does NOT intersect with owner RBAC, so the intersection lives HERE.
   */
  function makeCtx(principal: Principal | null, scope: ReadonlySet<string> | null, via: AuthVia): AuthContext {
    return {
      principal,
      can: (perm) =>
        principal !== null &&
        rbac.checkPermission(principal, perm) && // owner MUST hold it (RAM, zero-PG)
        (scope === null || scope.has(perm)), // a token can only NARROW; null scope = session (no narrowing)
      via,
    };
  }

  /**
   * be-09b/be-09c — resolve the {@link AuthContext}. COOKIE-FIRST and MUTUALLY EXCLUSIVE: a session cookie
   * resolves ONLY via {@link SessionCache.validate} (full owner RBAC, no narrowing); ELSE an `x-api-key`
   * header resolves ONLY via {@link resolveKey} (owner Principal + token scope). A value is NEVER tried as
   * both — a session token in `x-api-key` fails verifyApiKey (not a hashed key row), a raw key in the cookie
   * fails getSession; a query-string key is never read. Closes over `sessionCache`/`rbac`/`auth`/`teamView`.
   */
  async function resolveAuth(headers: Headers): Promise<AuthContext> {
    // SESSION PATH (cookie only).
    if (readSessionToken(headers) !== null) {
      const principal = await sessionCache.validate(headers);
      return makeCtx(principal, null, principal !== null ? 'session' : 'none');
    }
    // KEY PATH (x-api-key header only).
    const rawKey = headers.get('x-api-key');
    if (rawKey !== null && rawKey.length > 0) {
      const resolved = await resolveKey(auth, rawKey, teamView);
      if (resolved !== null) return makeCtx(resolved.principal, resolved.scope, 'key');
      return makeCtx(null, null, 'none');
    }
    return makeCtx(null, null, 'none');
  }

  /**
   * be-09b — the GATE primitive. uWS forces `res.onData`/`res.onAborted` to be registered SYNCHRONOUSLY in
   * the handler callback, so we cannot await auth BEFORE buffering the body. The discipline:
   *   1. capture the sync request bits the caller needs (params) BEFORE calling gate (caller closes over them),
   *   2. read the `Headers` SYNC off `req`, and (for body routes) start the SYNC body buffer via `readBody`,
   *   3. in the body callback (or immediately for bodyless), resolve auth + apply the 401/403 split,
   *   4. on success, run `proceed(body)` — the existing parse + core dispatch, but corked HERE.
   *
   * 401 (no/invalid/expired session) is precisely distinct from 403 (session present, perm missing); body
   * fields are NEVER consulted for authz (the Principal comes ONLY from {@link SessionCache.validate}).
   *
   * `proceed` receives the buffered body Buffer (null when oversized) and the abort probe, and is fully
   * responsible for the response from there (it corks). `readsBody:false` (DELETE /_files/:id) skips the
   * body buffer (those verbs carry none) and dispatches with a null body.
   */
  function gate(
    res: uWS.HttpResponse,
    req: uWS.HttpRequest,
    perm: string,
    readsBody: boolean,
    proceed: (body: Buffer | null, aborted: () => boolean) => void,
  ): void {
    // SYNCHRONOUS header read — `req` is invalid after the first await.
    const headers = new Headers();
    req.forEach((k, v) => headers.set(k, v));

    const run = (body: Buffer | null, aborted: () => boolean): void => {
      if (csrfReject(res, headers, aborted)) return;
      void (async () => {
        let ctx: AuthContext;
        try {
          ctx = await resolveAuth(headers);
        } catch {
          return corkSend(res, aborted, errorResponse(500, 'internal error'));
        }
        if (ctx.principal === null) return corkSend(res, aborted, errorResponse(401, 'unauthenticated'));
        if (!ctx.can(perm)) return corkSend(res, aborted, errorResponse(403, 'forbidden'));
        proceed(body, aborted);
      })();
    };

    if (readsBody) {
      const { aborted } = readBody(res, (body) => run(body, aborted));
    } else {
      let aborted = false;
      res.onAborted(() => {
        aborted = true;
      });
      run(null, () => aborted);
    }
  }

  /**
   * be-09f — GATE a `/_team` route and HAND THE RESOLVED PRINCIPAL to `proceed`. Identical 401/403 split as
   * {@link gate}, but the team handlers need the ACTOR's userId (resolved ONLY from the session — never the
   * body) to apply the privilege cap + self-guard. The principal passed here is the sole authz subject; the
   * route/body `:userId` only ever designates the TARGET. Auth is ALWAYS enabled (sessionCache + rbac +
   * teamView are required deps), so there is no open-route branch.
   */
  function gateTeam(
    res: uWS.HttpResponse,
    req: uWS.HttpRequest,
    readsBody: boolean,
    proceed: (principal: Principal, headers: Headers, body: Buffer | null, aborted: () => boolean) => void,
  ): void {
    const headers = new Headers();
    req.forEach((k, v) => headers.set(k, v));

    const run = (body: Buffer | null, aborted: () => boolean): void => {
      if (csrfReject(res, headers, aborted)) return;
      void (async () => {
        let ctx: AuthContext;
        try {
          ctx = await resolveAuth(headers);
        } catch {
          return corkSend(res, aborted, errorResponse(500, 'internal error'));
        }
        if (ctx.principal === null) return corkSend(res, aborted, errorResponse(401, 'unauthenticated'));
        if (!ctx.can('team.manage')) return corkSend(res, aborted, errorResponse(403, 'forbidden'));
        // The acting admin's headers are forwarded to the lifecycle `auth.api.*` calls so better-auth's own
        // admin endpoints resolve the actor's session (their authz is satisfied by adminRoles:['super-admin']
        // matching the better-auth user.role we set for super-admins). Our RBAC (checkPermission) remains the
        // SOLE CMS authz source — it never reads better-auth's role field.
        proceed(ctx.principal, headers, body, aborted);
      })();
    };

    if (readsBody) {
      const { aborted } = readBody(res, (body) => run(body, aborted));
    } else {
      let aborted = false;
      res.onAborted(() => {
        aborted = true;
      });
      run(null, () => aborted);
    }
  }

  /**
   * be-09c — GATE a `/_keys` route. Like {@link gateTeam} it resolves auth (session OR key) and hands the
   * full {@link AuthContext} (principal + can + via) to `proceed`, which applies its OWN authz: the self
   * routes (create/list/revoke-own) are SESSION-ONLY (a key may not mint/revoke keys — `ctx.via === 'key'`
   * is rejected so a key can never self-escalate), and the cross-user routes gate on `token.manage`. The
   * principal is the sole authz subject; a route/body `:userId` only ever designates the TARGET owner.
   */
  function gateKeys(
    res: uWS.HttpResponse,
    req: uWS.HttpRequest,
    readsBody: boolean,
    proceed: (ctx: AuthContext, headers: Headers, body: Buffer | null, aborted: () => boolean) => void,
  ): void {
    const headers = new Headers();
    req.forEach((k, v) => headers.set(k, v));

    const run = (body: Buffer | null, aborted: () => boolean): void => {
      if (csrfReject(res, headers, aborted)) return;
      void (async () => {
        let ctx: AuthContext;
        try {
          ctx = await resolveAuth(headers);
        } catch {
          return corkSend(res, aborted, errorResponse(500, 'internal error'));
        }
        if (ctx.principal === null) return corkSend(res, aborted, errorResponse(401, 'unauthenticated'));
        proceed(ctx, headers, body, aborted);
      })();
    };

    if (readsBody) {
      const { aborted } = readBody(res, (body) => run(body, aborted));
    } else {
      let aborted = false;
      res.onAborted(() => {
        aborted = true;
      });
      run(null, () => aborted);
    }
  }

  /**
   * be-09b — GATE the multipart upload. The upload body can be up to `uploadMaxBytes` (25 MiB) — much
   * larger than the 1 MiB JSON `MAX_BODY_BYTES` — so it does NOT use `gate`'s `readBody`. Instead it
   * buffers the raw multipart bytes SYNCHRONOUSLY (its own cap) WHILE resolving auth in parallel; once both
   * the body is fully read AND auth resolved, it applies the 401/403 split and (on allow) feeds the buffer
   * to busboy. onData/onAborted are registered synchronously (uWS requirement); the auth decision is
   * deferred but the bytes are never lost.
   */
  function gateUpload(
    res: uWS.HttpResponse,
    req: uWS.HttpRequest,
    contentType: string,
    proceed: (raw: Buffer, aborted: () => boolean) => void,
  ): void {
    const headers = new Headers();
    req.forEach((k, v) => headers.set(k, v));

    let aborted = false;
    res.onAborted(() => {
      aborted = true;
    });
    if (csrfReject(res, headers, () => aborted)) return; // cross-origin CSRF: reject before buffering bytes

    const cap = config.uploadMaxBytes;
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    let body: Buffer | null = null;
    let bodyDone = false;
    let authDone = false;
    let ctx: AuthContext | null = null;
    let authFailed = false;

    const tryFinish = (): void => {
      if (!bodyDone || !authDone) return;
      if (authFailed) return corkSend(res, () => aborted, errorResponse(500, 'internal error'));
      // Authz split FIRST — never even look at the (possibly oversized) body for an unauthorized caller.
      if (ctx!.principal === null) return corkSend(res, () => aborted, errorResponse(401, 'unauthenticated'));
      if (!ctx!.can('media.upload')) return corkSend(res, () => aborted, errorResponse(403, 'forbidden'));
      if (body === null) return corkSend(res, () => aborted, errorResponse(413, 'upload too large'));
      proceed(body, () => aborted);
    };

    res.onData((ab, isLast) => {
      if (!tooLarge) {
        const chunk = Buffer.from(ab.slice(0));
        size += chunk.length;
        if (size > cap) tooLarge = true;
        else chunks.push(chunk);
      }
      if (isLast) {
        body = tooLarge ? null : Buffer.concat(chunks);
        bodyDone = true;
        tryFinish();
      }
    });

    void (async () => {
      try {
        ctx = await resolveAuth(headers);
      } catch {
        authFailed = true;
      }
      authDone = true;
      tryFinish();
    })();
  }

  return { gate, gateTeam, gateKeys, gateUpload };
}
