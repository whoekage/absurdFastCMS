import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Sql } from 'postgres';

const { createFileDatabase, dropFileDatabase } = await import('./db-per-file.ts');
const { startTestServer, ARTICLE_SCHEMA, closeAuth } = await import('./helpers.ts');
type SessionCache = Awaited<ReturnType<typeof startTestServer>>['sessionCache'];

/**
 * be-i18n — ERROR-MESSAGE LOCALIZATION end-to-end over a REAL uWS server + REAL Postgres (per-file clone),
 * no mocks. Proves the boundary now renders a cataloged error in the caller's locale resolved from the
 * request `Accept-Language` header (decision D5), threaded from the transport edge through CoreRequest into
 * the one `toErrorResponse` boundary. We trigger a NON-freeform code (`cursor.invalid`, which carries real
 * per-locale templates) with a malformed pagination cursor and assert: the localized `error` string changes
 * per locale, the stable `code` does NOT, the base subtag + q-weights are honored, and an unsupported tag
 * (or no header) falls back to English — byte-identical to the historically thrown message.
 */

let sql: Sql;
let db: Awaited<ReturnType<typeof createFileDatabase>>;
let base: string;
let close: (token: unknown) => void;
let token: unknown;
let sessionCache: SessionCache;

before(async () => {
  db = await createFileDatabase('error-i18n');
  sql = db.sql;
  ({ base, close, token, sessionCache } = await startTestServer(sql, [ARTICLE_SCHEMA]));
});
after(async () => {
  if (close) close(token);
  if (sessionCache) sessionCache.stop();
  closeAuth();
  if (sql) await sql.end();
  if (db) await dropFileDatabase(db.name);
});

/** GET a keyset page with a deliberately-malformed cursor → InvalidCursorError → 400 `cursor.invalid`. */
async function badCursor(acceptLanguage?: string): Promise<{ status: number; error: string; code: string }> {
  const headers: Record<string, string> = {};
  if (acceptLanguage !== undefined) headers['accept-language'] = acceptLanguage;
  const res = await fetch(`${base}/article?pagination[cursor]=not-a-valid-cursor&pagination[pageSize]=5`, { headers });
  const body = (await res.json()) as { error: string; code: string };
  return { status: res.status, error: body.error, code: body.code };
}

test('Accept-Language localizes the error message; the code stays stable across locales', async () => {
  // No header → en, byte-identical to the historically thrown English.
  const en = await badCursor();
  assert.equal(en.status, 400);
  assert.equal(en.code, 'cursor.invalid');
  assert.equal(en.error, 'invalid or expired pagination cursor');

  // ru: SAME stable code, localized message.
  const ru = await badCursor('ru');
  assert.equal(ru.code, 'cursor.invalid');
  assert.equal(ru.error, 'недействительный или просроченный курсор постраничной навигации');

  // ja with region + q-weights (ja-JP;q=0.9) resolves to the base subtag `ja`.
  const ja = await badCursor('ja-JP,ja;q=0.9,en;q=0.8');
  assert.equal(ja.code, 'cursor.invalid');
  assert.equal(ja.error, '無効または期限切れのページネーションカーソル');

  // A Central-Asian locale localizes too (ky/kk/uz were added in this slice).
  const uz = await badCursor('uz');
  assert.equal(uz.error, 'yaroqsiz yoki muddati oʻtgan sahifalash kursori');

  const ko = await badCursor('ko-KR');
  assert.equal(ko.error, '잘못되었거나 만료된 페이지네이션 커서');

  // An unsupported tag falls back to en.
  const de = await badCursor('de-DE,fr;q=0.5');
  assert.equal(de.code, 'cursor.invalid');
  assert.equal(de.error, 'invalid or expired pagination cursor');
});
