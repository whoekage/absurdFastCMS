import type { CmsType, ComponentFieldKind } from '@conti/sdk';
import { resolveApiBase } from './runtime-config.ts';

/**
 * THE BUILDER WRITE-CLIENT (files-first). The public `@conti/sdk` is deliberately READ-ONLY for schema
 * (consumers read modules, only the admin authors them), so this thin fetch client — NOT the SDK — owns
 * the gated `/builder/modules` protocol: ETag/`version` optimistic concurrency (If-Match), the
 * preview → apply destructive-change flow, and `Idempotency-Key` retries. The server writes
 * `modules/<name>/schema.ts` (the dev-committed source of truth), migrates, and live-swaps the engine.
 *
 * Auth: every call rides the better-auth session cookie (`credentials: 'include'`); the routes are gated
 * on `builder.manage`. A 401 surfaces as a {@link BuilderError} the caller can route to sign-in.
 */

// Resolved at runtime (server-injected → VITE_API_URL → relative '/api'); in dev Vite proxies '/api' -> :3000.
const baseUrl = resolveApiBase();

// ── wire types (mirror packages/api/src/db/schema/model.ts + compose/builder.ts + db/schema/diff.ts) ──

/** A field's declared type: a scalar {@link CmsType} or a component kind (component/dynamiczone/relation). */
export type FieldType = CmsType | ComponentFieldKind;

/** Top-level relation cardinality (mirrors the API's RelationKind). */
export type RelationKind = 'oneToOne' | 'oneToMany' | 'manyToOne' | 'manyToMany';

/** A field's admin conditional-visibility rule ("show/hide when <field> <op> <value>"). Metadata only. */
export interface FieldCondition {
  field: string;
  op: 'eq' | 'ne';
  value: string | number | boolean;
  action: 'show' | 'hide';
}

/** The per-field options grab-bag (mirrors the catalog's FieldOptions). */
export interface FieldOptions {
  length?: number;
  precision?: number;
  scale?: number;
  values?: string[];
  nullable?: boolean;
  default?: unknown;
  multiple?: boolean;
  component?: string;
  components?: string[];
  target?: string;
  /** lower bound — char-length (string/email/uid) or VALUE (integer/float). */
  min?: number;
  /** upper VALUE bound (integer/float). Strings use `length` for their char max. */
  max?: number;
  /** admin editor layout width: 'full' (default) or 'half'. */
  editorWidth?: 'full' | 'half';
  /** admin conditional visibility. */
  condition?: FieldCondition;
  /** emit a single-column UNIQUE constraint (not for text/boolean/json/array/media). */
  unique?: boolean;
}

/** A field as it lives in `modules/<name>/schema.ts` — `id` is stable identity, `name` is the renamable key. */
export interface FieldSchema {
  id: string;
  name: string;
  type: FieldType;
  options?: FieldOptions;
  localized?: boolean;
}

/** A top-level relation owned by a module. */
export interface RelationSchema {
  id: string;
  field: string;
  kind: RelationKind;
  target: string;
  inverseField?: string;
  /** Which target field the relation picker shows/searches (admin metadata). */
  displayField?: string;
}

/** A whole module declaration (one schema file), as returned by GET /builder/modules[/:name] (carries ids). */
export interface ModuleSchema {
  id: string;
  name: string;
  /** Editable human display name; `label ?? name` is what the admin shows. */
  label?: string;
  collectionName?: string;
  options?: { draftAndPublish?: boolean; i18n?: boolean };
  fields: FieldSchema[];
  relations?: RelationSchema[];
}

/**
 * The PUT/preview payload. A field/relation/module WITHOUT an `id` is NEW (the server mints one); WITH an
 * `id` it is the SAME entity (so an `id`-kept + `name`-changed field is a lossless RENAME, not drop+add).
 */
export interface ModuleDraft {
  id?: string;
  name: string;
  label?: string;
  options?: { draftAndPublish?: boolean; i18n?: boolean };
  fields: Array<Omit<FieldSchema, 'id'> & { id?: string }>;
  relations?: Array<Omit<RelationSchema, 'id'> & { id?: string }>;
}

/** The risk classification the migrate-lint assigns each change. */
export type ChangeRisk = 'safe' | 'data-dependent' | 'destructive' | 'forbidden';

/** One planned migration step (subset of the API's Change — what the diff UI needs). */
export interface Change {
  kind: string;
  typeId: string;
  name: string;
  risk: ChangeRisk;
  field?: string;
  detail?: string;
}

/** POST /builder/modules/:name/preview result — a dry run (no write, no migrate). */
export interface PreviewResult {
  ok: boolean;
  applied: Change[];
  blocked: Change[];
  schema: ModuleSchema;
  generatedSource: string;
}

/** PUT/DELETE success — the new catalog version + the changes that ran (engine swapped live). */
export interface SaveResult {
  ok: true;
  version: string;
  applied: Change[];
  live: boolean;
  schema?: ModuleSchema;
}

/** GET /builder/modules — the applied catalog + its version (ETag). */
export interface CatalogResult {
  schemas: ModuleSchema[];
  version: string;
}

// ── typed error ──────────────────────────────────────────────────────────────────────────────────

