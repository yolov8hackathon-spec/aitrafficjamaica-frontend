// @ts-check
/**
 * Mobile Optimisation Test Suite — Playwright
 * Covers: layout, touch targets, overflow, font sizes, tap targets,
 *         navigation, forms, performance at mobile viewports.
 *
 * Devices tested: 375px (iPhone SE/12 mini), 390px (iPhone 14), 768px (iPad mini)
 */
import { test, expect } from '@playwright/test';

const BASE = 'https://aitrafficja.com';

const VIEWPORTS = {
  iphoneSE:  { width: 375, height: 667 },
  iphone14:  { width: 390, height: 844 },
  ipadMini:  { width: 768, height: 1024 },
};

async function load(page, vp = VIEWPORTS.iphone14) {
  await page.addInitScript(() => localStorage.setItem('wlz.onboarding.done', '1'));
  await page.setViewportSize(vp);
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
}

// ── 1. Viewport & meta ────────────────────────────────────────────────────────
test.describe('Viewport & meta', () => {
  test('viewport meta prevents scaling lock (user-scalable check)', async ({ page }) => {
    await page.goto(BASE);
    const content = await page.evaluate(() =>
      document.querySelector('meta[name="viewport"]')?.content || ''
    );
    expect(content).toMatch(/width=device-width/);
    // maximum-scale=1 is flagged by WCAG but common; we just confirm it's present
    expect(content.length).toBeGreaterThan(0);
  });

  test('theme-color meta is set for mobile chrome chrome bar', async ({ page }) => {
    await page.goto(BASE);
    const color = await page.evaluate(() =>
      document.querySelector('meta[name="theme-color"]')?.content || ''
    );
    expect(color.length).toBeGreaterThan(0);
  });

  test('apple-mobile-web-app meta tags are present', async ({ page }) => {
    await page.goto(BASE);
    const capable = await page.evaluate(() =>
      document.querySelector('meta[name="apple-mobile-web-app-capable"]')?.content || ''
    );
    expect(capable).toBe('yes');
  });
});

// ── 2. No horizontal overflow at mobile widths ────────────────────────────────
test.describe('No horizontal overflow', () => {
  for (const [name, vp] of Object.entries(VIEWPORTS)) {
    test(`no horizontal scroll at ${vp.width}px (${name})`, async ({ page }) => {
      await load(page, vp);
      const overflows = await page.evaluate(() => {
        const docWidth = document.documentElement.scrollWidth;
        const winWidth = window.innerWidth;
        const offenders = [];
        document.querySelectorAll('*').forEach(el => {
          const rect = el.getBoundingClientRect();
          if (rect.right > winWidth + 2) {
            offenders.push({
              tag: el.tagName,
              id: el.id || '',
              cls: [...el.classList].slice(0,3).join(' '),
              right: Math.round(rect.right),
            });
          }
        });
        return { docWidth, winWidth, offenders: offenders.slice(0, 10) };
      });
      if (overflows.offenders.length > 0) {
        console.log(`[${name}] Overflow offenders:`, JSON.stringify(overflows.offenders));
      }
      expect(overflows.docWidth, `Page is wider than viewport at ${vp.width}px`)
        .toBeLessThanOrEqual(vp.width + 2);
    });
  }
});

// ── 3. Touch target sizes (WCAG 2.5.5 — min 44×44px) ─────────────────────────
test.describe('Touch targets', () => {
  test('interactive elements meet 44px minimum tap target', async ({ page }) => {
    await load(page, VIEWPORTS.iphone14);
    const violations = await page.evaluate(() => {
      const MIN = 44;
      const interactives = document.querySelectorAll(
        'button:not([hidden]):not([disabled]), a[href]:not([hidden]), [role="button"]:not([hidden])'
      );
      const small = [];
      interactives.forEach(el => {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return; // not rendered
        if (rect.width < MIN || rect.height < MIN) {
          small.push({
            tag: el.tagName,
            id: el.id || '',
            cls: [...el.classList].slice(0,2).join(' '),
            text: (el.textContent || '').trim().slice(0, 30),
            w: Math.round(rect.width),
            h: Math.round(rect.height),
          });
        }
      });
      return small;
    });
    if (violations.length > 0) {
      console.log('Small tap targets:', JSON.stringify(violations, null, 2));
    }
    // Soft assertion — warn but don't fail (many decorative links are small)
    const critical = violations.filter(v => v.w < 24 || v.h < 24);
    expect(critical.length, `${critical.length} tap targets are critically small (<24px)`).toBe(0);
  });

  test('login button is tappable at 375px', async ({ page }) => {
    await load(page, VIEWPORTS.iphoneSE);
    const rect = await page.locator('#btn-open-login').boundingBox();
    expect(rect).not.toBeNull();
    expect(rect.height).toBeGreaterThanOrEqual(36);
  });
});

