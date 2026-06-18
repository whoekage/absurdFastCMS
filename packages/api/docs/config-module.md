# Configuration Module

## Overview

The `src/config.ts` module centralizes environment variable management and validation. All access to `process.env` should go through this module instead of using `process.env` directly.

## Benefits

1. **Single Source of Truth** — All config is validated and accessed through one module
2. **Type Safety** — TypeScript knows exactly what values are available
3. **Fail Fast** — Validation happens when values are accessed, with clear error messages
4. **Lazy Loading** — Config values are loaded on first access (not during module initialization)
5. **Security** — Easy to audit all environment variable usage in one place

## Usage

### Importing the Config

```typescript
import { config, isDevelopment, isTest, isProduction } from '../src/config.ts';
```

### Accessing Values

Config uses **getter properties** that lazily validate environment variables:

```typescript
// Database configuration
const dbUrl = config.databaseUrl;  // DATABASE_URL (required)

// Server configuration
const port = config.port();  // PORT env var, or default to 3000
const portWithCli = config.port('8080');  // CLI arg overrides PORT env var

// Security
const secret = config.cursorSecret;  // CURSOR_SECRET (with dev fallback)

// Environment checks (always safe)
if (isDevelopment()) { /* dev-only code */ }
if (isTest()) { /* test-only code */ }
if (isProduction()) { /* prod-only code */ }

// Test-specific
const external = config.testDatabaseUrl;  // TEST_DATABASE_URL (optional)
const adminDb = config.adminDatabaseUrl;  // ADMIN_DATABASE_URL (set by global-setup)
const reuse = config.testcontainersReuse;  // TESTCONTAINERS_REUSE_ENABLE
```

## Environment Variables Reference

### Required

| Variable | Description | Default | Used By |
|----------|-------------|---------|---------|
| `DATABASE_URL` | Postgres connection string | ❌ None (required) | `src/db/client.ts`, migrations |

### Optional

| Variable | Description | Default | Used By |
|----------|-------------|---------|---------|
| `PORT` | Server port | `3000` | `src/http/server.ts` |
| `NODE_ENV` | Environment | `development` | Config module |
| `CURSOR_SECRET` | HMAC secret for keyset cursors | Dev constant (insecure) | Cursor codec |
| `TEST_DATABASE_URL` | External Postgres for tests | ❌ Testcontainers | `test/global-setup.ts` |
| `TESTCONTAINERS_REUSE_ENABLE` | Reuse test containers | `true` | `test/global-setup.ts` |

## Loading Environment Variables

Node.js loads `.env` files via the `--env-file` flag:

```bash
# Development
node --env-file=.env src/http/server.ts

# Testing
node --env-file=.env.test --test --test-global-setup=./test/global-setup.ts

# Production
node src/http/server.ts  # No .env file; all vars from system env
```

## Implementation Notes

### Lazy Loading
Values are loaded on first access using TypeScript getter properties, not during module initialization. This ensures:
- `.env` or `.env.test` is fully loaded before validation runs
- Multiple accesses use cached values (consistent validation)

### Error Messages
When a required variable is missing or invalid:
```
Error: DATABASE_URL is not set. Launch with --env-file=.env (dev) or .env.test (test)
```

### Port Handling
PORT supports three sources (in priority order):
1. CLI argument: `node --env-file=.env src/http/server.ts 8080`
2. `PORT` environment variable
3. Default: `3000`

```typescript
const port = config.port(process.argv[2]);  // CLI arg wins
```

### Cursor Secret Security
The cursor secret has a documented dev default for convenience:

```
'absurdFastCMS-dev-only-cursor-secret-do-not-use-in-prod'
```

In production (when NODE_ENV ≠ development/test), a warning is logged if CURSOR_SECRET is not set:
```
[cursor] CURSOR_SECRET is not set; falling back to the INSECURE source-published dev secret.
Set CURSOR_SECRET in production — keyset cursors are forgeable otherwise.
```

## Migrating from Direct process.env Access

### Before
```typescript
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL not set');
```

### After
```typescript
import { config } from '../src/config.ts';
const url = config.databaseUrl;  // Validated and typed
```

All validation logic moves to the config module once, eliminating duplicated error-checking code.
