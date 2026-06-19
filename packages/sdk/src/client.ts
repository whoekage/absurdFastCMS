// @absurd/sdk — Slice 3: HTTP client core.
//
// Isomorphic + zero-dependency: the only runtime dependency is a `fetch` implementation. By default we
// resolve `globalThis.fetch` (Node 24, browsers, Deno, Bun all ship it), but it stays injectable via
// `ClientOptions.fetch` for tests / custom transports. No node-only APIs leak into src/.
//
// This slice carries ONLY the transport: AbsurdClient (ctor + the private request() pipeline) and the
// typed error tower (ApiError + per-status subclasses + the errorFromResponse factory). The read/write/
// builder slices (4/5/6) layer their methods on top of `request()`.

import { buildQueryString, type QueryParams, type FilterObject } from './filters.ts';
import {
  isKeysetPagination,
  type Entry,
  type ListResponse,
  type SingleResponse,
  type WriteBody,
  type ContentTypeDefinition,
  type CreateContentTypeInput,
  type FieldSpec,
  type UpdateFieldInput,
  type DropResult,
  type DeclareRelationInput,
} from './types.ts';
import { decodeEntry, type DecodeOptions } from './serde.ts';

/**
 * Slice 9.1 — the per-request HEADER PROVIDER: the formal auth/token seam.
 *
 * Called ON EVERY request (and on every retry attempt — see {@link AbsurdClient.request}), `await`ed,
 * and its result merged into the outgoing headers AFTER the built-in ones. This is the "Bearer-token
 * slot": a future implementation returns `{ authorization: 'Bearer <fresh-token>' }` here so a short-
 * lived / rotating token is minted afresh per call (token refresh) rather than frozen at construction.
 * For the common static-token case, prefer {@link ClientOptions.token} (which is sugar that populates
 * exactly this header); reach for `getHeaders` only when the header is dynamic / async.
 *
 * Forward-compat note: the @absurd/api server has NO auth yet (README roadmap: "AuthN/authZ — gate the
 * Builder (and writes) behind an admin scope"). Until that lands, whatever this returns is simply sent
 * and ignored by the open server — this seam is a no-op against today's API.
 */
export type HeaderProvider = () => Record<string, string> | Promise<Record<string, string>>;

/**
 * Slice 9.2 — the UNAUTHORIZED hook. Invoked (and `await`ed) when a response comes back `401`, just
 * before the {@link UnauthorizedError} is thrown. It is a no-op SEAM for a future token-refresh /
 * login-redirect: an implementation can clear a cached token, kick off a refresh, or redirect to a login
 * flow. The error is STILL thrown after the hook resolves (this slice does not retry-after-refresh — that
 * wires up when the api gains an auth scope; see the README roadmap item). Receives the request
 * coordinates plus the parsed error body. May be async.
 */
export type UnauthorizedHook = (ctx: {
  status: 401;
  method: string;
  url: string;
  body: unknown;
}) => void | Promise<void>;

/**
 * Slice 8.4 — the OUTGOING-REQUEST hook. Called once per attempt just before `fetch`, with the final
 * method / URL / merged headers / serialized body (the same `init` handed to `fetch`). May mutate
 * `headers` in place (e.g. add a correlation id / refresh a token) and may be async. It is invoked on
 * EVERY retry attempt, so it sees each try. The token-refresh seam lives here AND in {@link getHeaders};
 * use whichever is ergonomic.
 */
export type RequestHook = (req: {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
  attempt: number;
}) => void | Promise<void>;

/**
 * Slice 8.4 — the INCOMING-RESPONSE hook. Called once per attempt after `fetch` resolves, with the raw
 * {@link Response} plus the request coordinates. Observe-only (the body has not been consumed yet — do
 * NOT read `res.body`/`res.text()` here, the pipeline still needs it). May be async. Useful for logging,
 * metrics, or reacting to status codes (a 401 handler lands in Slice 9).
 */
export type ResponseHook = (res: {
  response: Response;
  method: string;
  url: string;
  attempt: number;
}) => void | Promise<void>;

/**
 * Slice 8.3 — retry policy for IDEMPOTENT GET requests ONLY. Writes (POST/PUT/DELETE) are NEVER retried
 * — re-sending a non-idempotent write risks duplicate effects. A GET is retried on a transport error
 * (network failure / timeout-abort) or a retryable status (`retryStatuses`, default 502/503/504), up to
 * `retries` extra attempts, sleeping `backoff(attempt)` ms between tries.
 */
export interface RetryOptions {
  /** Max EXTRA attempts after the first (so total tries = retries + 1). Default 0 (no retries). */
  retries?: number;
  /** ms to wait before attempt `n` (1-based: the delay BEFORE the first retry is `backoff(1)`). Default: exponential `2^(n-1)*100`. */
  backoff?: (attempt: number) => number;
  /** HTTP statuses that trigger a retry (transport errors always do). Default `[502, 503, 504]`. */
  retryStatuses?: number[];
}

