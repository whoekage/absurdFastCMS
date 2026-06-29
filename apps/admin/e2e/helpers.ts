import { expect, type Page } from '@playwright/test';

// ──────────────────────────────────────────────────────────────────────────────────────────────
// Shared E2E helpers. Everything drives the REAL admin UI (no API short-circuits) so the specs
// exercise the same paths an operator would. The only constraints baked in here come from the real
// components: Radix <Select> renders a trigger with role="combobox" and options with role="option";
// builder field rows have ids `#<draftKey>-name` / `#<draftKey>-type`; the type api_id input is
// `#name`; entry-form inputs are `#field-<name>`; success toasts render with role="status".
// ──────────────────────────────────────────────────────────────────────────────────────────────

/** A collision-resistant api_id for a throwaway content type (valid Postgres identifier). */
export function uniqueName(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `e2e_${prefix}_${Date.now().toString(36)}_${rand}`;
}

/** A spec-local field draft for the builder. type defaults to the builder's own default. */
export interface FieldDraftInput {
  name: string;
  type?: 'string' | 'text' | 'integer' | 'boolean' | 'enumeration';
  /** Enum members — required (and only used) when type is 'enumeration'. */
  enumValues?: string[];
}

/**
 * Pick an option in a Radix <Select> identified by its trigger locator. Opens the listbox and clicks
 * the option whose accessible name matches `optionName` exactly.
 */
export async function selectOption(page: Page, trigger: ReturnType<Page['locator']>, optionName: string): Promise<void> {
  await trigger.click();
  await page.getByRole('option', { name: optionName, exact: true }).click();
}

/** Wait for (and return) the most recent success toast text. */
export async function expectToast(page: Page, text: string | RegExp): Promise<void> {
  await expect(page.getByRole('status').filter({ hasText: text }).first()).toBeVisible();
}

/**
 * Create a content type via the builder UI (`/content-types/new`) with the given fields, then wait
 * for the redirect to its detail page. The first builder field row is reused for fields[0]; extra
 * fields click "Add field" first. Returns once the type exists server-side.
 */
export async function createContentType(
  page: Page,
  name: string,
  fields: FieldDraftInput[],
): Promise<void> {
  await page.goto('/content-types/new');
  await page.locator('#name').fill(name);

  for (let i = 0; i < fields.length; i++) {
    if (i > 0) await page.getByRole('button', { name: 'Add field' }).click();
    await fillBuilderFieldRow(page, i, fields[i]!);
  }

  await page.getByRole('button', { name: 'Create content type' }).click();

  // On success the builder navigates to the type's detail page and shows a toast.
  await expect(page).toHaveURL(new RegExp(`/content-types/${name}$`));
  await expect(page.getByRole('heading', { name: name })).toBeVisible();
}

/**
 * Fill the Nth builder field row (0-based). Field rows have generated draft keys, so the row is
 * located positionally by the bordered container that holds a "Name" label. type is left at the
 * default ('string') unless provided.
 */
export async function fillBuilderFieldRow(page: Page, index: number, field: FieldDraftInput): Promise<void> {
  // Each field row is a bordered block; locate by the Name input inside it. The form renders rows in
  // document order, so the Nth Name input belongs to the Nth row.
  const nameInputs = page.locator('input[id$="-name"]');
  const nameInput = nameInputs.nth(index);
  await nameInput.fill(field.name);

  if (field.type && field.type !== 'string') {
    const typeTrigger = page.locator('button[id$="-type"]').nth(index);
    await selectOption(page, typeTrigger, field.type);
  }

  if (field.type === 'enumeration') {
    const values = field.enumValues ?? [];
    // The enum editor starts empty; add one "value N" input per member, then fill them in order.
    const addValueBtn = page.getByRole('button', { name: 'Add value' });
    for (let v = 0; v < values.length; v++) await addValueBtn.click();
    for (let v = 0; v < values.length; v++) {
      await page.getByPlaceholder(`value ${v + 1}`).fill(values[v]!);
    }
  }
}

/**
 * Drop a content type via the builder (type-to-confirm dialog). Idempotent-ish cleanup: navigates to
 * the detail page and runs the drop flow. Safe to call in afterEach/afterAll.
 */
export async function dropContentType(page: Page, name: string): Promise<void> {
  await page.goto(`/content-types/${name}`);
  // If the type is already gone the detail page shows an error and there's no "Drop type" button.
  const dropBtn = page.getByRole('button', { name: 'Drop type' });
  if (!(await dropBtn.isVisible().catch(() => false))) return;
  await dropBtn.click();
  // The confirm dialog requires typing the exact api_id.
  await page.locator('#confirm-drop').fill(name);
  await page.getByRole('dialog').getByRole('button', { name: 'Drop type' }).click();
  await expect(page).toHaveURL(/\/content-types$/);
}

/**
 * Create an entry for `name` via the UI form. `values` maps editable field name → string value
 * typed into its `#field-<name>` input. `selects` maps an enumeration field name → option label
 * chosen in its Radix select. Waits for the post-create redirect back to the list.
 */
export async function createEntry(
  page: Page,
  name: string,
  values: Record<string, string>,
  selects: Record<string, string> = {},
): Promise<void> {
  await page.goto(`/content/${name}/new`);
  for (const [name, value] of Object.entries(values)) {
    await page.locator(`#field-${name}`).fill(value);
  }
  for (const [name, option] of Object.entries(selects)) {
    await selectOption(page, page.locator(`#field-${name}`), option);
  }
  await page.getByRole('button', { name: `Create ${name}` }).click();
  await expect(page).toHaveURL(new RegExp(`/content/${name}(\\?.*)?$`));
}
