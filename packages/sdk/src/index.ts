// @absurd/sdk — public barrel. Populated by later slices (query builder, client).

// --- Slice 1: contract types (shared vocabulary) ---
export type {
  CmsType,
  FieldOptions,
  FieldSpec,
  FieldDefinition,
  ContentTypeDefinition,
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
  RelationId,
  RelationInput,
  WriteBody,
  CreateContentTypeInput,
  UpdateFieldInput,
  DropResult,
} from './types.ts';
export { isKeysetPagination } from './types.ts';

// --- Slice 2: query-string builder (Strapi bracket syntax) ---
export type {
  FilterValue,
  FilterCondition,
  FilterObject,
  SortParam,
  PagePagination,
  OffsetPagination,
  KeysetPagination,
  PaginationParam,
  PopulateParam,
  PopulateObject,
  QueryParams,
} from './filters.ts';
export { buildQueryString } from './filters.ts';

// --- Slice 3: HTTP client core (+ Slice 9: auth readiness) ---
export type {
  ClientOptions,
  RequestOptions,
  HeaderProvider,
  UnauthorizedHook,
  RequestHook,
  ResponseHook,
  RetryOptions,
} from './client.ts';
export {
  AbsurdClient,
  Collection,
  ContentTypesApi,
  createClient,
  ApiError,
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  MethodNotAllowedError,
  ConflictError,
  PayloadTooLargeError,
  ServerError,
  errorFromResponse,
} from './client.ts';

// --- Slice 7: wire fidelity (schema-aware (de)serialization) ---
export type { DecodeOptions } from './serde.ts';
export {
  decodeEntry,
  decodeValue,
  encodeEntry,
  encodeValue,
  isLosslessBigDecode,
  assertNoNumberCoercion,
} from './serde.ts';

// --- Slice 8: ergonomics — fluent filter builder ---
export type { FilterLike } from './builder.ts';
export { FieldBuilder, FilterBuilder, f, and, or, not } from './builder.ts';
