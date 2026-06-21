import { createClient } from '@absurd/sdk';

// Single shared SDK client instance.
// In dev, the relative '/api' base is handled by the Vite proxy (-> http://localhost:3000,
// stripping the /api prefix). In prod, VITE_API_URL can point at the real API origin.
const baseUrl = import.meta.env.VITE_API_URL ?? '/api';

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
