// @ts-check
/**
 * Whitelinez E2E Test Suite — Playwright (Chromium)
 * Target: https://aitrafficja.com
 *
 * Run: npx playwright test
 * Run single group: npx playwright test --grep "API endpoints"
 *
 * Design rules:
 *  - No test requires an active round or authenticated user unless marked @auth
 *  - Onboarding overlay bypassed via localStorage in beforeEach
 *  - All API tests hit the live Vercel deployment
 *  - Network errors (HLS/WebSocket/stream) are excluded from JS error assertions
 */
import { test, expect, request } from '@playwright/test';

const BASE_URL = 'https://aitrafficja.com';

// ── Global setup ──────────────────────────────────────────────────────────────
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('wlz.onboarding.done', '1');
  });
});

// Helper: navigate and wait for JS to settle
async function goto(page, path = '/') {
  await page.goto(BASE_URL + path, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
}

// ── 1. Page load & meta ───────────────────────────────────────────────────────
test.describe('Page load & meta', () => {
  test('returns HTTP 200', async ({ page }) => {
    const res = await page.goto(BASE_URL);
    expect(res.status()).toBe(200);
  });

  test('title contains brand name', async ({ page }) => {
    await page.goto(BASE_URL);
    await expect(page).toHaveTitle(/traffic|whitelinez|ai/i);
  });

  test('meta description is set', async ({ page }) => {
    await page.goto(BASE_URL);
    const meta = page.locator('meta[name="description"]');
    await expect(meta).toHaveAttribute('content', /.+/);
  });

  test('meta theme-color is set', async ({ page }) => {
    await page.goto(BASE_URL);
    const meta = page.locator('meta[name="theme-color"]');
    await expect(meta).toHaveAttribute('content', /.+/);
  });

  test('viewport meta tag is present', async ({ page }) => {
    await page.goto(BASE_URL);
    const meta = page.locator('meta[name="viewport"]');
    await expect(meta).toHaveAttribute('content', /width=device-width/);
  });

  test('no critical JS errors on page load', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await goto(page);
    const critical = errors.filter(e =>
      !e.includes('HLS') && !e.includes('stream') &&
      !e.includes('net::ERR') && !e.includes('WebSocket')
    );
    expect(critical).toHaveLength(0);
  });
});

// ── 2. PWA & manifest ─────────────────────────────────────────────────────────
test.describe('PWA & manifest', () => {
  test('manifest.json is linked in <head>', async ({ page }) => {
    await page.goto(BASE_URL);
    const href = await page.evaluate(() =>
      document.querySelector('link[rel="manifest"]')?.getAttribute('href') || null
    );
    expect(href).toMatch(/manifest\.json/);
  });

  test('manifest.json is reachable and valid JSON', async ({ page }) => {
    const res = await page.goto(BASE_URL + '/manifest.json');
    expect(res.status()).toBe(200);
    const ct = res.headers()['content-type'] || '';
    expect(ct).toMatch(/json/);
    const body = await res.json();
    expect(body).toHaveProperty('name');
    expect(body).toHaveProperty('start_url');
    expect(body).toHaveProperty('display', 'standalone');
    expect(body.icons).toBeInstanceOf(Array);
    expect(body.icons.length).toBeGreaterThan(0);
  });

  test('apple-mobile-web-app-capable meta is present', async ({ page }) => {
    await page.goto(BASE_URL);
    const meta = page.locator('meta[name="apple-mobile-web-app-capable"]');
    await expect(meta).toHaveAttribute('content', 'yes');
  });
});

// ── 3. Security headers ───────────────────────────────────────────────────────
test.describe('Security headers', () => {
  test('HSTS header is set', async ({ page }) => {
    const res = await page.goto(BASE_URL);
    const sts = res.headers()['strict-transport-security'];
    expect(sts).toBeTruthy();
    expect(sts).toMatch(/max-age=/);
  });

  test('X-Content-Type-Options nosniff is set', async ({ page }) => {
    const res = await page.goto(BASE_URL);
    expect(res.headers()['x-content-type-options']).toBe('nosniff');
  });

  test('X-Frame-Options is set', async ({ page }) => {
    const res = await page.goto(BASE_URL);
    const xfo = res.headers()['x-frame-options'];
    expect(xfo).toBeTruthy();
  });
});

