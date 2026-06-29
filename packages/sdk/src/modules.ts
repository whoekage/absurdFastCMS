// @conti/sdk — files-first module READ surface (introspection).
//
// The legacy-meta teardown removed the runtime-DDL Builder routes (POST /content-types …) and their
// server-side def projection (`projectDef`). Schema is files-first now: a module lives in a committed
// `schema/<name>.json` file (the Schema IR), and the server exposes it READ-ONLY at:
//   • GET /builder/modules        → { ok, schemas: ModuleSchema[], version }
//   • GET /builder/modules/:name → { ok, schema:  ModuleSchema,   version }
// (mutation — PUT/DELETE/preview/reload — is files-first and out of scope for a data-access client.)
//
// The Schema IR is NON-REDUNDANT (records only `{ id, name, type, options }` per field; system fields and
// engine/pg types are re-derived). The admin still consumes the richer {@link ModuleDefinition}
// projection (system fields synthesized + prepended, two-way INVERSE relations folded in), so this module
// ports that projection CLIENT-SIDE — a faithful re-implementation of the api's deleted `projectDef` /
// registry `buildDef`, operating on the wire Schema IR.

import type {
  CmsType,
  ComponentFieldKind,
  FieldOptions,
  RelationKind,
  ModuleDefinition,
  FieldDefinition,
  RelationDefinition,
} from './types.ts';

/** A field as it lives in a `schema/<name>.json` file (the wire Schema IR). Mirrors `@conti/api`'s `FieldSchema`. */
export interface SchemaField {
  /** Stable identity (never changes; survives a rename). */
  id: string;
  /** The API key / physical column name (renamable). */
  name: string;
  type: CmsType | ComponentFieldKind;
  options?: FieldOptions;
  /** i18n: per-variant (true) vs shared (false). Defaults true. */
  localized?: boolean;
}

/** A relation declared (owned) by a module in its schema file. Mirrors `@conti/api`'s `RelationSchema`. */
export interface SchemaRelation {
  id: string;
  field: string;
  kind: RelationKind;
  target: string;
  inverseField?: string;
  displayField?: string;
}

/** One module as it lives on disk (`GET /builder/modules` element). Mirrors `@conti/api`'s `Schema`. */
export interface ModuleSchema {
  id: string;
  name: string;
  /** Editable human display name; `label ?? name` is what the admin shows. */
  label?: string;
  collectionName?: string;
  options?: { draftAndPublish?: boolean; i18n?: boolean };
  fields: SchemaField[];
  relations?: SchemaRelation[];
}

/** `GET /builder/modules` 200 body. */
export interface BuilderListResponse {
  ok: true;
  schemas: ModuleSchema[];
  version: string;
}

/** `GET /builder/modules/:name` 200 body. */
export interface BuilderGetResponse {
  ok: true;
  schema: ModuleSchema;
  version: string;
}

/** Invert a relation kind for the inverse (target) side: oneToMany↔manyToOne; oneToOne/manyToMany self-inverse. */
function invertKind(kind: RelationKind): RelationKind {
  if (kind === 'oneToMany') return 'manyToOne';
  if (kind === 'manyToOne') return 'oneToMany';
  return kind; // oneToOne / manyToMany are self-inverse
}

/** A synthesized system field (id/created_at/updated_at/document_id/published_at/locale). */
function systemField(name: string, type: CmsType, nullable: boolean, i18n: boolean): FieldDefinition {
  // For an i18n type EVERY field carries the conditional `localized` key (system fields are shared → false);
  // a non-i18n type omits the key entirely (a conditional wire key, matching the api projection).
  return { name, type, nullable, system: true, ...(i18n ? { localized: false } : {}) };
}

/** Project ONE module's own (system + user) fields, in the byte-identical order id/created_at/updated_at/[document_id]/[published_at]/[locale]/…user. */
function projectFields(schema: ModuleSchema): FieldDefinition[] {
  const i18n = schema.options?.i18n === true;
  const draftPublish = schema.options?.draftAndPublish === true;
  const fields: FieldDefinition[] = [
    systemField('id', 'integer', false, i18n),
    systemField('created_at', 'datetime', false, i18n),
    systemField('updated_at', 'datetime', false, i18n),
  ];
  // Order mirrors the api registry buildDef: document_id, then published_at, then locale.
  if (i18n) fields.push(systemField('document_id', 'integer', false, i18n));
  if (draftPublish) fields.push(systemField('published_at', 'datetime', true, i18n));
  if (i18n) fields.push(systemField('locale', 'string', false, i18n));

  for (const f of schema.fields) {
    const o: FieldOptions = f.options ?? {};
    const def: FieldDefinition = {
      name: f.name,
      type: f.type,
      nullable: o.nullable ?? true, // files-first default: nullable unless explicitly NOT NULL
      system: false,
    };
    if (f.type === 'enumeration' && o.values !== undefined) def.enumValues = o.values;
    if (o.length !== undefined) def.length = o.length;
    if (o.scale !== undefined) def.scale = o.scale;
    if (o.precision !== undefined) def.precision = o.precision;
    if (o.default !== undefined) def.default = o.default;
    if (f.type === 'media') def.multiple = o.multiple ?? false;
    if ((f.type === 'component' || f.type === 'component-repeatable') && o.component !== undefined) def.component = o.component;
    if (f.type === 'dynamiczone' && o.components !== undefined) def.components = o.components;
    if (i18n) def.localized = f.localized ?? true;
    fields.push(def);
  }
  return fields;
}

/**
 * Project the FULL catalog of Schema IRs into {@link ModuleDefinition}s — the faithful client-side port of
 * the api's deleted `projectDef`. Each module gets its synthesized system fields + its OWN (owner)
 * relations, PLUS every two-way INVERSE relation that another module declares against it (so a target type
 * lists the partner field exactly as the old server projection did). Cross-module derivation needs the
 * whole set, which is why introspection projects from the list, not a single schema.
 */
export function projectSchemas(schemas: ModuleSchema[]): ModuleDefinition[] {
  return schemas.map((schema) => {
    const relations: RelationDefinition[] = (schema.relations ?? []).map((r) => ({
      field: r.field,
      kind: r.kind,
      target: r.target,
      owner: true,
      ...(r.inverseField !== undefined ? { inverseField: r.inverseField } : {}),
      ...(r.displayField !== undefined ? { displayField: r.displayField } : {}),
    }));
    // Fold in the inverse side of every TWO-WAY relation any module declares against this one.
    for (const other of schemas) {
      for (const r of other.relations ?? []) {
        if (r.target !== schema.name || r.inverseField === undefined) continue;
        relations.push({
          field: r.inverseField,
          kind: invertKind(r.kind),
          target: other.name,
          owner: false,
          inverseField: r.field,
        });
      }
    }
    const def: ModuleDefinition = { name: schema.name, fields: projectFields(schema), relations };
    if (schema.label !== undefined) def.label = schema.label;
    if (schema.options?.draftAndPublish === true) def.draftPublish = true;
    if (schema.options?.i18n === true) def.i18n = true;
    return def;
  });
}
