/**
 * OFF-HEAP session store — a token→session map held entirely in ArrayBuffer-backed typed arrays and
 * byte arenas, NOT a JS `Map`. This is the same discipline the columnar engine uses for its columns
 * (see `store/column.ts`: `Float64Array` values, a UTF-8 arena + `Int32Array` offsets for text): the
 * data lives off the V8 object heap, so the garbage collector never traces it entry-by-entry. A plain
 * `Map<string, {…}>` of N live sessions is N+ long-lived heap objects the major GC re-marks every
 * full cycle — and it hard-caps at V8's 2^24 (~16.7M) Map limit. This structure has neither problem:
 * memory is a handful of large buffers, and capacity grows by doubling like the engine's columns.
 *
 * WHY a hand-rolled open-addressing table and not "just reuse an engine Table": the engine's own
 * token→row lookup IS a JS `Map` (`StringColumn.lookup`, the dictionary) and its EqIndex is Map-backed
 * too — so reusing it would reintroduce the exact 2^24 / GC problem we are escaping. The genuinely new
 * piece is therefore an **open-addressing hash table over an `Int32Array`** (hash the token bytes, probe
 * slots), which the engine does not have. Everything else (the value arena) mirrors the engine.
 *
 * SINGLE-INSTANCE / SINGLE-THREAD (the current target): the backing store is a regular `ArrayBuffer`,
 * so there are NO `Atomics` and no locking — every method runs to completion on the one event loop.
 * The layout is deliberately SAB-ready (fixed-width typed-array lanes + byte arenas, no per-entry
 * objects, index-as-handle), so a future move to a `SharedArrayBuffer` shared across worker_threads is
 * a swap of the buffer constructor + a slot-level CAS, NOT a rewrite. We do NOT pay that complexity
 * until worker_threads actually exist.
 *
 * RECORD LAYOUT — each record `rec` is SELF-CONTAINED via independent `(start, len)` lanes per value
 * (NOT shared-boundary offsets where `off[rec+1]` doubles as the next record's start): an in-place
 * userId rewrite must never disturb a neighbour, so the byte spans are addressed independently and the
 * stale bytes simply leak into the arena until the next {@link rebuild} reclaims them.
 *
 * CHURN model (sessions are insert/delete/expire heavy, unlike the engine's append-mostly columns):
 *   - records (token bytes, userId bytes, expiresAt) are APPENDED between rebuilds;
 *   - a delete marks the hash slot a TOMBSTONE and the record dead (its arena bytes leak until rebuild);
 *   - a {@link rebuild} (triggered when live+dead crosses the load factor) copies ONLY live records into
 *     fresh buffers and re-inserts them — this both GROWS (when live is high) and COMPACTS (reclaiming
 *     tombstoned / overwritten arena bytes) in one O(live) pass. After a rebuild deadCount is 0.
 *
 * TTL is NOT this store's concern: it stores `expiresAt` verbatim and the {@link SessionCache} layer
 * does the `Date.now()` compare + calls {@link delete} on an expired hit (lazy expiry, no timer).
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Initial slot capacity (a power of two — the probe index is `hash & (slotCap - 1)`). */
const INITIAL_SLOTS = 1024;
/** Initial record capacity and arena byte sizes; all grow by doubling. */
const INITIAL_RECORDS = 1024;
const INITIAL_ARENA = 1 << 16; // 64 KiB

/** A slot value of 0 means EMPTY (stop probing); -1 means TOMBSTONE (deleted — keep probing, reusable). */
const SLOT_EMPTY = 0;
const SLOT_TOMBSTONE = -1;

/** The value a {@link OffHeapSessionStore.get} resolves to — decoded out of the arenas on a hit. */
export interface StoredSession {
  userId: string;
  /** epoch ms; the session row's expiresAt (the caller applies the TTL compare). */
  expiresAt: number;
}

/**
 * FNV-1a (32-bit) over a byte array — a fast, well-dispersing non-cryptographic hash. The store keys on
 * session tokens (high-entropy base64url already), so we need spread, not cryptographic strength. The
 * SAME function hashes at insert and at lookup so the slot a token lands in is stable.
 */
