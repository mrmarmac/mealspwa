import { expect, test } from '@playwright/test';

/**
 * The core journey, end to end in a real build:
 *   capture a recipe → place it on the plan board → build the list → shop it.
 *
 * Each test gets a fresh browser profile, so IndexedDB starts empty and the app
 * auto-seeds its default space. We create our own recipe with a distinctive
 * name rather than leaning on a seed name, so the plan/shop steps can find it
 * unambiguously via the picker's search.
 */

// Distinctive, unlikely to collide with the 33 seeded recipes, and sorts oddly
// enough to be easy to search for.
const RECIPE_NAME = 'Zebra Test Stew';

test('capture a recipe, plan it, build and tick the shopping list', async ({ page }) => {
  // Warm up on the board first: the space store is app-global and initialises
  // (and seeds the default recipes) on first load. Saving a recipe no-ops until
  // that space exists, so wait for the board — which only renders once it does —
  // before heading into capture.
  await page.goto('#/plan');
  await expect(page.locator('.plan__board .plan__day').first()).toBeVisible();

  // --- Capture -------------------------------------------------------------
  await page.goto('#/capture');

  await expect(page.getByRole('heading', { name: 'Add recipe' })).toBeVisible();

  await page.getByPlaceholder('e.g. red roasted radishes').fill(RECIPE_NAME);
  await page
    .getByPlaceholder(/butter beans/)
    .fill('2 carrots\n1 onion\n400g chopped tomatoes\n1 tbsp olive oil');

  // The live parse preview is the app's "we read your ingredients" signal.
  await expect(page.getByRole('heading', { name: /How we read it/ })).toBeVisible();

  await page.getByRole('button', { name: 'Save recipe' }).click();

  // A successful save lands on the new recipe's detail page and flashes a toast.
  await expect(page).toHaveURL(/#\/recipes\/[^/]+$/);
  await expect(page.getByRole('status').filter({ hasText: `Saved ${RECIPE_NAME}` })).toBeVisible();

  // --- Plan ----------------------------------------------------------------
  await page.goto('#/plan');

  // Empty slots are full-width buttons labelled by meal type. Tap the first
  // Lunch slot to open the recipe picker.
  await page.getByRole('button', { name: 'Lunch', exact: true }).first().click();

  const picker = page.getByRole('dialog');
  await expect(picker).toBeVisible();

  // Search to disambiguate our recipe from the seeded library, then place it.
  await picker.getByRole('searchbox', { name: 'Search recipes' }).fill('Zebra');
  await picker.getByRole('button', { name: new RegExp(RECIPE_NAME) }).click();

  // The placed meal shows as a card on the board; the picker closes.
  await expect(picker).toBeHidden();
  await expect(page.locator('.meal-card', { hasText: RECIPE_NAME })).toBeVisible();

  // The build-list button (its label is randomised, so target it structurally)
  // enables once at least one meal is planned. Clicking it navigates to Shop.
  const buildList = page.locator('.plan__generate button');
  await expect(buildList).toBeEnabled();
  await buildList.click();

  // --- Shop ----------------------------------------------------------------
  await expect(page).toHaveURL(/#\/shop$/);
  await expect(page.getByRole('heading', { name: 'Shop', level: 1 })).toBeVisible();

  // The list was derived from our recipe, so there is at least one tickable row.
  const firstTick = page.getByRole('button', { name: /^Tick / }).first();
  await expect(firstTick).toBeVisible();

  // Capture the item name before ticking — the row's accessible label flips
  // from "Tick <item>" to "Untick <item>", so we must follow it by name.
  const label = (await firstTick.getAttribute('aria-label')) ?? '';
  const item = label.replace(/^Tick /, '');

  // Ticking flips the row's pressed state and decrements the "N left" counter.
  const countBefore = await readRemaining(page);
  await firstTick.click();
  await expect(page.getByRole('button', { name: `Untick ${item}` })).toBeVisible();

  await expect
    .poll(() => readRemaining(page))
    .toBe(countBefore === null ? countBefore : countBefore - 1);
});

/** Reads the header "N left" counter (or 0 when it shows "All done"). */
async function readRemaining(page: import('@playwright/test').Page): Promise<number | null> {
  const text = (await page.locator('.shop__count').textContent())?.trim() ?? '';
  if (/all done/i.test(text)) return 0;
  const match = text.match(/(\d+)\s*left/i);
  return match ? Number(match[1]) : null;
}
