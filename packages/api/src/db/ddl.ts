import { createHash } from 'node:crypto';
import { Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, DummyDriver, sql, type CompiledQuery } from 'kysely';
import type { Sql } from 'postgres';
import type { ResolvedType } from './type.catalog.ts';
import type { RelationKind } from '../store/relation.ts';

/**
 * Identifier safety + the Kysely COMPILE-ONLY DDL builders + the one atomic transactional applier.
 *
 * Execution wiring (per the locked decision): Kysely is used PURELY as a typed SQL string/parameter
 * builder. We build each DDL statement with the query builder, `.compile()` it to `{ sql, parameters }`
 * over a `DummyDriver` (so there is NO second connection / NO second pool / NO `pg` driver), and then
 * execute every statement via `tx.unsafe(sql, parameters)` inside ONE `sql.begin(...)` over our
 * postgres.js handle — exactly the pattern migrate.ts already uses. Meta INSERT/UPDATE/DELETE run on
 * the SAME `tx` as tagged-template queries, so a schema change is ONE driver, ONE backend, ONE tx.
 *
 * Identifier vs literal separation is absolute: identifiers go through the allowlist + 63-byte gate
 * and are always double-quoted; every literal is rendered SAFELY, NEVER string-concatenated into DDL.
 * NOTE on DEFAULTs: a PG DDL `DEFAULT` clause CANNOT be a bind parameter, so constant defaults are
 * emitted as Kysely-escaped LITERALS via `.defaultTo(value)` (value-serialization: numbers/booleans
 * inline, strings single-quote-doubled, Date as an escaped literal). Injection-safety for defaults
 * therefore rests on Kysely's literal escaping (verified end-to-end), not a param channel. Enum CHECK
 * members are escaped via `sql.lit`. Row DATA (a later step) goes through bound params.
 */

// --- the compile-only Kysely instance (no driver, never connects) ------------------------------

const compiler: Kysely<Record<string, never>> = new Kysely<Record<string, never>>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});

// --- identifier-safety constants ---------------------------------------------------------------

/** ASCII-only allowlist: first char a letter/underscore, rest letters/digits/underscore/`$`. No `u`/`i`. */
export const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_$]*$/;
/** PG truncates identifiers at 63 BYTES (not chars) -> a longer name silently collides; reject it. */
export const MAX_IDENTIFIER_BYTES = 63;
/** The reserved per-type table prefix. A user api_id may not start with it (we add it ourselves). */
export const TABLE_PREFIX = 'ct_';
/** System columns the generator injects; a user cannot define a field with one of these names. */
// `published_at` (snake_case) is the Draft & Publish system column — reserved on EVERY type (D&P or
// not), cheap + uniform, so a non-D&P type cannot declare a column that would collide if it later opted
// in, and a client cannot spoof one. NOTE: `publishedAt` (camelCase, the article seed's USER field) is
// NOT reserved — only the snake_case underscore form is, so the seed field keeps working byte-identically.
// `locale` (snake_case) is the i18n system column — reserved on EVERY type (i18n or not), so a non-i18n
// type cannot declare a column that would collide if it later opted in, and a client cannot spoof one.
export const RESERVED_FIELD_NAMES: ReadonlySet<string> = new Set(['id', 'document_id', 'created_at', 'updated_at', 'published_at', 'locale']);
/** Tables/api_ids a user type may not collide with. */
export const RESERVED_TABLE_NAMES: ReadonlySet<string> = new Set(['content_types', 'content_type_fields', 'content_type_relations', 'component_types', 'component_type_fields', 'files', '_migrations', '_schema_applied']);

// --- typed error classes (deterministic; never leak a raw PG error) ----------------------------

