import type { CmsType, ComponentFieldKind, FieldOptions, FieldCondition } from '../type.catalog.ts';
import type { RelationKind } from '../ddl.ts';
import type { Schema, FieldSchema, RelationSchema } from './model.ts';

/**
 * THE CODE-FIRST AUTHORING DSL (pivot §11) — a `schema/<name>.ts` declares its module via
 * {@link defineSchema} + the {@link c} field builders. Lifecycle hooks live in a SIBLING
 * `schema/<name>.hooks.ts` ({@link defineHooks}) — a clean machine/human split: the visual Builder OWNS +
 * regenerates `<name>.ts` wholesale (no AST surgery), and NEVER touches the dev-owned `.hooks.ts`. This is
 * the Payload/Drizzle shape: typed field builders, types inferred for free ({@link InferType}), no JSON.
 *
 * The DSL is a thin AUTHORING layer over the kept engine: a builder just records `{ id?, type, options }`
 * (+ a phantom TS type for inference). `defToSchema` introspects a def into the SAME internal
 * `Schema` IR the diff/migrate/registry already consume — so the whole engine is UNCHANGED; only
 * the source format moved. Runtime validation stays registry-driven (no redundant zod object is built here).
 *
 * IDs are OPTIONAL: absent ⇒ the field's id is its key / the type's id is its name (name-based). Pin an
 * explicit `id` to make a later rename LOSSLESS (the diff matches by id → RENAME COLUMN). Rename-safety is
 * thus an opt-in the dev controls, exactly as the visual Builder will emit ids automatically.
 */

// --- builders (the runtime shape + a phantom type parameter T used only for inference) ---------

/** A scalar/json/media/component field builder. `T` is the inferred wire type; never set at runtime. */
export interface FieldBuilder<T = unknown> {
  readonly __kind: 'field';
  readonly __type?: T;
  readonly id?: string;
  readonly type: CmsType | ComponentFieldKind;
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
  readonly displayField?: string;
}
type AnyBuilder = FieldBuilder | RelationBuilder;

interface BaseOpts {
  /** Stable id (optional). Absent ⇒ id = the field key. Pin it to keep a rename lossless. */
  id?: string;
  /** Defaults to TRUE (a field is nullable unless declared `nullable: false`). */
  nullable?: boolean;
  /** Admin editor layout width — 'full' (default) or 'half' (two side-by-side). Metadata only. */
  editorWidth?: 'full' | 'half';
  /** Admin conditional visibility ("show when …"). Metadata only. */
  condition?: FieldCondition;
}
/** Add `| null` to the inferred type unless the options literal says `nullable: false`. */
type Nullable<T, O> = O extends { nullable: false } ? T : T | null;

/** Drop undefined keys so an optional FieldOptions slot is absent, not `undefined` (exactOptional-safe). */
function clean(o: Record<string, unknown>): FieldOptions {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as FieldOptions;
}
function field<T>(type: CmsType | ComponentFieldKind, options: FieldOptions, id?: string): FieldBuilder<T> {
  return id !== undefined ? { __kind: 'field', type, options, id } : { __kind: 'field', type, options };
}
/** The per-field metadata EVERY type carries (editor layout + conditional visibility); undefined-dropped by clean(). */
function common(o?: BaseOpts): Record<string, unknown> {
  return { editorWidth: o?.editorWidth, condition: o?.condition };
}

type StringOpts = BaseOpts & { max?: number; min?: number; default?: string };
type NumOpts = BaseOpts & { min?: number; max?: number; default?: number };
type DecimalOpts = BaseOpts & { precision?: number; scale?: number; default?: number };
type MediaOpts = BaseOpts & { multiple?: boolean };
type RelOpts = { id?: string; kind: RelationKind; inverse?: string; displayField?: string };