/** Construction options for {@link AbsurdClient} / {@link createClient}. */
export interface ClientOptions {
  /** Base URL of the @absurd/api server, e.g. `http://127.0.0.1:3000`. A trailing `/` is stripped. */
  baseUrl: string;
  /**
   * The `fetch` implementation to use. Defaults to `globalThis.fetch`. Injecting it keeps the client
   * isomorphic and lets tests point at a real server's `fetch` without globals. Omit (or pass
   * `undefined`) to use the global.
   */
  fetch?: typeof fetch | undefined;
  /**
   * Slice 9.1 — a STATIC bearer token. Convenience over {@link getHeaders}: when set, the client sends
   * `Authorization: Bearer <token>` on every request. Mutable at runtime via
   * {@link AbsurdClient.setToken} (e.g. after a login). For a DYNAMIC / rotating token, use
   * {@link getHeaders} instead (called fresh per request). If BOTH are given, `getHeaders` wins on the
   * `authorization` key (it is merged last). Forward-compat: a no-op against today's open api.
   */
  token?: string | undefined;
  /**
   * Slice 9.1 — optional per-request header provider (the formal auth/token seam — see
   * {@link HeaderProvider}). Its headers are merged AFTER the built-in ones AND after the {@link token}
   * header (so it can override `content-type` / `authorization` if it really wants to). May be async.
   */
  getHeaders?: HeaderProvider | undefined;
  /**
   * Slice 9.2 — called when the api answers `401`, before {@link UnauthorizedError} is thrown. The no-op
   * seam for future token-refresh / login-redirect (see {@link UnauthorizedHook}). May be async.
   */
  onUnauthorized?: UnauthorizedHook | undefined;
  /**
   * Slice 8.4 — called before every `fetch` attempt with the final request init (mutate headers in
   * place to inject correlation ids / refresh tokens). May be async; runs on each retry attempt.
   */
  onRequest?: RequestHook | undefined;
  /**
   * Slice 8.4 — called after every `fetch` resolves, before the body is read. Observe-only (do not read
   * the body). May be async; runs on each retry attempt.
   */
  onResponse?: ResponseHook | undefined;
  /**
   * Slice 8.3 — default per-request timeout in ms (aborts the in-flight `fetch`). A per-call
   * `RequestOptions.timeout` overrides it. Omit / `0` = no timeout.
   */
  timeout?: number | undefined;
  /**
   * Slice 8.3 — default retry policy for IDEMPOTENT GET requests only. Per-call
   * `RequestOptions.retry` overrides it. Omit = no retries.
   */
  retry?: RetryOptions | undefined;
}

/** The options object for a single {@link AbsurdClient.request} call (internal to the method slices). */
export interface RequestOptions {
  /** The already-built query string WITHOUT a leading `?` (Slice 2 `buildQueryString` output). Empty = omit. */
  query?: string | undefined;
  /** The JSON request body. Serialized with `JSON.stringify`; `content-type: application/json` is set. */
  body?: unknown;
  /** An `AbortSignal` to cancel the in-flight request, threaded straight into `fetch` (combined with any timeout). */
  signal?: AbortSignal | undefined;
  /** Per-call timeout in ms — overrides {@link ClientOptions.timeout}. Omit / `0` = no timeout. */
  timeout?: number | undefined;
  /** Per-call retry policy (idempotent GET only) — overrides {@link ClientOptions.retry}. */
  retry?: RetryOptions | undefined;
}

/**
 * Base error for any non-2xx HTTP response from the api. Carries the HTTP `status`, the human `message`
 * (the `{ error }` field from the api's JSON error body, falling back to the status text), and the raw
 * parsed `body` (whatever JSON came back, or the raw text if it wasn't JSON, or `undefined` if empty).
 */
export class ApiError extends Error {
  /** The HTTP status code (e.g. 404). */
  readonly status: number;
  /** The raw response body: parsed JSON when possible, the raw string otherwise, `undefined` if empty. */
  readonly body: unknown;

  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = new.target.name;
    this.status = status;
    this.body = body;
  }
}

/** 400 — malformed request (bad query / body / identifier). Maps to the api's QueryParseError etc. */
export class BadRequestError extends ApiError {}
/**
 * 401 — UNAUTHENTICATED (missing / invalid / expired credentials). Slice 9 forward-compat: the api has
 * no auth yet, so this never fires against today's open server; it lands when the api gains an auth scope
 * (README roadmap: "gate the Builder (and writes) behind an admin scope"). See {@link UnauthorizedHook}.
 */
export class UnauthorizedError extends ApiError {}
/**
 * 403 — FORBIDDEN (authenticated but lacking the required scope/permission, e.g. a non-admin hitting the
 * Builder once it is gated). Slice 9 forward-compat — see {@link UnauthorizedError}.
 */
export class ForbiddenError extends ApiError {}
/** 404 — unknown content-type or no row for the given id. */
export class NotFoundError extends ApiError {}
/** 405 — wrong HTTP method on a known route. */
export class MethodNotAllowedError extends ApiError {}
/** 409 — conflict (e.g. content-type already exists, on the builder routes). */
export class ConflictError extends ApiError {}
/** 413 — request body exceeded the server's size limit. */
export class PayloadTooLargeError extends ApiError {}
/** 5xx — a server-side failure (a bug or transient fault, not a client error). */
export class ServerError extends ApiError {}

/**
 * Build the most specific {@link ApiError} subclass for an HTTP status. Exact codes (400/404/405/409/413)
 * map to their named subclass; any 5xx becomes {@link ServerError}; everything else falls back to the
 * base {@link ApiError}.
 */
export function errorFromResponse(status: number, message: string, body: unknown): ApiError {
  switch (status) {
    case 400:
      return new BadRequestError(status, message, body);
    case 401:
      return new UnauthorizedError(status, message, body);
    case 403:
      return new ForbiddenError(status, message, body);
    case 404:
      return new NotFoundError(status, message, body);
    case 405:
      return new MethodNotAllowedError(status, message, body);
    case 409:
      return new ConflictError(status, message, body);
    case 413:
      return new PayloadTooLargeError(status, message, body);
    default:
      if (status >= 500 && status <= 599) return new ServerError(status, message, body);
      return new ApiError(status, message, body);
  }
}