/**
 * A non-2xx builder response, decoded into the fields the UI branches on:
 *  - 412 `stale`         → `currentVersion` (someone else edited; re-fetch + retry)
 *  - 428 `precondition`  → missing If-Match (we always send it; a bug guard)
 *  - 409 `blocked`       → `blocked` changes need `allowDestructive` (show the diff + confirm)
 *  - 409 `busy`          → another builder write is in-flight (Retry-After)
 *  - 409 inbound-rel     → delete blocked by referencing modules (message lists them)
 *  - 422 `validation`    → bad draft (name/id/relation/enum/decimal)
 *  - 500 `dataLoss`      → real rows would truncate (`table`/`column`/`affected`)
 *  - 401                 → not signed in
 */
export class BuilderError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly blocked: Change[] | undefined;
  readonly currentVersion: string | undefined;
  readonly dataLoss: { table?: string; column?: string; affected?: number } | undefined;

  constructor(
    status: number,
    message: string,
    opts: {
      code?: string | undefined;
      blocked?: Change[] | undefined;
      currentVersion?: string | undefined;
      dataLoss?: { table?: string; column?: string; affected?: number } | undefined;
    } = {},
  ) {
    super(message);
    this.name = 'BuilderError';
    this.status = status;
    this.code = opts.code;
    this.blocked = opts.blocked;
    this.currentVersion = opts.currentVersion;
    this.dataLoss = opts.dataLoss;
  }

  /** True when the write was rejected purely because destructive changes weren't acknowledged. */
  get isDestructiveBlocked(): boolean {
    return this.status === 409 && Array.isArray(this.blocked) && this.blocked.length > 0;
  }

  /** True when another builder write was in-flight (safe to retry after a beat). */
  get isBusy(): boolean {
    return this.status === 409 && this.code === 'builder.busy';
  }

  /** True when our version was stale (the catalog changed under us). */
  get isStale(): boolean {
    return this.status === 412;
  }
}

// ── transport ────────────────────────────────────────────────────────────────────────────────────

interface RequestOpts {
  method: string;
  path: string;
  body?: unknown;
  /** Optimistic-concurrency token sent as both If-Match and body.version (server accepts either). */
  version?: string;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

async function request<T>(opts: RequestOpts): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.version !== undefined) headers['if-match'] = `"${opts.version}"`;
  if (opts.idempotencyKey !== undefined) headers['idempotency-key'] = opts.idempotencyKey;

  const init: RequestInit = { method: opts.method, headers, credentials: 'include' };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  if (opts.signal !== undefined) init.signal = opts.signal;

  const res = await fetch(`${baseUrl}${opts.path}`, init);

  // 304 only happens on conditional GETs we don't issue; treat any non-ok as an error below.
  const text = await res.text();
  const parsed: unknown = text.length > 0 ? safeJson(text) : undefined;

  if (!res.ok) throw toBuilderError(res.status, parsed);
  return parsed as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

function toBuilderError(status: number, body: unknown): BuilderError {
  const b = (body ?? {}) as Record<string, unknown>;
  const message = typeof b.error === 'string' ? b.error : `request failed (${status})`;
  return new BuilderError(status, message, {
    code: typeof b.code === 'string' ? b.code : undefined,
    blocked: Array.isArray(b.blocked) ? (b.blocked as Change[]) : undefined,
    currentVersion: typeof b.currentVersion === 'string' ? b.currentVersion : undefined,
    dataLoss:
      typeof b.table === 'string' || typeof b.column === 'string' || typeof b.affected === 'number'
        ? { table: b.table as string, column: b.column as string, affected: b.affected as number }
        : undefined,
  });
}

// ── API ──────────────────────────────────────────────────────────────────────────────────────────

const enc = (name: string): string => encodeURIComponent(name);

/** GET /builder/modules — the full applied catalog (schemas carry ids) + the catalog version (ETag). */
export async function listModules(signal?: AbortSignal): Promise<CatalogResult> {
  const r = await request<{ schemas: ModuleSchema[]; version: string }>({
    method: 'GET',
    path: '/builder/modules',
    ...(signal ? { signal } : {}),
  });
  return { schemas: r.schemas, version: r.version };
}

/** POST /builder/modules/:name/preview — a dry run: which changes would apply / be blocked + generated source. */
export async function previewModule(
  name: string,
  draft: ModuleDraft,
  allowDestructive: boolean,
  signal?: AbortSignal,
): Promise<PreviewResult> {
  return request<PreviewResult>({
    method: 'POST',
    path: `/builder/modules/${enc(name)}/preview`,
    body: { ...draft, allowDestructive },
    ...(signal ? { signal } : {}),
  });
}

/** PUT /builder/modules/:name — create-or-update: write the schema file, migrate, live-swap. */
export async function saveModule(
  name: string,
  draft: ModuleDraft,
  version: string,
  opts: { allowDestructive?: boolean; idempotencyKey?: string; signal?: AbortSignal } = {},
): Promise<SaveResult> {
  return request<SaveResult>({
    method: 'PUT',
    path: `/builder/modules/${enc(name)}`,
    body: { ...draft, allowDestructive: opts.allowDestructive ?? false, version },
    version,
    ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
}

/** DELETE /builder/modules/:name — drop the module (always destructive; 409 if other modules reference it). */
export async function deleteModule(
  name: string,
  version: string,
  opts: { idempotencyKey?: string; signal?: AbortSignal } = {},
): Promise<SaveResult> {
  return request<SaveResult>({
    method: 'DELETE',
    path: `/builder/modules/${enc(name)}`,
    body: { allowDestructive: true, version },
    version,
    ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
}
