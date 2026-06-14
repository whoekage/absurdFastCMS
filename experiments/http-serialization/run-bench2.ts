/**
 * Ceiling diagnostics: is ~44k/s a framework cap or a payload-byte cap, and how far does
 * clustering across the M1 Pro's 10 cores take us?
 *
 *  - tiny  (~50 B) isolates the framework's request ceiling (no byte cost).
 *  - buffer (~28 KB) is the realistic CMS list response (byte-bound).
 *  - node cluster x6 uses many cores; the client also gets worker threads so it can keep up.
 *
 * Run: node experiments/http-serialization/run-bench2.ts
 */
import autocannon from 'autocannon';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const CONNECTIONS = 125;
const WARMUP_S = 2;
const DURATION_S = 8;

interface Run {
  name: string;
  file: string;
  extraArgs: string[];
  port: number;
  routes: string[];
  clientWorkers: number;
}
const RUNS: Run[] = [
  { name: 'node single', file: 'serve-node.ts', extraArgs: [], port: 3001, routes: ['tiny', 'buffer'], clientWorkers: 2 },
  { name: 'hono single', file: 'serve-hono.ts', extraArgs: [], port: 3002, routes: ['tiny', 'buffer'], clientWorkers: 2 },
  { name: 'node cluster x6', file: 'serve-node-cluster.ts', extraArgs: ['6'], port: 3004, routes: ['tiny', 'buffer'], clientWorkers: 4 },
];

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
  throw new Error(`server on ${port} never ready`);
}

const out: { run: string; route: string; rps: number; p99: number; mbps: number }[] = [];

for (const run of RUNS) {
  const file = fileURLToPath(new URL(run.file, import.meta.url));
  const child = spawn('node', [file, String(run.port), ...run.extraArgs], { stdio: 'ignore' });
  try {
    await waitReady(run.port);
    for (const route of run.routes) {
      const url = `http://127.0.0.1:${run.port}/${route}`;
      await autocannon({ url, connections: CONNECTIONS, duration: WARMUP_S, workers: run.clientWorkers });
      const r = await autocannon({ url, connections: CONNECTIONS, duration: DURATION_S, workers: run.clientWorkers });
      out.push({
        run: run.name,
        route,
        rps: Math.round(r.requests.average),
        p99: r.latency.p99,
        mbps: r.throughput.average / 1e6,
      });
    }
  } finally {
    child.kill('SIGKILL');
    await sleep(500);
  }
}

console.log(`\n10-core M1 Pro · ${CONNECTIONS} conns · ${DURATION_S}s · client uses worker threads\n`);
console.log(['run', 'route', 'req/s', 'p99 ms', 'MB/s'].map((h) => h.padEnd(18)).join(''));
console.log('-'.repeat(70));
for (const r of out) {
  console.log(
    [r.run, r.route, r.rps.toLocaleString(), r.p99, r.mbps.toFixed(0)].map((c) => String(c).padEnd(18)).join(''),
  );
}
const g = (run: string, route: string) => out.find((r) => r.run === run && r.route === route)?.rps ?? 0;
console.log('\n--- answers ---');
console.log(`tiny vs 28KB (node single): ${g('node single', 'tiny').toLocaleString()} vs ${g('node single', 'buffer').toLocaleString()} req/s — is 44k a framework cap or a byte cap?`);
console.log(`cluster x6 vs single (tiny):   ${g('node cluster x6', 'tiny').toLocaleString()} vs ${g('node single', 'tiny').toLocaleString()} req/s`);
console.log(`cluster x6 vs single (28KB):   ${g('node cluster x6', 'buffer').toLocaleString()} vs ${g('node single', 'buffer').toLocaleString()} req/s`);
console.log('');
