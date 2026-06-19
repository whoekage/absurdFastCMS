import { test, expect } from '@playwright/test';
import { createContentType, dropContentType, expectToast, selectOption, uniqueApiId } from './helpers';

// ──────────────────────────────────────────────────────────────────────────────────────────────
// (2) Content-Type Builder against the real stack: create a temp type with a couple of fields, see
// it in the sidebar + the content-types list, add another field on the detail page, then drop the
// type (cleanup) — all via the UI, hitting the real runtime-DDL endpoints.
// ──────────────────────────────────────────────────────────────────────────────────────────────

test.describe('content-type builder', () => {
  const apiId = uniqueApiId('builder');

  // Best-effort cleanup if an assertion fails before the in-test drop runs.
  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await dropContentType(page, apiId);
    await page.close();
  });

  test('create type → appears in sidebar + list → add field → drop type', async ({ page }) => {
    // CREATE a type with two fields.
    await createContentType(page, apiId, [
      { name: 'name', cmsType: 'string' },
      { name: 'qty', cmsType: 'integer' },
    ]);
    await expectToast(page, new RegExp(`"${apiId}" created`));

    // Two fields show on the detail page.
    await expect(page.getByRole('cell', { name: 'name', exact: true })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'qty', exact: true })).toBeVisible();

    // APPEARS IN THE SIDEBAR (the Content section links one entry per type).
    const sidebar = page.getByRole('complementary');
    await expect(sidebar.getByRole('link', { name: apiId })).toBeVisible();

    // APPEARS IN THE CONTENT-TYPES LIST.
    await page.goto('/content-types');
    await expect(
      page.getByRole('row', { name: new RegExp(escapeRegExp(apiId)) }),
    ).toBeVisible();

    // ADD A FIELD on the detail page via the Add-field dialog.
    await page.goto(`/content-types/${apiId}`);
    await page.getByRole('button', { name: 'Add field' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('input[id$="-name"]').fill('description');
    await selectOption(page, dialog.locator('button[id$="-type"]'), 'text');
    await dialog.getByRole('button', { name: 'Add field' }).click();
    await expectToast(page, 'Field added');
    await expect(page.getByRole('cell', { name: 'description', exact: true })).toBeVisible();

    // DROP THE TYPE (type-to-confirm) — cleanup, leaving the catalog as it was.
    await page.getByRole('button', { name: 'Drop type' }).click();
    await page.locator('#confirm-drop').fill(apiId);
    await page.getByRole('dialog').getByRole('button', { name: 'Drop type' }).click();
    await expectToast(page, new RegExp(`"${apiId}" dropped`));
    await expect(page).toHaveURL(/\/content-types$/);

    // GONE from the list.
    await expect(
      page.getByRole('row', { name: new RegExp(escapeRegExp(apiId)) }),
    ).toHaveCount(0);
  });
});

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
