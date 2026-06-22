/**
 * OFF-HEAP, APPEND-ONLY string interner — a `string -> int code` dictionary held entirely in
 * ArrayBuffer-backed typed arrays + a UTF-8 byte arena, NOT a JS `Map<string, number>` plus a
 * `string[]`. This is the same off-heap discipline as {@link OffHeapSessionStore} (open-addressing
 * hash over an `Int32Array`, FNV-1a over the UTF-8 bytes, a growable byte arena with independent
 * `(start, len)` lanes per entry), GENERALIZED to the columnar dictionary use:
 *
 *   - APPEND-ONLY: a column dictionary never removes a code (a rebuild constructs a fresh interner),
 *     so there are NO deletes, NO tombstones, NO TTL, NO churn-compaction, NO `rebuild` — every
 *     wrinkle of the session store that exists only to reclaim deleted/expired records is dropped.
 *     `intern(s)` either returns the existing code or appends the bytes and assigns the next code;
 *     `decode(code)` recovers the exact stored string; `size()` is the distinct count.
 *
 * WHY off-heap: the previous {@link StringColumn} dictionary was a `Map<string, number>` (the intern
 * table) + a `string[]` (code -> string). On a HIGH-cardinality column (near-unique title/slug) the
 * Map grows to ~the data size and throws `RangeError: Map maximum size exceeded` at V8's 2^24 (~16.7M)
 * entry ceiling, and the `string[]` pins N long-lived heap strings the major GC re-traces every cycle.
 * This structure has NEITHER problem: the codes live in one `Int32Array`, the strings in one UTF-8
 * `Uint8Array` arena, so a dictionary of any size is a handful of large buffers off the object heap.
 *
 * BYTE-EXACT round-trip is the contract the whole engine rests on (the response oracle pins
 * `JSON.stringify` equivalence): `decode(intern(s)) === s` for EVERY string, including multi-byte
 * UTF-8 and the empty string. We encode to UTF-8 at intern and decode back at read; the empty string
 * interns to a real code with a zero-length arena slice (NOT confused with NULL — NULL is the Table's
 * per-column null bitset, never this interner's concern).
 *
 * MINIMUM ALLOCATION is deliberately SMALL so a low-cardinality column (a 3-value enum / locale /
 * status) costs ~KBs, not MBs: the initial slot table is 256 entries (1 KiB) and the arena 1 KiB.
 * The buffers grow by doubling exactly like the engine's columns, so a high-card column still scales.
 *
 * SINGLE-THREAD (the engine's target): a plain `ArrayBuffer`, no `Atomics`, no locking. The layout is
 * SAB-ready (fixed-width lanes + a byte arena, index-as-handle) should worker_threads ever arrive.
 *
 * RESIDUAL CEILING — the arena offset lane is `Int32Array`, so a code's `(start, len)` is a SIGNED
 * 32-bit byte offset: the arena can hold at most {@link ARENA_MAX} = 2^31 - 1 (~2 GiB) of distinct
 * UTF-8 bytes ACROSS ALL distinct values. (The distinct-COUNT ceiling — codes themselves — is the far
 * larger ~2^31 from the slot table, a huge lift over the old `Map`'s 2^24.) This byte ceiling is only
 * reachable for a high-card column whose distinct text is genuinely enormous (e.g. ~17M near-unique
 * ~130-byte titles ≈ 2.2 GiB). It is enforced as a LOUD, NAMED throw in {@link OffHeapStringInterner.append}
 * / {@link OffHeapStringArena.push} — NEVER a silent Int32 wrap that would return wrong bytes (a
 * byte-different response is the cardinal sin). This preserves the OLD `Map`'s loud-fail contract
 * (it threw a `RangeError` at 16.7M) at a ~128x-higher boundary. Widening the offset lane to
 * `Float64Array` (safe integers to 2^53) is the path if a single column dictionary must exceed 2 GiB.
 *
 * REUSED ELSEWHERE (off-heap, NO residual Map): {@link EqIndex} (value->MANY-rows postings, be-22b)
 * and the StringColumn folded-key -> raw-codes grouping (the `-i` `$eqi`/`$nei` path, be-22f) both
 * use THIS interner + a flat CSR instead of a `Map`, so a high-card column that is ALSO eq-indexed or
 * hit with case-insensitive operators no longer overflows the old 2^24 Map ceiling.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * Max arena size in bytes — the largest offset an `Int32Array` lane can hold without sign-bit wrap
 * (2^31 - 1). Exceeding it would truncate `used` to a NEGATIVE start and silently corrupt decode, so
 * the arena guards against it with a named throw instead.
 */
const ARENA_MAX = 0x7fffffff;

/**
 * Initial slot capacity (a power of two — the probe index is `hash & (slotCap - 1)`). SMALL on
 * purpose: a 3-value enum must not pay megabytes. 256 slots is 1 KiB.
 */
const INITIAL_SLOTS = 256;
/** Initial code-lane capacity (entries) and arena byte size; both grow by doubling. */
const INITIAL_CODES = 256;
const INITIAL_ARENA = 1024; // 1 KiB