/** Extract the human message from a parsed api error body (`{ error: string }`), if present. */
function messageFromBody(body: unknown): string | undefined {
  if (body && typeof body === 'object' && 'error' in body) {
    const { error } = body as { error: unknown };
    if (typeof error === 'string') return error;
  }
  return undefined;
}

/** Slice 8.3 — a promise that resolves after `ms` milliseconds (the inter-retry backoff sleep). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The bound transport seam the {@link ContentTypesApi} namespace calls. `AbsurdClient` passes its own
 * `request<T>` here so the namespace reuses the exact same URL build / header merge / typed-error tower
 * without re-implementing the pipeline or widening `request`'s visibility past the package.
 */
type RequestFn = <T>(method: string, path: string, opts?: RequestOptions) => Promise<T>;

/**
 * Slice 6 — the CONTENT-TYPE BUILDER namespace (`client.contentTypes`). Covers the meta / runtime-DDL
 * routes: `GET/POST /content-types`, `GET/DELETE /content-types/:apiId`, `POST .../fields`, and
 * `PUT/DELETE .../fields/:name`. Every 2xx body is a {@link ContentTypeDefinition} (the `projectDef`
 * shape) except a type drop, which returns {@link DropResult}. Path segments (`:apiId`, `:name`) are
 * URL-encoded. Errors surface as the Slice 3 typed subclasses: {@link ConflictError} (409 exists /
 * conflict), {@link NotFoundError} (404), {@link BadRequestError} (400 invalid identifier / unknown
 * cmsType / enum / option / forbidden type-change).
 *
 * ⚠️ The builder routes are only mounted by the server when it is started WITH a store + registry
 * (runtime DDL). Against a read-only server these calls answer 404/405.
 */
export class ContentTypesApi {
  /** The owning client's bound {@link AbsurdClient.request} pipeline. */
  private readonly request: RequestFn;

  constructor(request: RequestFn) {
    this.request = request;
  }

  /**
   * 6.1 — LIST. `GET /content-types` → every content-type's projected definition (system fields first,
   * then user fields in `sort` order).
   */
  list(signal?: AbortSignal): Promise<ContentTypeDefinition[]> {
    const opts: RequestOptions = {};
    if (signal) opts.signal = signal;
    return this.request<ContentTypeDefinition[]>('GET', '/content-types', opts);
  }

  /**
   * 6.1 — GET one. `GET /content-types/:apiId` → its projected definition. Throws {@link NotFoundError}
   * (404) when no content-type carries the api_id.
   */
  get(apiId: string, signal?: AbortSignal): Promise<ContentTypeDefinition> {
    const opts: RequestOptions = {};
    if (signal) opts.signal = signal;
    return this.request<ContentTypeDefinition>('GET', `/content-types/${encodeURIComponent(apiId)}`, opts);
  }

  /**
   * 6.2 — CREATE. `POST /content-types` with `{ apiId, fields }` → the new type's projected definition
   * (HTTP 201, canonical stored casing on `apiId`). Throws {@link ConflictError} (409) when the api_id
   * already exists and {@link BadRequestError} (400) on an invalid identifier / unknown cmsType / bad
   * enum or option.
   */
  create(input: CreateContentTypeInput, signal?: AbortSignal): Promise<ContentTypeDefinition> {
    const opts: RequestOptions = { body: input };
    if (signal) opts.signal = signal;
    return this.request<ContentTypeDefinition>('POST', '/content-types', opts);
  }

  /**
   * 6.3 — DROP a type. `DELETE /content-types/:apiId` (DROP TABLE + catalog row + RAM removal) →
   * `{ apiId, dropped: true }`. Throws {@link NotFoundError} (404) when the api_id is unknown.
   */
  drop(apiId: string, signal?: AbortSignal): Promise<DropResult> {
    const opts: RequestOptions = {};
    if (signal) opts.signal = signal;
    return this.request<DropResult>('DELETE', `/content-types/${encodeURIComponent(apiId)}`, opts);
  }

  /**
   * 6.4 — ADD a field. `POST /content-types/:apiId/fields` with a {@link FieldSpec} → the updated
   * projected definition (HTTP 201). Throws {@link ConflictError} (409) when the field name already
   * exists, {@link NotFoundError} (404) when the type is unknown, {@link BadRequestError} (400) on an
   * invalid name / unknown cmsType / bad enum or option.
   */
  addField(apiId: string, field: FieldSpec, signal?: AbortSignal): Promise<ContentTypeDefinition> {
    const opts: RequestOptions = { body: field };
    if (signal) opts.signal = signal;
    return this.request<ContentTypeDefinition>(
      'POST',
      `/content-types/${encodeURIComponent(apiId)}/fields`,
      opts,
    );
  }

  /**
   * 6.4 — UPDATE a field. `PUT /content-types/:apiId/fields/:name` with a {@link UpdateFieldInput}
   * (`newName` and/or `cmsType` + `options`) → the updated projected definition (HTTP 200). The server
   * renames FIRST then changes type on the new name. Throws {@link BadRequestError} (400) on an empty
   * change / invalid newName / forbidden type-change, {@link ConflictError} (409) on a name clash,
   * {@link NotFoundError} (404) when the type or field is unknown.
   */
  updateField(
    apiId: string,
    name: string,
    change: UpdateFieldInput,
    signal?: AbortSignal,
  ): Promise<ContentTypeDefinition> {
    const opts: RequestOptions = { body: change };
    if (signal) opts.signal = signal;
    return this.request<ContentTypeDefinition>(
      'PUT',
      `/content-types/${encodeURIComponent(apiId)}/fields/${encodeURIComponent(name)}`,
      opts,
    );
  }

