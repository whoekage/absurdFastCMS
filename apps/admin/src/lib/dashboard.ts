import type { ModuleDefinition, Entry } from '@conti/sdk';

// Re-export the shared error-message extractor so the dashboard feature has one import surface.
export { errorMessage } from '@/lib/errors';

/**
 * TanStack Query keys for the Lua dashboard, namespaced under `['dashboard', ...]` so the dashboard's
 * derived/aggregated queries never collide with the per-type content-manager cache (`['content', ...]`).
 */
export const dashboardKeys = {
  all: ['dashboard'] as const,
  /** The module catalog the dashboard aggregates over. */
  types: () => ['dashboard', 'types'] as const,
  /** The live row count for one type (drives a stat card). */
  count: (name: string) => ['dashboard', 'count', name] as const,
  /** The few newest entries of one type (fed into the "pick up where you left off" merge). */
  recent: (name: string) => ['dashboard', 'recent', name] as const,
};

/**
 * Pick which types get a stat card (cap ~4). We prefer the canonical modules — article, product,
 * author — when they exist, then backfill with the remaining types in catalog order, so a fresh project
 * still shows real cards. Returns the ordered api_ids.
 */
const PREFERRED_TYPES = ['article', 'product', 'author'] as const;

export function statCardTypes(defs: readonly ModuleDefinition[], cap = 3): string[] {
  const present = new Set(defs.map((d) => d.name));
  const preferred = PREFERRED_TYPES.filter((t) => present.has(t));
  const rest = defs.map((d) => d.name).filter((id) => !preferred.includes(id as never));
  return [...preferred, ...rest].slice(0, cap);
}

/**
 * Pick which types to pull recent entries from for the resume strip. Same preference ordering as the
 * stat cards but a touch wider so the merge has enough candidates to surface the 3 globally-newest.
 */
export function resumeSourceTypes(defs: readonly ModuleDefinition[], cap = 5): string[] {
  const present = new Set(defs.map((d) => d.name));
  const preferred = PREFERRED_TYPES.filter((t) => present.has(t));
  const rest = defs.map((d) => d.name).filter((id) => !preferred.includes(id as never));
  return [...preferred, ...rest].slice(0, cap);
}

/** A recent entry, flattened for the resume strip (carries its source type so the card can link + label). */
export interface RecentEntry {
  name: string;
  id: string;
  title: string;
  /** ISO `updated_at`, or null when the type has no timestamp / it is absent on the row. */
  updatedAt: string | null;
  /** D&P lifecycle: 'published' | 'draft' for a D&P type; null for a non-D&P type (no pill). */
  status: 'published' | 'draft' | null;
}

/**
 * Derive a human title for one entry. We do NOT invent data: we probe a short list of conventional
 * title-ish field names, then fall back to the first user-defined string field on the type, and finally
 * to `#<id>`. Always honest — never a fabricated label.
 */
const TITLE_FIELD_CANDIDATES = ['title', 'name', 'label', 'heading', 'slug'] as const;

function entryTitle(entry: Entry, def: ModuleDefinition): string {
  for (const key of TITLE_FIELD_CANDIDATES) {
    const v = entry[key];
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  // First user-defined string-typed field with a non-empty string value.
  for (const field of def.fields) {
    if (field.system) continue;
    const v = entry[field.name];
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  return `#${String(entry.id ?? '')}`;
}

/**
 * Map one raw entry to a {@link RecentEntry}. Status is derived from the D&P system column
 * (`published_at != null`) ONLY when the type opted into Draft & Publish; otherwise it is null (no pill).
 * `bigint`/`decimal` ids stay strings.
 */
export function toRecentEntry(entry: Entry, def: ModuleDefinition): RecentEntry {
  const updated = entry.updated_at;
  const status: RecentEntry['status'] = def.draftPublish
    ? entry.published_at != null
      ? 'published'
      : 'draft'
    : null;
  return {
    name: def.name,
    id: String(entry.id ?? ''),
    title: entryTitle(entry, def),
    updatedAt: typeof updated === 'string' ? updated : null,
    status,
  };
}

/** Merge per-type recent entries and return the globally-newest `take` by `updated_at` (desc). */
export function mergeRecent(groups: readonly RecentEntry[][], take = 3): RecentEntry[] {
  return groups
    .flat()
    .slice()
    .sort((a, b) => {
      const ta = a.updatedAt ? Date.parse(a.updatedAt) : 0;
      const tb = b.updatedAt ? Date.parse(b.updatedAt) : 0;
      return tb - ta;
    })
    .slice(0, take);
}

const UNITS: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 1000 * 60 * 60 * 24 * 365],
  ['month', 1000 * 60 * 60 * 24 * 30],
  ['week', 1000 * 60 * 60 * 24 * 7],
  ['day', 1000 * 60 * 60 * 24],
  ['hour', 1000 * 60 * 60],
  ['minute', 1000 * 60],
];

const RTF = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

/** Render an ISO timestamp as a relative phrase ("2 hours ago"); empty string when unknown. */
export function relativeTime(iso: string | null, now: number = Date.now()): string {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const diff = then - now;
  const abs = Math.abs(diff);
  for (const [unit, ms] of UNITS) {
    if (abs >= ms) return RTF.format(Math.round(diff / ms), unit);
  }
  return RTF.format(Math.round(diff / 1000), 'second');
}

/** Format an integer count with locale grouping ("1,248"). */
export function formatCount(n: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(n);
}

/** The leading initial for a tiny avatar chip on a resume card. */
export function titleInitial(title: string): string {
  const ch = title.trim().charAt(0);
  return ch ? ch.toUpperCase() : '?';
}
