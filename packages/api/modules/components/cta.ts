import { defineComponent, c } from '@conti/core';

/** A page-builder CALL-TO-ACTION block — a labelled button for a Page's dynamic zone. */
export default defineComponent({
  id: 'cmp_cta',
  fields: {
    label: c.string({ id: 'f_ctaLabel', max: 60, nullable: false }),
    url: c.string({ id: 'f_ctaUrl', max: 2048, nullable: false }),
    style: c.enum(['primary', 'secondary'], { id: 'f_ctaStyle', default: 'primary', nullable: true }),
  },
});
