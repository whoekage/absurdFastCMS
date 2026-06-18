import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Table, type FieldDef } from '../src/store/table.ts';

const FIELDS: FieldDef[] = [
  { name: 'price', type: 'f64' },
  { name: 'stock', type: 'i32' },
  { name: 'status', type: 'string' },
  { name: 'active', type: 'bool' },
];

const STATUSES = ['draft', 'published', 'archived'];

function build(n: number, withIndexes: boolean): Table {
  const t = new Table(FIELDS);
  if (withIndexes) {
    // Create indexes BEFORE inserting to also exercise live maintenance on insert.
    t.createHashIndex('status');
    t.createSortedIndex('price');
  }
  for (let i = 0; i < n; i++) {
    t.insert({
      price: (i * 37) % 1000,
      stock: i % 500,
      status: STATUSES[i % 3]!,
      active: (i & 1) === 0,
    });
  }
  return t;
}

test('hash index eq matches a full scan exactly', () => {
  const plain = build(2000, false);
  const indexed = build(2000, true);
  for (const status of [...STATUSES, 'missing']) {
    const a = plain.scan([{ field: 'status', op: 'eq', value: status }]).toArray();
    const b = indexed.scan([{ field: 'status', op: 'eq', value: status }]).toArray();
    assert.deepEqual(b, a, `status=${status}`);
  }
});

test('sorted index range matches a full scan exactly', () => {
  const plain = build(2000, false);
  const indexed = build(2000, true);
  const ops = ['gt', 'gte', 'lt', 'lte'] as const;
  for (const op of ops) {
    for (const value of [0, 250, 500, 999, 1000]) {
      const a = plain.scan([{ field: 'price', op, value }]).toArray();
      const b = indexed.scan([{ field: 'price', op, value }]).toArray();
      assert.deepEqual(b, a, `price ${op} ${value}`);
    }
  }
});

test('multi-predicate AND is identical with and without indexes', () => {
  const plain = build(3000, false);
  const indexed = build(3000, true);
  const filters = [
    { field: 'status', op: 'eq' as const, value: 'published' },
    { field: 'price', op: 'gte' as const, value: 500 },
    { field: 'active', op: 'eq' as const, value: true },
  ];
  assert.deepEqual(indexed.scan(filters).toArray(), plain.scan(filters).toArray());
});

test('query: sort asc/desc via sorted index returns globally ordered rows', () => {
  const t = build(1000, true);
  const asc = t.query({ sort: [{ field: 'price', dir: 'asc' }], limit: 1000 });
  const ascPrices = asc.map((r) => t.column('price').at(r) as number);
  for (let i = 1; i < ascPrices.length; i++) assert.ok(ascPrices[i]! >= ascPrices[i - 1]!);

  const desc = t.query({ sort: [{ field: 'price', dir: 'desc' }], limit: 1000 });
  const descPrices = desc.map((r) => t.column('price').at(r) as number);
  for (let i = 1; i < descPrices.length; i++) assert.ok(descPrices[i]! <= descPrices[i - 1]!);
});

test('query: pagination over sorted index is stable and non-overlapping', () => {
  const t = build(1000, true);
  const sort = [{ field: 'price', dir: 'asc' as const }];
  const page0 = t.query({ sort, offset: 0, limit: 20 });
  const page1 = t.query({ sort, offset: 20, limit: 20 });
  assert.equal(page0.length, 20);
  assert.equal(page1.length, 20);
  // Full list sliced the same way must equal the paged results.
  const full = t.query({ sort, limit: 1000 });
  assert.deepEqual(page0, full.slice(0, 20));
  assert.deepEqual(page1, full.slice(20, 40));
});

test('query: filter + sort + paginate composes correctly', () => {
  const t = build(3000, true);
  const rows = t.query({
    filters: [{ field: 'status', op: 'eq', value: 'published' }],
    sort: [{ field: 'price', dir: 'desc' }],
    offset: 5,
    limit: 10,
  });
  assert.equal(rows.length, 10);
  // Every returned row really is published, and prices are descending.
  let prev = Infinity;
  for (const r of rows) {
    assert.equal(t.column('status').at(r), 'published');
    const price = t.column('price').at(r) as number;
    assert.ok(price <= prev);
    prev = price;
  }
});

test('query: fallback comparator sorts a non-indexed (string) field', () => {
  const t = build(500, true); // no index on status
  const rows = t.query({ sort: [{ field: 'status', dir: 'asc' }], limit: 500 });
  const statuses = rows.map((r) => t.column('status').at(r) as string);
  for (let i = 1; i < statuses.length; i++) assert.ok(statuses[i]! >= statuses[i - 1]!);
});

test('query: default order is insertion order, paginated', () => {
  const t = build(100, true);
  assert.deepEqual(t.query({ offset: 0, limit: 5 }), [0, 1, 2, 3, 4]);
  assert.deepEqual(t.query({ offset: 10, limit: 3 }), [10, 11, 12]);
});

test('sorted index rebuilds after inserts that follow index creation', () => {
  const t = new Table(FIELDS);
  t.createSortedIndex('price');
  t.insert({ price: 300, stock: 1, status: 'a', active: true });
  // First query builds the index.
  assert.deepEqual(t.query({ sort: [{ field: 'price', dir: 'asc' }] }), [0]);
  // New row with a smaller price must reorder after the dirty-rebuild.
  t.insert({ price: 100, stock: 1, status: 'a', active: true });
  assert.deepEqual(t.query({ sort: [{ field: 'price', dir: 'asc' }] }), [1, 0]);
});
