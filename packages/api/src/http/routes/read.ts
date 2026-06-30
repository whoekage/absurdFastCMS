import type uWS from 'uWebSockets.js';
import { handleRequest, errorResponse, type CoreResponse } from '../read.router.ts';
import { writeResponse, writeJson, toInt, corkSend, corkSendNoStore } from '../responders.ts';
import { mediaPopulateTargets, stripMediaPopulate, applyMediaPopulate } from '../media.populate.ts';
import { componentPopulateTargets, applyComponentPopulate } from '../component.populate.ts';
import { listTypes, inspectType } from '../../store/inspect.ts';
import { localeFromAcceptLanguage, type Locale } from '../../errors/index.ts';
import { config } from '../../config.ts';
import type { ServerContext } from '../context.ts';

/**
 * The PUBLIC read surface: the data GET routes (`/:type`, `/:type/:id`), the optional media/component
 * populate post-step, the first-admin `/_setup` probe, and the dev-only debug inspector. Extracted from
 * `createServer` verbatim; reads stay SYNCHRONOUS + byte-identical except the optional async populate path.
 */
export function registerReadRoutes(rctx: ServerContext): void {
  const { route, live, store } = rctx;

  /**
   * be-04 MEDIA + be-05 COMPONENT — the OPTIONAL populate-post-step wrapper around a GET read. When the
   * registry is present and the request asked to populate >=1 MEDIA field and/or >=1 COMPONENT field of the
   * addressed type, this:
   *   1. STRIPS the targeted media + component populate names from the query (so the engine's relation-only
   *      populate parser never 400s on a scalar media / json component field), runs the pure read core,
   *   2. on a 200, applies the media populate (inline asset record(s)) AND the component populate (resolve
   *      inline media refs inside the component trees), each over the parsed envelope — corked + onAborted.
   * Returns true iff it OWNED the response (took the async path); false => the caller runs the normal
   * SYNCHRONOUS byte-identical read path. With no registry / no media+component field / no such populate
   * asked, it always returns false => the existing zero-copy read path is byte-identical.
   */
  function mediaRead(res: uWS.HttpResponse, method: string, path: string, type: string, query: string, locale: Locale): boolean {
    const reg = live.registry; // read the LIVE registry per-call so a post-swap type/field is seen
    if (method.toUpperCase() !== 'GET') return false;
    const def = reg.get(type);
    if (def === undefined || (def.mediaFields.size === 0 && def.componentFields.size === 0)) return false;
    const mediaTargets = mediaPopulateTargets(def, query);
    const componentTargets = componentPopulateTargets(def, query);
    if (mediaTargets.size === 0 && componentTargets.size === 0) return false;

    const sql = store.sql;
    // Strip BOTH the media + component populate names so the engine's relation-only parser never 400s.
    const stripNames = new Set<string>([...mediaTargets.keys(), ...componentTargets.keys()]);
    const strippedQuery = stripMediaPopulate(query, stripNames);
    let aborted = false;
    res.onAborted(() => {
      aborted = true;
    });
    void (async () => {
      let result: CoreResponse;
      try {
        const base = handleRequest(live.engine, { method, path, query: strippedQuery, locale });
        // Only a successful read carries a value to resolve; a 400/404/405 passes straight through.
        if (base.status === 200) {
          let body = base.body;
          if (mediaTargets.size > 0) body = (await applyMediaPopulate(sql, body, mediaTargets)).body;
          if (componentTargets.size > 0) body = (await applyComponentPopulate(sql, live.engine, reg, body, componentTargets)).body;
          result = { status: 200, contentType: base.contentType, body };
        } else {
          result = base;
        }
      } catch {
        result = errorResponse(500, 'internal error');
      }
      if (!aborted) res.cork(() => writeResponse(res, result));
    })();
    return true;
  }

  // DEBUG INSPECTOR (dev-only, read-only) — mounted ONLY when DEBUG_INSPECTOR=1 outside production. The
  // `debug-inspect` segment contains '-', illegal in an name, so it can never shadow a real `/:type`.
  // Synchronous like the read routes: decode straight off the live engine, emit JSON, never mutate.
  if (config.debugInspector) {
    // INDEX: every module + row count.
    route.get('/debug-inspect', (res) => {
      writeJson(res, 200, listTypes(live.engine));
    });
    // ONE type: per-column storage/stats + relations + a decoded row window (?offset=&limit=).
    route.get('/debug-inspect/:type', (res, req) => {
      const type = req.getParameter(0) ?? '';
      const params = new URLSearchParams(req.getQuery() ?? '');
      const offset = toInt(params.get('offset'));
      const limit = toInt(params.get('limit'));
      const result = inspectType(live.engine, type, { offset, limit } as { offset?: number; limit?: number });
      if (result === null) writeJson(res, 404, { error: `unknown module "${type}"` });
      else writeJson(res, 200, result);
    });
  }

  // PUBLIC setup status: does the instance still need its FIRST admin (no super-admin grant exists yet)? The
  // sign-in screen reads this BEFORE any session exists to choose "Create first admin" vs "Sign in". No auth,
  // no-store. Reveals only setup-state (standard — Strapi/Directus expose the same `hasAdmin` to the login UI).
  route.get('/_setup', (res) => {
    let aborted = false;
    res.onAborted(() => {
      aborted = true;
    });
    void (async () => {
      try {
        const [row] = await store.sql<{ needs: boolean }[]>`
          SELECT NOT EXISTS (
            SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.name = 'super-admin'
          ) AS needs`;
        if (!aborted) corkSendNoStore(res, () => aborted, 200, { needsFirstAdmin: row?.needs ?? true });
      } catch {
        if (!aborted) corkSend(res, () => aborted, errorResponse(500, 'internal error'));
      }
    })();
  });

  // LIST: /:type  — read everything off `req` synchronously, then delegate to the core.
  route.get('/:type', (res, req) => {
    const method = req.getMethod();
    const type = req.getParameter(0) ?? '';
    const query = req.getQuery() ?? '';
    const locale = localeFromAcceptLanguage(req.getHeader('accept-language')); // read sync (uWS req)
    // SYNC handler: no await past this point, so `req` is no longer touched and no onAborted needed —
    // UNLESS this is a media-populate read (registry present + a media field targeted), which needs an
    // async batched `files` lookup. mediaRead returns true iff it took the async path (else fall through).
    if (mediaRead(res, method, `/${type}`, type, query, locale)) return;
    writeResponse(res, handleRequest(live.engine, { method, path: `/${type}`, query, locale }));
  });

  // SINGLE: /:type/:id
  route.get('/:type/:id', (res, req) => {
    const method = req.getMethod();
    const type = req.getParameter(0) ?? '';
    const id = req.getParameter(1) ?? '';
    const query = req.getQuery() ?? '';
    const locale = localeFromAcceptLanguage(req.getHeader('accept-language')); // read sync (uWS req)
    if (mediaRead(res, method, `/${type}/${id}`, type, query, locale)) return;
    writeResponse(res, handleRequest(live.engine, { method, path: `/${type}/${id}`, query, locale }));
  });
}
