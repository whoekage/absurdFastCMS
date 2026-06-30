import {
  previewSchemaEdit,
  previewComponentEdit,
  readComponents,
  applyComponentEdit,
  applyComponentDelete,
  type ModuleDraft,
  type ComponentDraft,
} from '../../compose/builder.ts';
import { hashRequest } from '../../compose/catalog-version.ts';
import { localeFromAcceptLanguage } from '../../errors/index.ts';
import { type CoreResponse } from '../read.router.ts';
import { corkSend, builderJson, builderError, parseBody } from '../responders.ts';
import type { ServerContext } from '../context.ts';

/**
 * The Visual Builder route surface (modules + reusable component definitions). GET reads are PUBLIC (ETag/
 * 304 off the shared catalog version); mutations are GATED on `builder.manage` and funnel through the
 * apply-core (mutex + If-Match/version + idempotency). Components have NO table, so their writes never
 * migrate — they write the file + swap the registry; they share the catalog version/ETag with modules.
 */
export function registerBuilderRoutes(rctx: ServerContext): void {
  const { route, sql, dir, apply } = rctx;
  const { gate } = rctx.gates;

  // ---- BUILDER ROUTE SURFACE (design §1). GET reads are PUBLIC; mutations gated on builder.manage. ----

  // GET list — applied catalog (with ids) + ETag/304.
  route.get('/builder/modules', (res, req) => {
    const inm = req.getHeader('if-none-match');
    let aborted = false;
    res.onAborted(() => { aborted = true; });
    void (async () => {
      try {
        await apply.ensureVersion();
        if (inm !== '' && inm === apply.version()) return corkSend(res, () => aborted, builderJson(304, {}, { ETag: apply.version() }));
        const schemas = await apply.readApplied();
        corkSend(res, () => aborted, builderJson(200, { ok: true, schemas, version: apply.version() }, { ETag: apply.version() }));
      } catch { corkSend(res, () => aborted, builderJson(500, { ok: false, error: 'internal error' })); }
    })();
  });

  // GET one — 404 when absent; else the single schema WITH ids + ETag/304.
  route.get('/builder/modules/:name', (res, req) => {
    const name = req.getParameter(0) ?? '';
    const inm = req.getHeader('if-none-match');
    let aborted = false;
    res.onAborted(() => { aborted = true; });
    void (async () => {
      try {
        await apply.ensureVersion();
        const schema = (await apply.readApplied()).find((s) => s.name === name);
        if (schema === undefined) return corkSend(res, () => aborted, builderJson(404, { ok: false, error: `module "${name}" does not exist` }));
        if (inm !== '' && inm === apply.version()) return corkSend(res, () => aborted, builderJson(304, {}, { ETag: apply.version() }));
        corkSend(res, () => aborted, builderJson(200, { ok: true, schema, version: apply.version() }, { ETag: apply.version() }));
      } catch { corkSend(res, () => aborted, builderJson(500, { ok: false, error: 'internal error' })); }
    })();
  });

  // POST preview — dry-run (no write/migrate/swap), no mutex/version. GATED.
  route.post('/builder/modules/:name/preview', (res, req) => {
    const name = req.getParameter(0) ?? '';
    const locale = localeFromAcceptLanguage(req.getHeader('accept-language')); // sync: uWS req is dead after gate's await
    gate(res, req, 'builder.manage', true, (raw, aborted) => {
      const parsed = parseBody(raw);
      if (!parsed.ok) return corkSend(res, aborted, parsed.error);
      const body = parsed.body as { allowDestructive?: boolean } & ModuleDraft;
      if (body.name !== name) return corkSend(res, aborted, builderJson(422, { ok: false, error: 'body.name must equal the path name' }));
      void (async () => {
        let result: CoreResponse;
        try {
          const p = await previewSchemaEdit(sql, dir, body, { allowDestructive: body.allowDestructive === true });
          result = builderJson(200, { ok: p.ok, applied: p.changes, blocked: p.blocked, schema: p.schema, generatedSource: p.generatedSource });
        } catch (e) { result = builderError(e, locale); }
        corkSend(res, aborted, result);
      })();
    });
  });

  // PUT upsert — create / update / name-rename. GATED + mutex + If-Match/version + idempotency.
  route.put('/builder/modules/:name', (res, req) => {
    const name = req.getParameter(0) ?? '';
    const ifMatch = req.getHeader('if-match'); // '' when absent (uWS; lowercase key)
    const idemKey = req.getHeader('idempotency-key');
    const locale = localeFromAcceptLanguage(req.getHeader('accept-language')); // sync: uWS req is dead after gate's await
    gate(res, req, 'builder.manage', true, (raw, aborted) => {
      const parsed = parseBody(raw);
      if (!parsed.ok) return corkSend(res, aborted, parsed.error);
      const body = parsed.body as { allowDestructive?: boolean; version?: string } & ModuleDraft;
      if (body.name !== name) return corkSend(res, aborted, builderJson(422, { ok: false, error: 'body.name must equal the path name' }));
      if (ifMatch === '' && body.version === undefined) return corkSend(res, aborted, builderJson(428, { ok: false, error: 'precondition required (If-Match)' }));
      const { allowDestructive, version: _v, ...meaningful } = body;
      const requestHash = hashRequest({ m: 'PUT', name, body: meaningful });
      apply.runMutation(res, aborted, { ifMatch, bodyVersion: body.version, idemKey, requestHash },
        () => apply.runEdit(body, { allowDestructive: allowDestructive === true }), locale);
    });
  });

  // DELETE — drop a whole type (always destructive → require allowDestructive). GATED + same wrap.
  route.del('/builder/modules/:name', (res, req) => {
    const name = req.getParameter(0) ?? '';
    const ifMatch = req.getHeader('if-match');
    const idemKey = req.getHeader('idempotency-key');
    const locale = localeFromAcceptLanguage(req.getHeader('accept-language')); // sync: uWS req is dead after gate's await
    gate(res, req, 'builder.manage', true, (raw, aborted) => {
      const parsed = parseBody(raw);
      if (!parsed.ok) return corkSend(res, aborted, parsed.error);
      const body = parsed.body as { allowDestructive?: boolean; version?: string };
      if (body.allowDestructive !== true) return corkSend(res, aborted, builderJson(409, { ok: false, applied: [], blocked: [], error: 'requires allowDestructive' }));
      if (ifMatch === '' && body.version === undefined) return corkSend(res, aborted, builderJson(428, { ok: false, error: 'precondition required (If-Match)' }));
      const requestHash = hashRequest({ m: 'DELETE', name });
      apply.runMutation(res, aborted, { ifMatch, bodyVersion: body.version, idemKey, requestHash }, () => apply.runDelete(name), locale);
    });
  });

  // POST reload — operator escape hatch: cache-busted re-import + swap (registry/hooks/relations), NO
  // migrate; advances the version so a pre-reload PUT carrying the old version fails 412. GATED + mutex.
  route.post('/builder/reload', (res, req) => {
    const locale = localeFromAcceptLanguage(req.getHeader('accept-language')); // sync: uWS req is dead after gate's await
    gate(res, req, 'builder.manage', false, (_raw, aborted) => {
      apply.runReload(res, aborted, locale);
    });
  });

  // ---- COMPONENT-DEFINITION ROUTE SURFACE — reusable nested field groups (modules/components/*.ts). GET
  //      reads are PUBLIC; mutations gated on builder.manage. Components have NO table, so writes never
  //      migrate — they write the file + swap the registry. They share the catalog version/ETag with modules.

  // GET list components — defined components (with ids) + ETag/304.
  route.get('/builder/components', (res, req) => {
    const inm = req.getHeader('if-none-match');
    let aborted = false;
    res.onAborted(() => { aborted = true; });
    void (async () => {
      try {
        await apply.ensureVersion();
        if (inm !== '' && inm === apply.version()) return corkSend(res, () => aborted, builderJson(304, {}, { ETag: apply.version() }));
        const components = await readComponents(dir);
        corkSend(res, () => aborted, builderJson(200, { ok: true, components, version: apply.version() }, { ETag: apply.version() }));
      } catch { corkSend(res, () => aborted, builderJson(500, { ok: false, error: 'internal error' })); }
    })();
  });

  // GET one component — 404 when absent; else the single component WITH ids + ETag/304.
  route.get('/builder/components/:name', (res, req) => {
    const name = req.getParameter(0) ?? '';
    const inm = req.getHeader('if-none-match');
    let aborted = false;
    res.onAborted(() => { aborted = true; });
    void (async () => {
      try {
        await apply.ensureVersion();
        const component = (await readComponents(dir)).find((c) => c.name === name);
        if (component === undefined) return corkSend(res, () => aborted, builderJson(404, { ok: false, error: `component "${name}" does not exist` }));
        if (inm !== '' && inm === apply.version()) return corkSend(res, () => aborted, builderJson(304, {}, { ETag: apply.version() }));
        corkSend(res, () => aborted, builderJson(200, { ok: true, component, version: apply.version() }, { ETag: apply.version() }));
      } catch { corkSend(res, () => aborted, builderJson(500, { ok: false, error: 'internal error' })); }
    })();
  });

  // POST preview component — dry-run (no write/swap), no mutex/version. GATED.
  route.post('/builder/components/:name/preview', (res, req) => {
    const name = req.getParameter(0) ?? '';
    const locale = localeFromAcceptLanguage(req.getHeader('accept-language')); // sync: uWS req is dead after gate's await
    gate(res, req, 'builder.manage', true, (raw, aborted) => {
      const parsed = parseBody(raw);
      if (!parsed.ok) return corkSend(res, aborted, parsed.error);
      const body = parsed.body as ComponentDraft;
      if (body.name !== name) return corkSend(res, aborted, builderJson(422, { ok: false, error: 'body.name must equal the path name' }));
      void (async () => {
        let result: CoreResponse;
        try {
          const p = await previewComponentEdit(dir, body);
          result = builderJson(200, { ok: true, component: p.component, generatedSource: p.generatedSource });
        } catch (e) { result = builderError(e, locale); }
        corkSend(res, aborted, result);
      })();
    });
  });

  // PUT upsert a component — create / update. GATED + mutex + If-Match/version + idempotency. NO migrate.
  route.put('/builder/components/:name', (res, req) => {
    const name = req.getParameter(0) ?? '';
    const ifMatch = req.getHeader('if-match');
    const idemKey = req.getHeader('idempotency-key');
    const locale = localeFromAcceptLanguage(req.getHeader('accept-language')); // sync: uWS req is dead after gate's await
    gate(res, req, 'builder.manage', true, (raw, aborted) => {
      const parsed = parseBody(raw);
      if (!parsed.ok) return corkSend(res, aborted, parsed.error);
      const body = parsed.body as { version?: string } & ComponentDraft;
      if (body.name !== name) return corkSend(res, aborted, builderJson(422, { ok: false, error: 'body.name must equal the path name' }));
      if (ifMatch === '' && body.version === undefined) return corkSend(res, aborted, builderJson(428, { ok: false, error: 'precondition required (If-Match)' }));
      const { version: _v, ...meaningful } = body;
      const requestHash = hashRequest({ m: 'PUT-component', name, body: meaningful });
      apply.runComponentMutation(res, aborted, { ifMatch, bodyVersion: body.version, idemKey, requestHash }, async () => {
        const component = await applyComponentEdit(dir, body);
        await apply.reloadFromDisk();
        return { component };
      }, locale);
    });
  });

  // DELETE a component — blocked (422) while any field references it. GATED + same wrap. NO migrate.
  route.del('/builder/components/:name', (res, req) => {
    const name = req.getParameter(0) ?? '';
    const ifMatch = req.getHeader('if-match');
    const idemKey = req.getHeader('idempotency-key');
    const locale = localeFromAcceptLanguage(req.getHeader('accept-language')); // sync: uWS req is dead after gate's await
    gate(res, req, 'builder.manage', true, (raw, aborted) => {
      const parsed = parseBody(raw);
      if (!parsed.ok) return corkSend(res, aborted, parsed.error);
      const body = parsed.body as { version?: string };
      if (ifMatch === '' && body.version === undefined) return corkSend(res, aborted, builderJson(428, { ok: false, error: 'precondition required (If-Match)' }));
      const requestHash = hashRequest({ m: 'DELETE-component', name });
      apply.runComponentMutation(res, aborted, { ifMatch, bodyVersion: body.version, idemKey, requestHash }, async () => {
        await applyComponentDelete(dir, name);
        await apply.reloadFromDisk();
        return {};
      }, locale);
    });
  });
}
