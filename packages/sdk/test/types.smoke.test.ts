// Slice 1 — type-only smoke. Constructs sample values for every contract shape (so they must compile
// under strict + exactOptionalPropertyTypes + verbatimModuleSyntax) and pins the one piece of runtime
// behaviour in the slice: the `isKeysetPagination` narrowing guard. NO MOCKS — pure value construction.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type {
  CmsType,
  FieldOptions,
  FieldSpec,
  FieldDefinition,
  ModuleDefinition,
  BigIntegerValue,
  DecimalValue,
  JsonValue,
  Entry,
  ListResponse,
  SingleResponse,
  OffsetPaginationMeta,
  KeysetPaginationMeta,
  PaginationMeta,
  FilterOperator,
} from '@conti/sdk';
import { isKeysetPagination } from '@conti/sdk';

test('ModuleDefinition constructs (cmsType + field options + projected fields)', () => {
  const cmsType: CmsType = 'enumeration';
  const options: FieldOptions = { length: 64, values: ['draft', 'published'], nullable: false };
  const spec: FieldSpec = { name: 'status', cmsType, options };

  const def: ModuleDefinition = {
    name: 'article',
    fields: [
      { name: 'id', cmsType: 'integer', nullable: false, system: true },
      { name: 'createdAt', cmsType: 'datetime', nullable: false, system: true },
      {
        name: 'status',
        cmsType: 'enumeration',
        nullable: false,
        system: false,
        enumValues: ['draft', 'published'] as const,
      },
      { name: 'price', cmsType: 'decimal', nullable: true, system: false, precision: 10, scale: 2 },
    ],
    relations: [
      { field: 'author', kind: 'manyToOne', target: 'user', owner: true, inverseField: 'articles' },
    ],
  };

  // wire-format brand aliases.
  const big: BigIntegerValue = '9223372036854775807';
  const dec: DecimalValue = '12.34';
  const blob: JsonValue = { any: ['shape', 1, true] };

  assert.equal(spec.name, 'status');
  assert.equal(def.name, 'article');
  assert.equal(def.fields.length, 4);
  const enumField = def.fields.find((f: FieldDefinition) => f.name === 'status');
  assert.deepEqual(enumField?.enumValues, ['draft', 'published']);
  assert.equal(big, '9223372036854775807');
  assert.equal(dec, '12.34');
  assert.deepEqual(blob, { any: ['shape', 1, true] });
});

test('ListResponse / SingleResponse envelopes construct', () => {
  interface Article extends Entry {
    id: number;
    title: string;
  }

  const offset: OffsetPaginationMeta = { page: 1, pageSize: 25, pageCount: 4, total: 87 };

  const list: ListResponse<Article> = {
    data: [{ id: 1, title: 'hello' }],
    meta: { pagination: offset },
  };

  const single: SingleResponse<Article> = {
    data: { id: 1, title: 'hello' },
    meta: {},
  };

  assert.equal(list.data[0]?.title, 'hello');
  assert.equal(list.meta.pagination.pageSize, 25);
  assert.equal(single.data.id, 1);
  assert.deepEqual(single.meta, {});
});

test('isKeysetPagination narrows keyset meta to true, offset meta to false', () => {
  const offset: PaginationMeta = { page: 2, pageSize: 10, pageCount: 5, total: 42 };
  const keyset: PaginationMeta = {
    pageSize: 10,
    nextCursor: 'opaque-next',
    prevCursor: null,
    hasNextPage: true,
    hasPreviousPage: false,
  };

  assert.equal(isKeysetPagination(offset), false);
  assert.equal(isKeysetPagination(keyset), true);

  // and it actually narrows: inside the guard the keyset-only fields are reachable without a cast.
  if (isKeysetPagination(keyset)) {
    assert.equal(keyset.nextCursor, 'opaque-next');
    assert.equal(keyset.hasNextPage, true);
  } else {
    assert.fail('keyset meta should narrow to KeysetPaginationMeta');
  }

  // keyset meta with withCount populated (total/pageCount optional).
  const counted: KeysetPaginationMeta = {
    pageSize: 10,
    total: 42,
    pageCount: 5,
    nextCursor: null,
    prevCursor: null,
    hasNextPage: false,
    hasPreviousPage: false,
  };
  assert.equal(counted.total, 42);
});

test('FilterOperator tokens are assignable', () => {
  const ops: FilterOperator[] = ['$eq', '$between', '$in', '$null', '$containsi', '$endsWithi'];
  assert.equal(ops.length, 6);
});
