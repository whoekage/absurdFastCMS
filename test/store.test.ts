import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bitset } from '../src/store/bitset.ts';
import { Table } from '../src/store/table.ts';

test('Bitset: set/get/count/fill/toArray', () => {
  const bs = new Bitset(100);
  assert.equal(bs.count(), 0);
  bs.set(3);
  bs.set(64);
  bs.set(99);
  assert.equal(bs.get(3), true);
  assert.equal(bs.get(4), false);
  assert.equal(bs.get(64), true);
  assert.equal(bs.count(), 3);
  assert.deepEqual(bs.toArray(), [3, 64, 99]);

  const all = new Bitset(70);
  all.fill(70);
  assert.equal(all.count(), 70);
  assert.equal(all.get(69), true);
  assert.equal(all.get(70), false);
});

test('Bitset: and / or / andNot', () => {
  const a = new Bitset(64);
  const b = new Bitset(64);
  [1, 2, 3, 40].forEach((i) => a.set(i));
  [2, 3, 4, 50].forEach((i) => b.set(i));

  const andRes = new Bitset(64);
  [1, 2, 3, 40].forEach((i) => andRes.set(i));
  andRes.and(b);
  assert.deepEqual(andRes.toArray(), [2, 3]);

  const orRes = new Bitset(64);
  [1, 2, 3, 40].forEach((i) => orRes.set(i));
  orRes.or(b);
  assert.deepEqual(orRes.toArray(), [1, 2, 3, 4, 40, 50]);

  const diff = new Bitset(64);
  [1, 2, 3, 40].forEach((i) => diff.set(i));
  diff.andNot(b);
  assert.deepEqual(diff.toArray(), [1, 40]);
});

function seedTable(): Table {
  const t = new Table([
    { name: 'price', type: 'f64' },
    { name: 'stock', type: 'i32' },
    { name: 'status', type: 'string' },
    { name: 'active', type: 'bool' },
  ]);
  t.insert({ price: 50, stock: 10, status: 'draft', active: false });
  t.insert({ price: 150, stock: 0, status: 'published', active: true });
  t.insert({ price: 200, stock: 5, status: 'published', active: true });
  t.insert({ price: 99.5, stock: 3, status: 'archived', active: false });
  return t;
}

test('Table: numeric range scan', () => {
  const t = seedTable();
  const rows = t.scan([{ field: 'price', op: 'gt', value: 100 }]).toArray();
  assert.deepEqual(rows, [1, 2]);
});

test('Table: string equality scan compares interned codes', () => {
  const t = seedTable();
  const rows = t.scan([{ field: 'status', op: 'eq', value: 'published' }]).toArray();
  assert.deepEqual(rows, [1, 2]);

  // A value that was never inserted matches nothing on eq.
  assert.equal(t.scan([{ field: 'status', op: 'eq', value: 'nope' }]).count(), 0);
});

test('Table: multi-predicate AND', () => {
  const t = seedTable();
  const rows = t
    .scan([
      { field: 'status', op: 'eq', value: 'published' },
      { field: 'price', op: 'gte', value: 200 },
      { field: 'active', op: 'eq', value: true },
    ])
    .toArray();
  assert.deepEqual(rows, [2]);
});

test('Table: empty predicate list matches all rows', () => {
  const t = seedTable();
  assert.equal(t.scan([]).count(), 4);
});

test('Table: materialize reconstructs a row from columns', () => {
  const t = seedTable();
  assert.deepEqual(t.materialize(2), {
    price: 200,
    stock: 5,
    status: 'published',
    active: true,
  });
});

test('Table: grows past initial capacity without losing data', () => {
  const t = new Table([{ name: 'n', type: 'i32' }]);
  const N = 5000; // exceeds INITIAL_CAPACITY (1024) to force several grows
  for (let i = 0; i < N; i++) t.insert({ n: i });
  assert.equal(t.rowCount, N);
  assert.equal(t.column('n').at(4999), 4999);
  assert.equal(t.scan([{ field: 'n', op: 'gte', value: 4990 }]).count(), 10);
});