export class InvalidIdentifierError extends Error {
  readonly value: unknown;
  constructor(value: unknown, reason: string) {
    super(`invalid identifier ${JSON.stringify(value)}: ${reason}`);
    this.name = 'InvalidIdentifierError';
    this.value = value;
  }
}
export class IdentifierTooLongError extends Error {
  readonly value: string;
  constructor(value: string, bytes: number) {
    super(`identifier ${JSON.stringify(value)} is ${bytes} bytes; max is ${MAX_IDENTIFIER_BYTES}`);
    this.name = 'IdentifierTooLongError';
    this.value = value;
  }
}
export class ReservedFieldNameError extends Error {
  readonly value: string;
  constructor(value: string) {
    super(`field name ${JSON.stringify(value)} is reserved (system column or leading underscore)`);
    this.name = 'ReservedFieldNameError';
    this.value = value;
  }
}
export class ReservedTableNameError extends Error {
  readonly value: string;
  constructor(value: string) {
    super(`content-type api_id / table name ${JSON.stringify(value)} is reserved`);
    this.name = 'ReservedTableNameError';
    this.value = value;
  }
}
export class DuplicateFieldError extends Error {
  readonly value: string;
  constructor(value: string) {
    super(`duplicate field name ${JSON.stringify(value)} (names are unique case-insensitively)`);
    this.name = 'DuplicateFieldError';
    this.value = value;
  }
}
export class ModuleExistsError extends Error {
  readonly apiId: string;
  constructor(apiId: string) {
    super(`content-type ${JSON.stringify(apiId)} already exists`);
    this.name = 'ModuleExistsError';
    this.apiId = apiId;
  }
}
export class ModuleNotFoundError extends Error {
  readonly apiId: string;
  constructor(apiId: string) {
    super(`content-type ${JSON.stringify(apiId)} not found`);
    this.name = 'ModuleNotFoundError';
    this.apiId = apiId;
  }
}
export class FieldExistsError extends Error {
  readonly value: string;
  constructor(value: string) {
    super(`field ${JSON.stringify(value)} already exists`);
    this.name = 'FieldExistsError';
    this.value = value;
  }
}
export class FieldNotFoundError extends Error {
  readonly value: string;
  constructor(value: string) {
    super(`field ${JSON.stringify(value)} not found`);
    this.name = 'FieldNotFoundError';
    this.value = value;
  }
}
export class DefaultTypeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DefaultTypeError';
  }
}
export class TypeChangeForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TypeChangeForbiddenError';
  }
}
export class TypeChangeFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TypeChangeFailedError';
  }
}
export class SchemaChangeConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaChangeConflictError';
  }
}
export class DependentTypesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DependentTypesError';
  }
}
export class DuplicateDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DuplicateDataError';
  }
}
export class UnknownRelationKindError extends Error {
  readonly value: unknown;
  constructor(value: unknown) {
    super(`unknown relation kind ${JSON.stringify(value)} (expected oneToOne|oneToMany|manyToOne|manyToMany)`);
    this.name = 'UnknownRelationKindError';
    this.value = value;
  }
}

// --- relation kinds (a CLOSED set; relations are NOT scalar CmsTypes — they never touch resolveType) --

export type { RelationKind }; // engine-owned vocabulary (../store/relation.ts); re-exported for existing db/http consumers
export const RELATION_KINDS: ReadonlySet<string> = new Set<RelationKind>(['oneToOne', 'oneToMany', 'manyToOne', 'manyToMany']);

/** Closed-set validate a relation kind; the value is NEVER interpolated into SQL (it only selects a fixed template). */
export function validateRelationKind(value: unknown): RelationKind {
  if (typeof value !== 'string' || !RELATION_KINDS.has(value)) throw new UnknownRelationKindError(value);
  return value as RelationKind;
}

/** The inverse cardinality stored on the inverse meta row (owner kind -> inverse kind). */
export function inverseKind(kind: RelationKind): RelationKind {
  switch (kind) {
    case 'oneToMany':
      return 'manyToOne';
    case 'manyToOne':
      return 'oneToMany';
    case 'oneToOne':
      return 'oneToOne';
    case 'manyToMany':
      return 'manyToMany';
  }
}

// --- identifier validation ---------------------------------------------------------------------

/**
 * The universal identifier gate, in order (each step throws a precise typed error, NO coercion, NO
 * trim): non-string -> InvalidIdentifierError; empty -> InvalidIdentifierError; >63 BYTES ->
 * IdentifierTooLongError; fails the ASCII allowlist -> InvalidIdentifierError. Returns the name
 * verbatim. This single regex rejects quotes, `;`, whitespace, control/NUL chars, Unicode letters /
 * homoglyphs / combining marks / ZWJ / emoji, and leading digits/symbols.
 */
export function validateIdentifier(value: unknown): string {
  if (typeof value !== 'string') throw new InvalidIdentifierError(value, 'not a string');
  if (value.length === 0) throw new InvalidIdentifierError(value, 'empty');
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > MAX_IDENTIFIER_BYTES) throw new IdentifierTooLongError(value, bytes);
  if (!IDENTIFIER_RE.test(value)) throw new InvalidIdentifierError(value, 'must match /^[A-Za-z_][A-Za-z0-9_$]*$/ (ASCII only)');
  return value;
}

