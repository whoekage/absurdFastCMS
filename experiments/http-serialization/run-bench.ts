/**
 * Drives the matrix: spawns each server, warms it, load-tests every strategy with autocannon,
 * tears it down, then prints a comparison table + the answers we care about.
 *
 * Run: node experiments/http-serialization/run-bench.ts
 */
import autocannon from 'autocannon';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { PAYLOAD_BYTES } from './data.ts';

const CONNECTIONS = 50;
const WARMUP_S = 2;
const DURATION_S = 8;

interface Target {
  name: string;
  file: string;
  port: number;
  routes: string[];
}
const TARGETS: Target[] = [
  { name: 'node:http', file: 'serve-node.ts', port: 3001, routes: ['stringify', 'buffer'] },
  { name: 'hono', file: 'serve-hono.ts', port: 3002, routes: ['stringify', 'buffer'] },
  { name: 'fastify', file: 'serve-fastify.ts', port: 3003, routes: ['stringify', 'fjs', 'buffer'] },
];

async function waitReady(port: number): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/buffer`);
      if (r.ok) {
        await r.arrayBuffer();
        return;
      }
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  throw new Error(`server on ${port} never became ready`);
}

interface Row {
  server: string;
  strategy: string;
  rps: number;
  p50: number;
  p99: number;
  p999: number;
  mbps: number;
}

async function measure(url: string): Promise<autocannon.Result> {
  await autocannon({ url, connections: CONNECTIONS, duration: WARMUP_S });
  return autocannon({ url, connections: CONNECTIONS, duration: DURATION_S });
}

const rows: Row[] = [];

for (const t of TARGETS) {
  const file = fileURLToPath(new URL(t.file, import.meta.url));
  const child = spawn('node', [file, String(t.port)], { stdio: 'ignore' });
  try {
    await waitReady(t.port);
    for (const route of t.routes) {
      const r = await measure(`http://127.0.0.1:${t.port}/${route}`);
      rows.push({
        server: t.name,
        strategy: route,
        rps: Math.round(r.requests.average),
        p50: r.latency.p50,
        p99: r.latency.p99,
        p999: r.latency.p99_9 ?? r.latency.p99,
        mbps: r.throughput.average / 1e6,
      });
    }
  } finally {
    child.kill('SIGKILL');
    await sleep(400);
  }
}

console.log(`\npayload = ${(PAYLOAD_BYTES / 1024).toFixed(1)} KB/response · ${CONNECTIONS} conns · ${DURATION_S}s measured\n`);
console.log(['server', 'strategy', 'req/s', 'p50 ms', 'p99 ms', 'p99.9 ms', 'MB/s'].map((h) => h.padEnd(11)).join(''));
console.log('-'.repeat(77));
for (const r of rows) {
  console.log(
    [r.server, r.strategy, r.rps.toLocaleString(), r.p50, r.p99, r.p999, r.mbps.toFixed(0)]
      .map((c) => String(c).padEnd(11))
      .join(''),
  );
}

function rps(server: string, strategy: string): number {
  return rows.find((r) => r.server === server && r.strategy === strategy)?.rps ?? 0;
}
const fmt = (a: number, b: number) => (b > 0 ? (a / b).toFixed(2) + 'x' : '—');

console.log('\n--- answers ---');
for (const s of ['node:http', 'hono', 'fastify']) {
  console.log(`${s}: buffer vs stringify = ${fmt(rps(s, 'buffer'), rps(s, 'stringify'))} faster`);
}
console.log(`fastify: fast-json-stringify vs naive stringify = ${fmt(rps('fastify', 'fjs'), rps('fastify', 'stringify'))}`);
console.log(`fastify: buffer vs fast-json-stringify = ${fmt(rps('fastify', 'buffer'), rps('fastify', 'fjs'))} (does pre-serialization beat Fastify's best?)`);
console.log(`framework on buffer: hono ${rps('hono', 'buffer').toLocaleString()} vs fastify ${rps('fastify', 'buffer').toLocaleString()} vs node ${rps('node:http', 'buffer').toLocaleString()} req/s`);
console.log(`framework on stringify: hono ${rps('hono', 'stringify').toLocaleString()} vs fastify ${rps('fastify', 'stringify').toLocaleString()} req/s`);
console.log('');
