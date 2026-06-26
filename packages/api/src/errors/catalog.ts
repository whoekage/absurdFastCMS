import type { Locale } from './render.ts';

/**
 * THE error catalog — the single source of truth for every typed error's HTTP status + its localized
 * message templates. One entry per existing error class (the subclasses now extend {@link AppError}
 * and map their constructor args onto these `{param}` placeholders).
 *
 * BYTE-IDENTICAL CONTRACT: each `messages.en` template, after {@link interpolate} with the SAME params
 * the subclass passes, equals the message that class historically threw — character for character. A
 * few templates therefore expect an ALREADY-transformed param, NOT the raw constructor arg:
 *   - `{value}` / `{apiId}` / `{file}` on the ddl + schema-(de)serialize codes is `JSON.stringify(arg)`
 *     (the originals did `${JSON.stringify(value)}`), so the surrounding quotes are reproduced exactly.
 *   - `db.ddl.identifier_too_long` `{maxBytes}` is the `MAX_IDENTIFIER_BYTES` constant (63), not a ctor arg.
 *   - `db.migration.blocked` `{count}` = `blocked.length`, `{changeList}` = the pre-joined per-change lines
 *     (`blocked.map((c) => '  - ' + describeChange(c) + ' [' + c.risk + ']').join('\n')`); the raw `blocked`
 *     array also rides in params as a wire extra (see http.ts WIRE_EXTRAS).
 *   - the `db.registry.invalid_field` / `db.schema.adapt` templates carry LITERAL double quotes around
 *     `{apiId}`/`{field}` exactly as the originals did (raw interpolation, no JSON.stringify).
 *   - every freeform class maps its `message: string` arg to `{ detail: message }`; en/ru are both `{detail}`.
 *
 * STATUS = the HTTP status this error maps to at the boundary TODAY. Internal-only errors that currently
 * fall through to a 500 carry status 500 (status parity with builderErrorFields / read+write handlers).
 *
 * `as const satisfies ...` keeps the literal templates (so {@link ErrorCode} is the exact code union) while
 * still type-checking that every entry has a numeric status + an en/ru message pair.
 */