/** A user field name: a valid identifier that is NOT a reserved system column and not `_`-leading. */
export function validateFieldName(value: unknown): string {
  const name = validateIdentifier(value);
  if (name.startsWith('_')) throw new ReservedFieldNameError(name);
  if (RESERVED_FIELD_NAMES.has(name.toLowerCase())) throw new ReservedFieldNameError(name);
  return name;
}

/**
 * Derive (and validate) the physical table name for a content-type api_id. Validates the api_id,
 * rejects reserved names / `_`-leading / `ct_`-leading (case-insensitively), assembles `ct_${apiId}`,
 * then re-validates the FINAL assembled name INCLUDING the 63-byte check on the assembly (so the real
 * table name can never silently truncate) and rejects a final collision with a reserved table.
 */
export function deriveTableName(apiId: string): string {
  const id = validateIdentifier(apiId);
  const lower = id.toLowerCase();
  if (id.startsWith('_')) throw new ReservedTableNameError(id);
  if (lower.startsWith(TABLE_PREFIX)) throw new ReservedTableNameError(id);
  if (RESERVED_TABLE_NAMES.has(lower)) throw new ReservedTableNameError(id);
  const table = `${TABLE_PREFIX}${id}`;
  // Re-validate the final assembly (byte length on the WHOLE prefixed name; allowlist still holds).
  const bytes = Buffer.byteLength(table, 'utf8');
  if (bytes > MAX_IDENTIFIER_BYTES) throw new IdentifierTooLongError(table, bytes);
  if (RESERVED_TABLE_NAMES.has(table.toLowerCase())) throw new ReservedTableNameError(table);
  return table;
}

/** Double-quote an identifier, doubling any internal `"` (defense-in-depth; allowlist forbids `"`). */
export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

// --- default-value safety ----------------------------------------------------------------------

/**
 * Validate a constant default against the field's engine intent and return the value to hand to the
 * DDL builder. Volatile expressions (now()/gen_random_uuid()/...) and shape mismatches throw
 * {@link DefaultTypeError}. The returned value is emitted by Kysely's `.defaultTo()` as a SAFELY
 * ESCAPED LITERAL (a DDL DEFAULT cannot be a bind parameter), never string-concatenated.
 */
export function validateDefault(resolved: ResolvedType, raw: unknown): { sqlLiteral: unknown } {
  if (typeof raw === 'string') {
    const bare = raw.replace(/\(\s*\)\s*$/, '').trim().toLowerCase();
    if (VOLATILE_DEFAULT_REJECT.has(bare)) throw new DefaultTypeError(`volatile default ${JSON.stringify(raw)} is not allowed (constant defaults only)`);
  }
  switch (resolved.engineType) {
    case 'i32':
      if (typeof raw !== 'number' || !Number.isInteger(raw)) throw new DefaultTypeError(`integer default must be an integer, got ${String(raw)}`);
      return { sqlLiteral: raw };
    case 'i64':
      // bigint default arrives as a bigint or a decimal-digit string (NEVER a float Number).
      if (typeof raw === 'bigint') return { sqlLiteral: raw.toString() };
      if (typeof raw === 'string' && /^-?\d+$/.test(raw)) return { sqlLiteral: raw };
      throw new DefaultTypeError(`biginteger default must be a bigint or integer string, got ${String(raw)}`);
    case 'f64':
      if (typeof raw !== 'number' || !Number.isFinite(raw)) throw new DefaultTypeError(`float default must be a finite number, got ${String(raw)}`);
      return { sqlLiteral: raw };
    case 'decimal': {
      const text = typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : typeof raw === 'string' && /^-?\d+(\.\d+)?$/.test(raw) ? raw : null;
      if (text === null) throw new DefaultTypeError(`decimal default must be a numeric string/number, got ${String(raw)}`);
      const precision = resolved.params['precision'];
      const scale = resolved.params['scale'];
      const frac = text.split('.')[1] ?? '';
      if (typeof scale === 'number' && frac.length > scale) throw new DefaultTypeError(`decimal default ${text} exceeds scale ${scale}`);
      // Validate the INTEGER part against (precision - scale): PG does NOT range-check a DDL DEFAULT
      // expression, so a too-large default would only blow up later at INSERT with 22003. Reject now.
      if (typeof precision === 'number' && typeof scale === 'number') {
        const intDigits = text.replace('-', '').split('.')[0]!.replace(/^0+(?=\d)/, '').length;
        const maxIntDigits = precision - scale;
        if (intDigits > maxIntDigits) throw new DefaultTypeError(`decimal default ${text} exceeds precision ${precision} (max ${maxIntDigits} integer digits)`);
      }
      return { sqlLiteral: text };
    }
    case 'bool':
      if (typeof raw !== 'boolean') throw new DefaultTypeError(`boolean default must be a real boolean, got ${String(raw)}`);
      return { sqlLiteral: raw };
    case 'date': {
      // date / datetime: accept Date / ISO-string; reject unparseable. Bind as a Date.
      const d = raw instanceof Date ? raw : typeof raw === 'string' ? new Date(raw) : null;
      if (d === null || Number.isNaN(d.getTime())) throw new DefaultTypeError(`date default must be a Date or ISO-8601 string, got ${String(raw)}`);
      return { sqlLiteral: d };
    }
    case 'json':
      // jsonb default: bind the JSON text; reject anything unserializable.
      try {
        return { sqlLiteral: JSON.stringify(raw) };
      } catch {
        throw new DefaultTypeError(`json default is not serializable`);
      }
    case 'string': {
      if (typeof raw !== 'string') throw new DefaultTypeError(`string default must be a string, got ${String(raw)}`);
      // For an enum, the default must be one of the allowed members.
      const values = resolved.params['values'];
      if (Array.isArray(values) && !values.includes(raw)) throw new DefaultTypeError(`enumeration default ${JSON.stringify(raw)} is not one of the allowed values`);
      return { sqlLiteral: raw };
    }
    case 'text':
      if (typeof raw !== 'string') throw new DefaultTypeError(`text default must be a string, got ${String(raw)}`);
      return { sqlLiteral: raw };
    default:
      throw new DefaultTypeError(`no default supported for engine type ${String(resolved.engineType)}`);
  }
}

