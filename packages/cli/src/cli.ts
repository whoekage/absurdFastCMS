#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createConti, type ContiApp, type ContiConfig, type ServerLifecycle } from '@conti/core';

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
  for (const sub of ['extensions', 'schema', 'generated']) {
    await mkdir(path.join(dir, sub), { recursive: true });
    await writeFile(path.join(dir, sub, '.gitkeep'), '');
  }
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
      console.error(`conti: unknown command ${JSON.stringify(cmd ?? '')}. Available: start, dev, init`);
      process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv).catch((e) => {
    console.error('conti: fatal', e);
    process.exit(1);
  });
}