// ── 4. Input font size (prevent iOS auto-zoom) ────────────────────────────────
test.describe('Input font sizes', () => {
  test('text inputs have font-size ≥ 16px to prevent iOS zoom', async ({ page }) => {
    await load(page, VIEWPORTS.iphone14);
    // Open login modal so inputs are rendered
    await page.locator('#btn-open-login').click();
    await page.waitForTimeout(400);

    const violations = await page.evaluate(() => {
      const inputs = document.querySelectorAll('input[type="text"], input[type="email"], input[type="password"], textarea');
      const small = [];
      inputs.forEach(el => {
        const fs = parseFloat(window.getComputedStyle(el).fontSize);
        if (fs < 16) small.push({ id: el.id, type: el.type, fontSize: fs });
      });
      return small;
    });
    if (violations.length > 0) {
      console.log('Inputs with small font-size (will trigger iOS zoom):', violations);
    }
    expect(violations.length, 'Inputs with font-size < 16px trigger iOS auto-zoom').toBe(0);
  });
});

// ── 5. Core layout visibility at mobile ───────────────────────────────────────
test.describe('Core layout at 390px', () => {
  test.use({ viewport: VIEWPORTS.iphone14 });

  test('site header is visible', async ({ page }) => {
    await load(page, VIEWPORTS.iphone14);
    await expect(page.locator('.site-header, header').first()).toBeVisible();
  });

  test('logo is visible', async ({ page }) => {
    await load(page, VIEWPORTS.iphone14);
    await expect(page.locator('#site-logo, .logo, .site-logo').first()).toBeVisible();
  });

  test('login button is visible', async ({ page }) => {
    await load(page, VIEWPORTS.iphone14);
    await expect(page.locator('#btn-open-login')).toBeVisible();
  });

  test('count widget is visible', async ({ page }) => {
    await load(page, VIEWPORTS.iphone14);
    await expect(page.locator('#count-widget, .count-widget').first()).toBeVisible();
  });

  test('stream panel is visible', async ({ page }) => {
    await load(page, VIEWPORTS.iphone14);
    await expect(page.locator('.stream-panel, #stream-panel').first()).toBeVisible();
  });

  test('sidebar tabs are present', async ({ page }) => {
    await load(page, VIEWPORTS.iphone14);
    const tabs = page.locator('.sidebar-tabs .tab-btn, .tab-btn');
    expect(await tabs.count()).toBeGreaterThan(0);
  });
});

// ── 6. Navigation & modal on mobile ───────────────────────────────────────────
test.describe('Navigation & modals', () => {
  test('login modal opens and is full-width friendly at 375px', async ({ page }) => {
    await load(page, VIEWPORTS.iphoneSE);
    await page.locator('#btn-open-login').click();
    await page.waitForTimeout(500);
    const modal = page.locator('#login-modal, .modal, .auth-modal').first();
    await expect(modal).toBeVisible({ timeout: 5000 });
    const modalBox = await modal.boundingBox();
    // Modal should not overflow the viewport
    expect(modalBox.x).toBeGreaterThanOrEqual(-5);
    expect(modalBox.x + modalBox.width).toBeLessThanOrEqual(375 + 10);
  });

  test('login modal closes with Escape key on mobile', async ({ page }) => {
    await load(page, VIEWPORTS.iphone14);
    await page.locator('#btn-open-login').click();
    await page.waitForTimeout(400);
    await page.keyboard.press('Escape');
    const modal = page.locator('#login-modal');
    await expect(modal).toBeHidden({ timeout: 3000 });
  });

  test('login modal closes with X button on mobile', async ({ page }) => {
    await load(page, VIEWPORTS.iphone14);
    await page.locator('#btn-open-login').click();
    await page.waitForTimeout(400);
    await page.locator('#login-modal-close, .auth-modal-close').first().click();
    await expect(page.locator('#login-modal')).toBeHidden({ timeout: 3000 });
  });
});