function fnv1a(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    // h *= 16777619, kept in 32-bit via Math.imul; >>>0 normalizes to an unsigned word.
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export class OffHeapSessionStore {
  // ── hash table (open addressing, linear probing) ──────────────────────────────────────────────
  /** slot -> recordIndex+1 (>=1 live), SLOT_EMPTY (0), or SLOT_TOMBSTONE (-1). Power-of-two length. */
  private slots: Int32Array;
  private slotMask: number;

  // ── record lanes (parallel, indexed by recordIndex; independent (start,len) per value) ────────
  private recExpires: Float64Array; // epoch ms
  private recTokenStart: Int32Array;
  private recTokenLen: Int32Array;
  private recUserStart: Int32Array;
  private recUserLen: Int32Array;
  private recAlive: Uint8Array; // 1 = live, 0 = dead (tombstoned) — drives rebuild iteration
  private recCap: number;
  private recCount = 0; // records appended since the last rebuild (live + dead)

  // ── value arenas (UTF-8 bytes, like TextColumn) ───────────────────────────────────────────────
  private tokenBytes: Uint8Array;
  private tokenUsed = 0;
  private userBytes: Uint8Array;
  private userUsed = 0;

  private liveCount = 0;
  private deadCount = 0;
  /** Rolling record index for the incremental expiry sweep ({@link pruneExpired}). */
  private sweepCursor = 0;

  constructor(initialSlots = INITIAL_SLOTS) {
    const cap = ceilPow2(initialSlots);
    this.slots = new Int32Array(cap);
    this.slotMask = cap - 1;
    this.recCap = INITIAL_RECORDS;
    this.recExpires = new Float64Array(this.recCap);
    this.recTokenStart = new Int32Array(this.recCap);
    this.recTokenLen = new Int32Array(this.recCap);
    this.recUserStart = new Int32Array(this.recCap);
    this.recUserLen = new Int32Array(this.recCap);
    this.recAlive = new Uint8Array(this.recCap);
    this.tokenBytes = new Uint8Array(INITIAL_ARENA);
    this.userBytes = new Uint8Array(INITIAL_ARENA);
  }

  /** Number of LIVE sessions currently resident. */
  size(): number {
    return this.liveCount;
  }

  /**
   * Total records appended since the last {@link rebuild} (live + dead). Grows with INSERTS, not with
   * live count — a diagnostic/sizing seam (the sweep budgets its scan off this) and the quantity the
   * churn-compaction trigger bounds so sustained login/logout churn cannot grow the arenas without limit.
   */
  recordCount(): number {
    return this.recCount;
  }

  /**
   * EXACT off-heap footprint — the summed `byteLength` of every backing typed array / arena the store
   * owns. This is the "RAM held purely by storage" figure: deterministic and independent of V8 heap
   * accounting (these bytes live in ArrayBuffers, off the object heap). `total` should track
   * `process.memoryUsage().arrayBuffers` closely once other transient buffers are released.
   */
  memoryBytes(): { total: number; slots: number; lanes: number; tokenArena: number; userArena: number } {
    const slots = this.slots.byteLength;
    const lanes =
      this.recExpires.byteLength +
      this.recTokenStart.byteLength +
      this.recTokenLen.byteLength +
      this.recUserStart.byteLength +
      this.recUserLen.byteLength +
      this.recAlive.byteLength;
    const tokenArena = this.tokenBytes.byteLength;
    const userArena = this.userBytes.byteLength;
    return { total: slots + lanes + tokenArena + userArena, slots, lanes, tokenArena, userArena };
  }

  /**
   * Resolve a token to its stored session, or null when absent. Hashes the token bytes, then probes
   * linearly: an EMPTY slot ends the search (miss); a live slot whose stored token bytes equal the
   * query's is the hit; a TOMBSTONE is skipped. Touches ZERO heap-resident per-session objects — only
   * a transient encode of the query token and (on a hit) the decoded userId string, both short-lived.
   */
  get(token: string): StoredSession | null {
    const tb = enc.encode(token);
    const rec = this.findRecord(tb);
    if (rec < 0) return null;
    const us = this.recUserStart[rec]!;
    return {
      userId: dec.decode(this.userBytes.subarray(us, us + this.recUserLen[rec]!)),
      expiresAt: this.recExpires[rec]!,
    };
  }

  /**
   * Insert or update a session. An existing token updates its `expiresAt` in place (and rewrites userId
   * only if it actually changed) — better-auth refreshes a session's expiry on activity, so re-`set` of
   * a known token must not append a duplicate record nor bloat the arena. A new token appends a record
   * into the arenas and links the slot. Grows + compacts via {@link rebuild} when the table crosses its
   * load factor.
   */
  set(token: string, userId: string, expiresAt: number): void {
    // TWO rebuild triggers: (1) hash-table load factor — the slots are filling with live+tombstone
    // entries; (2) CHURN COMPACTION — recCount (records appended this generation) has outgrown live by
    // 2x, i.e. >half the arena is dead bytes from deleted/expired tokens. Without (2), a steady
    // login/logout stream at constant live size reuses tombstone SLOTS (so deadCount stays ~0 and (1)
    // never fires) while appending a fresh record every insert — the arenas would grow unbounded. (2)
    // forces an O(live) compaction that resets recCount to live, so memory tracks live, not cumulative churn.
    if (
      (this.liveCount + this.deadCount) * 10 >= this.slots.length * 7 ||
      this.recCount > (this.liveCount + 1) * 2
    ) {
      this.rebuild();
    }
    const tb = enc.encode(token);
    const ub = enc.encode(userId);
    const h = fnv1a(tb);
    let i = h & this.slotMask;
    let firstTomb = -1;
    for (;;) {
      const s = this.slots[i]!;
      if (s === SLOT_EMPTY) {
        // Reuse an earlier tombstone slot if we passed one (keeps probe chains short).
        const slot = firstTomb === -1 ? i : firstTomb;
        this.appendRecord(slot, tb, ub, expiresAt);
        return;
      }
      if (s === SLOT_TOMBSTONE) {
        if (firstTomb === -1) firstTomb = i;
      } else if (this.tokenEquals(s - 1, tb)) {
        // Known token: update expiry in place; rewrite userId only when it differs (avoids arena bloat
        // on the common expiry-refresh path, where userId is unchanged).
        const rec = s - 1;
        this.recExpires[rec] = expiresAt;
        if (!this.userEquals(rec, ub)) this.writeUser(rec, ub);
        return;
      }
      i = (i + 1) & this.slotMask;
    }
  }

  /**
   * Remove a token. Marks its slot a TOMBSTONE and the record dead (arena bytes reclaimed on the next
   * {@link rebuild}). Returns true if a live session was removed. This is the logout/expiry path —
   * O(probe), no allocation beyond the transient token encode.
   */
  delete(token: string): boolean {
    const tb = enc.encode(token);
    const h = fnv1a(tb);
    let i = h & this.slotMask;
    for (;;) {
      const s = this.slots[i]!;
      if (s === SLOT_EMPTY) return false;
      if (s !== SLOT_TOMBSTONE && this.tokenEquals(s - 1, tb)) {
        this.recAlive[s - 1] = 0;
        this.slots[i] = SLOT_TOMBSTONE;
        this.liveCount--;
        this.deadCount++;
        return true;
      }
      i = (i + 1) & this.slotMask;
    }
  }

  /**
   * ACTIVE EXPIRY — incrementally evict sessions whose `expiresAt <= nowMs`. Without this, an expired
   * session that is never re-validated (the user closed the tab / re-logged-in to a new token) would
   * sit resident until process restart, because expiry is otherwise only resolved lazily on a re-read.
   *
   * INCREMENTAL by design: it scans at most `maxScan` records from a rolling cursor, tombstoning the
   * expired live ones, so a single tick is bounded work (never an O(n) stall on a 10M store) and a full
   * pass completes over several ticks. The freed records are reclaimed (arena bytes) by the NEXT
   * {@link set}'s churn-compaction rebuild — eviction here just drops live count + tombstones the slot,
   * which is what stops `get` returning them. Returns the scan/eviction counts (a test/telemetry seam).
   */
  pruneExpired(nowMs: number, maxScan: number): { scanned: number; expired: number } {
    let scanned = 0;
    let expired = 0;
    const total = this.recCount;
    if (total === 0) return { scanned, expired };
    let rec = this.sweepCursor >= total ? 0 : this.sweepCursor;
    const limit = Math.min(maxScan, total);
    for (let n = 0; n < limit; n++) {
      if (rec >= total) rec = 0;
      if (this.recAlive[rec] === 1 && this.recExpires[rec]! <= nowMs) {
        this.tombstoneByRecord(rec);
        expired++;
      }
      rec++;
      scanned++;
    }
    this.sweepCursor = rec;
    return { scanned, expired };
  }

  // ── internals ─────────────────────────────────────────────────────────────────────────────────

  /**
   * Tombstone the slot pointing at record `rec` and mark it dead — the by-record equivalent of
   * {@link delete} (used by the expiry sweep, which holds a record index, not a token). Re-hashes the
   * record's stored token bytes to enter its probe chain, then matches the slot whose payload is exactly
   * `rec+1` (no token compare needed — the slot→record link is unique).
   */
  private tombstoneByRecord(rec: number): void {
    const ts = this.recTokenStart[rec]!;
    const tb = this.tokenBytes.subarray(ts, ts + this.recTokenLen[rec]!);
    let i = fnv1a(tb) & this.slotMask;
    for (;;) {
      const s = this.slots[i]!;
      if (s === SLOT_EMPTY) return; // unreachable for a live record; defensive
      if (s !== SLOT_TOMBSTONE && s - 1 === rec) {
        this.slots[i] = SLOT_TOMBSTONE;
        this.recAlive[rec] = 0;
        this.liveCount--;
        this.deadCount++;
        return;
      }
      i = (i + 1) & this.slotMask;
    }
  }

  /** Probe for a token; returns its record index or -1. */
  private findRecord(tb: Uint8Array): number {
    const h = fnv1a(tb);
    let i = h & this.slotMask;
    for (;;) {
      const s = this.slots[i]!;
      if (s === SLOT_EMPTY) return -1;
      if (s !== SLOT_TOMBSTONE && this.tokenEquals(s - 1, tb)) return s - 1;
      i = (i + 1) & this.slotMask;
    }
  }

  /** Byte-equality of record `rec`'s stored token against `tb` (length then memcmp) — no allocation. */
  private tokenEquals(rec: number, tb: Uint8Array): boolean {
    const len = this.recTokenLen[rec]!;
    if (len !== tb.length) return false;
    const start = this.recTokenStart[rec]!;
    const buf = this.tokenBytes;
    for (let k = 0; k < len; k++) if (buf[start + k] !== tb[k]) return false;
    return true;
  }

  /** Byte-equality of record `rec`'s stored userId against `ub` — no allocation. */
  private userEquals(rec: number, ub: Uint8Array): boolean {
    const len = this.recUserLen[rec]!;
    if (len !== ub.length) return false;
    const start = this.recUserStart[rec]!;
    const buf = this.userBytes;
    for (let k = 0; k < len; k++) if (buf[start + k] !== ub[k]) return false;
    return true;
  }

  /** Append a fresh record into the lanes/arenas and point `slot` at it. Caller resolved the slot. */
  private appendRecord(slot: number, tb: Uint8Array, ub: Uint8Array, expiresAt: number): void {
    const wasTomb = this.slots[slot] === SLOT_TOMBSTONE;
    const rec = this.recCount;
    this.ensureRecords();
    // token bytes
    this.ensureToken(tb.length);
    this.recTokenStart[rec] = this.tokenUsed;
    this.recTokenLen[rec] = tb.length;
    this.tokenBytes.set(tb, this.tokenUsed);
    this.tokenUsed += tb.length;
    // userId bytes
    this.ensureUser(ub.length);
    this.recUserStart[rec] = this.userUsed;
    this.recUserLen[rec] = ub.length;
    this.userBytes.set(ub, this.userUsed);
    this.userUsed += ub.length;
    // scalar lanes
    this.recExpires[rec] = expiresAt;
    this.recAlive[rec] = 1;
    this.recCount = rec + 1;
    this.slots[slot] = rec + 1;
    this.liveCount++;
    if (wasTomb) this.deadCount--; // a tombstone slot was reclaimed (not an extra dead record)
  }

  /** Overwrite an existing record's userId bytes (append-to-arena; old bytes leak until rebuild). */
  private writeUser(rec: number, ub: Uint8Array): void {
    this.ensureUser(ub.length);
    this.recUserStart[rec] = this.userUsed;
    this.recUserLen[rec] = ub.length;
    this.userBytes.set(ub, this.userUsed);
    this.userUsed += ub.length;
  }

  private ensureRecords(): void {
    if (this.recCount < this.recCap) return;
    const next = this.recCap * 2;
    this.recExpires = growF64(this.recExpires, next);
    this.recTokenStart = growI32(this.recTokenStart, next);
    this.recTokenLen = growI32(this.recTokenLen, next);
    this.recUserStart = growI32(this.recUserStart, next);
    this.recUserLen = growI32(this.recUserLen, next);
    this.recAlive = growU8(this.recAlive, next);
    this.recCap = next;
  }

  private ensureToken(need: number): void {
    if (this.tokenUsed + need <= this.tokenBytes.length) return;
    let cap = this.tokenBytes.length;
    while (cap < this.tokenUsed + need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.tokenBytes);
    this.tokenBytes = next;
  }

  private ensureUser(need: number): void {
    if (this.userUsed + need <= this.userBytes.length) return;
    let cap = this.userBytes.length;
    while (cap < this.userUsed + need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.userBytes);
    this.userBytes = next;
  }

  /**
   * Rebuild the whole structure with ONLY live records, into fresh right-sized buffers — this is both
   * the GROW path (live count high → bigger slot table) and the COMPACTION path (many tombstones /
   * overwritten userIds → reclaim the leaked arena bytes). One O(live) pass; afterwards deadCount is 0
   * and every arena holds only live bytes. New slot capacity keeps live below a 0.5 load factor so
   * probe chains stay short.
   */
  private rebuild(): void {
    const oldRecCount = this.recCount;
    const oldExpires = this.recExpires;
    const oldTokenStart = this.recTokenStart;
    const oldTokenLen = this.recTokenLen;
    const oldUserStart = this.recUserStart;
    const oldUserLen = this.recUserLen;
    const oldAlive = this.recAlive;
    const oldTokenBytes = this.tokenBytes;
    const oldUserBytes = this.userBytes;
    const live = this.liveCount;

    const slotCap = ceilPow2(Math.max(INITIAL_SLOTS, live * 2 + 1));
    this.slots = new Int32Array(slotCap);
    this.slotMask = slotCap - 1;
    this.recCap = Math.max(INITIAL_RECORDS, live * 2);
    this.recExpires = new Float64Array(this.recCap);
    this.recTokenStart = new Int32Array(this.recCap);
    this.recTokenLen = new Int32Array(this.recCap);
    this.recUserStart = new Int32Array(this.recCap);
    this.recUserLen = new Int32Array(this.recCap);
    this.recAlive = new Uint8Array(this.recCap);
    this.tokenBytes = new Uint8Array(Math.max(INITIAL_ARENA, ceilPow2(this.tokenUsed + 1)));
    this.userBytes = new Uint8Array(Math.max(INITIAL_ARENA, ceilPow2(this.userUsed + 1)));
    this.tokenUsed = 0;
    this.userUsed = 0;
    this.recCount = 0;
    this.liveCount = 0;
    this.deadCount = 0;
    this.sweepCursor = 0; // record indices are reassigned by the rebuild; restart the sweep

    for (let rec = 0; rec < oldRecCount; rec++) {
      if (oldAlive[rec] !== 1) continue;
      const ts = oldTokenStart[rec]!;
      const us = oldUserStart[rec]!;
      const tb = oldTokenBytes.subarray(ts, ts + oldTokenLen[rec]!);
      const ub = oldUserBytes.subarray(us, us + oldUserLen[rec]!);
      this.insertFresh(tb, ub, oldExpires[rec]!);
    }
  }

  /** Insert a known-absent token during {@link rebuild} (no duplicate check, slot is always empty). */
  private insertFresh(tb: Uint8Array, ub: Uint8Array, expiresAt: number): void {
    const h = fnv1a(tb);
    let i = h & this.slotMask;
    while (this.slots[i] !== SLOT_EMPTY) i = (i + 1) & this.slotMask;
    this.appendRecord(i, tb, ub, expiresAt);
  }
}

/** Smallest power of two >= n (n >= 1). */
function ceilPow2(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

function growF64(a: Float64Array, n: number): Float64Array {
  const next = new Float64Array(n);
  next.set(a);
  return next;
}
function growI32(a: Int32Array, n: number): Int32Array {
  const next = new Int32Array(n);
  next.set(a);
  return next;
}
function growU8(a: Uint8Array, n: number): Uint8Array {
  const next = new Uint8Array(n);
  next.set(a);
  return next;
}
