import { defineSchema, c } from '@conti/core';

/**
 * The demo content-type — files-first, code-first. One FOLDER per entity: this `entities/<apiId>/schema.ts`
 * is the SOURCE OF TRUTH (`conti migrate` applies it; the engine builds its registry from it;
 * `InferType<typeof Article>` gives the entry type for free). The visual Builder OWNS + regenerates this
 * file wholesale; lifecycle hooks go in a sibling `entities/article/hooks.ts` (`defineHooks({...})`) — and
 * custom `services.ts`/`controller.ts` live in the same folder — none of which the Builder touches.
 */
const Article = defineSchema({
  id: 'ct_article',
  options: { draftAndPublish: false, i18n: false },
  fields: {
    title: c.string({ id: 'f_title', max: 512, nullable: true }),
    body: c.text({ id: 'f_body', nullable: false }),
    status: c.enum(['draft', 'published', 'archived'], { id: 'f_status', nullable: false }),
    views: c.integer({ id: 'f_views', nullable: true }),
    rating: c.float({ id: 'f_rating', nullable: true }),
    active: c.boolean({ id: 'f_active', nullable: false }),
    publishedAt: c.datetime({ id: 'f_publishedAt', nullable: false }),
  },
});

export default Article;
export type Article = typeof Article;
