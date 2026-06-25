import type { Sql } from 'postgres';
import type { Engine, EngineOptions } from '../store/engine.ts';
import { Registry } from './registry.ts';
import type { Schema, ComponentSchema } from './schema/model.ts';
import { buildEngine } from './engine.loader.ts';
import { createSql } from './database.client.ts';

/**
 * The Postgres-backed durable source. {@link loadFromSchemas} builds the content-type
 * {@link Registry} from committed schema OBJECTS, then CURSOR-STREAMS every type's `ct_<apiId>` table into a
 * fresh Engine (type-aware coercion per the registry), warming each type's indexes once. The Postgres
 * `id` (serial PK) becomes the engine's public `id`. Empty catalog / empty type are valid.
 *
 * Connection ownership: construct with a `DATABASE_URL` string (or nothing, to read it from the env)
 * and the store OWNS the postgres.js handle — call {@link close} when done. Construct with an existing
 * `Sql` handle (e.g. a test sharing one connection) and the caller keeps ownership.
 */
export class PostgresStore {
  /** The live postgres.js handle — also used by the write repo for INSERT/UPDATE/DELETE. */
  readonly sql: Sql;
  private readonly ownsSql: boolean;

  constructor(source?: string | Sql) {
    if (typeof source === 'function') {
      // postgres.js `Sql` handles are callable (tagged-template) functions.
      this.sql = source;
      this.ownsSql = false;
    } else {
      this.sql = createSql(source);
      this.ownsSql = true;
    }
  }

  /**
   * FILES-FIRST load (the permanent path): build the registry from committed schema OBJECTS (read at the
   * EDGE by the composition root via `loadSchemaDir`), then CURSOR-STREAM the `ct_` data into a fresh engine.
   * The server needs BOTH the registry (to resolve write defs) and the engine (to serve reads) from the SAME
   * boot snapshot. The `ct_` tables are materialized by `migrate()` before this runs, so the schema source
   * and the physical tables agree.
   */
  async loadFromSchemas(schemas: Schema[], components: ComponentSchema[] = [], opts?: EngineOptions): Promise<{ engine: Engine; registry: Registry }> {
    const registry = Registry.fromSchemas(schemas, components);
    const engine = await buildEngine(this.sql, registry, opts);
    return { engine, registry };
  }

  /** Close the owned connection (no-op when an external `Sql` handle was injected). */
  async close(): Promise<void> {
    if (this.ownsSql) await this.sql.end();
  }
}
