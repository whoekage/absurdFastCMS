import type { CmsType, ComponentFieldKind, FieldOptions } from '../type.catalog.ts';
import type { RelationKind } from '../ddl.ts';
import type { ContentTypeSchema, FieldSchema, RelationSchema } from './model.ts';

/**
 * THE CODE-FIRST AUTHORING DSL (pivot §11) — a `schema/<apiId>.ts` declares its content type via
 * {@link defineType} + the {@link c} field builders, with colocated lifecycle hooks. This is the Payload /
 * Drizzle shape: typed field builders, types inferred for free ({@link InferType}), no JSON, no codegen.
 *
 * The DSL is a thin AUTHORING layer over the kept engine: a builder just records `{ id?, cmsType, options }`
 * (+ a phantom TS type for inference). `defToSchema` introspects a def into the SAME internal
 * `ContentTypeSchema` IR the diff/migrate/registry already consume — so the whole engine is UNCHANGED; only
 * the source format moved. Runtime validation stays registry-driven (no redundant zod object is built here).
 *
 * IDs are OPTIONAL: absent ⇒ the field's id is its key / the type's id is its apiId (name-based). Pin an
 * explicit `id` to make a later rename LOSSLESS (the diff matches by id → RENAME COLUMN). Rename-safety is
 * thus an opt-in the dev controls, exactly as the visual Builder will emit ids automatically.
 */

// --- builders (the runtime shape + a phantom type parameter T used only for inference) ---------

/** A scalar/json/media/component field builder. `T` is the inferred wire type; never set at runtime. */
export interface FieldBuilder<T = unknown> {
  readonly __kind: 'field';
  readonly __type?: T;
  readonly id?: string;
  readonly cmsType: CmsType | ComponentFieldKind;
  readonly options: FieldOptions;
}
/** A relation field builder (link-table). `T` is the inferred id / id[] wire type. */
export interface RelationBuilder<T = unknown> {
  readonly __kind: 'relation';
  readonly __type?: T;
  readonly id?: string;
  readonly relKind: RelationKind;
  readonly target: string;
  readonly inverse?: string;
}
type AnyBuilder = FieldBuilder | RelationBuilder;

interface BaseOpts {
  /** Stable id (optional). Absent ⇒ id = the field key. Pin it to keep a rename lossless. */
  id?: string;
  /** Defaults to TRUE (a field is nullable unless declared `nullable: false`). */
  nullable?: boolean;
}
/** Add `| null` to the inferred type unless the options literal says `nullable: false`. */
type Nullable<T, O> = O extends { nullable: false } ? T : T | null;

/** Drop undefined keys so an optional FieldOptions slot is absent, not `undefined` (exactOptional-safe). */
function clean(o: Record<string, unknown>): FieldOptions {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as FieldOptions;
}
function field<T>(cmsType: CmsType | ComponentFieldKind, options: FieldOptions, id?: string): FieldBuilder<T> {
  return id !== undefined ? { __kind: 'field', cmsType, options, id } : { __kind: 'field', cmsType, options };
}

type StringOpts = BaseOpts & { max?: number; default?: string };
type NumOpts = BaseOpts & { default?: number };
type DecimalOpts = BaseOpts & { precision?: number; scale?: number; default?: number };
type MediaOpts = BaseOpts & { multiple?: boolean };
type RelOpts = { id?: string; kind: RelationKind; inverse?: string };

/** The conti field-builder namespace (`c.string(...)`, `c.relation(...)`, ...). */
export const c = {
  string: <O extends StringOpts = {}>(o?: O): FieldBuilder<Nullable<string, O>> =>
    field('string', clean({ length: o?.max, nullable: o?.nullable ?? true, default: o?.default }), o?.id),
  text: <O extends BaseOpts & { default?: string } = {}>(o?: O): FieldBuilder<Nullable<string, O>> =>
    field('text', clean({ nullable: o?.nullable ?? true, default: o?.default }), o?.id),
  email: <O extends StringOpts = {}>(o?: O): FieldBuilder<Nullable<string, O>> =>
    field('email', clean({ length: o?.max, nullable: o?.nullable ?? true }), o?.id),
  uid: <O extends StringOpts = {}>(o?: O): FieldBuilder<Nullable<string, O>> =>
    field('uid', clean({ length: o?.max, nullable: o?.nullable ?? true }), o?.id),
  uuid: <O extends BaseOpts = {}>(o?: O): FieldBuilder<Nullable<string, O>> =>
    field('uuid', clean({ nullable: o?.nullable ?? true }), o?.id),
  enum: <const V extends readonly string[], O extends BaseOpts = {}>(values: V, o?: O): FieldBuilder<Nullable<V[number], O>> =>
    field('enumeration', clean({ values: [...values], nullable: o?.nullable ?? true }), o?.id),
  integer: <O extends NumOpts = {}>(o?: O): FieldBuilder<Nullable<number, O>> =>
    field('integer', clean({ nullable: o?.nullable ?? true, default: o?.default }), o?.id),
  biginteger: <O extends BaseOpts = {}>(o?: O): FieldBuilder<Nullable<string, O>> => // i64 serializes as string
    field('biginteger', clean({ nullable: o?.nullable ?? true }), o?.id),
  float: <O extends NumOpts = {}>(o?: O): FieldBuilder<Nullable<number, O>> =>
    field('float', clean({ nullable: o?.nullable ?? true, default: o?.default }), o?.id),
  decimal: <O extends DecimalOpts = {}>(o?: O): FieldBuilder<Nullable<string, O>> => // numeric serializes as string
    field('decimal', clean({ precision: o?.precision, scale: o?.scale, nullable: o?.nullable ?? true }), o?.id),
  boolean: <O extends BaseOpts & { default?: boolean } = {}>(o?: O): FieldBuilder<Nullable<boolean, O>> =>
    field('boolean', clean({ nullable: o?.nullable ?? true, default: o?.default }), o?.id),
  date: <O extends BaseOpts = {}>(o?: O): FieldBuilder<Nullable<string, O>> =>
    field('date', clean({ nullable: o?.nullable ?? true }), o?.id),
  datetime: <O extends BaseOpts = {}>(o?: O): FieldBuilder<Nullable<string, O>> =>
    field('datetime', clean({ nullable: o?.nullable ?? true }), o?.id),
  json: <O extends BaseOpts = {}>(o?: O): FieldBuilder<Nullable<unknown, O>> =>
    field('json', clean({ nullable: o?.nullable ?? true }), o?.id),
  media: <O extends MediaOpts = {}>(o?: O): FieldBuilder<Nullable<O extends { multiple: true } ? number[] : number, O>> =>
    field('media', clean({ multiple: o?.multiple ?? false, nullable: o?.nullable ?? true }), o?.id),
  component: <O extends BaseOpts = {}>(name: string, o?: O): FieldBuilder<Nullable<unknown, O>> =>
    field('component', clean({ component: name, nullable: o?.nullable ?? true }), o?.id),
  dynamiczone: (names: readonly string[], o?: { id?: string }): FieldBuilder<unknown[]> =>
    field('dynamiczone', clean({ components: [...names] }), o?.id),
  relation: <const O extends RelOpts>(target: string, o: O): RelationBuilder<O['kind'] extends 'oneToMany' | 'manyToMany' ? number[] : number | null> => {
    const b: RelationBuilder<never> = o.inverse !== undefined
      ? { __kind: 'relation', relKind: o.kind, target, inverse: o.inverse, ...(o.id !== undefined ? { id: o.id } : {}) }
      : { __kind: 'relation', relKind: o.kind, target, ...(o.id !== undefined ? { id: o.id } : {}) };
    return b as never;
  },
};

