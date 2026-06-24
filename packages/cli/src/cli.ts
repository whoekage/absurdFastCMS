#!/usr/bin/env node
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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

async function main(argv: string[]): Promise<void> {
  const cmd = argv[2];
  switch (cmd) {
    case 'start':
      await runStart();
      break;
    default:
      console.error(`conti: unknown command ${JSON.stringify(cmd ?? '')}. Available: start`);
      process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv).catch((e) => {
    console.error('conti: fatal', e);
    process.exit(1);
  });
}
