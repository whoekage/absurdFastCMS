import { defineSchema, c } from '@conti/core';

export default defineSchema({
  id: 'ct_widget',
  fields: {
    name: c.string({ id: 'f_name', nullable: true }),
  },
});
