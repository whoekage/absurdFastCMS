import { test, expect } from '@playwright/test';
import {
  createContentType,
  createEntry,
  dropContentType,
  expectToast,
  uniqueName,
} from './helpers';

// ──────────────────────────────────────────────────────────────────────────────────────────────
// (1) Content/entry CRUD against the real stack: create an entry, see it in the list, open it, edit
// a field, verify the change, delete it, verify it's gone. To stay self-contained and idempotent we
// stand up a throwaway content type for the run and drop it (with all its rows) at the end.
// ──────────────────────────────────────────────────────────────────────────────────────────────

test.describe('content CRUD', () => {
  const name = uniqueName('crud');

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    // A string "title" (the search field) + a "body" text field.
    await createContentType(page, name, [
      { name: 'title', type: 'string' },
      { name: 'body', type: 'text' },
    ]);
    await page.close();
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await dropContentType(page, name);
    await page.close();
  });

  test('create → list → open → edit → verify → delete → verify gone', async ({ page }) => {
    const title = `Hello E2E ${Date.now()}`;
    const editedTitle = `${title} (edited)`;

    // CREATE via the UI form.
    await createEntry(page, name, { title, body: 'first body' });
    await expectToast(page, 'Entry created');

    // SEE IT IN THE LIST.
    await page.goto(`/content/${name}`);
    const row = page.getByRole('row', { name: new RegExp(escapeRegExp(title)) });
    await expect(row).toBeVisible();

    // OPEN IT (the view page) via the row's "View" action.
    await row.getByRole('link', { name: 'View' }).click();
    await expect(page).toHaveURL(new RegExp(`/content/${name}/\\d+$`));
    await expect(page.getByText(title)).toBeVisible();

    // EDIT a field.
    await page.getByRole('link', { name: 'Edit' }).click();
    await expect(page).toHaveURL(new RegExp(`/content/${name}/\\d+/edit$`));
    await page.locator('#field-title').fill(editedTitle);
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expectToast(page, 'Entry updated');

    // VERIFY THE CHANGE on the view page.
    await expect(page).toHaveURL(new RegExp(`/content/${name}/\\d+$`));
    await expect(page.getByText(editedTitle)).toBeVisible();

    // DELETE it from the list (per-row trash → confirm dialog).
    await page.goto(`/content/${name}`);
    const editedRow = page.getByRole('row', { name: new RegExp(escapeRegExp(editedTitle)) });
    await expect(editedRow).toBeVisible();
    await editedRow.getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
    await expectToast(page, 'Entry deleted');

    // VERIFY IT'S GONE.
    await expect(
      page.getByRole('row', { name: new RegExp(escapeRegExp(editedTitle)) }),
    ).toHaveCount(0);
  });
});

/** Escape a string for safe embedding in a RegExp (titles contain spaces/parens). */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