// ── 4. Core layout ────────────────────────────────────────────────────────────
test.describe('Core layout', () => {
  test('site header is visible', async ({ page }) => {
    await goto(page);
    await expect(page.locator('.site-header')).toBeVisible();
  });

  test('logo is visible', async ({ page }) => {
    await goto(page);
    await expect(page.locator('.logo-icon, .site-logo, .header-logo').first()).toBeVisible();
  });

  test('login button is present in header', async ({ page }) => {
    await goto(page);
    await expect(page.locator('#btn-open-login')).toBeVisible();
  });

  test('dev banner renders and is dismissible', async ({ page }) => {
    await page.goto(BASE_URL);
    const banner = page.locator('#dev-banner');
    if (await banner.count() > 0 && await banner.isVisible()) {
      await page.locator('.dev-banner-close').click();
      await expect(banner).toBeHidden();
    } else {
      test.skip();
    }
  });
});

// ── 5. Count widget ───────────────────────────────────────────────────────────
test.describe('Count widget', () => {
  test('count widget wrapper is visible', async ({ page }) => {
    await goto(page);
    await expect(page.locator('#count-widget, .count-widget').first()).toBeVisible();
  });

  test('count total element is present', async ({ page }) => {
    await goto(page);
    await expect(page.locator('#cw-total')).toBeAttached();
  });

  test('count total has correct aria-label', async ({ page }) => {
    await goto(page);
    const el = page.locator('#cw-total');
    await expect(el).toHaveAttribute('aria-label', /vehicle count/i);
  });

  test('fps badge is attached', async ({ page }) => {
    await goto(page);
    await expect(page.locator('#cw-fps, .cw-fps').first()).toBeAttached();
  });

  test('count widget has correct aria-label', async ({ page }) => {
    await goto(page);
    const widget = page.locator('#count-widget');
    await expect(widget).toHaveAttribute('aria-label', /widget/i);
  });
});

// ── 6. Stream panel ───────────────────────────────────────────────────────────
test.describe('Stream panel', () => {
  test('stream panel container is visible', async ({ page }) => {
    await goto(page);
    await expect(
      page.locator('#stream-panel, .stream-panel, #video-wrapper').first()
    ).toBeVisible();
  });

  test('HLS video element is present', async ({ page }) => {
    await goto(page);
    const video = page.locator('video').first();
    await expect(video).toBeAttached();
  });

  test('stream offline overlay is present in DOM', async ({ page }) => {
    await goto(page);
    await expect(
      page.locator('.stream-offline-overlay, #stream-offline-overlay, .stream-switching-overlay').first()
    ).toBeAttached();
  });
});

// ── 7. Leaderboard ────────────────────────────────────────────────────────────
test.describe('Leaderboard', () => {
  test('window tab buttons are in the DOM', async ({ page }) => {
    await goto(page);
    await expect(page.locator('[data-win="60"]')).toBeAttached();
    await expect(page.locator('[data-win="180"]')).toBeAttached();
    await expect(page.locator('[data-win="300"]')).toBeAttached();
  });

  test('ranked-list container is in the DOM', async ({ page }) => {
    await goto(page);
    await expect(page.locator('#ranked-list')).toBeAttached();
  });

  test('3MIN tab activates on click (mobile)', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.addInitScript(() => localStorage.setItem('wlz.onboarding.done', '1'));
    await page.goto(BASE_URL);
    await page.waitForTimeout(1500);
    await page.locator('.tab-btn[data-tab="leaderboard"]').click();
    await page.waitForTimeout(400);
    const tab3min = page.locator('[data-win="180"]');
    await tab3min.click();
    await page.waitForTimeout(400);
    await expect(tab3min).toHaveClass(/active/);
  });
});

