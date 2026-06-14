/**
 * uWebSockets.js vs Hono vs node:http — single-process framework ceiling on tiny (~50 B) and the
 * real 28 KB list buffer. Verifies each server returns correct bytes BEFORE timing (so a uWS
 * Buffer-offset bug can't masquerade as throughput). Same connections/duration for all.
 *
 * Run: node experiments/http-serialization/run-bench-uws.ts
 */
import autocannon from 'autocannon';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { PAYLOAD_BYTES } from './data.ts';

const CONNECTIONS = 125;
const WARMUP_S = 2;
const DURATION_S = 8;
const CLIENT_WORKERS = 2;

const TARGETS = [
  { name: 'node:http', file: 'serve-node.ts', port: 3001 },
  { name: 'hono', file: 'serve-hono.ts', port: 3002 },
  { name: 'uWebSockets.js', file: 'serve-uws.ts', port: 3005 },
];
const ROUTES = ['tiny', 'buffer'];

async function fetchBytes(port: number, route: string): Promise<Buffer> {
  const r = await fetch(`http://127.0.0.1:${port}/${route}`);
  return Buffer.from(await r.arrayBuffer());
}

async function waitReadyAndVerify(port: number): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      const tiny = await fetchBytes(port, 'tiny');
      JSON.parse(tiny.toString('utf8')); // valid JSON
      const buf = await fetchBytes(port, 'buffer');
      if (buf.length !== PAYLOAD_BYTES) throw new Error(`/buffer ${buf.length} bytes != expected ${PAYLOAD_BYTES}`);
      JSON.parse(buf.toString('utf8')); // valid JSON, correct bytes
      return;
    } catch (e) {
      if (i === 99) throw e;
      await sleep(100);
    }
  }
}

const out: { name: string; route: string; rps: number; p99: number; mbps: number }[] = [];

for (const t of TARGETS) {
  const file = fileURLToPath(new URL(t.file, import.meta.url));
  const child = spawn('node', [file, String(t.port)], { stdio: 'ignore' });
  try {
    await waitReadyAndVerify(t.port);
    for (const route of ROUTES) {
      const url = `http://127.0.0.1:${t.port}/${route}`;
      await autocannon({ url, connections: CONNECTIONS, duration: WARMUP_S, workers: CLIENT_WORKERS });
      const r = await autocannon({ url, connections: CONNECTIONS, duration: DURATION_S, workers: CLIENT_WORKERS });
      out.push({ name: t.name, route, rps: Math.round(r.requests.average), p99: r.latency.p99, mbps: r.throughput.average / 1e6 });
    }
  } finally {
    child.kill('SIGKILL');
    await sleep(400);
  }
}

console.log(`\nsingle-process framework ceiling · ${CONNECTIONS} conns · ${DURATION_S}s · bytes verified correct first\n`);
console.log(['server', 'route', 'req/s', 'p99 ms', 'MB/s'].map((h) => h.padEnd(18)).join(''));
console.log('-'.repeat(72));
for (const r of out) {
  console.log([r.name, r.route, r.rps.toLocaleString(), r.p99, r.mbps.toFixed(0)].map((c) => String(c).padEnd(18)).join(''));
}
const g = (name: string, route: string) => out.find((r) => r.name === name && r.route === route)?.rps ?? 0;
const fmt = (a: number, b: number) => (b > 0 ? (a / b).toFixed(2) + 'x' : '—');
console.log('\n--- answers ---');
console.log(`tiny:   uWS ${g('uWebSockets.js', 'tiny').toLocaleString()} vs hono ${g('hono', 'tiny').toLocaleString()} vs node ${g('node:http', 'tiny').toLocaleString()} req/s  (uWS/hono ${fmt(g('uWebSockets.js', 'tiny'), g('hono', 'tiny'))})`);
console.log(`28KB:   uWS ${g('uWebSockets.js', 'buffer').toLocaleString()} vs hono ${g('hono', 'buffer').toLocaleString()} vs node ${g('node:http', 'buffer').toLocaleString()} req/s  (uWS/hono ${fmt(g('uWebSockets.js', 'buffer'), g('hono', 'buffer'))})`);
console.log('');
