import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';
import { createFileDatabase, dropFileDatabase } from './db-per-file.ts';
import { startTestServerFromFilesWithAuth, closeAuth } from './helpers.ts';
import { loadTypes } from '../src/db/schema/load.ts';
import { migrate } from '../src/db/schema/migrate.ts';

/**
 * Component definitions authored in `modules/components/*.ts` load at BOOT and survive a `/builder/reload`,
 * end-to-end over a REAL uWS server + REAL Postgres (no mocks). Proves the wiring that threads loaded
 * components into the registry: a module with a component field validates + populates a nested instance,
 * and a reload (which rebuilds the registry from disk) keeps the component so writes still validate.
 *
 * The files-boot harness doesn't migrate, so the module table is created from the file-loaded IR first.
 */

const genDir = fileURLToPath(new URL(`./fixtures/.gen-${process.pid}-component-boot/`, import.meta.url));

let sql: Sql;
let db: Awaited<ReturnType<typeof createFileDatabase>>;
let srv: Awaited<ReturnType<typeof startTestServerFromFilesWithAuth>>;
let cookie: string;

before(async () => {
  db = await createFileDatabase('component-boot');
  sql = db.sql;

  // A reusable component + a module that references it, both authored in code.
  await mkdir(`${genDir}/components`, { recursive: true });
  await mkdir(`${genDir}/article`, { recursive: true });
  await writeFile(
    `${genDir}/components/seo.ts`,
    [
      "import { defineComponent, c } from '@conti/core';",
      "export default defineComponent({",
      "  id: 'cmp_seo',",
      "  fields: {",
      "    meta_title: c.string({ id: 'f_mt', nullable: false }),",
      "    meta_description: c.text({ id: 'f_md' }),",
      "  },",
      "});",
      '',
    ].join('\n'),
  );
  await writeFile(
    `${genDir}/article/schema.ts`,
    [
      "import { defineSchema, c } from '@conti/core';",
      "export default defineSchema({",
      "  id: 'ct_article',",
      "  fields: {",
      "    title: c.string({ id: 'f_title', nullable: false }),",
      "    seo: c.component('seo', { id: 'f_seo' }),",
      "  },",
      "});",
      '',
    ].join('\n'),
  );

  // Create ct_article (incl. the seo jsonb column) from the FILE-loaded IR, then boot from those files.
  const { schemas } = await loadTypes(genDir);
  await migrate(sql, schemas, { allowDestructive: true });
  srv = await startTestServerFromFilesWithAuth(sql, genDir);

  const email = `cmp-boot-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;
  cookie = await srv.signUp(email);
  await srv.grantRole(await srv.userIdOf(email), 'super-admin');
});

after(async () => {
  if (srv) {
    srv.close(srv.token);
    srv.sessionCache.stop();
    await closeAuth();
  }
  if (sql) await sql.end();
  if (db) await dropFileDatabase(db.name);
  await rm(genDir, { recursive: true, force: true });
});

const postArticle = (body: unknown): Promise<Response> =>
  fetch(`${srv.base}/article`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });

test('a code-authored component loads at boot: a nested instance validates, stores, and reads back', async () => {
  const created = (await (await postArticle({ title: 'Home', seo: { meta_title: 'Welcome', meta_description: 'hi' } })).json()) as {
    data: { id: number; seo: { id: number; meta_title: string; meta_description: string | null } };
  };
  assert.equal(created.data.seo.meta_title, 'Welcome');
  assert.equal(typeof created.data.seo.id, 'number'); // server-assigned stable instance id

  const got = (await (await fetch(`${srv.base}/article/${created.data.id}`)).json()) as { data: { seo: { meta_title: string } } };
  assert.equal(got.data.seo.meta_title, 'Welcome');

  // A nested-field violation (missing the required meta_title) is rejected — proof the component shape is enforced.
  const bad = await postArticle({ title: 'X', seo: { meta_description: 'no title' } });
  assert.equal(bad.status, 400);
});

test('the component survives POST /builder/reload (registry rebuilt from disk keeps it)', async () => {
  const reload = await fetch(`${srv.base}/builder/reload`, { method: 'POST', headers: { cookie } });
  assert.equal(reload.status, 200);

  // After the reload-driven registry swap, a nested component instance still validates + stores.
  const after = await postArticle({ title: 'After reload', seo: { meta_title: 'Still here' } });
  assert.equal(after.status, 201);
  const body = (await after.json()) as { data: { seo: { meta_title: string } } };
  assert.equal(body.data.seo.meta_title, 'Still here');
});
