/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** Runtime config the server injects into index.html at SERVE time (see resolveApiBase / server.publicUrl). */
interface Window {
  __CONTI__?: { apiBase?: string };
}
