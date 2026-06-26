import { createClient } from '@conti/sdk';
import { resolveApiBase } from './runtime-config.ts';

// Single shared SDK client instance. The API base is resolved at runtime (server-injected → VITE_API_URL →
// relative '/api'); in dev the relative '/api' is handled by the Vite proxy (-> :3000, stripping /api).
const baseUrl = resolveApiBase();

// be-09b — the api now gates the Builder + writes + media upload behind a better-auth session (reads stay
// public). The session cookie rides automatically (the SDK sends `credentials: 'include'`). `onUnauthorized`
// is the 401 seam: until a dedicated admin login screen lands (a later slice), surface the auth gap rather
// than silently failing. NEVER log the cookie/token — only the request coordinates.
export const api = createClient({
  baseUrl,
  onUnauthorized: ({ method, url }) => {
    console.warn(`[api] 401 unauthenticated on ${method} ${url} — sign in to perform this action.`);
  },
});
