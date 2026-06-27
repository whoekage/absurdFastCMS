import path from 'node:path';
import type { S3Config } from '../config.ts';
import { config } from '../config.ts';

/**
 * `ContiConfig` — the typed, config-as-code shape of the SERVER configuration a user authors in
 * `conti.config.ts`. This describes how the server is WIRED (db connection, listen port, auth/cursor
 * secrets, storage, i18n default, debug) — it is NOT the content SCHEMA (modules are data in
 * Postgres, managed by the Builder). Keep that boundary: server wiring = code here; content modelling
 * = data in PG.
 *
 * Phase 2 (T1) introduces only the TYPE + the two helpers below. No runtime consumer yet — `createConti`
 * (T2) will drive boot from a `ContiConfig` instead of reading env directly.
 *
 * Immutable by construction (`readonly`): a resolved config is a snapshot, never mutated after load.
 */
export interface ContiConfig {
  readonly database: { readonly url: string };
  readonly server: {
    readonly port: number;
    /**
     * The PUBLIC origin this server is reachable at from a browser, e.g. `https://example.com`. Leave
     * UNDEFINED for the same-origin norm (admin at `/` + API at `/api`, one process behind a reverse
     * proxy) — the admin then calls a relative `/api`. Set it ONLY when the admin SPA is served from a
     * DIFFERENT origin than the API (e.g. `admin.example.com`), so the admin reaches the API absolutely.
     */
    readonly publicUrl?: string | undefined;
  };
  /** better-auth provider secret (cookie signing + at-rest hashing). */
  readonly auth: { readonly secret: string };
  /** HMAC secret for the keyset cursor codec. */
  readonly cursor: { readonly secret: string };
  readonly storage: {
    readonly uploadMaxBytes: number;
    /** The local-fs provider settings; always resolved (used when `s3` is absent). */
    readonly local: { readonly path: string; readonly publicBaseUrl: string };
    /** When set, the S3 provider is selected instead of local. */
    readonly s3?: S3Config | undefined;
  };
  readonly i18n: { readonly defaultLocale: string };
  readonly debug: { readonly inspector: boolean };
  /**
   * Files-first ENTITIES location — the project's `modules/` dir holding one FOLDER per module
   * (`modules/<apiId>/schema.ts` + optional `hooks.ts`; the SOURCE OF TRUTH). Optional: when absent,
   * {@link createConti} defaults to `<cwd>/modules`. Resolved to an absolute path by
   * {@link loadConfigFromEnv} (relative to the project dir = cwd), so the CLI and direct callers agree.
   */
  readonly modules?: { readonly dir: string };

  /**
   * Directory of the prebuilt admin SPA to serve at the root, or `undefined` to run headless (API only).
   * The generated `conti.config.ts` sets this explicitly to `adminBundleDir()` — @conti/core's own shipped
   * admin bundle — so there is NO boot-time fallback: serving the admin is a visible config line the user
   * owns (point it at a custom admin build to override, or drop it to go headless).
   */
  readonly adminDir?: string;

  /**
   * Cross-origin access. By default empty = SAME-ORIGIN ONLY (the admin served at `/` + API at `/api`, one
   * process / reverse proxy): no CORS headers, cookies stay SameSite=Lax, zero cross-origin attack surface.
   * Setting `trustedOrigins` switches on the whole credentialed cross-origin bundle at once — CORS (exact
   * ACAO echo + credentials + preflight), a CSRF Origin-check on writes, and SameSite=None cookies — for the
   * admin/a trusted frontend on a DIFFERENT origin. Requires `server.publicUrl` (the API's own origin). Each
   * entry is an exact bare https origin (no `*`, no path); validated at boot.
   */
  readonly cors?: {
    readonly trustedOrigins?: readonly string[];
  };
}

/**
 * The typed-authoring helper for `conti.config.ts` (Vite/Payload `defineConfig` pattern): an identity
 * function whose only job is to give the user editor autocomplete + type-checking on the config literal.
 */
export function defineConfig(config: ContiConfig): ContiConfig {
  return config;
}

/**
 * Validate `server.publicUrl` (CONTI_PUBLIC_URL) and return its canonical ORIGIN (`https://example.com`,
 * port preserved only when non-default, no trailing slash). It MUST be an absolute http(s) origin and
 * nothing more — a bare host (`example.com`) is treated as a RELATIVE path by the browser, and a path
 * (`…/cms`) implies sub-path mounting, which conti does not support (the prebuilt admin references its
 * assets at an absolute `/assets/…`). Throws a descriptive error on boot so a misconfigured cross-origin
 * deploy fails fast and loud instead of silently serving an admin that calls the wrong API. Learned from
 * Payload's serverURL footguns (doubled origin #14900, path-in-serverURL #24) and Directus's PUBLIC_URL
 * boot warning.
 */