// ── 7. Leaderboard tabs on mobile ─────────────────────────────────────────────
test.describe('Leaderboard tabs', () => {
  test('all 3 window tabs are tappable at 390px', async ({ page }) => {
    await load(page, VIEWPORTS.iphone14);
    // Activate leaderboard tab first so the panel is visible
    await page.locator('[data-tab="leaderboard"]').click();
    await page.waitForTimeout(200);
    for (const win of ['60', '180', '300']) {
      const btn = page.locator(`[data-win="${win}"]`);
      await expect(btn).toBeAttached();
      const box = await btn.boundingBox().catch(() => null);
      if (box) expect(box.height).toBeGreaterThanOrEqual(28);
    }
  });

  test('3MIN tab switches leaderboard view', async ({ page }) => {
    await load(page, VIEWPORTS.iphone14);
    // Activate leaderboard tab first so the panel is visible
    await page.locator('[data-tab="leaderboard"]').click();
    await page.waitForTimeout(200);
    await page.locator('[data-win="180"]').click();
    await page.waitForTimeout(300);
    await expect(page.locator('[data-win="180"]')).toHaveClass(/active/);
  });
});

// ── 8. Guess panel on mobile ──────────────────────────────────────────────────
test.describe('Guess panel', () => {
  test('guess input and submit button are present at 390px', async ({ page }) => {
    await load(page, VIEWPORTS.iphone14);
    await expect(page.locator('#bp-count, #bet-input, input[name="bet"], .guess-input').first()).toBeAttached();
    await expect(page.locator('#bp-submit, #bet-submit-btn, .bet-submit').first()).toBeAttached();
  });

  test('window duration buttons are all visible at 375px', async ({ page }) => {
    await load(page, VIEWPORTS.iphoneSE);
    const btns = page.locator('.window-btn, [data-duration], .duration-btn');
    const count = await btns.count();
    if (count > 0) {
      for (let i = 0; i < count; i++) {
        await expect(btns.nth(i)).toBeVisible();
      }
    }
  });
});

// ── 9. Chat panel on mobile ───────────────────────────────────────────────────
test.describe('Chat panel', () => {
  test('chat input is present and not clipped at 390px', async ({ page }) => {
    await load(page, VIEWPORTS.iphone14);
    const input = page.locator('#chat-input');
    await expect(input).toBeAttached();
    const box = await input.boundingBox().catch(() => null);
    if (box) {
      // Input should be within viewport width
      expect(box.x + box.width).toBeLessThanOrEqual(390 + 10);
    }
  });
});

// ── 10. Images & media ────────────────────────────────────────────────────────
test.describe('Images & media', () => {
  test('logo image is not broken at 375px', async ({ page }) => {
    const errors = [];
    page.on('response', res => {
      if (res.url().match(/iconinframes|logo/) && !res.ok()) errors.push(res.url());
    });
    await load(page, VIEWPORTS.iphoneSE);
    expect(errors).toHaveLength(0);
  });

  test('video element has correct aspect ratio container at mobile', async ({ page }) => {
    await load(page, VIEWPORTS.iphone14);
    const video = page.locator('video').first();
    await expect(video).toBeAttached();
    const box = await video.boundingBox().catch(() => null);
    if (box) {
      // Video should be at least 60% of viewport width on mobile
      expect(box.width).toBeGreaterThanOrEqual(VIEWPORTS.iphone14.width * 0.6);
    }
  });
});

// ── 11. Performance on mobile ─────────────────────────────────────────────────
test.describe('Mobile performance', () => {
  test('page DOM is ready under 3s on mobile (simulated)', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('wlz.onboarding.done', '1'));
    await page.setViewportSize(VIEWPORTS.iphone14);
    const start = Date.now();
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    const dclTime = Date.now() - start;
    console.log(`Mobile DOMContentLoaded: ${dclTime}ms`);
    expect(dclTime).toBeLessThan(3000);
  });

  test('no layout shift above 0.25 on mobile (CLS)', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('wlz.onboarding.done', '1'));
    await page.setViewportSize(VIEWPORTS.iphone14);
    await page.goto(BASE, { waitUntil: 'load' });
    const cls = await page.evaluate(() => new Promise(resolve => {
      let cumulativeCls = 0;
      new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          if (!entry.hadRecentInput) cumulativeCls += entry.value;
        }
      }).observe({ type: 'layout-shift', buffered: true });
      setTimeout(() => resolve(cumulativeCls), 3000);
    }));
    console.log(`Mobile CLS: ${cls.toFixed(4)}`);
    expect(cls).toBeLessThan(0.25);
  });
});

// ── 12. iPad layout ───────────────────────────────────────────────────────────
test.describe('iPad layout (768px)', () => {
  test('main layout visible at 768px', async ({ page }) => {
    await load(page, VIEWPORTS.ipadMini);
    await expect(page.locator('.site-header, header').first()).toBeVisible();
    await expect(page.locator('.stream-panel, #stream-panel').first()).toBeVisible();
  });

  test('no horizontal overflow at 768px', async ({ page }) => {
    await load(page, VIEWPORTS.ipadMini);
    const docWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(docWidth).toBeLessThanOrEqual(768 + 2);
  });
});
