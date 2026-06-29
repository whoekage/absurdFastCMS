import { test, expect } from '@playwright/test';
import {
  createContentType,
  createEntry,
  dropContentType,
  selectOption,
  uniqueName,
} from './helpers';

// ──────────────────────────────────────────────────────────────────────────────────────────────
// (3) List filtering + search against the real stack: seed a few rows, apply a free-text search
// (mapped by the admin to a `$containsi` on the type's search field) AND a status enumeration
// filter, then assert the filtered result set. The type + rows are torn down at the end so reruns
// are idempotent.
//
// Seed data (type has `title` string [the search field] + `status` enumeration):
//   • "Apple pie"   / published
//   • "Apple cake"  / draft
//   • "Banana bread"/ published
// A `$containsi "apple"` search narrows to the two Apple rows; adding status = published narrows to
// exactly "Apple pie".
// ──────────────────────────────────────────────────────────────────────────────────────────────

const STATUSES = ['draft', 'published'] as const;

test.describe('list filtering + search', () => {
  const name = uniqueName('filter');

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await createContentType(page, name, [
      { name: 'title', cmsType: 'string' },
      { name: 'status', cmsType: 'enumeration', enumValues: [...STATUSES] },
    ]);
    await createEntry(page, name, { title: 'Apple pie' }, { status: 'published' });
    await createEntry(page, name, { title: 'Apple cake' }, { status: 'draft' });
    await createEntry(page, name, { title: 'Banana bread' }, { status: 'published' });
    await page.close();
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await dropContentType(page, name);
    await page.close();
  });

  test('search ($containsi) + status filter narrows to the expected row', async ({ page }) => {
    await page.goto(`/content/${name}`);

    // All three rows seeded.
    await expect(page.getByRole('row', { name: /Apple pie/ })).toBeVisible();
    await expect(page.getByRole('row', { name: /Apple cake/ })).toBeVisible();
    await expect(page.getByRole('row', { name: /Banana bread/ })).toBeVisible();

    // SEARCH — debounced into the URL `q`, mapped to `$containsi` on `title`.
    await page.getByPlaceholder(/Search title/).fill('apple');
    await expect(page.getByRole('row', { name: /Apple pie/ })).toBeVisible();
    await expect(page.getByRole('row', { name: /Apple cake/ })).toBeVisible();
    await expect(page.getByRole('row', { name: /Banana bread/ })).toHaveCount(0);

    // STATUS FILTER — add a filter row, switch its field to `status`, pick `published`.
    await page.getByRole('button', { name: 'Add filter' }).click();
    // Field picker defaults to the first filterable field (`title`); switch it to `status`.
    await selectOption(page, page.getByRole('combobox').filter({ hasText: 'title' }), 'status');
    // The value picker (enum single-select) starts on its placeholder; choose `published`.
    await selectOption(page, page.getByRole('combobox').filter({ hasText: 'value…' }), 'published');

    // Combined: $containsi "apple" AND status = published → only "Apple pie".
    await expect(page.getByRole('row', { name: /Apple pie/ })).toBeVisible();
    await expect(page.getByRole('row', { name: /Apple cake/ })).toHaveCount(0);
    await expect(page.getByRole('row', { name: /Banana bread/ })).toHaveCount(0);

    // The URL encodes the search + filter state (shareable list state).
    await expect(page).toHaveURL(/status/);
  });
});
