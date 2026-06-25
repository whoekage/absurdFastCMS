import type { Sql, TransactionSql } from 'postgres';
import type { ModuleDef, RelationMeta } from './registry.ts';
import type { RelationOp } from './body.parser.ts';
import { quoteIdent, validateIdentifier, inverseKind, type RelationKind } from './ddl.ts';
import { EntryWriteError, mapPgError } from './entry.repository.ts';

/**
 * The WRITE-side link-table mutator — the relation counterpart to {@link entry-repo.ts}. Applies the
 * validated {@link RelationOp}s of ONE owner row INSIDE the caller's transaction (the scalar write +
 * these link mutations commit together; a non-existent related id raises FK 23503 -> the whole tx rolls
 * back -> a clean {@link EntryWriteError} 400, no partial write).
 *
 * SECURITY DOCTRINE (mirrors entry-repo): the link table identifier comes ONLY from the validated
 * relation meta (`meta.linkTable`, re-validated here belt-and-suspenders); `owner_id`/`related_id`/`ord`
 * are FIXED column literals; every id is a BOUND parameter; `meta.kind` selects a FIXED SQL template.
 *
 * COLUMN ORIENTATION (the sharpest edge): the physical `owner_id`/`related_id` columns are anchored to
 * the OWNING ct_ table, NOT to whichever API field drove the write. When the body-owner writes through
 * the OWNING field (`meta.isOwner === true`) the body-owner id IS `owner_id` and each op id is
 * `related_id`. When it writes through the INVERSE field (`meta.isOwner === false`) the orientation
 * SWAPS: the body-owner id is `related_id` and each op id is `owner_id`.
 *
 * CARDINALITY KIND: the per-kind UNIQUE / ON CONFLICT target always names the PHYSICAL column, which was
 * built from the OWNING side's kind (ddl.ts `compileCreateLinkTable`). The inverse meta row stores the
 * INVERSE kind (`inverseKind(spec.kind)`), so the physical/owning kind is `meta.kind` on the owning side
 * and `inverseKind(meta.kind)` on the inverse side — `owningKind` below. Get this right: using the
 * inverse meta's kind directly would name a non-existent UNIQUE (42P10).
 */

/** The OWNING-side kind that drives the PHYSICAL link-table UNIQUEs, from either side's meta. */
function owningKind(meta: RelationMeta): RelationKind {
  return meta.isOwner ? meta.kind : inverseKind(meta.kind);
}

/** Apply every relation op for `ownerId` (the body-owner's row) within the caller's tx `tx`. */
export async function applyRelationOps(tx: Sql | TransactionSql, def: ModuleDef, ownerId: number, ops: RelationOp[]): Promise<void> {
  for (const op of ops) {
    const meta = def.relationsByField.get(op.field);
    if (meta === undefined) throw new EntryWriteError('write rejected: unknown relation field'); // unreachable past the validator.
    validateIdentifier(meta.linkTable); // belt-and-suspenders identifier gate (also validated at declare + registry build).
    const tbl = quoteIdent(meta.linkTable);
    // The physical column that carries the BODY-OWNER id (owning side: owner_id; inverse side: related_id).
    const bodyOwnerCol = meta.isOwner ? 'owner_id' : 'related_id';
    const otherCol = meta.isOwner ? 'related_id' : 'owner_id';

    try {
      if (op.op === 'set') {
        // Replace this owner's whole related set: clear (unconditionally, so `[]` clears) then re-add.
        // Assert the to-one cap BEFORE the DELETE so the guard short-circuits before any mutation runs
        // (mirrors the `connect` branch; harmless inside the tx either way, but clearer + no wasted DELETE).
        assertToOneCap(meta, op);
        await tx.unsafe(`DELETE FROM ${tbl} WHERE ${quoteIdent(bodyOwnerCol)} = $1`, [ownerId] as never[]);
        for (const id of op.ids) await insertEdge(tx, meta, tbl, ownerId, id);
      } else if (op.op === 'connect') {
        assertToOneCap(meta, op);
        for (const id of op.ids) await insertEdge(tx, meta, tbl, ownerId, id);
      } else {
        // disconnect: delete the specific (body-owner, related) edges; 0 rows = no-op.
        if (op.ids.length === 0) continue;
        await tx.unsafe(
          `DELETE FROM ${tbl} WHERE ${quoteIdent(bodyOwnerCol)} = $1 AND ${quoteIdent(otherCol)} = ANY($2::int[])`,
          [ownerId, op.ids] as never[],
        );
      }
    } catch (e) {
      mapPgError(e);
    }
  }
}

