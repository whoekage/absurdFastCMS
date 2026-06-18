// @absurd/sdk — Slice 8.1: FLUENT FILTER BUILDER.
//
// A thin, chainable façade over the Slice 2 {@link FilterObject} / {@link FilterCondition} types. It
// produces NOTHING new on the wire — every method just assembles the exact plain-object shape that
// {@link buildQueryString} already serializes (and that the api's real `parseQuery` round-trips). The
// builder is sugar; `f('views').gte(100).and(f('status').eq('published'))` is just a more readable way
// to spell `{ $and: [{ views: { $gte: 100 } }, { status: { $eq: 'published' } } ] }`.
//
// Design:
//   • `f(field)` opens a FIELD builder — one operator call (`eq`/`gt`/`contains`/…) closes it into a
//     full {@link FilterBuilder} carrying `{ [field]: { $op: value } }`. `null()`/`notNull()` are the
//     flag arms; the string ops cover the contains/startsWith/endsWith family (+ case-insensitive `i`).
//   • A {@link FilterBuilder} is the COMBINABLE node: `.and(...)` / `.or(...)` fold this node plus the
//     argument(s) into a `$and` / `$or` tree (flattening a same-operator child so chains stay shallow),
//     `.not()` wraps it in `$not`. `.build()` returns the plain {@link FilterObject}.
//   • Anywhere a method accepts "a filter" it takes EITHER a {@link FilterBuilder} or a raw
//     {@link FilterObject}, so the builder and hand-written objects interleave freely.

import type { FilterValue, FilterCondition, FilterObject } from './filters.ts';

/** A node that can be combined: either a fluent {@link FilterBuilder} or a raw {@link FilterObject}. */
export type FilterLike = FilterBuilder | FilterObject;

/** Coerce a {@link FilterLike} to its plain {@link FilterObject}. */
function toObject(node: FilterLike): FilterObject {
  return node instanceof FilterBuilder ? node.build() : node;
}

/**
 * A combinable filter node wrapping a plain {@link FilterObject}. Returned by every {@link FieldBuilder}
 * operator and by the logical combinators. Pass it straight into `QueryParams.filters` (the client/
 * collection accept a builder too) or call {@link build} for the bare object.
 */
export class FilterBuilder {
  /** The accumulated plain filter object (the wire shape). */
  private readonly node: FilterObject;

  constructor(node: FilterObject) {
    this.node = node;
  }

  /** The plain {@link FilterObject} — exactly what {@link buildQueryString} consumes. */
  build(): FilterObject {
    return this.node;
  }

  /**
   * AND this node with one or more others → `{ $and: [...] }`. A same-operator `$and` child is
   * FLATTENED (so `a.and(b).and(c)` yields a single 3-element `$and`, not a nested pair).
   */
  and(...others: FilterLike[]): FilterBuilder {
    return new FilterBuilder({ $and: combine('$and', this.node, others.map(toObject)) });
  }

  /** OR this node with one or more others → `{ $or: [...] }` (same-operator flattening as {@link and}). */
  or(...others: FilterLike[]): FilterBuilder {
    return new FilterBuilder({ $or: combine('$or', this.node, others.map(toObject)) });
  }

  /** Negate this node → `{ $not: <node> }`. */
  not(): FilterBuilder {
    return new FilterBuilder({ $not: this.node });
  }
}

/** Fold `self` + `rest` into a flat list under `$and`/`$or`, unwrapping a same-operator `self`. */
function combine(op: '$and' | '$or', self: FilterObject, rest: FilterObject[]): FilterObject[] {
  const selfChildren = self[op];
  // If `self` is ALREADY a single-key `$and`/`$or`, splice its children in so chains stay one level deep.
  const head = Array.isArray(selfChildren) && Object.keys(self).length === 1 ? selfChildren : [self];
  return [...head, ...rest];
}

/**
 * A FIELD builder — the open state of `f('field')` before an operator is chosen. Each operator method
 * closes it into a {@link FilterBuilder} carrying `{ [field]: { $op: value } }`. Stateless (carries only
 * the field name); every call produces a fresh node so it is safe to reuse.
 */
export class FieldBuilder {
  /** The field name this builder targets. */
  private readonly field: string;

  constructor(field: string) {
    this.field = field;
  }