  /**
   * 6.4 — DROP a field. `DELETE /content-types/:apiId/fields/:name` → the updated projected definition
   * (HTTP 200). Throws {@link NotFoundError} (404) when the type or field is unknown.
   */
  dropField(apiId: string, name: string, signal?: AbortSignal): Promise<ContentTypeDefinition> {
    const opts: RequestOptions = {};
    if (signal) opts.signal = signal;
    return this.request<ContentTypeDefinition>(
      'DELETE',
      `/content-types/${encodeURIComponent(apiId)}/fields/${encodeURIComponent(name)}`,
      opts,
    );
  }

  /**
   * DECLARE a relation. `POST /content-types/:apiId/relations` with a {@link DeclareRelationInput}
   * (`field`, `kind`, `target`, optional `inverseField`) → the owner's updated projected definition
   * (HTTP 201), now carrying the new entry in `relations`. The relation goes LIVE immediately for both
   * deep filtering (`?filters[field][...]`) and `?populate=field`. Throws {@link NotFoundError} (404)
   * when the owner or target type is unknown, {@link ConflictError} (409) on a field/relation name clash,
   * {@link BadRequestError} (400) on an invalid identifier / reserved name / unknown kind.
   */
  addRelation(apiId: string, input: DeclareRelationInput, signal?: AbortSignal): Promise<ContentTypeDefinition> {
    const opts: RequestOptions = { body: input };
    if (signal) opts.signal = signal;
    return this.request<ContentTypeDefinition>(
      'POST',
      `/content-types/${encodeURIComponent(apiId)}/relations`,
      opts,
    );
  }
}

/**
 * The transport client. Holds the normalized base URL, the resolved `fetch`, and the optional header
 * provider; everything else (read/write/builder methods) is built on the private {@link request} pipeline
 * by later slices. Construct via {@link createClient} or `new AbsurdClient(options)`.
 */
export class AbsurdClient {
  /** Normalized base URL (no trailing slash). */
  protected readonly baseUrl: string;
  /** The resolved fetch implementation (injected or `globalThis.fetch`). */
  protected readonly fetchImpl: typeof fetch;
  /** Slice 9.1 — the static bearer token (mutable via {@link setToken}); `undefined` = send no `Authorization`. */
  protected token: string | undefined;
  /** Optional per-request header provider (auth seam). */
  protected readonly getHeaders: HeaderProvider | undefined;
  /** Slice 9.2 — optional 401 hook (token-refresh / redirect seam). */
  protected readonly onUnauthorized: UnauthorizedHook | undefined;
  /** Slice 8.4 — optional pre-fetch hook. */
  protected readonly onRequest: RequestHook | undefined;
  /** Slice 8.4 — optional post-fetch hook. */
  protected readonly onResponse: ResponseHook | undefined;
  /** Slice 8.3 — default per-request timeout (ms). */
  protected readonly timeout: number | undefined;
  /** Slice 8.3 — default retry policy (idempotent GET only). */
  protected readonly retry: RetryOptions | undefined;

  /**
   * Slice 6 — the content-type builder namespace. Reuses this client's {@link request} pipeline (same
   * URL build / header merge / typed-error tower) for the meta / runtime-DDL routes.
   */
  readonly contentTypes: ContentTypesApi;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');

    const resolved = options.fetch ?? globalThis.fetch;
    if (typeof resolved !== 'function') {
      throw new Error(
        'AbsurdClient: no `fetch` available. Provide options.fetch or run on a platform with global fetch (Node >=18).',
      );
    }
    // Bind so a global `fetch` keeps its `Illegal invocation`-free `this` (the WHATWG fetch wants the
    // realm's global as receiver); a custom fn is unaffected by binding to undefined here.
    this.fetchImpl = resolved === globalThis.fetch ? resolved.bind(globalThis) : resolved;

    this.token = options.token;
    this.getHeaders = options.getHeaders;
    this.onUnauthorized = options.onUnauthorized;
    this.onRequest = options.onRequest;
    this.onResponse = options.onResponse;
    this.timeout = options.timeout;
    this.retry = options.retry;

