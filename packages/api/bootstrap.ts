import { defineBootstrap } from './src/compose/conti.ts';

/**
 * Server lifecycle (the second project file). This is SERVER/infra lifecycle — NOT content/data hooks
 * (those are a separate system). The realistic shape is: fail-fast on dependencies in `onBeforeStart`,
 * readiness/warmup in `onAfterStart`, graceful resource close in `onShutdown`.
 *
 * Advanced example with an external dependency you own (add the dep, then uncomment):
 *
 *   import Redis from 'ioredis';
 *   let redis: Redis;
 *   onBeforeStart: async () => {
 *     redis = new Redis(process.env.REDIS_URL!);
 *     await redis.ping();          // pre-flight: a throw here ABORTS boot — never serve with a dead dependency
 *   },
 *   onShutdown: async () => { await redis.quit(); },   // mirror onBeforeStart — release what you opened
 *
 * The context is intentionally minimal ({ config, log } + port) — the read engine stays out of reach. To
 * react to content writes, or to read/seed data, use the (separate) content-hook system, not this file.
 */
export default defineBootstrap({
  async onAfterStart(ctx) {
    // Warm the read hot path so the first real request isn't the cold one (best-effort, non-blocking).
    await fetch(`http://127.0.0.1:${ctx.port}/article?pagination[pageSize]=1`).catch(() => {});
    ctx.log(`conti live on :${ctx.port}`);
  },
  onShutdown(ctx) {
    ctx.log('conti shutting down');
  },
});
