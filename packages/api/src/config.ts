/**
 * Configuration module that validates and exposes environment variables.
 * 
 * Environment variables are loaded from:
 * - .env for development
 * - .env.test for testing
 * 
 * Values are validated lazily (on first access) to allow .env file loading to complete first.
 * This prevents "DATABASE_URL is not set" errors during module load.
 */

type NodeEnv = 'development' | 'test' | 'production';

/**
 * The DEV-ONLY default HMAC secret for the keyset cursor codec.
 * Production MUST set CURSOR_SECRET; this constant only keeps dev/test working without extra config.
 */
const DEV_CURSOR_SECRET = 'absurdFastCMS-dev-only-cursor-secret-do-not-use-in-prod';

/**
 * Cached values to ensure consistent validation across multiple calls
 */
const cache: Record<string, string | boolean | number | null> = {};

/**
 * Get and validate the NODE_ENV environment variable.
 * Defaults to 'development' if not set.
 */
function getNodeEnv(): NodeEnv {
  if ('nodeEnv' in cache) return cache.nodeEnv as NodeEnv;
  
  const env = process.env.NODE_ENV;
  if (env && !['development', 'test', 'production'].includes(env)) {
    throw new Error(
      `Invalid NODE_ENV: "${env}". Must be one of: development, test, production`,
    );
  }
  const result = (env as NodeEnv) || 'development';
  cache.nodeEnv = result;
  return result;
}

/**
 * Get and validate DATABASE_URL (required).
 * Must be set via .env or .env.test depending on the environment.
 */
function getDatabaseUrl(): string {
  if ('databaseUrl' in cache) return cache.databaseUrl as string;
  
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Launch with --env-file=.env (dev) or .env.test (test)',
    );
  }
  cache.databaseUrl = url;
  return url;
}

/**
 * Get PORT for the server (optional, defaults to 3000).
 * Can also be provided via command line argument as a fallback.
 */
function getPort(cliArg?: string): number {
  const fromEnv = process.env.PORT;
  const fromCliArg = cliArg;
  const defaultPort = 3000;

  const portStr = fromEnv || fromCliArg || String(defaultPort);
  const port = Number(portStr);

  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: "${portStr}". Must be a number between 1 and 65535`);
  }

  return port;
}

/**
 * Get CURSOR_SECRET for HMAC-based keyset cursor codec.
 * 
 * The DEV_CURSOR_SECRET is a source-published constant used as fallback.
 * In production, failing to set CURSOR_SECRET is a security issue that emits a warning.
 */
function getCursorSecret(): string {
  if ('cursorSecret' in cache) return cache.cursorSecret as string;
  
  const secret = process.env.CURSOR_SECRET;
  
  if (secret === undefined || secret === '') {
    const nodeEnv = getNodeEnv();
    if (nodeEnv !== 'development' && nodeEnv !== 'test') {
      console.warn(
        '[cursor] CURSOR_SECRET is not set; falling back to the INSECURE source-published dev secret. ' +
        'Set CURSOR_SECRET in production — keyset cursors are forgeable otherwise.',
      );
    }
    cache.cursorSecret = DEV_CURSOR_SECRET;
    return DEV_CURSOR_SECRET;
  }
  
  cache.cursorSecret = secret;
  return secret;
}

/**
 * Whether the read-only debug inspector route (GET /debug-inspect[...]) is mounted.
 *
 * Opt-in via DEBUG_INSPECTOR=1 (or 'true') AND only outside production — so it can be left in .env for
 * dev and is never exposed by a production deploy even if the var leaks in. Off by default (and in
 * .env.test, which omits it), so tests and prod never mount it.
 */
function getDebugInspector(): boolean {
  if ('debugInspector' in cache) return cache.debugInspector as boolean;

  const raw = process.env.DEBUG_INSPECTOR;
  const enabled = (raw === '1' || raw === 'true') && getNodeEnv() !== 'production';
  cache.debugInspector = enabled;
  return enabled;
}

/**
 * The global default locale (i18n). Read from DEFAULT_LOCALE (dev: .env, test: .env.test); falls back to
 * 'en' when unset. Used by the read router as the locale a `locale`-less read of an i18n type resolves to.
 * Cached on first access.
 */
function getDefaultLocale(): string {
  if ('defaultLocale' in cache) return cache.defaultLocale as string;
  const loc = process.env.DEFAULT_LOCALE?.trim() || 'en';
  cache.defaultLocale = loc;
  return loc;
}

/**
 * Get TEST_DATABASE_URL for test setup (optional).
 * Used by testcontainers to connect to the test database instance.
 */
function getTestDatabaseUrl(): string | undefined {
  if ('testDatabaseUrl' in cache) return cache.testDatabaseUrl as string | undefined;
  
  const url = process.env.TEST_DATABASE_URL?.trim() || undefined;
  cache.testDatabaseUrl = url || null;
  return url;
}

/**
 * Get ADMIN_DATABASE_URL for test setup (optional).
 * Set by global-setup.ts after testcontainers container starts.
 */
function getAdminDatabaseUrl(): string | undefined {
  // Don't cache this as it's set by globalSetup after module load
  return process.env.ADMIN_DATABASE_URL;
}

/**
 * Check if testcontainers should reuse existing containers.
 * Defaults to true if TESTCONTAINERS_REUSE_ENABLE is not explicitly 'false'.
 */
function getTestcontainersReuse(): boolean {
  if ('testcontainersReuse' in cache) return cache.testcontainersReuse as boolean;
  
  const enabled = process.env.TESTCONTAINERS_REUSE_ENABLE !== 'false';
  cache.testcontainersReuse = enabled;
  return enabled;
}

/**
 * Configuration object with lazy-loaded properties.
 * Access config values via properties, not direct process.env.
 * 
 * IMPORTANT: Do NOT access these properties during module load / global scope.
 * Only access within functions that run after .env file loading is complete.
 */
export const config = {
  get nodeEnv(): NodeEnv {
    return getNodeEnv();
  },
  
  get databaseUrl(): string {
    return getDatabaseUrl();
  },
  
  get cursorSecret(): string {
    return getCursorSecret();
  },
  
  get testDatabaseUrl(): string | undefined {
    return getTestDatabaseUrl();
  },
  
  get adminDatabaseUrl(): string | undefined {
    return getAdminDatabaseUrl();
  },
  
  get testcontainersReuse(): boolean {
    return getTestcontainersReuse();
  },

  get debugInspector(): boolean {
    return getDebugInspector();
  },

  get defaultLocale(): string {
    return getDefaultLocale();
  },

  // Dev-only constant (always available)
  get devCursorSecret(): string {
    return DEV_CURSOR_SECRET;
  },
  
  /**
   * Get PORT with optional CLI argument override.
   * Must be called as a function since port can come from CLI args.
   */
  port(cliArg?: string): number {
    return getPort(cliArg);
  },
};

/**
 * Helper functions for environment checks.
 * Safe to call anywhere as they just check the cached NODE_ENV value.
 */
export const isDevelopment = (): boolean => config.nodeEnv === 'development';
export const isTest = (): boolean => config.nodeEnv === 'test';
export const isProduction = (): boolean => config.nodeEnv === 'production';
