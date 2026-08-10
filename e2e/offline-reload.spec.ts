import { expect, test } from '@playwright/test';

/**
 * Offline reload — the core promise of the app: launch it in a supermarket with
 * no signal and still see your plan. Against the production build, the service
 * worker precaches the shell and `navigateFallback` serves index.html from
 * cache, so a reload while offline still boots the app from IndexedDB.
 */
test('reloads and renders the plan board while offline', async ({ page, context }) => {
  await page.goto('#/plan');

  // Wait for the service worker to be installed and active for this scope —
  // otherwise an offline reload has nothing cached to fall back to.
  await page.waitForFunction(async () => {
    if (!('serviceWorker' in navigator)) return false;
    const reg = await navigator.serviceWorker.ready;
    return !!reg.active;
  });

  // The board should be up before we cut the network.
  await expect(page.locator('.plan__board .plan__day').first()).toBeVisible();

  await context.setOffline(true);
  try {
    await page.reload();

    // The unmissable offline banner appears...
    await expect(
      page.getByRole('status').filter({ hasText: /Offline — showing what's already saved/ }),
    ).toBeVisible();

    // ...and the plan board still renders from cache + IndexedDB.
    await expect(page.locator('.plan__board .plan__day').first()).toBeVisible();
    await expect(page.getByRole('group', { name: 'Plan range' })).toBeVisible();
  } finally {
    await context.setOffline(false);
  }
});
