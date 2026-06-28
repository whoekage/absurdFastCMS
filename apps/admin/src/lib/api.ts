import { createClient } from '@conti/sdk';
import { resolveApiBase } from './runtime-config.ts';
import { queryClient } from './query-client.ts';
import { SESSION_KEY } from './auth.ts';

// Single shared SDK client instance. The API base is resolved at runtime (server-injected → VITE_API_URL →
// relative '/api'); in dev the relative '/api' is handled by the Vite proxy (-> :3000, stripping /api).
const baseUrl = resolveApiBase();

// be-09b — the api gates the Builder + writes + media upload behind a better-auth session (reads stay
// public). The session cookie rides automatically (`credentials: 'include'`). On a 401 (a write against a
// dead/absent session — e.g. after the DB was dropped) PURGE the cached session so the shell's auth guard
// redirects the ACTIVE tab to /sign-in immediately, instead of leaving a stale "logged in" view (the bug
// Strapi #26163 / Directus #4883 describe). NEVER log the cookie/token — only the request coordinates.
export const api = createClient({
  baseUrl,
  onUnauthorized: ({ method, url }) => {
    console.warn(`[api] 401 on ${method} ${url} — session invalid; redirecting to sign-in.`);
    queryClient.setQueryData(SESSION_KEY, null);
  },
});
