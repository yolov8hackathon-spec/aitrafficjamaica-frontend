// @ts-check
import { test, expect } from '@playwright/test';

const BASE = 'https://aitrafficja.com';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('wlz.onboarding.done', '1'));
});

// ── 404 handling ──────────────────────────────────────────────────────────────
test('unknown route returns 404 or custom error page', async ({ page }) => {
  const res = await page.goto(`${BASE}/this-page-does-not-exist-xyz123`);
  // Vercel returns 404 for unknown static routes
  expect([404, 200]).toContain(res?.status()); // 200 = SPA catch-all
  // Page should not be blank
  const bodyText = await page.locator('body').innerText();
  expect(bodyText.trim().length).toBeGreaterThan(0);
});

test('/404 page is not blank', async ({ page }) => {
  await page.goto(`${BASE}/404`, { waitUntil: 'domcontentloaded' });
  const bodyText = await page.locator('body').innerText();
  expect(bodyText.trim().length).toBeGreaterThan(0);
});

// ── Internal links don't 404 ─────────────────────────────────────────────────
test('all internal <a href> links return non-404', async ({ page, request }) => {
  await page.goto(BASE);

  const hrefs = await page.evaluate(() =>
    [...document.querySelectorAll('a[href]')]
      .map(a => a.href)
      .filter(h =>
        h.startsWith(location.origin) &&          // internal only
        !h.includes('#') &&                        // skip anchors
        !h.includes('mailto:') &&                  // skip mailto
        !h.includes('tel:')                        // skip tel
      )
  );

  const unique = [...new Set(hrefs)];
  console.log(`Checking ${unique.length} internal links...`);

  const broken = [];
  for (const url of unique) {
    const res = await request.get(url).catch(() => null);
    if (!res || res.status() === 404) {
      broken.push(url);
      console.log(`✘ 404: ${url}`);
    } else {
      console.log(`✓ ${res.status()}: ${url}`);
    }
  }

  expect(broken, `Broken internal links:\n${broken.join('\n')}`).toHaveLength(0);
});

// ── External link safety ──────────────────────────────────────────────────────
test('external links have rel="noopener" or rel="noreferrer"', async ({ page }) => {
  await page.goto(BASE);

  const unsafe = await page.evaluate(() =>
    [...document.querySelectorAll('a[href^="http"][target="_blank"]')]
      .filter(a => {
        const rel = a.getAttribute('rel') || '';
        return !rel.includes('noopener') && !rel.includes('noreferrer');
      })
      .map(a => a.outerHTML.slice(0, 120))
  );

  if (unsafe.length > 0) {
    console.log(`External links missing rel="noopener":`);
    unsafe.forEach(l => console.log(`  ${l}`));
  }

  expect(unsafe, 'External _blank links without noopener/noreferrer').toHaveLength(0);
});

// ── Static assets load ────────────────────────────────────────────────────────
test('key images load without error', async ({ page }) => {
  const failed = [];
  page.on('response', res => {
    const ct = res.headers()['content-type'] || '';
    if (ct.startsWith('image/') && res.status() >= 400) {
      failed.push({ url: res.url(), status: res.status() });
    }
  });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (failed.length) failed.forEach(f => console.log(`Image failed: ${f.status} ${f.url}`));
  expect(failed).toHaveLength(0);
});

test('CSS files load without error', async ({ page }) => {
  const failed = [];
  page.on('response', res => {
    const ct = res.headers()['content-type'] || '';
    if (ct.includes('css') && res.status() >= 400) {
      failed.push({ url: res.url(), status: res.status() });
    }
  });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  expect(failed, `CSS load failures: ${JSON.stringify(failed)}`).toHaveLength(0);
});

test('JS files load without error', async ({ page }) => {
  const failed = [];
  page.on('response', res => {
    const ct = res.headers()['content-type'] || '';
    if (ct.includes('javascript') && res.status() >= 400) {
      failed.push({ url: res.url(), status: res.status() });
    }
  });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  expect(failed, `JS load failures: ${JSON.stringify(failed)}`).toHaveLength(0);
});