/** The conti field-builder namespace (`c.string(...)`, `c.relation(...)`, ...). */
export const c = {
  string: <O extends StringOpts = {}>(o?: O): FieldBuilder<Nullable<string, O>> =>
    field('string', clean({ length: o?.max, min: o?.min, nullable: o?.nullable ?? true, default: o?.default, ...common(o) }), o?.id),
  text: <O extends BaseOpts & { default?: string } = {}>(o?: O): FieldBuilder<Nullable<string, O>> =>
    field('text', clean({ nullable: o?.nullable ?? true, default: o?.default, ...common(o) }), o?.id),
  email: <O extends StringOpts = {}>(o?: O): FieldBuilder<Nullable<string, O>> =>
    field('email', clean({ length: o?.max, min: o?.min, nullable: o?.nullable ?? true, ...common(o) }), o?.id),
  uid: <O extends StringOpts = {}>(o?: O): FieldBuilder<Nullable<string, O>> =>
    field('uid', clean({ length: o?.max, min: o?.min, nullable: o?.nullable ?? true, ...common(o) }), o?.id),
  uuid: <O extends BaseOpts = {}>(o?: O): FieldBuilder<Nullable<string, O>> =>
    field('uuid', clean({ nullable: o?.nullable ?? true, ...common(o) }), o?.id),
  enum: <const V extends readonly string[], O extends BaseOpts = {}>(values: V, o?: O): FieldBuilder<Nullable<V[number], O>> =>
    field('enumeration', clean({ values: [...values], nullable: o?.nullable ?? true, ...common(o) }), o?.id),
  integer: <O extends NumOpts = {}>(o?: O): FieldBuilder<Nullable<number, O>> =>
    field('integer', clean({ nullable: o?.nullable ?? true, min: o?.min, max: o?.max, default: o?.default, ...common(o) }), o?.id),
  biginteger: <O extends BaseOpts = {}>(o?: O): FieldBuilder<Nullable<string, O>> => // i64 serializes as string
    field('biginteger', clean({ nullable: o?.nullable ?? true, ...common(o) }), o?.id),
  float: <O extends NumOpts = {}>(o?: O): FieldBuilder<Nullable<number, O>> =>
    field('float', clean({ nullable: o?.nullable ?? true, min: o?.min, max: o?.max, default: o?.default, ...common(o) }), o?.id),
  decimal: <O extends DecimalOpts = {}>(o?: O): FieldBuilder<Nullable<string, O>> => // numeric serializes as string
    field('decimal', clean({ precision: o?.precision, scale: o?.scale, nullable: o?.nullable ?? true, ...common(o) }), o?.id),
  boolean: <O extends BaseOpts & { default?: boolean } = {}>(o?: O): FieldBuilder<Nullable<boolean, O>> =>
    field('boolean', clean({ nullable: o?.nullable ?? true, default: o?.default, ...common(o) }), o?.id),
  date: <O extends BaseOpts = {}>(o?: O): FieldBuilder<Nullable<string, O>> =>
    field('date', clean({ nullable: o?.nullable ?? true, ...common(o) }), o?.id),
  datetime: <O extends BaseOpts = {}>(o?: O): FieldBuilder<Nullable<string, O>> =>
    field('datetime', clean({ nullable: o?.nullable ?? true, ...common(o) }), o?.id),
  json: <O extends BaseOpts = {}>(o?: O): FieldBuilder<Nullable<unknown, O>> =>
    field('json', clean({ nullable: o?.nullable ?? true, ...common(o) }), o?.id),
  media: <O extends MediaOpts = {}>(o?: O): FieldBuilder<Nullable<O extends { multiple: true } ? number[] : number, O>> =>
    field('media', clean({ multiple: o?.multiple ?? false, nullable: o?.nullable ?? true, ...common(o) }), o?.id),
  component: <O extends BaseOpts = {}>(name: string, o?: O): FieldBuilder<Nullable<unknown, O>> =>
    field('component', clean({ component: name, nullable: o?.nullable ?? true, ...common(o) }), o?.id),
  dynamiczone: (names: readonly string[], o?: { id?: string }): FieldBuilder<unknown[]> =>
    field('dynamiczone', clean({ components: [...names] }), o?.id),
  relation: <const O extends RelOpts>(target: string, o: O): RelationBuilder<O['kind'] extends 'oneToMany' | 'manyToMany' ? number[] : number | null> => {
    const b: RelationBuilder<never> = {
      __kind: 'relation',
      relKind: o.kind,
      target,
      ...(o.inverse !== undefined ? { inverse: o.inverse } : {}),
      ...(o.displayField !== undefined ? { displayField: o.displayField } : {}),
      ...(o.id !== undefined ? { id: o.id } : {}),
    };
    return b as never;
  },
};

// --- defineSchema + the lifecycle hook surface ---------------------------------------------------

type FieldsRecord = Record<string, AnyBuilder>;
export interface TypeOptions {
  draftAndPublish?: boolean;
  i18n?: boolean;
}
export interface HookContext {
  readonly name: string;
  readonly op: 'create' | 'update' | 'delete';
}
/**
 * A `before*` hook — TRANSFORM + VETO. Runs INSIDE the write transaction, pre-persist. Receives the
 * validated write data and RETURNS the (possibly transformed) data to persist (return-value contract, like
 * Payload/Directus — explicit + typed, not mutate-in-place). Returning nothing passes the input through.
 * THROW to veto: it aborts the transaction (rollback) → 400 (throw a {@link HookError} for a clean message).
 * Never do side-effects here (uncommitted/rollback would make them phantom).
 */
