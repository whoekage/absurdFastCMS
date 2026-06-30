import { defineSchema, c } from '@conti/core';

/**
 * Authors are CONTENT, not login accounts. A content `relation` can only target another content module
 * (the auth `user`/`team` live in a separate better-auth domain the engine can't relate to), and — like
 * every competitor (Strapi/Sanity/Ghost) — a byline author (public name/avatar/bio) is distinct from the
 * CMS user who happens to be logged in. So `article.author` is a relation to THIS module.
 */
const Author = defineSchema({
  id: 'ct_author',
  options: { draftAndPublish: false, i18n: false },
  fields: {
    name: c.string({ id: 'f_authorName', max: 128, nullable: false }),
    slug: c.uid({ id: 'f_authorSlug', nullable: false, unique: true }),
    avatar: c.media({ id: 'f_authorAvatar', allowedTypes: ['images'] }),
    email: c.email({ id: 'f_authorEmail', nullable: true }),
    bio: c.text({ id: 'f_authorBio', nullable: true }),
  },
});

export default Author;
export type Author = typeof Author;