// --- defineType + the lifecycle hook surface ---------------------------------------------------

type FieldsRecord = Record<string, AnyBuilder>;
export interface TypeOptions {
  draftAndPublish?: boolean;
  i18n?: boolean;
}
/** A content lifecycle hook — fires around a write (the registry/write-path invokes them; wired in a later phase). */
export type HookFn = (entry: Record<string, unknown>, ctx: HookContext) => void | Promise<void>;
export interface HookContext {
  readonly apiId: string;
  readonly op: 'create' | 'update' | 'delete';
}
export interface Hooks {
  beforeCreate?: HookFn;
  afterCreate?: HookFn;
  beforeUpdate?: HookFn;
  afterUpdate?: HookFn;
  beforeDelete?: HookFn;
  afterDelete?: HookFn;
}

/** The captured content-type definition (carries the field record + options as type params for inference). */
export interface TypeDef<F extends FieldsRecord = FieldsRecord, O extends TypeOptions = TypeOptions> {
  readonly id?: string;
  readonly options?: O;
  readonly fields: F;
  readonly hooks?: Hooks;
}

/**
 * Author a content type. Identity helper (like `defineConfig`) — returns the def verbatim but captures the
 * field record + options as generics so {@link InferType} can derive the typed entry. The `apiId` is the
 * FILE NAME (the loader supplies it); `id`/field ids are optional (see the DSL header).
 */
export function defineType<const F extends FieldsRecord, const O extends TypeOptions = {}>(def: {
  id?: string;
  options?: O;
  fields: F;
  hooks?: Hooks;
}): TypeDef<F, O> {
  return def;
}

// --- type inference (types for free) -----------------------------------------------------------

type InferBuilder<B> = B extends FieldBuilder<infer T> ? T : B extends RelationBuilder<infer T> ? T : never;
type SystemFields<O> = { id: number; created_at: string; updated_at: string } & (O extends { draftAndPublish: true }
  ? { published_at: string | null }
  : Record<never, never>) &
  (O extends { i18n: true } ? { document_id: number; locale: string } : Record<never, never>);

/** The inferred entry type for a content type — system fields + each user field's wire type. */
export type InferType<D> = D extends TypeDef<infer F, infer O>
  ? SystemFields<O> & { -readonly [K in keyof F]: InferBuilder<F[K]> }
  : never;

// --- introspection: DSL def → the internal ContentTypeSchema IR --------------------------------

/**
 * Introspect a {@link TypeDef} into the engine's internal {@link ContentTypeSchema} IR (the SAME shape the
 * JSON path produced) — so diff/migrate/registry are unchanged. The field KEY is the name; a relation
 * builder becomes a {@link RelationSchema} (split out of `fields`), everything else a {@link FieldSchema}.
 * `apiId` comes from the file name; ids fall back to the key/apiId when not pinned.
 */
export function defToSchema(def: TypeDef, apiId: string): ContentTypeSchema {
  const fields: FieldSchema[] = [];
  const relations: RelationSchema[] = [];
  for (const [name, b] of Object.entries(def.fields)) {
    if (b.__kind === 'relation') {
      relations.push(
        b.inverse !== undefined
          ? { id: b.id ?? name, field: name, kind: b.relKind, target: b.target, inverseField: b.inverse }
          : { id: b.id ?? name, field: name, kind: b.relKind, target: b.target },
      );
    } else {
      fields.push({ id: b.id ?? name, name, type: b.cmsType, options: b.options });
    }
  }
  const schema: ContentTypeSchema = { id: def.id ?? apiId, apiId, fields };
  if (def.options !== undefined) schema.options = def.options;
  if (relations.length > 0) schema.relations = relations;
  return schema;
}
