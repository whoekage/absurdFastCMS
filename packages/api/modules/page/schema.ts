import { defineSchema, c } from '@conti/core';

/**
 * A page-builder Page: a title + slug + reusable SEO, and a DYNAMIC ZONE (`blocks`) the editor fills with
 * an ordered mix of `hero` / `richtext` / `cta` component instances (each tagged `__component`). This is
 * the headless-CMS "compose a layout without a developer" pattern. Draft & Publish is on so a page can be
 * staged before going live.
 */
const Page = defineSchema({
  id: 'ct_page',
  options: { draftAndPublish: true, i18n: false },
  fields: {
    title: c.string({ id: 'f_pageTitle', max: 256, nullable: false }),
    slug: c.uid({ id: 'f_pageSlug', nullable: false, unique: true }),
    seo: c.component('seo', { id: 'f_pageSeo' }),
    blocks: c.dynamiczone(['hero', 'richtext', 'cta'], { id: 'f_pageBlocks' }),
  },
});

export default Page;
export type Page = typeof Page;
