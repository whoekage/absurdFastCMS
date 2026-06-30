import type uWS from 'uWebSockets.js';
import { handleWrite } from '../write.handler.ts';
import { errorResponse, type CoreResponse } from '../read.router.ts';
import { corkSend, parseBody } from '../responders.ts';
import { localeFromAcceptLanguage } from '../../errors/index.ts';
import type { ServerContext } from '../context.ts';

/**
 * be-09b — GATED data writes (POST/PUT/DELETE /:type[/:id]) plus the Draft & Publish action sub-route and
 * the i18n variant-create. The verb→perm map is fixed at the registration site (POST=create, PUT=update,
 * DELETE=delete); the same can(perm) fronts every verb so no method gets a weaker check. Params are
 * captured sync BEFORE gate; the body is buffered by gate; parse + core dispatch happen on success.
 */
export function registerDataRoutes(rctx: ServerContext): void {
  const { route, writeCtx: ctx } = rctx;
  const { gate } = rctx.gates;

  // Draft & Publish action sub-route (`content.publish`). 3 segments — structurally distinct from the
  // 2-segment data routes (ordering irrelevant: uWS matches by segment count + literals).
  route.post('/:type/:id/actions/:action', (res, req) => {
    const type = req.getParameter(0) ?? '';
    const idRaw = req.getParameter(1) ?? '';
    const actionRaw = req.getParameter(2) ?? '';
    const locale = localeFromAcceptLanguage(req.getHeader('accept-language')); // sync: uWS req is dead after gate's await
    gate(res, req, 'content.publish', true, (_raw, aborted) => {
      void (async () => {
        if (actionRaw !== 'publish' && actionRaw !== 'unpublish') {
          return corkSend(res, aborted, errorResponse(404, 'not found'));
        }
        let result: CoreResponse;
        try {
          result = await handleWrite(ctx, { method: 'POST', type, idRaw, body: undefined, action: actionRaw, locale });
        } catch {
          result = errorResponse(500, 'internal error');
        }
        corkSend(res, aborted, result);
      })();
    });
  });
  // i18n variant create: POST /:type/:id/locales/:locale (`content.create`). 4 segments; literal
  // `locales` distinguishes it from `/actions/:action`.
  route.post('/:type/:id/locales/:locale', (res, req) => {
    const type = req.getParameter(0) ?? '';
    const idRaw = req.getParameter(1) ?? '';
    const variantLocale = req.getParameter(2) ?? '';
    const locale = localeFromAcceptLanguage(req.getHeader('accept-language')); // UI error locale (header), distinct from the variantLocale data slug
    gate(res, req, 'content.create', true, (raw, aborted) => {
      const parsed = parseBody(raw);
      if (!parsed.ok) return corkSend(res, aborted, parsed.error);
      void (async () => {
        let result: CoreResponse;
        try {
          result = await handleWrite(ctx, { method: 'POST', type, idRaw, body: parsed.body, variantLocale, locale });
        } catch {
          result = errorResponse(500, 'internal error');
        }
        corkSend(res, aborted, result);
      })();
    });
  });
  const dataWrite = (method: string, perm: string, hasId: boolean) => (res: uWS.HttpResponse, req: uWS.HttpRequest): void => {
    const type = req.getParameter(0) ?? '';
    const idRaw = hasId ? (req.getParameter(1) ?? '') : '';
    const locale = localeFromAcceptLanguage(req.getHeader('accept-language')); // sync: uWS req is dead after gate's await
    gate(res, req, perm, true, (raw, aborted) => {
      const parsed = parseBody(raw);
      if (!parsed.ok) return corkSend(res, aborted, parsed.error);
      void (async () => {
        let result: CoreResponse;
        try {
          result = await handleWrite(ctx, { method, type, idRaw, body: parsed.body, locale });
        } catch {
          result = errorResponse(500, 'internal error');
        }
        corkSend(res, aborted, result);
      })();
    });
  };
  route.post('/:type', dataWrite('POST', 'content.create', false));
  route.put('/:type/:id', dataWrite('PUT', 'content.update', true));
  route.del('/:type/:id', dataWrite('DELETE', 'content.delete', true));
}