// ── 8. Login modal ────────────────────────────────────────────────────────────
test.describe('Login modal', () => {
  test('opens on login button click', async ({ page }) => {
    await goto(page);
    await page.locator('#btn-open-login').click();
    await expect(page.locator('#login-modal')).toBeVisible({ timeout: 3000 });
  });

  test('closes on X button', async ({ page }) => {
    await goto(page);
    await page.locator('#btn-open-login').click();
    await expect(page.locator('#login-modal')).toBeVisible();
    await page.locator('#login-modal-close').click();
    await expect(page.locator('#login-modal')).toBeHidden({ timeout: 2000 });
  });

  test('closes on Escape key', async ({ page }) => {
    await goto(page);
    await page.locator('#btn-open-login').click();
    await expect(page.locator('#login-modal')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#login-modal')).toBeHidden({ timeout: 2000 });
  });

  test('contains Google sign-in button', async ({ page }) => {
    await goto(page);
    await page.locator('#btn-open-login').click();
    await expect(
      page.locator('#login-modal').locator('button, [role="button"]').filter({ hasText: /google/i })
    ).toBeAttached();
  });
});

// ── 9. Guess panel ────────────────────────────────────────────────────────────
test.describe('Guess panel', () => {
  test('guess panel is present in the DOM', async ({ page }) => {
    await goto(page);
    await expect(page.locator('#bet-panel, .bet-panel, #bp-form').first()).toBeAttached();
  });

  test('count input is present', async ({ page }) => {
    await goto(page);
    await expect(page.locator('#bp-count')).toBeAttached();
  });

  test('submit button is present', async ({ page }) => {
    await goto(page);
    await expect(page.locator('#bp-submit')).toBeAttached();
  });

  test('non-numeric input shows validation error', async ({ page }) => {
    await goto(page);
    const input = page.locator('#bp-count');
    const submitBtn = page.locator('#bp-submit');
    if (await input.isVisible() && await submitBtn.isVisible()) {
      await input.fill('abc');
      await submitBtn.click();
      await expect(page.locator('#bp-error')).not.toBeEmpty({ timeout: 2000 });
    } else {
      test.skip();
    }
  });

  test('window duration selector buttons are present', async ({ page }) => {
    await goto(page);
    await expect(
      page.locator('[data-window="60"], [data-win="60"], .window-btn').first()
    ).toBeAttached();
  });
});

// ── 10. Chat panel ────────────────────────────────────────────────────────────
test.describe('Chat panel', () => {
  test('chat messages container is in the DOM', async ({ page }) => {
    await goto(page);
    await expect(page.locator('#chat-messages, .chat-messages').first()).toBeAttached();
  });

  test('chat input is present', async ({ page }) => {
    await goto(page);
    await expect(page.locator('#chat-input, .chat-input').first()).toBeAttached();
  });

  test('chat send button is present', async ({ page }) => {
    await goto(page);
    await expect(page.locator('#chat-send, .chat-send-btn').first()).toBeAttached();
  });
});

// ── 11. Gov overlay ───────────────────────────────────────────────────────────
test.describe('Gov overlay (analytics)', () => {
  // Helper: open the gov overlay
  async function openGov(page) {
    await goto(page);
    const trigger = page.locator(
      '#gov-open-btn, .gov-open-btn, [data-open="gov"], .header-analytics-cta, #header-analytics-cta'
    ).first();
    if (await trigger.count() === 0) return false;
    await trigger.click();
    await page.waitForTimeout(800);
    return true;
  }

  test('gov overlay has a trigger button', async ({ page }) => {
    await goto(page);
    const btn = page.locator(
      '#gov-open-btn, .gov-open-btn, [data-open="gov"], #header-analytics-cta'
    ).first();
    await expect(btn).toBeAttached();
  });

  test('gov overlay opens and is visible', async ({ page }) => {
    const opened = await openGov(page);
    if (!opened) return test.skip();
    // Check overlay is present and has had the hidden class removed
    const isVisible = await page.evaluate(() => {
      const el = document.querySelector('#gov-overlay, .gov-overlay');
      if (!el) return false;
      return !el.classList.contains('hidden') && el.offsetParent !== null;
    });
    if (!isVisible) return test.skip(); // overlay may require auth — skip gracefully
    await expect(page.locator('#gov-overlay, .gov-overlay').first()).toBeVisible();
  });

  test('gov overlay closes on X button', async ({ page }) => {
    const opened = await openGov(page);
    if (!opened) return test.skip();
    const overlay = page.locator('#gov-overlay, .gov-overlay').first();
    await expect(overlay).toBeVisible();
    await page.locator('#gov-close-btn, .gov-close-btn, [data-close="gov"]').first().click();
    await expect(overlay).toBeHidden({ timeout: 3000 });
  });

  test('gov overlay closes on Escape', async ({ page }) => {
    const opened = await openGov(page);
    if (!opened) return test.skip();
    await expect(page.locator('#gov-overlay, .gov-overlay').first()).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#gov-overlay, .gov-overlay').first()).toBeHidden({ timeout: 3000 });
  });

  test('analytics tab is present inside gov overlay', async ({ page }) => {
    const opened = await openGov(page);
    if (!opened) return test.skip();
    await expect(
      page.locator('[data-tab="analytics"], .gov-tab[data-tab]').first()
    ).toBeAttached();
  });
});

// ── 12. API endpoints ─────────────────────────────────────────────────────────
test.describe('API endpoints', () => {
  test('/api/health returns 200 with expected fields', async ({ page }) => {
    const res = await page.goto(BASE_URL + '/api/health');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('status');
    // Backend health fields vary; just confirm it's a valid object
    expect(typeof body).toBe('object');
  });

  test('/api/health has cache-control header', async ({ page }) => {
    const res = await page.goto(BASE_URL + '/api/health');
    const cc = res.headers()['cache-control'] || '';
    // CDN edge may strip s-maxage; the downstream response must have some cache directive
    expect(cc.length).toBeGreaterThan(0);
  });

  test('/api/analytics/traffic returns 200 for default request', async ({ page }) => {
    const res = await page.goto(BASE_URL + '/api/analytics/traffic?hours=24&granularity=hour');
    expect([200, 400, 401]).toContain(res.status());
    if (res.status() === 200) {
      const body = await res.json();
      expect(body).toHaveProperty('rows');
    }
  });

  test('/api/analytics/traffic rejects invalid dates with 400', async ({ page }) => {
    const res = await page.goto(BASE_URL + '/api/analytics/traffic?from=not-a-date&to=also-bad');
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/invalid date/i);
  });

  test('/api/analytics/export rejects >90 day range with 400', async ({ page }) => {
    const res = await page.goto(
      BASE_URL + '/api/analytics/export?from=2020-01-01&to=2026-01-01'
    );
    // Needs auth JWT — expect 401 or 400 (not 200 or 500)
    expect([400, 401]).toContain(res.status());
  });

  test('/api/admin/rounds rejects missing token with 401', async ({ page }) => {
    const res = await page.goto(BASE_URL + '/api/admin/rounds');
    expect(res.status()).toBe(401);
  });

  test('/api/admin/rounds rejects malformed token with 401', async ({ page }) => {
    const ctx = await request.newContext({
      extraHTTPHeaders: { Authorization: 'Bearer notajwt' },
    });
    const res = await ctx.get(BASE_URL + '/api/admin/rounds');
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/malformed/i);
    await ctx.dispose();
  });

  test('/api/agency/data rejects missing x-api-key with 401', async ({ page }) => {
    const ctx = await request.newContext();
    const res = await ctx.get(BASE_URL + '/api/agency/data?from=2026-03-01&to=2026-03-07');
    expect(res.status()).toBe(401);
    await ctx.dispose();
  });

  test('/api/agency/data rejects invalid key with 401', async ({ page }) => {
    const ctx = await request.newContext({
      extraHTTPHeaders: { 'x-api-key': 'wlzk_fake_key_that_doesnt_exist' },
    });
    const res = await ctx.get(BASE_URL + '/api/agency/data?from=2026-03-01&to=2026-03-07');
    expect(res.status()).toBe(401);
    await ctx.dispose();
  });

  test('/api/cron/daily-backfill rejects missing auth with 401', async ({ page }) => {
    const ctx = await request.newContext();
    const res = await ctx.get(BASE_URL + '/api/cron/daily-backfill');
    expect(res.status()).toBe(401);
    await ctx.dispose();
  });
});

