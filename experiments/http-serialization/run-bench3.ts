/**
 * macOS has no CPU pinning (no taskset; M1 thread-affinity is advisory/ignored). So instead of
 * pinning the client to a core, we directly test whether the CLIENT is the bottleneck: sweep the
 * load-generator's worker-thread count against a fixed single-process server. If the server's
 * req/s plateaus, the server is the limiter (client contention is NOT the issue — pinning wouldn't
 * help). If it climbs with more client workers, the client was starving.
 *
 * Run: node experiments/http-serialization/run-bench3.ts
 */
import autocannon from 'autocannon';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const CONNECTIONS = 125;
const WARMUP_S = 2;
const DURATION_S = 6;
const CLIENT_WORKERS = [1, 2, 4, 8];
const PORT = 3001;

async function waitReady(port: number): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/tiny`);
      if (r.ok) {
        await r.arrayBuffer();
        return;
      }
    } catch {
      /* not up */
    }
    await sleep(100);
  }
  throw new Error('server never ready');
}

const file = fileURLToPath(new URL('serve-node.ts', import.meta.url));
const child = spawn('node', [file, String(PORT)], { stdio: 'ignore' });
const out: { route: string; workers: number; rps: number; p99: number }[] = [];

try {
  await waitReady(PORT);
  for (const route of ['tiny', 'buffer']) {
    for (const workers of CLIENT_WORKERS) {
      const url = `http://127.0.0.1:${PORT}/${route}`;
      await autocannon({ url, connections: CONNECTIONS, duration: WARMUP_S, workers });
      const r = await autocannon({ url, connections: CONNECTIONS, duration: DURATION_S, workers });
      out.push({ route, workers, rps: Math.round(r.requests.average), p99: r.latency.p99 });
    }
  }
} finally {
  child.kill('SIGKILL');
}

console.log(`\nsingle-process node:http server · ${CONNECTIONS} conns · ${DURATION_S}s · sweeping CLIENT worker threads\n`);
console.log(['route', 'client workers', 'server req/s', 'p99 ms'].map((h) => h.padEnd(18)).join(''));
console.log('-'.repeat(70));
for (const r of out) {
  console.log([r.route, r.workers, r.rps.toLocaleString(), r.p99].map((c) => String(c).padEnd(18)).join(''));
}
console.log('\n--- read ---');
console.log('If req/s is flat across client-worker counts => SERVER-bound (client/affinity not the limit).');
console.log('If req/s climbs with more client workers => the CLIENT was starving the test.');
console.log('');