    // Bind request so the namespace keeps the right `this` while calling the protected pipeline.
    this.contentTypes = new ContentTypesApi(this.request.bind(this));
  }

  /**
   * Slice 9.1 — set (or clear) the static bearer token AFTER construction — e.g. once a login completes,
   * or to drop credentials on logout. Subsequent requests send `Authorization: Bearer <token>` (or omit
   * the header when passed `undefined`). For a token that changes EVERY request, prefer
   * {@link ClientOptions.getHeaders} (minted fresh per call) over polling this.
   */
  setToken(token: string | undefined): void {
    this.token = token;
  }

  /**
   * The single request pipeline. Builds the URL (`baseUrl + path`, with `?query` only when non-empty),
   * merges headers (`content-type: application/json` when a body is present, then the async
   * {@link getHeaders} on top), JSON-stringifies the body, threads the `AbortSignal`, then reads the
   * response as text and `JSON.parse`s it. On a non-2xx status it throws the typed {@link ApiError}
   * built from the status + the `{ error }` message; on success it returns the parsed JSON as `T`.
   */
  protected async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    let url = this.baseUrl + path;
    if (opts.query !== undefined && opts.query !== '') url += `?${opts.query}`;

    const hasBody = opts.body !== undefined;
    const bodyStr = hasBody ? JSON.stringify(opts.body) : undefined;

    // Slice 8.3 — retries are SAFE for idempotent GET only; writes are never re-sent.
    const policy = opts.retry ?? this.retry;
    const idempotent = method === 'GET';
    const maxRetries = idempotent && policy?.retries !== undefined && policy.retries > 0 ? policy.retries : 0;
    const retryStatuses = new Set(policy?.retryStatuses ?? [502, 503, 504]);
    const backoff = policy?.backoff ?? ((attempt: number) => 2 ** (attempt - 1) * 100);

    const timeoutMs = opts.timeout ?? this.timeout;

    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      // Per-attempt headers: rebuilt each try so getHeaders/onRequest can mint a fresh token per retry.
      const headers: Record<string, string> = {};
      if (hasBody) headers['content-type'] = 'application/json';
      // Slice 9.1 — the static-token slot: `Authorization: Bearer <token>`. getHeaders (below) merges
      // last so a dynamic provider can still override `authorization` for the rotating-token case.
      if (this.token !== undefined) headers['authorization'] = `Bearer ${this.token}`;
      if (this.getHeaders) {
        const extra = await this.getHeaders();
        for (const key in extra) headers[key] = extra[key]!;
      }
      if (this.onRequest) await this.onRequest({ method, url, headers, body: bodyStr, attempt });

      // Slice 8.3 — fold the caller's signal together with a per-attempt timeout signal (fresh each try).
      const { signal, dispose } = this.buildSignal(opts.signal, timeoutMs);
      const init: RequestInit = { method, headers };
      if (bodyStr !== undefined) init.body = bodyStr; // narrows to string (exactOptionalPropertyTypes)
      if (signal) init.signal = signal;

      let res: Response;
      try {
        res = await this.fetchImpl(url, init);
      } catch (err) {
        dispose();
        // A transport error (network failure / timeout-abort). If the CALLER aborted, surface at once.
        if (opts.signal?.aborted) throw err;
        lastErr = err;
        if (idempotent && attempt <= maxRetries) {
          await sleep(backoff(attempt));
          continue;
        }
        throw err;
      }
      dispose();

      if (this.onResponse) await this.onResponse({ response: res, method, url, attempt });

      // A retryable status on an idempotent GET → back off and try again (still consume the body first).
      if (!res.ok && idempotent && attempt <= maxRetries && retryStatuses.has(res.status)) {
        await res.text().catch(() => {});
        await sleep(backoff(attempt));
        continue;
      }

      const raw = await res.text();
      let parsed: unknown = undefined;
      if (raw !== '') {
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = raw; // Not JSON — keep the raw text as the body (e.g. an unexpected plain-text error).
        }
      }

      if (!res.ok) {
        const message = messageFromBody(parsed) ?? res.statusText ?? `HTTP ${res.status}`;
        // Slice 9.2 — fire the no-op auth seam on a 401 (token-refresh / login-redirect hook), then
        // still throw the typed UnauthorizedError. (No retry-after-refresh yet — that lands when the api
        // gains an auth scope; see README roadmap "gate the Builder (and writes) behind an admin scope".)
        if (res.status === 401 && this.onUnauthorized) {
          await this.onUnauthorized({ status: 401, method, url, body: parsed });
        }
        throw errorFromResponse(res.status, message, parsed);
      }

      return parsed as T;
    }
    // Exhausted all idempotent retries on transport errors.
    throw lastErr;
  }

  /**
   * Slice 8.3 — combine an optional caller {@link AbortSignal} with an optional per-attempt timeout into
   * one signal. Returns the signal to thread into `fetch` plus a `dispose` to clear the timer. Built
   * fresh per attempt (a timed-out attempt must not poison the next retry).
   */
  private buildSignal(
    caller: AbortSignal | undefined,
    timeoutMs: number | undefined,
  ): { signal: AbortSignal | undefined; dispose: () => void } {
    if (!timeoutMs || timeoutMs <= 0) return { signal: caller, dispose: () => {} };
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    if (!caller) return { signal: timeoutSignal, dispose: () => {} };
    // Both present: AbortSignal.any fires when EITHER aborts (Node 20.3+ / modern browsers).
    return { signal: AbortSignal.any([caller, timeoutSignal]), dispose: () => {} };
  }

  // === Slice 4 — read methods ===================================================================

  /**
   * 4.1 — LIST. `GET /:type` with the full {@link QueryParams} serialized by {@link buildQueryString}
   * (filters / sort / pagination / fields / populate). Returns the raw {@link ListResponse} envelope
   * (`{ data, meta: { pagination } }`); inspect `meta.pagination` with {@link isKeysetPagination} to
   * tell offset from keyset. The optional `signal` cancels the in-flight request.
   */
  async list<T extends Entry = Entry>(
    type: string,
    params: QueryParams = {},
    signal?: AbortSignal,
  ): Promise<ListResponse<T>> {
    const opts: RequestOptions = { query: buildQueryString(params) };
    if (signal) opts.signal = signal;
    return this.request<ListResponse<T>>('GET', `/${encodeURIComponent(type)}`, opts);
  }

  /**
   * 4.2 — SINGLE. `GET /:type/:id` resolving `id` as the PUBLIC primary key. `opts.populate` threads a
   * populate spec into the query (the only read param the single route honors). Throws
   * {@link NotFoundError} (404) when no row carries the id. Use {@link findOneOrNull} for a null-on-404
   * variant.
   */
  async findOne<T extends Entry = Entry>(
    type: string,
    id: number | string,
    opts: { populate?: QueryParams['populate']; status?: QueryParams['status']; locale?: QueryParams['locale'] } = {},
    signal?: AbortSignal,
  ): Promise<SingleResponse<T>> {
    const params: QueryParams = {};
    if (opts.populate !== undefined) params.populate = opts.populate;
    if (opts.status !== undefined) params.status = opts.status;
    if (opts.locale !== undefined) params.locale = opts.locale;
    const reqOpts: RequestOptions = { query: buildQueryString(params) };
    if (signal) reqOpts.signal = signal;
    return this.request<SingleResponse<T>>(
      'GET',
      `/${encodeURIComponent(type)}/${encodeURIComponent(String(id))}`,
      reqOpts,
    );
  }

  /**
   * 4.2 — SINGLE, soft. As {@link findOne} but returns `null` instead of throwing on a
   * {@link NotFoundError} (404). Any other error (400/405/5xx) still propagates.
   */
  async findOneOrNull<T extends Entry = Entry>(
    type: string,
    id: number | string,
    opts: { populate?: QueryParams['populate']; status?: QueryParams['status']; locale?: QueryParams['locale'] } = {},
    signal?: AbortSignal,
  ): Promise<SingleResponse<T> | null> {
    try {
      return await this.findOne<T>(type, id, opts, signal);
    } catch (e) {
      if (e instanceof NotFoundError) return null;
      throw e;
    }
  }

  /**
   * 4.3 — COUNT. The total number of rows matching `filters`, derived from the pagination meta WITHOUT
   * fetching rows. We request a minimal page (`pagination: { start: 0, limit: 0 }`) so the offset meta
   * carries `total` for free (the engine's match-set popcount). If the server ever answers with keyset
   * meta we fall back to its `withCount` total. The optional `signal` cancels the request.
   */
  async count(type: string, filters?: FilterObject, signal?: AbortSignal): Promise<number> {
    const params: QueryParams = { pagination: { start: 0, limit: 0 } };
    if (filters !== undefined) params.filters = filters;
    const res = await this.list(type, params, signal);
    const meta = res.meta.pagination;
    if (isKeysetPagination(meta)) {
      // A keyset answer only carries total when withCount was set; re-ask explicitly if it's missing.
      if (meta.total !== undefined) return meta.total;
      const withCount = await this.list(type, {
        ...(filters !== undefined ? { filters } : {}),
        pagination: { pageSize: 1, withCount: true },
      }, signal);
      const km = withCount.meta.pagination;
      return isKeysetPagination(km) ? (km.total ?? 0) : km.total;
    }
    return meta.total;
  }

  /**
   * 4.4 — OFFSET iterator. Yields entries page-by-page in OFFSET mode: starts at the caller's
   * `pagination.start` (default 0) with `pagination.limit` as the page size (default 25), advancing
   * `start` by the page size until a SHORT page (fewer rows than the limit) or an empty page ends the
   * stream. Filters / sort / fields / populate from `params` are preserved on every page. Any
   * `pagination` the caller passes seeds the first page; offset mode is enforced thereafter.
   *
   * Yields one ENTRY at a time (not pages) so callers can `for await (const row of client.listAll(...))`.
   */
  async *listAll<T extends Entry = Entry>(
    type: string,
    params: QueryParams = {},
    signal?: AbortSignal,
  ): AsyncGenerator<T, void, void> {
    const seed = (params.pagination ?? {}) as { start?: number; limit?: number };
    const limit = seed.limit !== undefined && seed.limit > 0 ? seed.limit : 25;
    let start = seed.start ?? 0;
    const rest: QueryParams = { ...params };
    delete rest.pagination;

    for (;;) {
      const page = await this.list<T>(type, { ...rest, pagination: { start, limit } }, signal);
      const rows = page.data;
      for (const row of rows) yield row;
      // A short (or empty) page is the last page — stop before issuing a wasted empty request.
      if (rows.length < limit) return;
      start += limit;
    }
  }

  /**
   * 4.5 — KEYSET iterator. Yields entries page-by-page in KEYSET mode by following
   * `meta.pagination.nextCursor` until `hasNextPage === false`. The cursor is an OPAQUE token — minted
   * by the server, threaded straight back as `pagination.cursor` with no inspection. `pagination.pageSize`
   * (default 25) sizes each page; filters / sort / fields / populate from `params` are preserved. The
   * first page bootstraps with an empty cursor (the parser's first-page sentinel).
   *
   * Yields one ENTRY at a time so callers can `for await (const row of client.listAllKeyset(...))`.
   */
  async *listAllKeyset<T extends Entry = Entry>(
    type: string,
    params: QueryParams = {},
    signal?: AbortSignal,
  ): AsyncGenerator<T, void, void> {
    const seed = (params.pagination ?? {}) as { pageSize?: number };
    const pageSize = seed.pageSize !== undefined && seed.pageSize > 0 ? seed.pageSize : 25;
    const rest: QueryParams = { ...params };
    delete rest.pagination;

    let cursor = '';
    for (;;) {
      const page = await this.list<T>(type, { ...rest, pagination: { cursor, pageSize } }, signal);
      for (const row of page.data) yield row;
      const meta = page.meta.pagination;
      // The keyset routes always answer with keyset meta; guard anyway so a misuse can't loop forever.
      if (!isKeysetPagination(meta) || !meta.hasNextPage || meta.nextCursor === null) return;
      cursor = meta.nextCursor;
    }
  }

  // === Slice 7 — wire-fidelity convenience (decode on read when a def is supplied) ==============

  /**
   * 7 — LIST + DECODE. As {@link list}, but runs every row through {@link decodeEntry} against the
   * supplied {@link ContentTypeDefinition} so the returned `data` carries typed values (biginteger /
   * decimal stay lossless strings by default; opt into `bigint` / `Date` via {@link DecodeOptions}).
   * The pagination meta is passed through unchanged. Convenience only — `list` + `decodeEntry` compose
   * to the same result; this wires them in one call.
   */
  async listDecoded<T extends Entry = Entry>(
    type: string,
    def: ContentTypeDefinition,
    params: QueryParams = {},
    opts: DecodeOptions = {},
    signal?: AbortSignal,
  ): Promise<ListResponse<T>> {
    const res = await this.list<Entry>(type, params, signal);
    return { data: res.data.map((row) => decodeEntry<T>(def, row, opts)), meta: res.meta };
  }

  /**
   * 7 — SINGLE + DECODE. As {@link findOne}, but decodes the row through {@link decodeEntry} against
   * `def` (see {@link listDecoded}). Throws {@link NotFoundError} (404) like {@link findOne}.
   */
  async findOneDecoded<T extends Entry = Entry>(
    type: string,
    id: number | string,
    def: ContentTypeDefinition,
    opts: { populate?: QueryParams['populate'] } & DecodeOptions = {},
    signal?: AbortSignal,
  ): Promise<SingleResponse<T>> {
    const { populate, bigints, dates } = opts;
    const findOpts: { populate?: QueryParams['populate'] } = {};
    if (populate !== undefined) findOpts.populate = populate;
    const decodeOpts: DecodeOptions = {};
    if (bigints !== undefined) decodeOpts.bigints = bigints;
    if (dates !== undefined) decodeOpts.dates = dates;
    const res = await this.findOne<Entry>(type, id, findOpts, signal);
    return { data: decodeEntry<T>(def, res.data, decodeOpts), meta: res.meta };
  }

  // === Slice 5 — write methods ==================================================================

  /**
   * 5.1 — CREATE. `POST /:type` with `data` as the flat JSON body (scalar fields + relation ops as
   * sibling keys — see {@link WriteBody}; NOT a `{ data }` envelope). Every NOT-NULL-without-default
   * field is required. Returns the created row as a {@link SingleResponse} (HTTP 201). Throws
   * {@link BadRequestError} (400) on a bad body or a relation FK that does not exist (the whole tx
   * rolls back — no partial write) and {@link PayloadTooLargeError} (413) on an oversized body.
   */
  async create<T extends Entry = Entry>(
    type: string,
    data: WriteBody<T>,
    signal?: AbortSignal,
  ): Promise<SingleResponse<T>> {
    const opts: RequestOptions = { body: data };
    if (signal) opts.signal = signal;
    return this.request<SingleResponse<T>>('POST', `/${encodeURIComponent(type)}`, opts);
  }

  /**
   * 5.2 — UPDATE (partial, Strapi semantics). `PUT /:type/:id` resolving `id` as the PUBLIC primary
   * key. ONLY the keys present in `data` are touched — every other column keeps its stored value. The
   * body must carry at least one writable scalar OR one relation op (an empty body is a 400). Returns
   * the updated row (HTTP 200). Throws {@link NotFoundError} (404) when no row carries the id,
   * {@link BadRequestError} (400) on a bad body / nonexistent relation FK, {@link PayloadTooLargeError}
   * (413) on an oversized body.
   */
  async update<T extends Entry = Entry>(
    type: string,
    id: number | string,
    data: WriteBody<T>,
    signal?: AbortSignal,
  ): Promise<SingleResponse<T>> {
    const opts: RequestOptions = { body: data };
    if (signal) opts.signal = signal;
    return this.request<SingleResponse<T>>(
      'PUT',
      `/${encodeURIComponent(type)}/${encodeURIComponent(String(id))}`,
      opts,
    );
  }

  /**
   * 5.3 — DELETE. `DELETE /:type/:id` resolving `id` as the PUBLIC primary key. No request body.
   * Returns the DELETED row as a {@link SingleResponse} (HTTP 200). Throws {@link NotFoundError} (404)
   * when no row carries the id.
   */
  async delete<T extends Entry = Entry>(
    type: string,
    id: number | string,
    signal?: AbortSignal,
  ): Promise<SingleResponse<T>> {
    const opts: RequestOptions = {};
    if (signal) opts.signal = signal;
    return this.request<SingleResponse<T>>(
      'DELETE',
      `/${encodeURIComponent(type)}/${encodeURIComponent(String(id))}`,
      opts,
    );
  }

  // === Draft & Publish lifecycle ================================================================

  /**
   * Draft & Publish — PUBLISH. `POST /:type/:id/actions/publish` sets the entry's `published_at` so it
   * becomes visible to the default (published-only) read. No request body. Returns the updated row as a
   * {@link SingleResponse} (HTTP 200). Throws {@link NotFoundError} (404) when no row carries the id, or
   * {@link BadRequestError} (400) when the type does not have Draft & Publish enabled.
   */
  async publish<T extends Entry = Entry>(type: string, id: number | string, signal?: AbortSignal): Promise<SingleResponse<T>> {
    const opts: RequestOptions = {};
    if (signal) opts.signal = signal;
    return this.request<SingleResponse<T>>('POST', `/${encodeURIComponent(type)}/${encodeURIComponent(String(id))}/actions/publish`, opts);
  }

  /**
   * Draft & Publish — UNPUBLISH. `POST /:type/:id/actions/unpublish` clears `published_at` (back to
   * draft), hiding the entry from the default read. No request body. Same return/throw contract as
   * {@link publish}.
   */
  async unpublish<T extends Entry = Entry>(type: string, id: number | string, signal?: AbortSignal): Promise<SingleResponse<T>> {
    const opts: RequestOptions = {};
    if (signal) opts.signal = signal;
    return this.request<SingleResponse<T>>('POST', `/${encodeURIComponent(type)}/${encodeURIComponent(String(id))}/actions/unpublish`, opts);
  }

  // === i18n — locale variant create =============================================================

  /**
   * i18n — CREATE A LOCALE VARIANT. `POST /:type/:id/locales/:locale` creates a NEW row that joins the
   * SAME document as the existing entry `id` (reusing its `document_id`), under a new `locale`. SHARED
   * (`localized:false`) fields are COPIED from the addressed sibling; the request `data` supplies the
   * LOCALIZED fields (a shared key in `data` is a 400 — shared values stay in sync via the write path).
   * `locale` is server-set, NOT a body key. Returns the created variant (HTTP 201).
   *
   * Throws {@link BadRequestError} (400) when the type does not have i18n enabled, the locale slug is
   * malformed, a `(document_id, locale)` already exists (duplicate locale), or a required localized field
   * is missing; {@link NotFoundError} (404) when no row carries `id`.
   */
  async createVariant<T extends Entry = Entry>(
    type: string,
    id: number | string,
    locale: string,
    data: WriteBody<T> = {} as WriteBody<T>,
    signal?: AbortSignal,
  ): Promise<SingleResponse<T>> {
    const opts: RequestOptions = { body: data };
    if (signal) opts.signal = signal;
    return this.request<SingleResponse<T>>(
      'POST',
      `/${encodeURIComponent(type)}/${encodeURIComponent(String(id))}/locales/${encodeURIComponent(locale)}`,
      opts,
    );
  }

  // === Slice 8.2 — bound collection =============================================================

  /**
   * 8.2 — bind a content-type to a typed, pre-bound API surface. `client.collection<Article>('article')`
   * returns a {@link Collection} whose `list`/`findOne`/`create`/`update`/`delete`/`count`/iterators all
   * carry the `type` and the row type `T` so callers stop repeating the api_id and stop re-annotating
   * `<T>` on every call. Pure sugar over the same `request` pipeline (retries / timeout / hooks apply).
   */
  collection<T extends Entry = Entry>(type: string): Collection<T> {
    return new Collection<T>(this, type);
  }
}

