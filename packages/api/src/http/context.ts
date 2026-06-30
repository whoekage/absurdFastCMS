import type uWS from 'uWebSockets.js';
import type { Sql } from 'postgres';
import type { Engine } from '../store/engine.ts';
import type { Registry } from '../db/registry.ts';
import type { HookRegistry } from '../db/schema/hooks.ts';
import type { WriteContext } from './write.handler.ts';
import type { FileContext } from './upload.handler.ts';
import type { PostgresStore } from '../db/postgres.store.ts';
import type { Auth } from '../auth/auth.ts';
import type { RbacRegistry } from '../auth/rbac.registry.ts';
import type { TeamView } from '../auth/team.view.ts';
import type { Principal } from '../auth/session.cache.ts';

/**
 * The shared structural contracts for the decomposed HTTP layer. `createServer` builds a single
 * {@link ServerContext} (`rctx`) and hands it to each `register*Routes(rctx)` module, so every route
 * family reads the SAME live cell / gates / apply-core / deps. This module is type-only (erasable);
 * `auth-gates.ts` and `apply-core.ts` import their contracts from here and provide the factories.
 */

type UwsHandler = (res: uWS.HttpResponse, req: uWS.HttpRequest) => void;

/** The basePath-prefixed + CORS-wrapped registration object (today's inline `route`). */
export interface RouteTable {
  get(p: string, h: UwsHandler): void;
  post(p: string, h: UwsHandler): void;
  put(p: string, h: UwsHandler): void;
  del(p: string, h: UwsHandler): void;
  any(p: string, h: UwsHandler): void;
}

/**
 * The SINGLE mutable cell every schema-reading route closure reads through. A schema-edit swap rebuilds
 * a fresh Engine/Registry off-side and reassigns these three fields in ONE synchronous assignment; the
 * `live` OBJECT is what consumers capture, so a reassignment is seen everywhere.
 */
export interface LiveCell {
  engine: Engine;
  registry: Registry;
  hooks: HookRegistry;
}

/** How a request authenticated (drives the key-management session-only rule). */
export type AuthVia = 'session' | 'key' | 'none';

/** The per-request auth context: a Principal resolved ONLY from a session cookie or an `x-api-key` header. */
export interface AuthContext {
  principal: Principal | null;
  /** EFFECTIVE perms = owner RBAC ∩ token scope (a key only NARROWS; a session never narrows). */
  can(perm: string): boolean;
  via: AuthVia;
}

/**
 * The auth gate primitives (provided by `auth-gates.ts`). Each resolves auth (session OR key), applies
 * the 401/403 split, and hands the appropriate subject to `proceed`. See `auth-gates.ts` for the rules.
 */
export interface Gates {
  gate(
    res: uWS.HttpResponse,
    req: uWS.HttpRequest,
    perm: string,
    readsBody: boolean,
    proceed: (body: Buffer | null, aborted: () => boolean) => void,
  ): void;
  gateTeam(
    res: uWS.HttpResponse,
    req: uWS.HttpRequest,
    readsBody: boolean,
    proceed: (principal: Principal, headers: Headers, body: Buffer | null, aborted: () => boolean) => void,
  ): void;
  gateKeys(
    res: uWS.HttpResponse,
    req: uWS.HttpRequest,
    readsBody: boolean,
    proceed: (ctx: AuthContext, headers: Headers, body: Buffer | null, aborted: () => boolean) => void,
  ): void;
  gateUpload(
    res: uWS.HttpResponse,
    req: uWS.HttpRequest,
    contentType: string,
    proceed: (raw: Buffer, aborted: () => boolean) => void,
  ): void;
}

/**
 * The bundle handed to every `register*Routes(rctx)` module. `apply` (the schema-write core that owns
 * the version/mutex cell) is added in the apply-core extraction step; route families that don't mutate
 * the catalog never reference it.
 */
export interface ServerContext {
  route: RouteTable;
  gates: Gates;
  live: LiveCell;
  writeCtx: WriteContext;
  store: PostgresStore;
  sql: Sql;
  dir: string;
  auth: Auth;
  rbac: RbacRegistry;
  teamView: TeamView;
  fileCtx: FileContext;
}
