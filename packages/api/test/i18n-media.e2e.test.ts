import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Sql } from 'postgres';

// Point local storage at a fresh temp dir BEFORE any config access (config caches on first read).
const STORAGE_DIR = await mkdtemp(path.join(os.tmpdir(), 'absurd-i18n-media-'));
process.env.LOCAL_STORAGE_PATH = STORAGE_DIR;
delete process.env.S3_BUCKET; // select the LOCAL provider for this run.

const { runMigrations } = await import('../src/db/migration.runner.ts');
const { createFileDatabase, dropFileDatabase } = await import('./db-per-file.ts');
const { freePort } = await import('./helpers.ts');
const { resetStorageProvider } = await import('../src/storage/index.ts');
const { pngBytes } = await import('./storage-fixtures.ts');
const { PostgresStore } = await import('../src/db/postgres.store.ts');
const { createServer } = await import('../src/http/uws.adapter.ts');
const { createContentType } = await import('../src/db/content-type.repository.ts');

/**
 * be-04 × be-06 — i18n CROSSED WITH MEDIA, end-to-end over a REAL uWS server + REAL Postgres (per-file
 * clone) + REAL local-fs uploads. NO mocks. This is the regression coverage for the be-04 BLOCKING bug:
 * a variant-create on an i18n type whose SHARED (localized:false) MULTIPLE media field HAS a value used
 * to 500 — readSiblingForVariant wraps the jsonb media column in a RawJson, and assertMediaRefsExist
 * did a `for...of` over it (RawJson is not iterable) -> TypeError -> 500. The shared field cannot be
 * supplied in the variant body (shared keys are rejected), so the value MUST flow through the sibling
 * copy: there was NO path that avoided the crash. We exercise BOTH a shared multiple-media field and a
 * shared single-media field, plus a localized media field overlaid in the variant body.
 */

let sql: Sql;
let db: Awaited<ReturnType<typeof createFileDatabase>>;
let base: string;
let close: (token: unknown) => void;
let token: unknown;

const DEFAULT_LOCALE = process.env.DEFAULT_LOCALE?.trim() || 'en';

interface Asset { id: number }

async function uploadAsset(w: number, h: number): Promise<Asset> {
  const fd = new FormData();
  fd.set('file', new Blob([pngBytes(w, h)], { type: 'image/png' }), `img-${w}x${h}.png`);
  const r = await fetch(`${base}/_files/upload`, { method: 'POST', body: fd });
  assert.ok(r.status === 201 || r.status === 200, `upload ${w}x${h} -> ${r.status}`);
  return ((await r.json()) as { data: Asset }).data;
}

const POST = (p: string, body: unknown) => fetch(`${base}${p}`, { method: 'POST', body: JSON.stringify(body) });
const GET = (p: string) => fetch(`${base}${p}`);

before(async () => {
  resetStorageProvider();
  db = await createFileDatabase('i18nmedia');
  sql = db.sql;
  await runMigrations(db.url);

  // i18n type with: a localized title, a SHARED MULTIPLE media field (the crashing case), and a SHARED
  // SINGLE media field (the int4 case that already worked — asserted still fine), plus a LOCALIZED media
  // field (overlaid per variant via the request body).
  await createContentType(sql, {
    apiId: 'page',
    fields: [
      { name: 'title', cmsType: 'string', options: { nullable: false }, localized: true },
      { name: 'gallery', cmsType: 'media', options: { multiple: true, nullable: true }, localized: false },
      { name: 'hero', cmsType: 'media', options: { nullable: true }, localized: false },
      { name: 'banner', cmsType: 'media', options: { nullable: true }, localized: true },
    ],
    i18n: true,
  });

  const store = new PostgresStore(sql);
  const { engine, registry } = await store.loadWithRegistry();
  const server = createServer(engine, store, registry);
  const port = await freePort();
  token = await server.listen(port);
  close = server.close;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  if (token) close(token);
  if (sql) await sql.end();
  if (db) await dropFileDatabase(db.name);
  await rm(STORAGE_DIR, { recursive: true, force: true });
});

