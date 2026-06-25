#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createConti, runMigrate, runMigrateLint, MigrationBlockedError, describeChange, type ContiApp, type ContiConfig, type ServerLifecycle } from '@conti/core';

/**
 * `@conti/cli` — the `conti` binary. It is the process entrypoint (lifted out of @conti/core, which is now
 * a pure library): it resolves the PROJECT directory (process.cwd(), Payload-style), loads the project's
 * two files, and boots createConti(config, lifecycle). This replaces the core's old hardcoded `../../`
 * entry — the project dir is now cwd, overridable via CONTI_CONFIG.
 */

export interface LoadedProject {
  config: ContiConfig;
  lifecycle: ServerLifecycle;
}

/**
 * Resolve + import a conti project from `cwd`: `conti.config.ts` (required, default-exports a ContiConfig)
 * and `bootstrap.ts` (optional, default-exports a ServerLifecycle). The config path is overridable with
 * the CONTI_CONFIG env var.
 */
export async function loadProject(cwd: string = process.cwd()): Promise<LoadedProject> {
  const configPath = process.env.CONTI_CONFIG ?? path.join(cwd, 'conti.config.ts');
  if (!existsSync(configPath)) {
    throw new Error(`conti: no config at ${configPath} — run 'conti init' or set CONTI_CONFIG`);
  }
  const configMod = (await import(pathToFileURL(configPath).href)) as { default: ContiConfig };
  const bootstrapPath = path.join(cwd, 'bootstrap.ts');
  let lifecycle: ServerLifecycle = {};
  if (existsSync(bootstrapPath)) {
    const mod = (await import(pathToFileURL(bootstrapPath).href)) as { default?: ServerLifecycle };
    lifecycle = mod.default ?? {};
  }
  return { config: configMod.default, lifecycle };
}

/** Load `<cwd>/.env` if present (dev convenience). In production the environment is already populated. */
function loadEnv(cwd: string): void {
  const envPath = path.join(cwd, '.env');
  if (existsSync(envPath)) {
    try {
      process.loadEnvFile(envPath);
    } catch {
      /* a malformed/locked .env falls back to the ambient environment */
    }
  }
}

