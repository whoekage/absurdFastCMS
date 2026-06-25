import { defineType, c } from '@conti/core';

export default defineType({
  id: 'ct_widget',
  fields: {
    name: c.string({ id: 'f_name', nullable: true }),
  },
});
