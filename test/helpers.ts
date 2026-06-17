import net from 'node:net';
import type { Sql } from 'postgres';
import { PostgresStore } from '../src/db/postgres-store.ts';
import { createServer } from '../src/http/app.ts';
import type { Engine } from '../src/store/engine.ts';
import type { Registry } from '../src/store/registry.ts';

/** Shared test helpers: extracted verbatim from the per-file copies so behavior stays byte-identical. */

/** Reserve an ephemeral OS port (bind :0, read it back, release) for a server to listen on next. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const { port } = addr;
        srv.close(() => resolve(port));
      } else srv.close(() => reject(new Error('no port')));
    });
    srv.on('error', reject);
  });
}

/** Clean-start each test: drop every runtime per-type table + wipe the catalog (never the static `articles`). */
export async function cleanCatalog(sql: Sql): Promise<void> {
  // Drop link tables FIRST (not ct_-prefixed; the ct_ sweep below misses them). Read names from meta.
  const links = await sql<{ link_table: string }[]>`SELECT DISTINCT link_table FROM content_type_relations`;
  for (const { link_table } of links) await sql.unsafe(`DROP TABLE IF EXISTS "${link_table}" CASCADE`);
  const tables = await sql<{ table_name: string }[]>`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'ct\\_%'`;
  for (const { table_name } of tables) await sql.unsafe(`DROP TABLE IF EXISTS "${table_name}" CASCADE`);
  await sql`TRUNCATE content_type_relations, content_type_fields, content_types RESTART IDENTITY CASCADE`;
}

/** Whether a table physically exists. */
export async function tableExists(sql: Sql, table: string): Promise<boolean> {
  const r = await sql`SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ${table}`;
  return r.length > 0;
}

/** Read the real columns of a table from information_schema, in ordinal order. */
export async function physicalColumns(sql: Sql, table: string): Promise<{ name: string; type: string; nullable: boolean }[]> {
  const rows = await sql<{ column_name: string; data_type: string; udt_name: string; is_nullable: string; character_maximum_length: number | null; numeric_precision: number | null; numeric_scale: number | null }[]>`
    SELECT column_name, data_type, udt_name, is_nullable, character_maximum_length, numeric_precision, numeric_scale
    FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${table} ORDER BY ordinal_position
  `;
  return rows.map((r) => ({ name: r.column_name, type: r.data_type, nullable: r.is_nullable === 'YES' }));
}

/**
 * Extract the raw bytes of one field from a single-item response (avoids JSON.parse precision loss).
 * Accepts a Buffer or string; depth-tracking walk reads a string value or a balanced object/array.
 */
export function rawField(buf: Buffer | string, field: string): string {
  const s = typeof buf === 'string' ? buf : buf.toString('utf8');
  const key = `"${field}":`;
  const start = s.indexOf(key) + key.length;
  let depth = 0;
  let i = start;
  if (s[i] === '"') {
    i++;
    while (i < s.length && s[i] !== '"') {
      if (s[i] === '\\') i++;
      i++;
    }
    return s.slice(start, i + 1);
  }
  while (i < s.length) {
    const c = s[i]!;
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      if (depth === 0) break;
      depth--;
    } else if (c === ',' && depth === 0) break;
    i++;
  }
  return s.slice(start, i);
}

/** Bring up a real uWS server over the given sql: load engine+registry, create + listen on a free port. */
export async function startTestServer(
  sql: Sql,
): Promise<{ base: string; close: (token: unknown) => void; token: unknown; engine: Engine; registry: Registry }> {
  const store = new PostgresStore(sql);
  const { engine, registry } = await store.loadWithRegistry();
  const server = createServer(engine, store, registry);
  const port = await freePort();
  const token = await server.listen(port);
  return { base: `http://127.0.0.1:${port}`, close: server.close, token, engine, registry };
}
