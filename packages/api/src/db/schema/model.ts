import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { CmsType, ComponentFieldKind, FieldOptions } from '../type.catalog.ts';
import type { RelationKind } from '../ddl.ts';

/**
 * THE FILES-FIRST SCHEMA MODEL (§S1 of docs/research/schema-source-of-truth.md). A content-type is
 * declared in a committed, dev-editable `schema/<apiId>.json` file — the SOURCE OF TRUTH. This module
 * is the model + the Zod BOUNDARY validator for that file; it is PURE (no DB, no fs) and carries the
 * cardinal design choice:
 *
 *   - every type AND field carries a STABLE `id` (short uid, NEVER changes) separate from its `name`
 *     (the API key / column name). Identity is the `id`; `name`/`apiId`/`collectionName` are renamable
 *     LABELS. The diff engine (S3) matches by `id`, so a rename is `id` unchanged + `name` changed →
 *     `ALTER ... RENAME COLUMN` (lossless) instead of Strapi's drop+add data loss.
 *
 * The file stays NON-REDUNDANT: it records ONLY `{ id, name, type, options }` per field. `engine_type`,
 * `pg_type` and the resolved `params` are NOT stored — they are re-derived from `type`+`options` through
 * the SAME catalog (`resolveType`/`resolveComponentField`) the meta writer uses (see `adapt.ts`), so the
 * file can never disagree with how a column actually materializes.
 */

/** A field's declared type: a scalar {@link CmsType} or a {@link ComponentFieldKind} (component kinds). */
export type FieldType = CmsType | ComponentFieldKind;

// The closed set of `type` literals for the Zod gate, kept in lockstep with {@link FieldType}: the
// `satisfies` makes the compiler reject any literal here that is not a FieldType. `as const` first, so
// z.enum receives a literal tuple (not widened `string[]`).
const FIELD_TYPE_LITERALS = [
  'string', 'text', 'email', 'uid', 'enumeration', 'integer', 'biginteger', 'float', 'decimal',
  'boolean', 'date', 'datetime', 'time', 'json', 'array', 'uuid', 'media',
  'component', 'component-repeatable', 'dynamiczone', 'relation',
] as const satisfies readonly FieldType[];

const RELATION_KIND_LITERALS = ['oneToOne', 'oneToMany', 'manyToOne', 'manyToMany'] as const satisfies readonly RelationKind[];

/** A stable id looks like `ct_ab12` / `f_x1` / `rel_9f` / `cmp_kk` — a short prefix + `_` + alnum tail. */
const idSchema = z.string().regex(/^[a-z]{1,8}_[A-Za-z0-9]+$/, 'id must look like "ct_ab12" / "f_x1"');

/**
 * Per-field options — the SAME grab-bag as the catalog's {@link FieldOptions}, validated `.strict()` so a
 * dev's typo in a hand-edited file fails LOUD at the boundary (the catalog does the deep semantic check).
 */
const fieldOptionsSchema = z
  .object({
    length: z.number().int().positive().optional(),
    precision: z.number().int().positive().optional(),
    scale: z.number().int().min(0).optional(),
    values: z.array(z.string()).optional(),
    nullable: z.boolean().optional(),
    default: z.unknown().optional(),
    multiple: z.boolean().optional(),
    component: z.string().optional(),
    components: z.array(z.string()).optional(),
    target: z.string().optional(),
  })
  .strict();

const fieldSchemaZ = z
  .object({
    id: idSchema,
    name: z.string().min(1),
    type: z.enum(FIELD_TYPE_LITERALS),
    options: fieldOptionsSchema.optional(),
    /** i18n: localized (per-variant) vs shared. Mirrors {@link FieldSpec.localized}; defaults true. */
    localized: z.boolean().optional(),
  })
  .strict();

const relationSchemaZ = z
  .object({
    id: idSchema,
    field: z.string().min(1),
    kind: z.enum(RELATION_KIND_LITERALS),
    target: z.string().min(1),
    inverseField: z.string().min(1).optional(),
  })
  .strict();

/**
 * One content-type, as it lives on disk in `schema/<apiId>.json`. `id` is identity; `apiId` is the
 * route/engine key and the basis for the `ct_<apiId>` table; `collectionName` is OPTIONAL (re-derived as
 * `ct_<apiId>` when absent — stored only to mirror Strapi's display↔table decoupling). `info` is cosmetic
 * (unused by the registry). Field ORDER is significant (the byte-identical wire order).
 */
export const schemaZ = z
  .object({
    id: idSchema,
    apiId: z.string().min(1),
    collectionName: z.string().min(1).optional(),
    info: z
      .object({
        singularName: z.string().optional(),
        pluralName: z.string().optional(),
        displayName: z.string().optional(),
      })
      .strict()
      .optional(),
    options: z
      .object({
        draftAndPublish: z.boolean().optional(),
        i18n: z.boolean().optional(),
      })
      .strict()
      .optional(),
    fields: z.array(fieldSchemaZ),
    relations: z.array(relationSchemaZ).optional(),
  })
  .strict();

// The PUBLIC types are explicit interfaces built on the catalog's own {@link FieldOptions}/{@link RelationKind}
// (one source of truth), NOT `z.infer` — under `exactOptionalPropertyTypes` Zod infers optionals as
// `key?: T | undefined`, which drifts from `FieldOptions`. The Zod schema above stays the runtime BOUNDARY
// validator; `serialize.parseSchema` casts its validated output to these interfaces at the seam.

/** A field declaration in a `schema/<apiId>.json` file. */
export interface FieldSchema {
  /** Stable identity (never changes; survives a rename). */
  id: string;
  /** The API key / physical column name (renamable). */
  name: string;
  type: FieldType;
  options?: FieldOptions;
  localized?: boolean;
}

/** A relation declaration owned by a content-type. */
export interface RelationSchema {
  id: string;
  field: string;
  kind: RelationKind;
  target: string;
  inverseField?: string;
}

/**
 * A COMPONENT declaration — a reusable field group with NO physical table (stored as nested JSON in a host
 * type's jsonb column). No options (draft&publish/i18n are content-type concerns) and no top-level relations
 * (a `relation` field INSIDE a component is an inline id-ref, expressed as a normal {@link FieldSchema} of
 * type `relation`). Lives in `schema/components/<apiId>.ts`.
 */
export interface ComponentSchema {
  id: string;
  apiId: string;
  fields: FieldSchema[];
}

/** A whole content-type declaration (one `schema/<apiId>.json` file). */
export interface Schema {
  /** Stable identity (never changes; survives an apiId/displayName rename). */
  id: string;
  apiId: string;
  collectionName?: string;
  info?: { singularName?: string; pluralName?: string; displayName?: string };
  options?: { draftAndPublish?: boolean; i18n?: boolean };
  fields: FieldSchema[];
  relations?: RelationSchema[];
}

/** Mint a fresh stable id with the given kind prefix (32 bits of entropy — ample for a per-project catalog). */
export function mintId(prefix: 'ct' | 'f' | 'rel' | 'cmp'): string {
  return `${prefix}_${randomBytes(4).toString('hex')}`;
}