/** A slot value of 0 means EMPTY (stop probing). There are NO tombstones — append-only never deletes. */
const SLOT_EMPTY = 0;

/**
 * FNV-1a (32-bit) over a byte array — the SAME well-dispersing non-cryptographic hash the session
 * store uses, hashing at intern and at lookup so a string always lands in the same probe chain.
 */
function fnv1a(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Smallest power of two >= n (n >= 1). */
function ceilPow2(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

export class OffHeapStringInterner {
  // ── hash table (open addressing, linear probing) ──────────────────────────────────────────────
  /** slot -> code+1 (>=1 occupied) or SLOT_EMPTY (0). Power-of-two length; grows by doubling. */
  private slots: Int32Array;
  private slotMask: number;

  // ── per-code lanes (parallel, indexed by code; independent (start,len) into the arena) ─────────
  private codeStart: Int32Array;
  private codeLen: Int32Array;
  private codeCap: number;
  private codeCount = 0;

  // ── value arena (UTF-8 bytes, one buffer for every distinct string) ────────────────────────────
  private bytes: Uint8Array;
  private used = 0;

  constructor(initialSlots = INITIAL_SLOTS) {
    const cap = ceilPow2(initialSlots);
    this.slots = new Int32Array(cap);
    this.slotMask = cap - 1;
    this.codeCap = INITIAL_CODES;
    this.codeStart = new Int32Array(this.codeCap);
    this.codeLen = new Int32Array(this.codeCap);
    this.bytes = new Uint8Array(INITIAL_ARENA);
  }

  /** Distinct interned strings (the next code to be assigned). */
  size(): number {
    return this.codeCount;
  }

  /**
   * Intern `s`: return its existing code, or append its UTF-8 bytes and assign the next code. The
   * probe is identical in shape to a Map `get`-or-insert, but over the off-heap slot table: hash the
   * bytes, linear-probe until either a byte-equal occupied slot (the existing code) or an EMPTY slot
   * (a miss — append + link). NO tombstones to skip; append-only never frees a slot.
   */
  intern(s: string): number {
    const sb = enc.encode(s);
    if ((this.codeCount + 1) * 10 >= this.slots.length * 7) this.growSlots();
    const h = fnv1a(sb);
    let i = h & this.slotMask;
    for (;;) {
      const slot = this.slots[i]!;
      if (slot === SLOT_EMPTY) {
        const code = this.append(sb);
        this.slots[i] = code + 1;
        return code;
      }
      if (this.codeEquals(slot - 1, sb)) return slot - 1;
      i = (i + 1) & this.slotMask;
    }
  }

  /**
   * Resolve `s` to its code WITHOUT interning it — returns `undefined` when `s` was never seen. The
   * read-side equivalent of `Map.get`, used by the equality/set operators to turn a query value into
   * a code (a value absent from the dictionary contributes no code, so `$eq` matches nothing).
   */
  codeOf(s: string): number | undefined {
    const sb = enc.encode(s);
    const h = fnv1a(sb);
    let i = h & this.slotMask;
    for (;;) {
      const slot = this.slots[i]!;
      if (slot === SLOT_EMPTY) return undefined;
      if (this.codeEquals(slot - 1, sb)) return slot - 1;
      i = (i + 1) & this.slotMask;
    }
  }

  /** Decode `code` back to its exact stored string (UTF-8 decode of the code's arena slice). */
  decode(code: number): string {
    const start = this.codeStart[code]!;
    const len = this.codeLen[code]!;
    if (len === 0) return '';
    return dec.decode(this.bytes.subarray(start, start + len));
  }

  /**
   * EXACT off-heap footprint — the summed `byteLength` of every backing buffer. A low-card column
   * should read in the low KiBs here; a test asserts a 3-value enum stays tiny.
   */
  memoryBytes(): { total: number; slots: number; lanes: number; arena: number } {
    const slots = this.slots.byteLength;
    const lanes = this.codeStart.byteLength + this.codeLen.byteLength;
    const arena = this.bytes.byteLength;
    return { total: slots + lanes + arena, slots, lanes, arena };
  }

  // ── internals ─────────────────────────────────────────────────────────────────────────────────

  /** Byte-equality of code `code`'s stored bytes against `sb` (length then memcmp) — no allocation. */
  private codeEquals(code: number, sb: Uint8Array): boolean {
    const len = this.codeLen[code]!;
    if (len !== sb.length) return false;
    const start = this.codeStart[code]!;
    const buf = this.bytes;
    for (let k = 0; k < len; k++) if (buf[start + k] !== sb[k]) return false;
    return true;
  }

  /** Append `sb` into the arena + lanes, assign and return the next code. */
  private append(sb: Uint8Array): number {
    const code = this.codeCount;
    this.ensureCodes();
    this.ensureArena(sb.length);
    this.codeStart[code] = this.used;
    this.codeLen[code] = sb.length;
    this.bytes.set(sb, this.used);
    this.used += sb.length;
    this.codeCount = code + 1;
    return code;
  }

  private ensureCodes(): void {
    if (this.codeCount < this.codeCap) return;
    const next = this.codeCap * 2;
    const ns = new Int32Array(next);
    ns.set(this.codeStart);
    this.codeStart = ns;
    const nl = new Int32Array(next);
    nl.set(this.codeLen);
    this.codeLen = nl;
    this.codeCap = next;
  }

  private ensureArena(need: number): void {
    // GUARD the signed-32-bit offset lane: once the arena would pass 2^31-1 bytes, `used` no longer
    // fits an Int32 start lane and would wrap NEGATIVE — a silent byte-corrupting decode. Fail LOUD
    // (the old Map threw a RangeError at 16.7M distinct; we throw at ~2 GiB of distinct bytes).
    if (this.used + need > ARENA_MAX) {
      throw new RangeError(
        `OffHeapStringInterner arena exceeded 2 GiB (${ARENA_MAX} bytes) — column dictionary too large; ` +
          `widen the offset lane to Float64Array to support a >2 GiB single-column dictionary`,
      );
    }
    if (this.used + need <= this.bytes.length) return;
    let cap = this.bytes.length;
    while (cap < this.used + need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.bytes);
    this.bytes = next;
  }

  /**
   * Double the slot table and re-insert every existing code (open addressing cannot resize in place
   * — the mask changed, so every slot is re-probed). Append-only means there are no tombstones to
   * drop; we just re-hash each code's stored bytes into the larger table. O(distinct) on growth only.
   */
  private growSlots(): void {
    const cap = this.slots.length * 2;
    const slots = new Int32Array(cap);
    const mask = cap - 1;
    const buf = this.bytes;
    for (let code = 0; code < this.codeCount; code++) {
      const start = this.codeStart[code]!;
      const len = this.codeLen[code]!;
      let i = fnv1a(buf.subarray(start, start + len)) & mask;
      while (slots[i] !== SLOT_EMPTY) i = (i + 1) & mask;
      slots[i] = code + 1;
    }
    this.slots = slots;
    this.slotMask = mask;
  }
}

/**
 * Append-only, NON-deduping, code-aligned UTF-8 string store — the off-heap replacement for a
 * code-aligned `string[]` (e.g. {@link StringColumn}'s parallel folded dictionary, where slot `code`
 * holds `fold(dict[code])`). Unlike {@link OffHeapStringInterner} it does NOT hash or dedup: `push(s)`
 * always appends a fresh slot (so a duplicate folded value still gets its own code-aligned entry) and
 * returns its index, keeping a 1:1 alignment with the raw dictionary code. Just the byte arena + the
 * `(start, len)` lanes — no slot table — so it is even cheaper than the interner.
 *
 * Round-trips byte-exact (UTF-8 encode at push, decode at read), same minimum-small allocation policy.
 * Shares the {@link OffHeapStringInterner} 2 GiB arena ceiling (Int32 offset lane) and the same loud,
 * named throw in {@link OffHeapStringArena.push} — never a silent Int32 wrap that returns wrong bytes.
 */
export class OffHeapStringArena {
  private codeStart: Int32Array;
  private codeLen: Int32Array;
  private codeCap: number;
  private codeCount = 0;
  private bytes: Uint8Array;
  private used = 0;

  constructor() {
    this.codeCap = INITIAL_CODES;
    this.codeStart = new Int32Array(this.codeCap);
    this.codeLen = new Int32Array(this.codeCap);
    this.bytes = new Uint8Array(INITIAL_ARENA);
  }

  /** Number of stored entries (the index the next push will land at). */
  size(): number {
    return this.codeCount;
  }

  /** Append `s` (no dedup) and return its code-aligned index. */
  push(s: string): number {
    const sb = enc.encode(s);
    const code = this.codeCount;
    if (this.codeCount >= this.codeCap) {
      const next = this.codeCap * 2;
      const ns = new Int32Array(next);
      ns.set(this.codeStart);
      this.codeStart = ns;
      const nl = new Int32Array(next);
      nl.set(this.codeLen);
      this.codeLen = nl;
      this.codeCap = next;
    }
    // GUARD the signed-32-bit offset lane (same 2 GiB ceiling + loud throw as OffHeapStringInterner).
    if (this.used + sb.length > ARENA_MAX) {
      throw new RangeError(
        `OffHeapStringArena arena exceeded 2 GiB (${ARENA_MAX} bytes) — folded dictionary too large; ` +
          `widen the offset lane to Float64Array to support a >2 GiB single-column dictionary`,
      );
    }
    if (this.used + sb.length > this.bytes.length) {
      let cap = this.bytes.length;
      while (cap < this.used + sb.length) cap *= 2;
      const nb = new Uint8Array(cap);
      nb.set(this.bytes);
      this.bytes = nb;
    }
    this.codeStart[code] = this.used;
    this.codeLen[code] = sb.length;
    this.bytes.set(sb, this.used);
    this.used += sb.length;
    this.codeCount = code + 1;
    return code;
  }

  /** Decode entry `code` back to its exact stored string. */
  decode(code: number): string {
    const len = this.codeLen[code]!;
    if (len === 0) return '';
    const start = this.codeStart[code]!;
    return dec.decode(this.bytes.subarray(start, start + len));
  }
}