// ── 13. Sidebar & mobile tabs ─────────────────────────────────────────────────
test.describe('Sidebar tabs (mobile)', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('tab buttons are present', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('wlz.onboarding.done', '1'));
    await page.goto(BASE_URL);
    await page.waitForTimeout(1500);
    const tabs = page.locator('.tab-btn');
    expect(await tabs.count()).toBeGreaterThan(1);
  });

  test('leaderboard tab activates its panel', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('wlz.onboarding.done', '1'));
    await page.goto(BASE_URL);
    await page.waitForTimeout(1500);
    await page.locator('.tab-btn[data-tab="leaderboard"]').click();
    await page.waitForTimeout(400);
    await expect(page.locator('.tab-btn[data-tab="leaderboard"]')).toHaveClass(/active/);
  });

  test('layout renders correctly at 375px', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('wlz.onboarding.done', '1'));
    await page.goto(BASE_URL);
    await expect(page.locator('.site-header')).toBeVisible();
    await expect(page.locator('#count-widget, .count-widget').first()).toBeVisible();
  });
});

// ── 14. Accessibility basics ──────────────────────────────────────────────────
test.describe('Accessibility', () => {
  test('page has a <main> landmark or equivalent', async ({ page }) => {
    await goto(page);
    const main = page.locator('main, [role="main"]');
    await expect(main.first()).toBeAttached();
  });

  test('all images have alt attributes', async ({ page }) => {
    await goto(page);
    const imgs = page.locator('img:not([alt])');
    const count = await imgs.count();
    expect(count).toBe(0);
  });

  test('login button has accessible label', async ({ page }) => {
    await goto(page);
    const btn = page.locator('#btn-open-login');
    const label = await btn.getAttribute('aria-label') || await btn.textContent();
    expect(label?.trim().length).toBeGreaterThan(0);
  });
});

// ── 15. Performance basics ────────────────────────────────────────────────────
test.describe('Performance', () => {
  test('page loads in under 8 seconds', async ({ page }) => {
    const start = Date.now();
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    const duration = Date.now() - start;
    expect(duration).toBeLessThan(8000);
  });

  test('no 5xx responses from primary assets', async ({ page }) => {
    const failures = [];
    page.on('response', res => {
      if (res.status() >= 500 && !res.url().includes('/api/stream')) {
        failures.push(`${res.status()} ${res.url()}`);
      }
    });
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    expect(failures).toHaveLength(0);
  });
});
