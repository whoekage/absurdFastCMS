/**
 * uWS-MIGRATION SLICE 2 bench — the READ path through the REAL uWS stack on a seeded Engine, with
 * the response cache ON. Confirms end-to-end throughput of the bench-validated send-the-buffer path
 * (no per-request JSON.stringify). Drives a REAL uWS server (the production server, createServer)
 * bound to a free port with autocannon — the same single-process stack the entrypoint serves.
 *
 * Run: node experiments/http-serialization/run-bench-slice3.ts
 */
import autocannon from 'autocannon';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { seed } from '../../src/http/fixtures.ts';
import { createServer } from '../../src/http/server.ts';

const CONNECTIONS = 100;
const WARMUP_S = 2;
const DURATION_S = 6;
const ROWS = 10000;

/** Allocate a free TCP port: listen on :0, read the OS-assigned port, close, return it. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr === null || typeof addr === 'string') {
        srv.close(() => reject(new Error('no port assigned')));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

const engine = seed(ROWS);
const server = createServer(engine);
const PORT = await freePort();
const token = await server.listen(PORT);

async function waitReady(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/article?pagination[limit]=25`);
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

const ROUTES: { label: string; path: string }[] = [
  { label: 'list page (25 rows)', path: '/article?pagination[limit]=25' },
  { label: 'list filtered+sorted', path: '/article?filters[status][$eq]=published&sort=views:desc&pagination[limit]=25' },
  { label: 'single item', path: '/article/42' },
];

const out: { label: string; rps: number; p99: number; bytes: number }[] = [];

try {
  await waitReady();
  for (const route of ROUTES) {
    const url = `http://127.0.0.1:${PORT}${route.path}`;
    await autocannon({ url, connections: CONNECTIONS, duration: WARMUP_S });
    const r = await autocannon({ url, connections: CONNECTIONS, duration: DURATION_S });
    out.push({
      label: route.label,
      rps: Math.round(r.requests.average),
      p99: r.latency.p99,
      bytes: Math.round(r.throughput.average),
    });
  }
} finally {
  server.close(token);
}

console.log(`\nREAL uWS stack · seeded Engine (${ROWS} rows) · response cache ON · ${CONNECTIONS} conns · ${DURATION_S}s\n`);
console.log(['route', 'req/s', 'p99 ms', 'MB/s'].map((h) => h.padEnd(24)).join(''));
console.log('-'.repeat(80));
for (const r of out) {
  console.log(
    [r.label, r.rps.toLocaleString(), r.p99, (r.bytes / 1e6).toFixed(1)]
      .map((c) => String(c).padEnd(24))
      .join(''),
  );
}
console.log(`\ncache: hits=${engine.cache.hits} misses=${engine.cache.misses} size=${engine.cache.size}`);
console.log('Order-of-magnitude: a hot cached query collapses to one Map.get + send-buffer (no assemble, no stringify).\n');
process.exit(0);