export type BeforeHookFn = (data: Record<string, unknown>, ctx: HookContext) => Record<string, unknown> | void | Promise<Record<string, unknown> | void>;
/**
 * An `after*` hook — REACT to a committed change. Runs AFTER commit + the read-engine rebuild, with the
 * committed row. Side-effects only: it cannot mutate or veto, and a throw is LOGGED, never fatal (the write
 * is already durable). For durable post-commit work (email/webhooks) prefer a transactional outbox.
 */
export type AfterHookFn = (entry: Record<string, unknown>, ctx: HookContext) => void | Promise<void>;
export interface Hooks {
  beforeCreate?: BeforeHookFn;
  afterCreate?: AfterHookFn;
  beforeUpdate?: BeforeHookFn;
  afterUpdate?: AfterHookFn;
  beforeDelete?: BeforeHookFn;
  afterDelete?: AfterHookFn;
}

/** The captured module definition (carries the field record + options as type params for inference). */
export interface TypeDef<F extends FieldsRecord = FieldsRecord, O extends TypeOptions = TypeOptions> {
  readonly id?: string;
  /** Editable human display name; `label ?? name` is what the admin shows. Not derivable from the file name. */
  readonly label?: string;
  readonly options?: O;
  readonly fields: F;
}

/**
 * Author a module. Identity helper (like `defineConfig`) — returns the def verbatim but captures the
 * field record + options as generics so {@link InferType} can derive the typed entry. The `name` is the
 * FILE NAME (the loader supplies it); `label`/`id`/field ids are optional (see the DSL header). Lifecycle
 * hooks go in a sibling `schema/<name>.hooks.ts` ({@link defineHooks}), NOT here.
 */
export function defineSchema<const F extends FieldsRecord, const O extends TypeOptions = {}>(def: {
  id?: string;
  label?: string;
  options?: O;
  fields: F;
}): TypeDef<F, O> {
  return def;
}

/**
 * Author a module's lifecycle hooks — the default export of `schema/<name>.hooks.ts`. Identity
 * helper for type-checking. `before*` transform/veto inside the write tx; `after*` react post-commit
 * (see the Hooks types). The loader pairs this file with `<name>.ts` by name.
 */
export function defineHooks(hooks: Hooks): Hooks {
  return hooks;
}

// --- type inference (types for free) -----------------------------------------------------------

type InferBuilder<B> = B extends FieldBuilder<infer T> ? T : B extends RelationBuilder<infer T> ? T : never;
type SystemFields<O> = { id: number; created_at: string; updated_at: string } & (O extends { draftAndPublish: true }
  ? { published_at: string | null }
  : Record<never, never>) &
  (O extends { i18n: true } ? { document_id: number; locale: string } : Record<never, never>);

/** The inferred entry type for a module — system fields + each user field's wire type. */
export type InferType<D> = D extends TypeDef<infer F, infer O>
  ? SystemFields<O> & { -readonly [K in keyof F]: InferBuilder<F[K]> }
  : never;

// --- introspection: DSL def → the internal Schema IR --------------------------------

/**
 * Introspect a {@link TypeDef} into the engine's internal {@link Schema} IR (the SAME shape the
 * JSON path produced) — so diff/migrate/registry are unchanged. The field KEY is the name; a relation
 * builder becomes a {@link RelationSchema} (split out of `fields`), everything else a {@link FieldSchema}.
 * `name` comes from the file name; ids fall back to the key/name when not pinned.
 */
export function defToSchema(def: TypeDef, moduleName: string): Schema {
  const fields: FieldSchema[] = [];
  const relations: RelationSchema[] = [];
  for (const [name, b] of Object.entries(def.fields)) {
    if (b.__kind === 'relation') {
      const rel: RelationSchema = { id: b.id ?? name, field: name, kind: b.relKind, target: b.target };
      if (b.inverse !== undefined) rel.inverseField = b.inverse;
      if (b.displayField !== undefined) rel.displayField = b.displayField;
      relations.push(rel);
    } else {
      fields.push({ id: b.id ?? name, name, type: b.type, options: b.options });
    }
  }
  const schema: Schema = { id: def.id ?? moduleName, name: moduleName, fields };
  if (def.label !== undefined) schema.label = def.label;
  if (def.options !== undefined) schema.options = def.options;
  if (relations.length > 0) schema.relations = relations;
  return schema;
}
