import busboy from 'busboy';
import type uWS from 'uWebSockets.js';
import { handleUpload, handleListFiles, handleGetFile, handleDeleteFile, type FileContext, type ParsedUpload } from '../upload.handler.ts';
import { errorResponse, type CoreResponse } from '../read.router.ts';
import { writeResponse, corkSend, toInt } from '../responders.ts';
import { config } from '../../config.ts';
import type { ServerContext } from '../context.ts';

// be-04 MEDIA — sanitize a busboy-reported filename to its bare basename over a safe alphabet. NEVER used
// to build a storage path (that is the content-addressed key); recorded only for display. Strips any
// directory component (defends against `../../etc/passwd` or a backslash-path), collapses everything
// outside `[A-Za-z0-9._-]`, caps length, and falls back to `upload` when nothing survives.
function sanitizeFilename(raw: string): string {
  // basename over BOTH separators (a Windows client may send backslashes).
  const base = raw.replace(/\\/g, '/').split('/').pop() ?? '';
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 255);
  return cleaned.length > 0 ? cleaned : 'upload';
}

/** A media upload-route outcome: a parsed single file, or a client error to surface verbatim. */
type UploadParseResult = { ok: true; upload: ParsedUpload } | { ok: false; status: number; message: string };

/**
 * be-09b — parse an ALREADY-BUFFERED multipart body through busboy (single-file, bounded). Used by the
 * GATED upload path: the gate resolves auth (async) WHILE the body buffers synchronously, so by dispatch
 * time the bytes are in hand and we feed busboy in one `write`+`end`. The size cap is enforced by the
 * caller's buffering (uploadMaxBytes); busboy's own `fileSize` limit is a belt-and-suspenders second wall.
 */
function parseMultipartBuffer(contentType: string, raw: Buffer, onDone: (r: UploadParseResult) => void): void {
  if (!/^multipart\/form-data/i.test(contentType)) {
    onDone({ ok: false, status: 415, message: 'expected multipart/form-data' });
    return;
  }
  let bb: ReturnType<typeof busboy>;
  try {
    bb = busboy({ headers: { 'content-type': contentType }, limits: { files: 1, fields: 0, fileSize: config.uploadMaxBytes } });
  } catch {
    onDone({ ok: false, status: 400, message: 'invalid multipart body' });
    return;
  }
  let settled = false;
  const settle = (r: UploadParseResult): void => {
    if (settled) return;
    settled = true;
    onDone(r);
  };
  const chunks: Buffer[] = [];
  let sawFile = false;
  let tooLarge = false;
  let extraFile = false;
  let filename = 'upload';
  let declaredMime = 'application/octet-stream';
  bb.on('file', (_name, stream, info) => {
    if (sawFile) {
      extraFile = true;
      stream.resume();
      return;
    }
    sawFile = true;
    filename = sanitizeFilename(info.filename ?? '');
    declaredMime = (info.mimeType ?? 'application/octet-stream').slice(0, 127);
    stream.on('data', (d: Buffer) => {
      if (!tooLarge) chunks.push(d);
    });
    stream.on('limit', () => {
      tooLarge = true;
    });
    stream.on('error', () => settle({ ok: false, status: 400, message: 'invalid multipart body' }));
  });
  bb.on('filesLimit', () => {
    extraFile = true;
  });
  bb.on('error', () => settle({ ok: false, status: 400, message: 'invalid multipart body' }));
  bb.on('close', () => {
    if (tooLarge) return settle({ ok: false, status: 413, message: 'upload too large' });
    if (extraFile) return settle({ ok: false, status: 400, message: 'expected exactly one file part' });
    if (!sawFile) return settle({ ok: false, status: 400, message: 'no file part' });
    settle({ ok: true, upload: { bytes: Buffer.concat(chunks), filename, declaredMime } });
  });
  bb.end(raw);
}

/**
 * be-04 MEDIA — the GET /_files[, /:id] + DELETE /_files/:id routes. GET-list reads ?start&limit off the
 * query synchronously; the :id routes validate a canonical int id (404 otherwise, like the data routes).
 * No body is read (these verbs carry none), so this is synchronous-capture + async-core, corked.
 */
function handleFilesRoute(res: uWS.HttpResponse, req: uWS.HttpRequest, method: 'GET' | 'DELETE', hasId: boolean, ctx: FileContext): void {
  const idRaw = hasId ? (req.getParameter(0) ?? '') : '';
  const query = req.getQuery() ?? '';
  let aborted = false;
  res.onAborted(() => {
    aborted = true;
  });
  void (async () => {
    let result: CoreResponse;
    try {
      if (!hasId) {
        const params = new URLSearchParams(query);
        const start = toInt(params.get('start')) ?? 0;
        const limit = toInt(params.get('limit')) ?? 25;
        result = await handleListFiles(ctx, start, limit);
      } else {
        // Canonical non-negative int id, else 404 — symmetric with the data routes.
        if (!/^(0|[1-9]\d*)$/.test(idRaw)) result = errorResponse(404, 'not found');
        else if (method === 'GET') result = await handleGetFile(ctx, Number(idRaw));
        else result = await handleDeleteFile(ctx, Number(idRaw));
      }
    } catch {
      result = errorResponse(500, 'internal error');
    }
    if (!aborted) res.cork(() => writeResponse(res, result));
  })();
}

/**
 * be-04 MEDIA — asset endpoints under the `/_files` literal prefix. A leading underscore is illegal
 * in an name (validateFieldName / deriveTableName), so `_files` can NEVER collide with a real
 * `/:type`; uWS also matches a static segment over a `:param`. The UPLOAD (POST) + DELETE are GATED on
 * `media.upload`; the GET reads stay PUBLIC.
 */
export function registerMediaRoutes(rctx: ServerContext): void {
  const { route, fileCtx } = rctx;
  const { gate, gateUpload } = rctx.gates;

  // GATED upload (`media.upload`): read the content-type header SYNC (multipart boundary), buffer the
  // body (up to uploadMaxBytes) while resolving auth in parallel via gateUpload, then on allow parse the
  // buffered multipart through busboy and dispatch the core.
  route.post('/_files/upload', (res, req) => {
    const contentType = req.getHeader('content-type') ?? '';
    gateUpload(res, req, contentType, (raw, aborted) => {
      parseMultipartBuffer(contentType, raw, (parsed) => {
        void (async () => {
          if (!parsed.ok) return corkSend(res, aborted, errorResponse(parsed.status, parsed.message));
          let result: CoreResponse;
          try {
            result = await handleUpload(fileCtx, parsed.upload);
          } catch {
            result = errorResponse(500, 'internal error');
          }
          corkSend(res, aborted, result);
        })();
      });
    });
  });
  route.get('/_files', (res, req) => handleFilesRoute(res, req, 'GET', false, fileCtx));
  route.get('/_files/:id', (res, req) => handleFilesRoute(res, req, 'GET', true, fileCtx));
  // GATED delete (`media.upload`): a delete is a mutation. Capture the id sync, gate (bodyless), dispatch.
  route.del('/_files/:id', (res, req) => {
    const idRaw = req.getParameter(0) ?? '';
    gate(res, req, 'media.upload', false, (_raw, aborted) => {
      void (async () => {
        let result: CoreResponse;
        try {
          if (!/^(0|[1-9]\d*)$/.test(idRaw)) result = errorResponse(404, 'not found');
          else result = await handleDeleteFile(fileCtx, Number(idRaw));
        } catch {
          result = errorResponse(500, 'internal error');
        }
        corkSend(res, aborted, result);
      })();
    });
  });
}
