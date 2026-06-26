/**
 * Public entry of `@conti/core` — the surface a conti project (`conti.config.ts`, `bootstrap.ts`) and the
 * `@conti/cli` consume. Deliberately SMALL: `createConti` + the config/lifecycle authoring helpers + their
 * types. The columnar engine, db, http and auth internals are NOT exported — the package.json `exports`
 * map maps only `.`, so a deep import like `@conti/core/store/engine` does not resolve (engine out of reach).
 */
export { createConti, defineBootstrap } from './compose/conti.ts';
export type { ContiApp, ServerLifecycle, ServerContext, StartedContext } from './compose/conti.ts';
export { defineConfig, loadConfigFromEnv } from './compose/config.ts';
export type { ContiConfig } from './compose/config.ts';
// Resolves @conti/core's OWN shipped assets (admin SPA / migrations) from any install layout — a generated
// `conti.config.ts` calls `adminBundleDir()` to serve the bundled admin at the root.
export { adminBundleDir, migrationsDir } from './paths.ts';
export type { S3Config } from './config.ts';
// Code-first schema authoring DSL (the `schema/<apiId>.ts` surface): defineSchema + the `c.*` builders.
export { defineSchema, defineHooks, c } from './db/schema/define.ts';
export type { InferType, TypeDef, BeforeHookFn, AfterHookFn, Hooks, HookContext } from './db/schema/define.ts';
export { HookError } from './db/schema/hooks.ts';
// Files-first schema migration (the `conti migrate` / `conti migrate lint` commands).
export { runMigrate, runMigrateLint } from './compose/migrate.ts';
// Visual-Builder server side: apply a schema edit (mint ids → gate → write modules/<apiId>/schema.ts → migrate).
export { applySchemaEdit } from './compose/builder.ts';
export type { ModuleDraft, SchemaEditResult } from './compose/builder.ts';
// S3 boot reconciliation guard (heals the S2 crash window / forward edits at boot).
export { reconcileBoot, SchemaReconcileHaltError } from './compose/boot-reconcile.ts';
export type { ReconcileResult } from './compose/boot-reconcile.ts';
export { MigrationBlockedError, describeChange } from './db/schema/migrate.ts';
export type { MigrateResult } from './db/schema/migrate.ts';
export type { Change } from './db/schema/diff.ts';
