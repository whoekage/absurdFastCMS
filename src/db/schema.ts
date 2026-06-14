import { pgTable, serial, varchar, text, integer, doublePrecision, boolean, timestamp } from 'drizzle-orm/pg-core';

/**
 * The `article` content-type as a Postgres table — the SOURCE OF TRUTH for the read engine.
 *
 * Nullability mirrors the engine's column nullability (and the old in-code seed): `title`, `views`,
 * `rating` are nullable; everything else is NOT NULL. Column names are snake_case in Postgres but
 * Drizzle maps them back to the camelCase JS property names the API exposes (`publishedAt`), which
 * are exactly the engine {@link FieldDef} names. `id` (serial PK) becomes the engine's `id` field —
 * the real primary key the public API and `GET /article/:id` resolve against.
 */
export const articles = pgTable('articles', {
  id: serial('id').primaryKey(),
  title: varchar('title', { length: 512 }),
  body: text('body').notNull(),
  status: varchar('status', { length: 32 }).notNull(),
  views: integer('views'),
  rating: doublePrecision('rating'),
  active: boolean('active').notNull(),
  publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' }).notNull(),
});

export type ArticleRow = typeof articles.$inferSelect;
