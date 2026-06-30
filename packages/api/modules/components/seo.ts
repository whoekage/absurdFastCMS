import { defineComponent, c } from '@conti/core';

/**
 * Reusable SEO metadata — the canonical headless-CMS pattern (mirrors Strapi's `shared.seo`). Attach it to
 * any module via `c.component('seo', { id: 'f_seo' })`; the same fields then render across articles, pages,
 * etc. Components have NO table — this is stored inline as validated JSON on the owning row.
 */
export default defineComponent({
  id: 'cmp_seo',
  fields: {
    metaTitle: c.string({ id: 'f_seoTitle', max: 60, nullable: false }),
    metaDescription: c.string({ id: 'f_seoDesc', max: 160, nullable: true }),
    metaImage: c.media({ id: 'f_seoImg', allowedTypes: ['images'] }),
    keywords: c.text({ id: 'f_seoKw', nullable: true }),
    metaRobots: c.string({ id: 'f_seoRobots', max: 64, default: 'index, follow', nullable: true }),
    canonicalURL: c.string({ id: 'f_seoCanonical', max: 2048, nullable: true }),
    structuredData: c.json({ id: 'f_seoJsonld', nullable: true }),
  },
});
