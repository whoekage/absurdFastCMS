import { defineComponent, c } from '@conti/core';

/** A page-builder HERO block — one of the components a Page's dynamic zone can hold. */
export default defineComponent({
  id: 'cmp_hero',
  fields: {
    heading: c.string({ id: 'f_heroHeading', max: 200, nullable: false }),
    subheading: c.string({ id: 'f_heroSub', max: 300, nullable: true }),
    image: c.media({ id: 'f_heroImg', allowedTypes: ['images'] }),
    ctaLabel: c.string({ id: 'f_heroCtaLabel', max: 60, nullable: true }),
    ctaUrl: c.string({ id: 'f_heroCtaUrl', max: 2048, nullable: true }),
  },
});