/**
 * Defense-in-depth to-one cap in the mutation layer. The parser already caps set/connect to <=1 id when
 * the BODY-OWNER side is to-one. The corruption it prevents: when the body-owner occupies the `owner_id`
 * column (isOwner) AND that column is UNIQUE (owningKind oneToOne/manyToOne), >1 id would make the
 * INSERT ... ON CONFLICT (owner_id) DO UPDATE silently last-write-win on a single owner. Mirror that
 * exact condition here. (When isOwner=false the body-owner is in `related_id`, so many distinct
 * owner_ids is legitimate — e.g. connecting many books through the inverse author.books field.)
 */
function assertToOneCap(meta: RelationMeta, op: RelationOp): void {
  const kind = owningKind(meta);
  const ownerColIsUnique = kind === 'oneToOne' || kind === 'manyToOne';
  if (meta.isOwner && ownerColIsUnique && op.ids.length > 1) {
    throw new EntryWriteError('write rejected: a to-one relation accepts at most one id');
  }
}

/**
 * INSERT one edge with cardinality MAINTAINED by reassignment per the OWNING kind (never a 23505 on a
 * legit reassign). The (owner_id, related_id) VALUES are oriented by `isOwner`; the ON CONFLICT target
 * names the PHYSICAL UNIQUE column(s) from ddl.ts via COLUMN INFERENCE (not the cap()-truncated
 * constraint name). `ord` is left NULL (the column is nullable; populate ordering is edge/PK order).
 */
async function insertEdge(tx: Sql | TransactionSql, meta: RelationMeta, tbl: string, ownerId: number, id: number): Promise<void> {
  // Physical column values: owning side -> (owner_id=ownerId, related_id=id); inverse side -> swapped.
  const o = meta.isOwner ? ownerId : id;
  const r = meta.isOwner ? id : ownerId;
  switch (owningKind(meta)) {
    case 'manyToMany':
      // UNIQUE(owner_id, related_id): idempotent — a duplicate edge collapses to one row.
      await tx.unsafe(
        `INSERT INTO ${tbl} (owner_id, related_id, ord) VALUES ($1, $2, NULL) ON CONFLICT (owner_id, related_id) DO NOTHING`,
        [o, r] as never[],
      );
      break;
    case 'manyToOne':
      // UNIQUE(owner_id): the owner holds <=1 edge — reassign its single edge to the new related.
      await tx.unsafe(
        `INSERT INTO ${tbl} (owner_id, related_id, ord) VALUES ($1, $2, NULL) ON CONFLICT (owner_id) DO UPDATE SET related_id = EXCLUDED.related_id, ord = EXCLUDED.ord`,
        [o, r] as never[],
      );
      break;
    case 'oneToMany':
      // UNIQUE(related_id): the related holds <=1 owner — move the related under this owner.
      await tx.unsafe(
        `INSERT INTO ${tbl} (owner_id, related_id, ord) VALUES ($1, $2, NULL) ON CONFLICT (related_id) DO UPDATE SET owner_id = EXCLUDED.owner_id, ord = EXCLUDED.ord`,
        [o, r] as never[],
      );
      break;
    case 'oneToOne':
      // TWO uniques (owner_id AND related_id): a single ON CONFLICT cannot cover both, so pre-DELETE any
      // conflicting edge on EITHER side, then a plain INSERT. A self-link (o === r) deletes its prior
      // self-row and re-adds it — correct.
      await tx.unsafe(`DELETE FROM ${tbl} WHERE owner_id = $1 OR related_id = $2`, [o, r] as never[]);
      await tx.unsafe(`INSERT INTO ${tbl} (owner_id, related_id, ord) VALUES ($1, $2, NULL)`, [o, r] as never[]);
      break;
  }
}