export const CATALOG = {
  // --- db/ddl.ts (identifier + schema-shape guards; all internal -> 500) ----------------------------
  'db.ddl.invalid_identifier': {
    status: 500,
    messages: {
      en: 'invalid identifier {value}: {reason}',
      ru: 'недопустимый идентификатор {value}: {reason}',
    },
  },
  'db.ddl.identifier_too_long': {
    status: 500,
    messages: {
      en: 'identifier {value} is {bytes} bytes; max is {maxBytes}',
      ru: 'идентификатор {value} занимает {bytes} байт(ов); максимум — {maxBytes}',
    },
  },
  'db.ddl.reserved_field_name': {
    status: 500,
    messages: {
      en: 'field name {value} is reserved (system column or leading underscore)',
      ru: 'имя поля {value} зарезервировано (системный столбец или ведущее подчёркивание)',
    },
  },
  'db.ddl.reserved_table_name': {
    status: 500,
    messages: {
      en: 'module api_id / table name {value} is reserved',
      ru: 'api_id модуля / имя таблицы {value} зарезервировано',
    },
  },
  'db.ddl.duplicate_field': {
    status: 500,
    messages: {
      en: 'duplicate field name {value} (names are unique case-insensitively)',
      ru: 'повторяющееся имя поля {value} (имена уникальны без учёта регистра)',
    },
  },
  'db.ddl.module_exists': {
    status: 500,
    messages: {
      en: 'module {apiId} already exists',
      ru: 'модуль {apiId} уже существует',
    },
  },
  'db.ddl.module_not_found': {
    status: 500,
    messages: {
      en: 'module {apiId} not found',
      ru: 'модуль {apiId} не найден',
    },
  },
  'db.ddl.field_exists': {
    status: 500,
    messages: {
      en: 'field {value} already exists',
      ru: 'поле {value} уже существует',
    },
  },
  'db.ddl.field_not_found': {
    status: 500,
    messages: {
      en: 'field {value} not found',
      ru: 'поле {value} не найдено',
    },
  },
  'db.ddl.default_type': {
    status: 500,
    messages: { en: '{detail}', ru: '{detail}' },
  },
  'db.ddl.type_change_forbidden': {
    status: 500,
    messages: { en: '{detail}', ru: '{detail}' },
  },
  'db.ddl.type_change_failed': {
    status: 500,
    messages: { en: '{detail}', ru: '{detail}' },
  },
  'db.ddl.dependent_types': {
    status: 500,
    messages: { en: '{detail}', ru: '{detail}' },
  },
  'db.ddl.duplicate_data': {
    status: 500,
    messages: { en: '{detail}', ru: '{detail}' },
  },
  'db.ddl.unknown_relation_kind': {
    status: 500,
    messages: {
      en: 'unknown relation kind {value} (expected oneToOne|oneToMany|manyToOne|manyToMany)',
      ru: 'неизвестный вид связи {value} (ожидается oneToOne|oneToMany|manyToOne|manyToMany)',
    },
  },

  // --- db/registry.ts -------------------------------------------------------------------------------
  'db.registry.invalid_field': {
    status: 500,
    messages: {
      en: 'module "{apiId}" field "{field}": {reason}',
      ru: 'модуль "{apiId}" поле "{field}": {reason}',
    },
  },

  // --- db/schema/* (load/adapt/codegen/diff/serialize + the migrate engine) -------------------------
  'db.schema.load': {
    status: 500,
    messages: {
      en: 'schema module {file}: {reason}',
      ru: 'модуль схемы {file}: {reason}',
    },
  },
  'db.schema.adapt': {
    status: 500,
    messages: {
      en: 'module "{apiId}": {reason}',
      ru: 'модуль "{apiId}": {reason}',
    },
  },
  'db.schema.codegen': {
    status: 500,
    messages: { en: '{detail}', ru: '{detail}' },
  },
  'db.schema.diff': {
    status: 422,
    messages: { en: '{detail}', ru: '{detail}' },
  },
  'db.schema.file': {
    status: 500,
    messages: {
      en: 'schema file {file}: {reason}',
      ru: 'файл схемы {file}: {reason}',
    },
  },
  // SchemaChangeConflictError: the transient schema-lock 409 (Retry-After at the boundary).
  'db.schema.conflict': {
    status: 409,
    messages: { en: '{detail}', ru: '{detail}' },
  },
  // SchemaReconcileHaltError: boot-time reconcile halt (internal -> 500).
  'db.schema.reconcile_halt': {
    status: 500,
    messages: { en: '{detail}', ru: '{detail}' },
  },
  'db.migration.blocked': {
    status: 409,
    messages: {
      en: 'migration blocked: {count} change(s) require --allow-destructive or are forbidden:\n{changeList}',
      ru: 'миграция заблокирована: {count} изменени(й) требуют --allow-destructive или запрещены:\n{changeList}',
    },
  },
  'db.migration.unsupported': {
    status: 422,
    messages: { en: '{detail}', ru: '{detail}' },
  },
  'db.migration.data_loss': {
    status: 422,
    messages: {
      en: 'migration would lose data: {affected} row(s) in {table}.{column} {detail} — refusing to silently truncate/round (widen the target or clean the rows first)',
      ru: 'миграция приведёт к потере данных: {affected} строк(и) в {table}.{column} {detail} — отказ от молчаливого усечения/округления (расширьте целевой тип или сначала очистите строки)',
    },
  },

  // --- request-facing 4xx (the wire-shaped errors) --------------------------------------------------
  'body.invalid': {
    status: 400,
    messages: { en: '{detail}', ru: '{detail}' },
  },
  'entry.write': {
    status: 400,
    messages: { en: '{detail}', ru: '{detail}' },
  },
  'query.invalid': {
    status: 400,
    messages: { en: '{detail}', ru: '{detail}' },
  },
  'cursor.invalid': {
    status: 400,
    messages: {
      en: 'invalid or expired pagination cursor',
      ru: 'недействительный или просроченный курсор постраничной навигации',
    },
  },
  'hook.failed': {
    status: 400,
    messages: { en: '{detail}', ru: '{detail}' },
  },
  'store.keyset_unsupported': {
    status: 500,
    messages: { en: '{detail}', ru: '{detail}' },
  },

  // --- compose/builder.ts (the admin Builder routes) -----------------------------------------------
  'builder.validation': {
    status: 422,
    messages: { en: '{detail}', ru: '{detail}' },
  },
  'builder.not_found': {
    status: 404,
    messages: { en: '{detail}', ru: '{detail}' },
  },
  'builder.busy': {
    status: 500,
    messages: { en: '{detail}', ru: '{detail}' },
  },

  // --- storage/provider.ts --------------------------------------------------------------------------
  'storage.object_not_found': {
    status: 500,
    messages: {
      en: 'object not found',
      ru: 'объект не найден',
    },
  },
} as const satisfies Record<string, { status: number; messages: Record<Locale, string> }>;

/** The exact union of every defined error code (drives compile-time exhaustiveness at the call sites). */
export type ErrorCode = keyof typeof CATALOG;