  /** Build `{ [field]: condition }` as a {@link FilterBuilder}. */
  private make(condition: FilterCondition): FilterBuilder {
    return new FilterBuilder({ [this.field]: condition });
  }

  /** `$eq` — equals. */
  eq(value: FilterValue): FilterBuilder {
    return this.make({ $eq: value });
  }
  /** `$ne` — not equals. */
  ne(value: FilterValue): FilterBuilder {
    return this.make({ $ne: value });
  }
  /** `$eqi` — case-insensitive equals. */
  eqi(value: FilterValue): FilterBuilder {
    return this.make({ $eqi: value });
  }
  /** `$nei` — case-insensitive not equals. */
  nei(value: FilterValue): FilterBuilder {
    return this.make({ $nei: value });
  }
  /** `$gt` — greater than. */
  gt(value: FilterValue): FilterBuilder {
    return this.make({ $gt: value });
  }
  /** `$gte` — greater than or equal. */
  gte(value: FilterValue): FilterBuilder {
    return this.make({ $gte: value });
  }
  /** `$lt` — less than. */
  lt(value: FilterValue): FilterBuilder {
    return this.make({ $lt: value });
  }
  /** `$lte` — less than or equal. */
  lte(value: FilterValue): FilterBuilder {
    return this.make({ $lte: value });
  }
  /** `$between` — inclusive range `[lo, hi]`. */
  between(lo: FilterValue, hi: FilterValue): FilterBuilder {
    return this.make({ $between: [lo, hi] });
  }
  /** `$in` — value is one of `values`. */
  in(values: FilterValue[]): FilterBuilder {
    return this.make({ $in: values });
  }
  /** `$notIn` — value is none of `values`. */
  notIn(values: FilterValue[]): FilterBuilder {
    return this.make({ $notIn: values });
  }
  /** `$null` — field IS null (emits the literal `true` flag). */
  null(): FilterBuilder {
    return this.make({ $null: true });
  }
  /** `$notNull` — field is NOT null (emits the literal `true` flag). */
  notNull(): FilterBuilder {
    return this.make({ $notNull: true });
  }
  /** `$contains` — substring (case-sensitive). */
  contains(value: FilterValue): FilterBuilder {
    return this.make({ $contains: value });
  }
  /** `$containsi` — substring (case-insensitive). */
  containsi(value: FilterValue): FilterBuilder {
    return this.make({ $containsi: value });
  }
  /** `$notContains` — does NOT contain substring (case-sensitive). */
  notContains(value: FilterValue): FilterBuilder {
    return this.make({ $notContains: value });
  }
  /** `$notContainsi` — does NOT contain substring (case-insensitive). */
  notContainsi(value: FilterValue): FilterBuilder {
    return this.make({ $notContainsi: value });
  }
  /** `$startsWith` — prefix (case-sensitive). */
  startsWith(value: FilterValue): FilterBuilder {
    return this.make({ $startsWith: value });
  }
  /** `$startsWithi` — prefix (case-insensitive). */
  startsWithi(value: FilterValue): FilterBuilder {
    return this.make({ $startsWithi: value });
  }
  /** `$endsWith` — suffix (case-sensitive). */
  endsWith(value: FilterValue): FilterBuilder {
    return this.make({ $endsWith: value });
  }
  /** `$endsWithi` — suffix (case-insensitive). */
  endsWithi(value: FilterValue): FilterBuilder {
    return this.make({ $endsWithi: value });
  }
}

/** Open a fluent filter on `field`: `f('views').gte(100)`. Returns a {@link FieldBuilder}. */
export function f(field: string): FieldBuilder {
  return new FieldBuilder(field);
}

/** AND a list of filter nodes → a {@link FilterBuilder} wrapping `{ $and: [...] }`. */
export function and(...nodes: FilterLike[]): FilterBuilder {
  return new FilterBuilder({ $and: nodes.map(toObject) });
}

/** OR a list of filter nodes → a {@link FilterBuilder} wrapping `{ $or: [...] }`. */
export function or(...nodes: FilterLike[]): FilterBuilder {
  return new FilterBuilder({ $or: nodes.map(toObject) });
}

/** Negate a single filter node → a {@link FilterBuilder} wrapping `{ $not: <node> }`. */
export function not(node: FilterLike): FilterBuilder {
  return new FilterBuilder({ $not: toObject(node) });
}
