import { defineComponent, c } from '@conti/core';

/** A page-builder RICH-TEXT block — free-form prose for a Page's dynamic zone. */
export default defineComponent({
  id: 'cmp_richtext',
  fields: {
    content: c.text({ id: 'f_rtContent', nullable: false }),
  },
});
