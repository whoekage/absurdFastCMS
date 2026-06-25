/**
 * The demo `article` enumeration members, kept as a tiny shared const after the legacy-meta teardown gutted
 * this file's seed functions (boot now materializes tables via `migrate()` from the files-first IR, and the
 * test seed helpers were migrated to `ct()` + `startTestServerFromSchemas`). `STATUSES` is imported by the
 * `server.ts` bench generator and a dozen engine tests, so it lives on here as its sole export.
 */
export const STATUSES = ['draft', 'published', 'archived'];
