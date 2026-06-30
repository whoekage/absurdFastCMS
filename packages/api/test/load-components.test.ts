import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadTypes } from '../src/db/schema/load.ts';
import { generateComponentSource } from '../src/db/schema/codegen.ts';
import type { ComponentSchema } from '../src/db/schema/model.ts';

/**
 * The component-definition file loader: `modules/components/*.ts` (each `export default defineComponent(...)`)
 * is read into the ComponentSchema IR, parallel to the module loader. No DB — pure filesystem + import.
 * Fixtures are written UNDER the repo so the generated files resolve `@conti/core` via node_modules.
 */

const genDir = fileURLToPath(new URL(`./fixtures/.gen-${process.pid}-components/`, import.meta.url));
after(() => rm(genDir, { recursive: true, force: true }));

test('loadTypes returns no components when the components dir is absent (byte-identical to today)', async () => {
  const dir = `${genDir}/no-components`;
  await mkdir(dir, { recursive: true });
  const loaded = await loadTypes(dir);
  assert.deepEqual(loaded.components, []);
});

test('loadTypes reads modules/components/*.ts into the ComponentSchema IR', async () => {
  const dir = `${genDir}/with-components`;
  await mkdir(`${dir}/components`, { recursive: true });
  await writeFile(
    `${dir}/components/seo.ts`,
    [
      "import { defineComponent, c } from '@conti/core';",
      "export default defineComponent({",
      "  id: 'cmp_seo',",
      "  fields: {",
      "    meta_title: c.string({ id: 'f_mt', max: 60 }),",
      "    og_image: c.media({ id: 'f_og' }),",
      "  },",
      "});",
      '',
    ].join('\n'),
  );
  const loaded = await loadTypes(dir);
  assert.equal(loaded.components.length, 1);
  assert.deepEqual(loaded.components[0], {
    id: 'cmp_seo',
    name: 'seo', // component name is the file basename
    fields: [
      { id: 'f_mt', name: 'meta_title', type: 'string', options: { length: 60, nullable: true } },
      { id: 'f_og', name: 'og_image', type: 'media', options: { multiple: false, nullable: true } },
    ],
  });
});

test('generateComponentSource → loadComponents round-trips to the same IR', async () => {
  const hero: ComponentSchema = {
    id: 'cmp_hero',
    name: 'hero',
    fields: [
      { id: 'f_h', name: 'heading', type: 'string', options: { nullable: false } },
      { id: 'f_img', name: 'image', type: 'media', options: { multiple: false, nullable: true } },
    ],
  };
  const dir = `${genDir}/roundtrip`;
  await mkdir(`${dir}/components`, { recursive: true });
  await writeFile(`${dir}/components/hero.ts`, generateComponentSource(hero));
  const loaded = await loadTypes(dir);
  assert.deepEqual(loaded.components[0], hero);
});