/** Volatile default expressions (bare function names, lower-cased) rejected by {@link validateDefault}. */
const VOLATILE_DEFAULT_REJECT: ReadonlySet<string> = new Set(['now', 'current_timestamp', 'gen_random_uuid', 'uuid_generate_v4', 'random', 'nextval', 'clock_timestamp', 'statement_timestamp', 'transaction_timestamp']);

// --- compiled DDL builders (compile-only -> { sql, parameters }) --------------------------------

/** A fully-resolved field ready to render as a real column: validated name + resolved type + flags. */
export interface ResolvedField {
  name: string;
  resolved: ResolvedType;
  nullable: boolean;
  /** validated/bound default value (from {@link validateDefault}); undefined = no default. */
  defaultValue?: unknown;
  /** i18n: true => localized (per-variant); false => shared. Stored in meta; no effect on the column DDL. */
  localized?: boolean;
}

/** Render one user column onto a Kysely createTable/alterTable add-column builder. */
function columnSpec(name: string, field: ResolvedField): (cb: import('kysely').ColumnDefinitionBuilder) => import('kysely').ColumnDefinitionBuilder {
  return (cb) => {
    let b = field.nullable ? cb : cb.notNull();
    // enum CHECK: members rendered as SAFE escaped literals via sql.lit (NEVER string-concatenated).
    const values = field.resolved.params['values'];
    if (Array.isArray(values)) {
      const members = values.map((v) => sql.lit(v as string));
      b = b.check(sql`${sql.ref(name)} in (${sql.join(members)})`);
    }
    if (field.defaultValue !== undefined) {
      // A DDL DEFAULT cannot be a bind parameter; Kysely renders this as a SAFELY ESCAPED LITERAL
      // (numbers/booleans inline, strings single-quote-doubled, Date as an escaped literal). Injection
      // is neutralized by that escaping (verified end-to-end), not by a param channel.
      b = b.defaultTo(field.defaultValue as never);
    }
    return b;
  };
}