/**
 * Slice 8.2 — a typed, type-bound view over an {@link AbsurdClient}. Every method forwards to the
 * matching client method with the bound `type` and the bound row type `T` baked in. Construct via
 * {@link AbsurdClient.collection}. Holds no extra state — it shares the client's transport (so retries,
 * timeout, and hooks all still apply).
 */
export class Collection<T extends Entry = Entry> {
  /** The owning client (its full method surface is reused). */
  private readonly client: AbsurdClient;
  /** The bound content-type api_id. */
  readonly type: string;

  constructor(client: AbsurdClient, type: string) {
    this.client = client;
    this.type = type;
  }

  /** {@link AbsurdClient.list} bound to this type. */
  list(params?: QueryParams, signal?: AbortSignal): Promise<ListResponse<T>> {
    return this.client.list<T>(this.type, params, signal);
  }

  /** {@link AbsurdClient.findOne} bound to this type. */
  findOne(
    id: number | string,
    opts?: { populate?: QueryParams['populate']; status?: QueryParams['status']; locale?: QueryParams['locale'] },
    signal?: AbortSignal,
  ): Promise<SingleResponse<T>> {
    return this.client.findOne<T>(this.type, id, opts, signal);
  }

  /** {@link AbsurdClient.findOneOrNull} bound to this type (404 → null). */
  findOneOrNull(
    id: number | string,
    opts?: { populate?: QueryParams['populate']; status?: QueryParams['status']; locale?: QueryParams['locale'] },
    signal?: AbortSignal,
  ): Promise<SingleResponse<T> | null> {
    return this.client.findOneOrNull<T>(this.type, id, opts, signal);
  }