test('variant-create copies a SHARED MULTIPLE media field from the sibling without a 500 (the be-04 bug)', async () => {
  const a = await uploadAsset(10, 10);
  const b = await uploadAsset(11, 11);
  const hero = await uploadAsset(12, 12);

  // Plain create: default-locale variant with the shared multiple gallery + shared single hero populated.
  const created = await POST('/page', { title: 'Home', gallery: [a.id, b.id], hero: hero.id });
  assert.equal(created.status, 201);
  const en = (await created.json()) as { data: { id: number; document_id: number; gallery: number[]; hero: number } };
  assert.deepEqual(en.data.gallery, [a.id, b.id]);
  assert.equal(en.data.hero, hero.id);

  // Variant create: the body carries ONLY the localized title; gallery + hero MUST be copied from the
  // sibling. This used to 500 (RawJson not iterable). It must be a clean 201 with the shared values copied.
  const frRes = await POST(`/page/${en.data.id}/locales/fr`, { title: 'Accueil' });
  assert.equal(frRes.status, 201, 'variant-create with a shared multiple-media value must NOT 500');
  const fr = (await frRes.json()) as { data: { id: number; document_id: number; locale: string; title: string; gallery: number[]; hero: number } };
  assert.equal(fr.data.document_id, en.data.document_id, 'variant reuses the document_id');
  assert.equal(fr.data.locale, 'fr');
  assert.equal(fr.data.title, 'Accueil');
  assert.deepEqual(fr.data.gallery, [a.id, b.id], 'the shared MULTIPLE media field is copied verbatim');
  assert.equal(fr.data.hero, hero.id, 'the shared SINGLE media field is copied verbatim');

  // Populate round-trips on the variant (proves the copied jsonb is well-formed, not a mangled RawJson).
  const pop = (await (await GET(`/page/${fr.data.id}?locale=fr&populate=gallery`)).json()) as { data: { gallery: { id: number }[] } };
  assert.deepEqual(pop.data.gallery.map((x) => x.id), [a.id, b.id], 'order preserved after the copy');
});

test('variant-create overlays a LOCALIZED media field from the body while still copying shared media', async () => {
  const g1 = await uploadAsset(20, 20);
  const enBanner = await uploadAsset(21, 21);
  const frBanner = await uploadAsset(22, 22);

  const created = await POST('/page', { title: 'Docs', gallery: [g1.id], banner: enBanner.id });
  const en = (await created.json()) as { data: { id: number; banner: number; gallery: number[] } };
  assert.equal(en.data.banner, enBanner.id);

  // The variant overlays its OWN localized banner; the shared gallery is copied from the sibling.
  const frRes = await POST(`/page/${en.data.id}/locales/fr`, { title: 'Docs FR', banner: frBanner.id });
  assert.equal(frRes.status, 201);
  const fr = (await frRes.json()) as { data: { banner: number; gallery: number[] } };
  assert.equal(fr.data.banner, frBanner.id, 'the localized media field is the variant body value');
  assert.deepEqual(fr.data.gallery, [g1.id], 'the shared multiple-media field is still copied');
});

test('variant-create still rejects a shared media field supplied in the body (S1 consistency) -> 400', async () => {
  const g = await uploadAsset(30, 30);
  const created = await POST('/page', { title: 'Guide', gallery: [g.id] });
  const en = (await created.json()) as { data: { id: number } };
  // gallery is shared -> supplying it on a variant create must be a 400, NOT a silent per-variant divergence.
  const bad = await POST(`/page/${en.data.id}/locales/fr`, { title: 'Guide FR', gallery: [g.id] });
  assert.equal(bad.status, 400);
});

test('a variant copying a shared media field that points at a since-DELETED asset is tolerated (populate -> null/skip)', async () => {
  const a = await uploadAsset(40, 40);
  const created = await POST('/page', { title: 'Ghost', gallery: [a.id], hero: a.id });
  const en = (await created.json()) as { data: { id: number; document_id: number } };

  // Variant create BEFORE deleting -> the existence check passes (asset still present), no 500.
  const frRes = await POST(`/page/${en.data.id}/locales/fr`, { title: 'Fantome' });
  assert.equal(frRes.status, 201);
  const fr = (await frRes.json()) as { data: { id: number } };

  // Now delete the asset out from under BOTH variants and confirm populate degrades gracefully, never 500.
  assert.equal((await fetch(`${base}/_files/${a.id}`, { method: 'DELETE' })).status, 200);
  const pop = await GET(`/page/${fr.data.id}?locale=fr&populate=gallery,hero`);
  assert.equal(pop.status, 200);
  const body = (await pop.json()) as { data: { gallery: { id: number }[]; hero: { id: number } | null } };
  assert.deepEqual(body.data.gallery, [], 'a dangling shared multiple-media populates to []');
  assert.equal(body.data.hero, null, 'a dangling shared single-media populates to null');
});
