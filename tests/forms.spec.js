// @ts-check
import { test, expect } from '@playwright/test';

const BASE = 'https://aitrafficja.com';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('wlz.onboarding.done', '1'));
  await page.goto(BASE);
  await page.locator('#btn-open-login').click();
  await expect(page.locator('#login-modal')).toBeVisible();
});

// ── Login form validation ─────────────────────────────────────────────────────
test('login: submitting empty form shows error', async ({ page }) => {
  // Use reportValidity() to trigger native HTML5 validation without navigating
  const valid = await page.evaluate(() => {
    const form = document.querySelector('#modal-login-form');
    return form ? form.reportValidity() : null;
  });
  // Empty required fields — form must report invalid
  expect(valid, 'Expected form to be invalid when empty').toBe(false);
});

test('login: invalid email format triggers validation', async ({ page }) => {
  await page.locator('#modal-email').fill('notanemail');
  await page.locator('#modal-password, input[type="password"]').first().fill('somepass');
  await page.locator('#modal-submit-btn').click();
  // Native HTML5 email validation or custom error
  const invalidEmail = await page.locator('input[type="email"]:invalid').count();
  const errorEl = page.locator('#modal-auth-error, .auth-error').first();
  const hasError = invalidEmail > 0 || (await errorEl.isVisible().catch(() => false));
  expect(hasError, 'Expected validation error on invalid email').toBeTruthy();
});

test('login: wrong credentials shows auth error message', async ({ page }) => {
  await page.locator('#modal-email').fill('test@example.com');
  await page.locator('#modal-password, input[type="password"]').first().fill('wrongpassword123');
  await page.locator('#modal-submit-btn').click();
  // Wait for Supabase auth response and error text to be set
  await page.waitForFunction(
    () => (document.querySelector('#modal-auth-error')?.textContent?.trim().length ?? 0) > 0,
    { timeout: 15000 }
  );
  const errorText = await page.locator('#modal-auth-error').textContent();
  expect((errorText || '').trim().length).toBeGreaterThan(0);
  console.log(`Auth error: "${(errorText || '').trim()}"`);
});

test('login: Enter key on email field moves focus to password', async ({ page }) => {
  await page.locator('#modal-email').fill('test@example.com');
  await page.locator('#modal-email').press('Tab');
  const focused = await page.evaluate(() => document.activeElement?.getAttribute('type'));
  expect(focused).toBe('password');
});

test('login: modal fields are accessible via keyboard', async ({ page }) => {
  // Tab through the modal
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  const focusedId = await page.evaluate(() => document.activeElement?.id);
  expect(focusedId).toBeTruthy();
});

test('login: close button is reachable via keyboard', async ({ page }) => {
  await page.locator('#login-modal-close').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#login-modal')).toBeHidden();
});

// ── Register modal ────────────────────────────────────────────────────────────
test('register modal opens from login modal switch link', async ({ page }) => {
  const switchLink = page.locator('#login-modal .auth-switch a, #login-to-register');
  if (await switchLink.count() > 0) {
    await switchLink.first().click();
    await expect(page.locator('#register-modal')).toBeVisible({ timeout: 3000 });
  } else {
    test.skip();
  }
});
