import { defineSchema, c } from '@conti/core';

/** A taxonomy term for articles (manyToMany). The inverse `articles` field is synthesized on this module. */
const Category = defineSchema({
  id: 'ct_category',
  options: { draftAndPublish: false, i18n: false },
  fields: {
    name: c.string({ id: 'f_categoryName', max: 128, nullable: false }),
    slug: c.uid({ id: 'f_categorySlug', nullable: false, unique: true }),
    description: c.text({ id: 'f_categoryDesc', nullable: true }),
  },
});

export default Category;
export type Category = typeof Category;
