/**
 * The scaled-i64 cap for `decimal` columns: the max precision that round-trips losslessly
 * through an int64 in the columnar engine. An ENGINE storage constraint — lives in the engine
 * (store) layer so both the engine (column.ts) and the db type-catalog import it DOWNWARD.
 */
export const DECIMAL_MAX_SAFE_PRECISION = 18;
