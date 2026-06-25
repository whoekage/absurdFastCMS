import { defineHooks } from '@conti/core';

export default defineHooks({
  beforeCreate(data) {
    return data;
  },
  afterCreate() {
    /* side-effect */
  },
});
