import type { Engine } from './engine.ts';

/**
 * The durable-source SEAM. A `Store` knows how to build a fully-loaded, index-warmed {@link Engine}
 * from some source of truth — exactly the contract the in-code `seed()` already satisfies. The OSS
 * single-instance build uses {@link PostgresStore}; a future multi-instance build can swap in another
 * impl without the HTTP/engine layers changing.
 */
export interface Store {
  /** Build an Engine, load all rows, warm indexes, and return it ready to serve. */
  load(): Promise<Engine>;
}