/**
 * CREATE TABLE for a content-type: the three system columns (`id` identity PK, `created_at`,
 * `updated_at` both `timestamptz NOT NULL DEFAULT now()`) then the user columns in `sort` order, each
 * with its native pg type via the `sql\`\`` escape hatch, NULL/NOT NULL, enum CHECK, and constant
 * default. Valid even with zero user fields. Returns `{ sql, parameters }` — never executes.
 *
 * DRAFT & PUBLISH (Model A, per-type opt-in): when `draftPublish` is true, a nullable snake_case
 * `published_at timestamptz` system column is injected AFTER `updated_at` and BEFORE the user columns
 * (matching registry SYSTEM_FIELDS order). NULL = draft (a fresh insert is a draft — NO DEFAULT, so the
 * column is left NULL and a publish writes it explicitly). With `draftPublish=false` (the DEFAULT) the
 * emitted SQL string + parameter list are BYTE-IDENTICAL to before this feature — the `if` is the only
 * change, every existing call site is untouched.
 *
 * Alternative considered + REJECTED: `published_at DEFAULT now()`. Model A requires create=draft (NULL);
 * a default would auto-publish every insert, and `now()` is non-deterministic (breaks byte-exact fixtures).
 *
 * i18n (per-type opt-in): when `i18n` is true, a NOT NULL snake_case `locale varchar(35)` system column is
 * injected AFTER `published_at` and BEFORE the user columns (matching the registry field order), plus a
 * `UNIQUE(document_id, locale)` constraint (one row per (document, locale)). NO DEFAULT — the server sets
 * `locale` on every insert (a variant create supplies it; a plain create uses the request/default locale).
 * With `i18n=false` (the DEFAULT) the emitted SQL is BYTE-IDENTICAL to before — the `if` is the only delta.
 */
const LOCALE_VARCHAR = 'varchar(35)'; // BCP-47-ish slug bound (e.g. `en`, `pt-BR`); matches the locale validator.