  /** {@link AbsurdClient.count} bound to this type. */
  count(filters?: FilterObject, signal?: AbortSignal): Promise<number> {
    return this.client.count(this.type, filters, signal);
  }

  /** {@link AbsurdClient.create} bound to this type. */
  create(data: WriteBody<T>, signal?: AbortSignal): Promise<SingleResponse<T>> {
    return this.client.create<T>(this.type, data, signal);
  }

  /** {@link AbsurdClient.update} bound to this type. */
  update(id: number | string, data: WriteBody<T>, signal?: AbortSignal): Promise<SingleResponse<T>> {
    return this.client.update<T>(this.type, id, data, signal);
  }

  /** {@link AbsurdClient.delete} bound to this type. */
  delete(id: number | string, signal?: AbortSignal): Promise<SingleResponse<T>> {
    return this.client.delete<T>(this.type, id, signal);
  }

  /** {@link AbsurdClient.publish} bound to this type. */
  publish(id: number | string, signal?: AbortSignal): Promise<SingleResponse<T>> {
    return this.client.publish<T>(this.type, id, signal);
  }

  /** {@link AbsurdClient.unpublish} bound to this type. */
  unpublish(id: number | string, signal?: AbortSignal): Promise<SingleResponse<T>> {
    return this.client.unpublish<T>(this.type, id, signal);
  }

  /** {@link AbsurdClient.createVariant} bound to this type. */
  createVariant(id: number | string, locale: string, data?: WriteBody<T>, signal?: AbortSignal): Promise<SingleResponse<T>> {
    return this.client.createVariant<T>(this.type, id, locale, data, signal);
  }

  /** {@link AbsurdClient.listAll} (offset iterator) bound to this type. */
  listAll(params?: QueryParams, signal?: AbortSignal): AsyncGenerator<T, void, void> {
    return this.client.listAll<T>(this.type, params, signal);
  }

  /** {@link AbsurdClient.listAllKeyset} (keyset iterator) bound to this type. */
  listAllKeyset(params?: QueryParams, signal?: AbortSignal): AsyncGenerator<T, void, void> {
    return this.client.listAllKeyset<T>(this.type, params, signal);
  }
}

/** Factory for {@link AbsurdClient} — the ergonomic entry point: `const client = createClient({ baseUrl })`. */
export function createClient(options: ClientOptions): AbsurdClient {
  return new AbsurdClient(options);
}
