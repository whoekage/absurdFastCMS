/**
 * Where the admin SPA calls the content API. The admin bundle is PREBUILT and shipped inside @conti/core,
 * so the API location cannot be baked at our build time — it is discovered at RUNTIME. Resolution order:
 *   1. `window.__CONTI__.apiBase` — injected by the server into index.html at SERVE time when the admin runs
 *      on a different origin than the API (set via ContiConfig `server.publicUrl`). No rebuild needed.
 *   2. `VITE_API_URL` — build-time override for the local `npm run dev` flow (Vite proxy) / custom builds.
 *   3. `/api` — relative, same-origin default (admin at `/` + API at `/api`, one process / reverse proxy).
 */
export function resolveApiBase(): string {
  return window.__CONTI__?.apiBase ?? import.meta.env.VITE_API_URL ?? '/api';
}
