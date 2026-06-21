import { buildAuth } from './auth.ts';

/**
 * CLI-ONLY entrypoint for `@better-auth/cli generate`. The CLI imports the named `auth` export purely to
 * READ its schema (core tables + the apiKey plugin's table) and emit plain SQL, which we then hand-fold
 * into `migrations/0001_init.sql`. It is NEVER imported by the runtime (the server builds its own auth
 * via {@link buildAuth} at boot). Run:
 *
 *   DATABASE_URL=postgres://x AUTH_SECRET=cli npx @better-auth/cli generate \
 *     --config src/auth/auth.cli.ts --output .auth-schema.sql --yes
 */
export const auth = buildAuth();