/** Wire signal-based graceful shutdown: stop once, then exit; a guardian timer forces exit if it hangs. */
function installSignals(app: ContiApp): void {
  const shutdown = (signal: string): void => {
    console.log(`${signal} received — shutting down`);
    const guard = setTimeout(() => {
      console.error('shutdown timed out after 10s — forcing exit');
      process.exit(1);
    }, 10_000);
    guard.unref();
    app.stop().then(
      () => process.exit(0),
      (e) => {
        console.error('error during shutdown', e);
        process.exit(1);
      },
    );
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

/** `conti start` — load the project (env + config + bootstrap) and boot its server (no watch). */
export async function runStart(cwd: string = process.cwd()): Promise<void> {
  loadEnv(cwd);
  const { config, lifecycle } = await loadProject(cwd);
  const app = createConti(config, lifecycle);
  await app.start();
  installSignals(app);
}

/**
 * `conti migrate [lint] [--allow-destructive]` — apply (or lint) the committed `schema/` against the DB.
 * `lint` prints the pending change-set + which ops are blocked, applies nothing, and exits 1 if any are
 * blocked. Plain `migrate` applies; a {@link MigrationBlockedError} (destructive/data-dependent without an
 * ack, or a forbidden op) prints a clean message and exits 1 instead of dumping a stack.
 */
export async function runMigrateCommand(argv: string[], cwd: string = process.cwd()): Promise<void> {
  loadEnv(cwd);
  const { config } = await loadProject(cwd);
  if (argv[3] === 'lint') {
    const { changes, blocked } = await runMigrateLint(config);
    if (changes.length === 0) {
      console.log('conti migrate lint: schema is up to date');
      return;
    }
    console.log(`conti migrate lint: ${changes.length} pending change(s):`);
    for (const c of changes) console.log(`  - ${describeChange(c)} [${c.risk}]`);
    if (blocked.length > 0) {
      console.error(`\n${blocked.length} change(s) BLOCKED — re-run 'conti migrate --allow-destructive' to apply (forbidden ops can never apply).`);
      process.exit(1);
    }
    return;
  }
  const allowDestructive = argv.includes('--allow-destructive');
  try {
    const r = await runMigrate(config, { allowDestructive });
    console.log(r.noop ? 'conti migrate: schema is up to date' : `conti migrate: applied ${r.applied.length} change(s)`);
  } catch (e) {
    if (e instanceof MigrationBlockedError) {
      console.error(e.message);
      console.error("\nre-run with 'conti migrate --allow-destructive' to allow destructive/data-dependent changes (forbidden ops can never apply).");
      process.exit(1);
    }
    throw e;
  }
}

// ----- conti init: scaffold a thin project (the two-file contract + the standard dirs) -----

const CONFIG_TEMPLATE = `import { defineConfig, loadConfigFromEnv } from '@conti/core';

// Server config-as-code. Env-driven by default; override any field inline, e.g.:
//   export default defineConfig({ ...loadConfigFromEnv(), server: { port: 8080 } });
export default defineConfig(loadConfigFromEnv());
`;

const BOOTSTRAP_TEMPLATE = `import { defineBootstrap } from '@conti/core';

// SERVER lifecycle (NOT content/data hooks). Fail-fast in onBeforeStart, readiness/warmup in
// onAfterStart, graceful resource close in onShutdown. Context is { config, log } (+ port for afterStart).
export default defineBootstrap({
  onAfterStart(ctx) {
    ctx.log(\`ready on :\${ctx.port}\`);
  },
});
`;

const GITIGNORE_TEMPLATE = `node_modules
.env
`;

// The demo content-type, code-first: `schema/<apiId>.ts` is the SOURCE OF TRUTH (committed, dev-edited or
// Builder-edited, git-reviewed). `conti migrate` applies it; createConti builds the registry from it at
// boot; the entry type is inferred. Add lifecycle hooks alongside the fields.
const SCHEMA_ARTICLE_TEMPLATE = `import { defineSchema, c } from '@conti/core';

// One folder per entity (modules/<apiId>/). This schema.ts is owned/regenerated by the visual Builder;
// lifecycle hooks go in hooks.ts (this folder), custom logic in services.ts / controller.ts.
const Article = defineSchema({
  id: 'ct_article',
  options: { draftAndPublish: false, i18n: false },
  fields: {
    title: c.string({ id: 'f_title', max: 512, nullable: true }),
    body: c.text({ id: 'f_body', nullable: false }),
    status: c.enum(['draft', 'published', 'archived'], { id: 'f_status', nullable: false }),
    views: c.integer({ id: 'f_views', nullable: true }),
    rating: c.float({ id: 'f_rating', nullable: true }),
    active: c.boolean({ id: 'f_active', nullable: false }),
    publishedAt: c.datetime({ id: 'f_publishedAt', nullable: false }),
  },
});

export default Article;
export type Article = typeof Article;
`;

// modules/article/hooks.ts — the OPTIONAL lifecycle file (one per entity that needs hooks). The visual
// Builder never touches it. Shipped commented-out so the demo boots hookless but the pattern is visible.
const SCHEMA_ARTICLE_HOOKS_TEMPLATE = `import { defineHooks } from '@conti/core';

// Lifecycle hooks for \`article\`. before* run INSIDE the write tx (transform the data via the return value;
// throw HookError to veto → rollback → 400). after* run AFTER commit (side-effects only; never fatal).
export default defineHooks({
  // beforeCreate(data, ctx) { return { ...data }; },
  // afterCreate(entry, ctx) { /* e.g. enqueue a job */ },
});
`;

// modules/article/services.ts + controller.ts — custom per-entity logic (reusable functions + custom
// routes). Reserved for a later release; scaffolded as visible placeholders. Not loaded yet.
const SCHEMA_ARTICLE_SERVICES_TEMPLATE = `// Custom services for \`article\` — reusable domain functions you call from hooks/controllers.
// Wired in a later release; this file is a placeholder for the structure.
export {};
`;
const SCHEMA_ARTICLE_CONTROLLER_TEMPLATE = `// Custom controller for \`article\` — bespoke routes beyond the generated CRUD.
// Wired in a later release; this file is a placeholder for the structure.
export {};
`;

function packageJsonTemplate(name: string): string {
  return `${JSON.stringify(
    {
      name,
      version: '0.0.0',
      private: true,
      type: 'module',
      engines: { node: '>=24' },
      scripts: { dev: 'conti dev', start: 'conti start' },
      dependencies: { '@conti/core': '^0.1.0', '@conti/cli': '^0.1.0' },
    },
    null,
    2,
  )}\n`;
}

function envExampleTemplate(authSecret: string, cursorSecret: string): string {
  return [
    '# Copy to .env and set DATABASE_URL. Dev reads .env; tests read .env.test.',
    'DATABASE_URL=postgres://conti:conti@localhost:5432/conti_dev',
    `AUTH_SECRET=${authSecret}`,
    `CURSOR_SECRET=${cursorSecret}`,
    'PORT=3000',
    '',
  ].join('\n');
}

/**
 * Scaffold a thin conti project at `dir`: the two-file contract (conti.config.ts + bootstrap.ts), a
 * package.json wired to the `conti` CLI, an .env.example with freshly-generated secrets, and the standard
 * extensions/ schema/ generated/ dirs. Refuses to overwrite an existing project.
 */
export async function initProject(dir: string, opts: { name?: string } = {}): Promise<void> {
  if (existsSync(path.join(dir, 'conti.config.ts'))) {
    throw new Error(`conti: ${dir} already contains a conti.config.ts — refusing to overwrite`);
  }
  const name = opts.name ?? path.basename(path.resolve(dir));
  await mkdir(dir, { recursive: true });
  for (const sub of ['extensions', 'generated']) {
    await mkdir(path.join(dir, sub), { recursive: true });
    await writeFile(path.join(dir, sub, '.gitkeep'), '');
  }
  // modules/<apiId>/ ships the demo `article` (one folder per content-type): schema + hooks + custom-logic
  // placeholders. This is the code-first source of truth.
  const articleDir = path.join(dir, 'modules', 'article');
  await mkdir(articleDir, { recursive: true });
  await writeFile(path.join(articleDir, 'schema.ts'), SCHEMA_ARTICLE_TEMPLATE);
  await writeFile(path.join(articleDir, 'hooks.ts'), SCHEMA_ARTICLE_HOOKS_TEMPLATE);
  await writeFile(path.join(articleDir, 'services.ts'), SCHEMA_ARTICLE_SERVICES_TEMPLATE);
  await writeFile(path.join(articleDir, 'controller.ts'), SCHEMA_ARTICLE_CONTROLLER_TEMPLATE);
  await writeFile(path.join(dir, 'conti.config.ts'), CONFIG_TEMPLATE);
  await writeFile(path.join(dir, 'bootstrap.ts'), BOOTSTRAP_TEMPLATE);
  await writeFile(path.join(dir, 'package.json'), packageJsonTemplate(name));
  await writeFile(
    path.join(dir, '.env.example'),
    envExampleTemplate(randomBytes(32).toString('hex'), randomBytes(32).toString('hex')),
  );
  await writeFile(path.join(dir, '.gitignore'), GITIGNORE_TEMPLATE);
}

/**
 * The argv (after the node binary) for the watched dev child — exported for testing. `conti dev` runs the
 * server under Node's built-in `--watch`: it watches this CLI entry + its whole import graph (including the
 * dynamically-loaded conti.config.ts / bootstrap.ts), so editing source restarts the server. No custom
 * watcher (no-build ethos). On a change, `--watch` SIGTERMs the child — runStart()'s handler stops it
 * gracefully (socket closed, PG pool drained) so the port is free before the restart.
 */
export function devChildArgs(): string[] {
  return ['--watch', '--watch-preserve-output', fileURLToPath(import.meta.url), 'start'];
}

/** `conti dev` — run `conti start` under `node --watch` (auto-reload), supervising the child + signals. */
export function runDev(cwd: string = process.cwd()): void {
  const child = spawn(process.execPath, devChildArgs(), { cwd, stdio: 'inherit' });
  // Forward termination so Ctrl-C reaches the watched child (which graceful-stops), then mirror its exit.
  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
  child.on('exit', (code) => process.exit(code ?? 0));
}

async function main(argv: string[]): Promise<void> {
  const cmd = argv[2];
  switch (cmd) {
    case 'start':
      await runStart();
      break;
    case 'dev':
      runDev();
      break;
    case 'migrate':
      await runMigrateCommand(process.argv);
      break;
    case 'init': {
      const target = path.resolve(argv[3] ?? '.');
      await initProject(target);
      console.log(
        `conti: scaffolded a project in ${target}\n` +
          "next: cp .env.example .env, set DATABASE_URL, then run 'conti dev'.",
      );
      break;
    }
    default:
      console.error(`conti: unknown command ${JSON.stringify(cmd ?? '')}. Available: start, dev, init, migrate`);
      process.exit(1);
  }
}

// "Am I the CLI entry?" — realpath BOTH sides so a SYMLINKED bin (npm link / global install) matches: there
// process.argv[1] is the symlink path while import.meta.url is the real path, so a raw compare (or
// import.meta.main) silently skipped main(). When a test imports this module, argv[1] is the test file, so
// realpath differs and main() does not run.
function isEntrypoint(): boolean {
  try {
    return realpathSync(process.argv[1] ?? '') === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  main(process.argv).catch((e) => {
    console.error('conti: fatal', e);
    process.exit(1);
  });
}