export function compileCreateTable(tableName: string, fields: ResolvedField[], draftPublish = false, i18n = false): CompiledQuery {
  let builder = compiler.schema
    .createTable(tableName)
    .addColumn('id', 'serial', (cb) => cb.primaryKey().notNull())
    // Global document_id (i32) — the variant-grouping key for draft/publish + i18n. DEFAULTs from the
    // shared sequence (0001_init.sql) so a plain INSERT auto-allocates; a variant supplies an existing
    // value. NOT projected by the loader for a non-i18n type (not in registry SYSTEM_FIELDS) — reads stay
    // byte-identical; for an i18n type the registry un-skips it (queryable + emitted).
    .addColumn('document_id', sql`integer`, (cb) => cb.notNull().defaultTo(sql`nextval('document_id_seq')`))
    .addColumn('created_at', sql`timestamptz`, (cb) => cb.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', sql`timestamptz`, (cb) => cb.notNull().defaultTo(sql`now()`));
  if (draftPublish) {
    // NULL = draft. No DEFAULT (a fresh insert is a draft); publish writes it explicitly.
    builder = builder.addColumn('published_at', sql`timestamptz`, (cb) => cb);
  }
  if (i18n) {
    // NOT NULL: every variant row has a locale (server-set). No DEFAULT — the write path supplies it.
    builder = builder.addColumn('locale', sql.raw(LOCALE_VARCHAR), (cb) => cb.notNull());
    // UNIQUE(document_id, locale): one row per (document, locale). Constraint name capped to 63 bytes.
    const suffix = '_doc_loc_uq';
    const room = MAX_IDENTIFIER_BYTES - suffix.length;
    // The compile-only Kysely is typed `Record<string, never>`, so the dynamic ct_ table's columns are
    // not in its literal column union — cast the column list (the names are validated system columns).
    builder = builder.addUniqueConstraint(validateIdentifier(`${tableName.slice(0, room)}${suffix}`), ['document_id', 'locale'] as never[]);
  }
  for (const f of fields) {
    builder = builder.addColumn(f.name, sql.raw(f.resolved.pgType), columnSpec(f.name, f));
  }
  return builder.compile();
}

/** ALTER TABLE ... ADD COLUMN for a single field. */
export function compileAddColumn(tableName: string, field: ResolvedField): CompiledQuery {
  return compiler.schema.alterTable(tableName).addColumn(field.name, sql.raw(field.resolved.pgType), columnSpec(field.name, field)).compile();
}

/** ALTER TABLE ... RENAME COLUMN (real rename — never drop+recreate). */
export function compileRenameColumn(tableName: string, from: string, to: string): CompiledQuery {
  return compiler.schema.alterTable(tableName).renameColumn(from, to).compile();
}

/** ALTER TABLE ... RENAME TO ... (real TABLE rename for a content-type apiId change — lossless). */
export function compileRenameTable(from: string, to: string): CompiledQuery {
  return compiler.schema.alterTable(from).renameTo(to).compile();
}

/** ALTER TABLE ... ALTER COLUMN ... SET/DROP NOT NULL. SET NOT NULL fails (23502) if existing rows are NULL. */
export function compileSetColumnNotNull(tableName: string, name: string, notNull: boolean): CompiledQuery {
  return compiler.schema
    .alterTable(tableName)
    .alterColumn(name, (ac) => (notNull ? ac.setNotNull() : ac.dropNotNull()))
    .compile();
}

/** ALTER TABLE ... DROP COLUMN (RESTRICT by default — PG's default; a dependent object errors). */
export function compileDropColumn(tableName: string, name: string): CompiledQuery {
  return compiler.schema.alterTable(tableName).dropColumn(name).compile();
}

/**
 * ALTER TABLE ... ALTER COLUMN ... TYPE ... USING, built via the `sql\`\`` escape hatch (Kysely's
 * `setDataType` only takes a `ColumnDataType` enum, not a parameterized native type). The pg type
 * comes verbatim from the validated catalog literal; the column name is allowlisted + quoted.
 */
export function compileAlterColumnType(tableName: string, name: string, resolved: ResolvedType): CompiledQuery {
  const tbl = quoteIdent(tableName);
  const col = quoteIdent(name);
  const stmt = sql`alter table ${sql.raw(tbl)} alter column ${sql.raw(col)} type ${sql.raw(resolved.pgType)} using ${sql.raw(col)}::${sql.raw(resolved.pgType)}`;
  return stmt.compile(compiler);
}

/**
 * ALTER TABLE ... ADD CHECK (col IN (members)) — the enum value-set CHECK, members as SAFE escaped
 * literals via `sql.lit` (mirrors the column-level check in {@link compileCreateTable}). Unnamed, so PG
 * auto-names it `<table>_<col>_check` — the same form {@link dropColumnChecks}'s lookup finds by column.
 */
export function compileAddCheck(tableName: string, name: string, values: readonly string[]): CompiledQuery {
  const members = values.map((v) => sql.lit(v));
  const stmt = sql`alter table ${sql.raw(quoteIdent(tableName))} add check (${sql.ref(name)} in (${sql.join(members)}))`;
  return stmt.compile(compiler);
}

/** ALTER TABLE ... DROP CONSTRAINT — used to drop an enum's old CHECK (name discovered at runtime). */
export function compileDropConstraint(tableName: string, constraint: string): CompiledQuery {
  const stmt = sql`alter table ${sql.raw(quoteIdent(tableName))} drop constraint ${sql.raw(quoteIdent(constraint))}`;
  return stmt.compile(compiler);
}

/**
 * COUNT the non-null rows whose char-length exceeds `maxLen` — i.e. the rows a shrink to `varchar(maxLen)`
 * would SILENTLY TRUNCATE. The pre-flight guard runs this before the lossy `ALTER TYPE` so the migrate can
 * fail LOUD on real data loss instead of mangling rows (PG's `::varchar(n)` truncates without a 22001).
 */
export function compileCountTooLong(tableName: string, name: string, maxLen: number): CompiledQuery {
  const stmt = sql`select count(*)::int as n from ${sql.raw(quoteIdent(tableName))} where ${sql.ref(name)} is not null and length(${sql.ref(name)}) > ${sql.lit(maxLen)}`;
  return stmt.compile(compiler);
}

/**
 * COUNT the non-null rows whose value would CHANGE when rounded to `scale` fractional digits — i.e. the rows
 * a numeric scale reduce would SILENTLY ROUND (lose precision). Same pre-flight role as {@link compileCountTooLong}.
 */
export function compileCountScaleLoss(tableName: string, name: string, scale: number): CompiledQuery {
  const stmt = sql`select count(*)::int as n from ${sql.raw(quoteIdent(tableName))} where ${sql.ref(name)} is not null and ${sql.ref(name)} <> round(${sql.ref(name)}, ${sql.lit(scale)})`;
  return stmt.compile(compiler);
}

/** DROP TABLE (RESTRICT by default). */
export function compileDropTable(tableName: string): CompiledQuery {
  return compiler.schema.dropTable(tableName).compile();
}

// --- relation link-table name + DDL ------------------------------------------------------------

const LINK_SUFFIX = '_lnk';
/** Hex chars of the stable hash suffix on overflow (>=8 for collision-resistance over a small catalog). */
const LINK_HASH_HEX = 10;

/**
 * Resolve the physical link-table name for (ownerApiId, fieldName). Both inputs are ALREADY validated
 * identifiers (ownerApiId via deriveTableName's gate, fieldName via validateFieldName) BEFORE calling.
 * base = `${ownerApiId}_${fieldName}_lnk`; if it fits in 63 bytes, use it verbatim. On overflow, build a
 * STABLE name = truncatedPrefix + '_' + sha256(owner + '\0' + field)[:LINK_HASH_HEX], sized so the WHOLE
 * result is <= 63 bytes. The NUL separator makes ('a','bc') vs ('ab','c') hash distinctly. The FINAL name
 * is re-run through validateIdentifier (allowlist + 63-byte gate) and refused if it would collide with a
 * reserved table or the ct_ prefix. The CALLER STORES this verbatim in content_type_relations.link_table;
 * the loader/drop path read it from meta and NEVER re-derive.
 */
export function deriveLinkTableName(ownerApiId: string, fieldName: string): string {
  const base = `${ownerApiId}_${fieldName}${LINK_SUFFIX}`;
  let name: string;
  if (Buffer.byteLength(base, 'utf8') <= MAX_IDENTIFIER_BYTES) {
    name = base;
  } else {
    const hash = createHash('sha256').update(`${ownerApiId}\0${fieldName}`).digest('hex').slice(0, LINK_HASH_HEX);
    const tail = `_${hash}`; // separator + hash
    const room = MAX_IDENTIFIER_BYTES - Buffer.byteLength(tail, 'utf8');
    // Truncate the prefix on a BYTE boundary (ASCII-only here, so chars == bytes); reserve room for tail.
    name = base.slice(0, room) + tail;
  }
  validateIdentifier(name); // allowlist + 63-byte gate, belt-and-suspenders
  const lower = name.toLowerCase();
  if (lower.startsWith(TABLE_PREFIX) || RESERVED_TABLE_NAMES.has(lower)) throw new ReservedTableNameError(name);
  return name;
}

/**
 * CREATE TABLE for a relation link table: id serial PK, owner_id/related_id integer NOT NULL with
 * ON DELETE CASCADE FKs to the (validated, quoted) owner/target ct_ tables, ord double precision, plus
 * the per-kind UNIQUE constraint(s). Compile-only -> { sql, parameters }; executed via tx.unsafe in the
 * same runSchemaTx as the meta INSERTs. ownerTable/targetTable MUST already be deriveTableName output.
 * NO `IF NOT EXISTS` (non-idempotent by design like compileCreateTable): a pre-existing table -> 42P07
 * -> whole-tx rollback.
 *
 * Per-kind UNIQUE map (the cardinality contract): manyToMany -> UNIQUE(owner_id, related_id);
 * oneToMany -> UNIQUE(related_id); manyToOne -> UNIQUE(owner_id); oneToOne -> both.
 */
export function compileCreateLinkTable(linkTable: string, ownerTable: string, targetTable: string, kind: RelationKind): CompiledQuery {
  validateIdentifier(linkTable);
  // Kysely's column `.references('table.column')` takes a STRING it parses + QUOTES itself; ownerTable/
  // targetTable are already validated identifiers (allowlist, no `.`/quote), so the `table.id` form is
  // unambiguous and safe. `.onDelete('cascade')` renders the FK action — no hand-built SQL string.
  let b = compiler.schema
    .createTable(linkTable)
    .addColumn('id', 'serial', (cb) => cb.primaryKey().notNull())
    .addColumn('owner_id', sql`integer`, (cb) => cb.notNull().references(`${ownerTable}.id`).onDelete('cascade'))
    .addColumn('related_id', sql`integer`, (cb) => cb.notNull().references(`${targetTable}.id`).onDelete('cascade'))
    .addColumn('ord', sql`double precision`);
  // Constraint names: short, derived from the resolved link name; cap so they never exceed 63 bytes.
  const cap = (suffix: string): string => {
    const room = MAX_IDENTIFIER_BYTES - suffix.length;
    const nm = `${linkTable.slice(0, room)}${suffix}`;
    return validateIdentifier(nm);
  };
  switch (kind) {
    case 'manyToMany':
      b = b.addUniqueConstraint(cap('_ow_re_uq'), ['owner_id', 'related_id']);
      break;
    case 'oneToMany':
      b = b.addUniqueConstraint(cap('_re_uq'), ['related_id']);
      break;
    case 'manyToOne':
      b = b.addUniqueConstraint(cap('_ow_uq'), ['owner_id']);
      break;
    case 'oneToOne':
      b = b.addUniqueConstraint(cap('_ow_uq'), ['owner_id']).addUniqueConstraint(cap('_re_uq'), ['related_id']);
      break;
  }
  return b.compile();
}

// --- the single atomic transactional applier ---------------------------------------------------

/** Advisory-lock key derived from a table name (stable 31-bit hash). Serializes changes per type. */
export function advisoryKey(tableName: string): number {
  let h = 0;
  for (let i = 0; i < tableName.length; i++) h = (Math.imul(h, 31) + tableName.charCodeAt(i)) | 0;
  return h & 0x7fffffff;
}

/** PG error shape we read inside the catch (postgres.js puts the SQLSTATE on `.code`). */
interface PgError extends Error {
  code?: string;
  /** postgres.js surfaces the violated constraint/unique-index name here (when PG reports one). */
  constraint_name?: string;
  /** raw detail line (a fallback when `constraint_name` is absent). */
  detail?: string;
}

/** Fallback: pull a known unique-index name out of a 23505 DETAIL line when `constraint_name` is absent. */
function extractConstraint(detail: string | undefined): string | undefined {
  if (detail === undefined) return undefined;
  for (const name of ['ctf_type_name_lower_uq', 'ctf_type_sort_uq', 'ctr_type_field_lower_uq', 'content_types_api_id_lower_uq', 'content_types_table_name_lower_uq', 'cmptf_type_name_lower_uq', 'cmptf_type_sort_uq', 'component_types_api_id_lower_uq']) {
    if (detail.includes(name)) return name;
  }
  return undefined;
}

/**
 * Run `work` inside ONE `sql.begin(...)` with a bounded `lock_timeout`, mapping PG SQLSTATEs to the
 * typed errors OUTSIDE the transaction (never try/catch-and-continue inside — that poisons the tx).
 * The advisory lock serializes concurrent schema changes on the same table (queue, not deadlock).
 */
export async function runSchemaTx<T>(sql: Sql, tableName: string, work: (tx: Sql) => Promise<T>): Promise<T> {
  try {
    return await sql.begin(async (tx) => {
      await tx`SET LOCAL lock_timeout = '5s'`;
      // Defense-in-depth: pin standard_conforming_strings ON so the sql.lit single-quote-doubling used
      // for enum CHECK members (and any escaped literal) is correct regardless of server/connection
      // defaults — backslashes never become escape sequences. PG 18 defaults ON; this guarantees it.
      await tx`SET LOCAL standard_conforming_strings = on`;
      await tx`SELECT pg_advisory_xact_lock(${advisoryKey(tableName)})`;
      return work(tx as unknown as Sql);
    }) as T;
  } catch (err) {
    const pg = err as PgError;
    const code = pg.code;
    switch (code) {
      case '55P03': // lock_not_available
      case '40P01': // deadlock_detected
      case '40001': // serialization_failure
        throw new SchemaChangeConflictError(`schema change on ${tableName} conflicted (${code}); retry`);
      case '23505': {
        // unique_violation — DISAMBIGUATE by the violated index so the typed error matches the layer
        // that lost the race. content_types_*_uq => the content-type itself exists; ctf_type_name_lower_uq
        // => a racing DUPLICATE FIELD; ctf_type_sort_uq => a lost-update on `sort` (retryable conflict).
        const constraint = pg.constraint_name ?? extractConstraint(pg.detail);
        if (constraint === 'ctf_type_name_lower_uq' || constraint === 'cmptf_type_name_lower_uq') throw new FieldExistsError(constraint);
        // ctr_type_field_lower_uq => a racing DUPLICATE RELATION field on the same type.
        if (constraint === 'ctr_type_field_lower_uq') throw new FieldExistsError(constraint);
        if (constraint === 'ctf_type_sort_uq' || constraint === 'cmptf_type_sort_uq') throw new SchemaChangeConflictError(`schema change on ${tableName} conflicted (concurrent sort race); retry`);
        // content_types_api_id_lower_uq / content_types_table_name_lower_uq (and any unknown) -> type exists.
        throw new ModuleExistsError(tableName);
      }
      case '23502': // not_null_violation — NOT NULL add to populated table without default
        throw new DefaultTypeError(`adding a NOT NULL column requires a constant default on a populated table`);
      case '22P02': // invalid_text_representation — failed cast / bad uuid / bad enum
      case '22003': // numeric_value_out_of_range
      case '22001': // string_data_right_truncation — varchar shrink
        throw new TypeChangeFailedError(`type change/cast failed (${code})`);
      default:
        throw err;
    }
  }
}