function assertOrigin(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`conti: ${label} must be an absolute URL like "https://example.com" — got ${JSON.stringify(value)}`);
  }
  const bad: string[] = [];
  if (url.protocol !== 'http:' && url.protocol !== 'https:') bad.push(`protocol must be http or https (got "${url.protocol}")`);
  if (url.hostname.includes('*')) bad.push('wildcard hosts are not allowed — list exact origins (a subdomain wildcard would inherit any subdomain XSS)');
  if (url.pathname !== '/' && url.pathname !== '') bad.push('it must be a bare ORIGIN with no path');
  if (url.search) bad.push('it must not contain a query string');
  if (url.hash) bad.push('it must not contain a fragment');
  if (url.username || url.password) bad.push('it must not contain credentials');
  if (bad.length > 0) {
    throw new Error(`conti: ${label} = ${JSON.stringify(value)} is invalid — ${bad.join('; ')}. Use a bare origin like "https://example.com".`);
  }
  return url.origin;
}

/**
 * Validate `server.publicUrl` (CONTI_PUBLIC_URL) and return its canonical ORIGIN (`https://example.com`,
 * port preserved only when non-default, no trailing slash). It MUST be an absolute http(s) origin and
 * nothing more — a bare host (`example.com`) is treated as a RELATIVE path by the browser, and a path
 * (`…/cms`) implies sub-path mounting, which conti does not support (the prebuilt admin references its
 * assets at an absolute `/assets/…`). Throws a descriptive error on boot so a misconfigured cross-origin
 * deploy fails fast and loud instead of silently serving an admin that calls the wrong API. Learned from
 * Payload's serverURL footguns (doubled origin #14900, path-in-serverURL #24) and Directus's PUBLIC_URL
 * boot warning.
 */
export function normalizePublicUrl(value: string): string {
  return assertOrigin(value, 'server.publicUrl (CONTI_PUBLIC_URL)');
}

/**
 * Validate `cors.trustedOrigins` (CONTI_TRUSTED_ORIGINS) — the allowlist of origins permitted to make
 * CREDENTIALED cross-origin requests (the admin / a trusted frontend on another origin). Each must be a
 * bare http(s) origin (same rule as publicUrl); returns the canonical, de-duplicated set. Exact-match only —
 * NO wildcards, NO `*`, NO `null`, NO paths — pre-empting the CORS-misconfig vuln class (reflect-any,
 * `example.com.evil.com` suffix matches, sandboxed-iframe `null`). Throws on any bad entry.
 */
export function normalizeTrustedOrigins(values: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const v of values) seen.add(assertOrigin(v, 'cors.trustedOrigins (CONTI_TRUSTED_ORIGINS)'));
  return [...seen];
}

/**
 * Build a {@link ContiConfig} from the environment — the DEFAULT config source (`.env` in dev,
 * `.env.test` in test). It DELEGATES to the existing env-reading `config` module rather than re-reading
 * `process.env`, so every value (validation, defaults, dev-secret fallbacks, the `AUTH_SECRET` ↔
 * `BETTER_AUTH_SECRET` and PORT-CLI fallbacks, the `publicBaseUrl`-from-port default) is produced by the
 * SAME single source of truth — no duplicated logic, no drift. The resulting snapshot is byte-for-byte
 * the values today's boot path reads from env.
 *
 * @param cliPort optional CLI port override (e.g. `conti start 8080` / `argv[2]`), threaded to
 *   `config.port()` which applies the env-PORT-wins-then-CLI-then-default precedence.
 */
export function loadConfigFromEnv(cliPort?: string): ContiConfig {
  return {
    database: { url: config.databaseUrl },
    server: { port: config.port(cliPort), publicUrl: config.publicUrl },
    auth: { secret: config.authSecret },
    cursor: { secret: config.cursorSecret },
    storage: {
      uploadMaxBytes: config.uploadMaxBytes,
      local: { path: config.localStoragePath, publicBaseUrl: config.publicBaseUrl },
      s3: config.s3,
    },
    i18n: { defaultLocale: config.defaultLocale },
    debug: { inspector: config.debugInspector },
    // The project dir is cwd (the CLI loads conti.config.ts from there); the modules/ dir sits beside it.
    modules: { dir: path.join(process.cwd(), 'modules') },
    cors: { trustedOrigins: config.trustedOrigins },
  };
}
