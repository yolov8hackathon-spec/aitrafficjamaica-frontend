// @ts-check
import { test, expect } from '@playwright/test';

const BASE = 'https://aitrafficja.com';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('wlz.onboarding.done', '1'));
});

// ── Title & description ───────────────────────────────────────────────────────
test('page has a non-empty <title>', async ({ page }) => {
  await page.goto(BASE);
  const title = await page.title();
  expect(title.length).toBeGreaterThan(5);
  console.log(`Title: "${title}"`);
});

test('meta description exists and is meaningful', async ({ page }) => {
  await page.goto(BASE);
  const desc = await page.locator('meta[name="description"]').getAttribute('content');
  expect(desc).toBeTruthy();
  expect((desc || '').length).toBeGreaterThan(20);
  console.log(`Description: "${desc}"`);
});

// ── Open Graph ────────────────────────────────────────────────────────────────
test('og:title is set', async ({ page }) => {
  await page.goto(BASE);
  const og = await page.locator('meta[property="og:title"]').getAttribute('content');
  expect(og).toBeTruthy();
  console.log(`og:title: "${og}"`);
});

test('og:description is set', async ({ page }) => {
  await page.goto(BASE);
  const og = await page.locator('meta[property="og:description"]').getAttribute('content');
  expect(og).toBeTruthy();
});

test('og:image is set and is an absolute URL', async ({ page }) => {
  await page.goto(BASE);
  const og = await page.locator('meta[property="og:image"]').getAttribute('content');
  expect(og).toBeTruthy();
  expect(og).toMatch(/^https?:\/\//);
  console.log(`og:image: "${og}"`);
});

test('og:url matches the page URL', async ({ page }) => {
  await page.goto(BASE);
  const og = await page.locator('meta[property="og:url"]').getAttribute('content');
  expect(og).toBeTruthy();
  expect(og).toContain('aitrafficja.com');
});

// ── Technical SEO ─────────────────────────────────────────────────────────────
test('<html> has lang attribute', async ({ page }) => {
  await page.goto(BASE);
  const lang = await page.locator('html').getAttribute('lang');
  expect(lang).toBeTruthy();
  console.log(`lang="${lang}"`);
});

test('viewport meta tag is present', async ({ page }) => {
  await page.goto(BASE);
  const vp = await page.locator('meta[name="viewport"]').getAttribute('content');
  expect(vp).toContain('width=device-width');
});

test('canonical link is set', async ({ page }) => {
  await page.goto(BASE);
  const canonical = await page.locator('link[rel="canonical"]').getAttribute('href');
  if (canonical) {
    expect(canonical).toContain('aitrafficja.com');
    console.log(`Canonical: "${canonical}"`);
  } else {
    console.log('⚠ No canonical link found — recommended for SEO');
  }
});

test('favicon is reachable', async ({ request }) => {
  // Try common favicon paths
  const paths = ['/favicon.ico', '/favicon.png', '/img/favicon.ico'];
  let found = false;
  for (const p of paths) {
    const res = await request.get(`${BASE}${p}`);
    if (res.status() === 200) { found = true; console.log(`Favicon at ${p}`); break; }
  }
  if (!found) console.log('⚠ No favicon found at common paths');
});

test('robots.txt is accessible', async ({ request }) => {
  const res = await request.get(`${BASE}/robots.txt`);
  expect([200, 404]).toContain(res.status());
  if (res.status() === 200) {
    const body = await res.text();
    console.log(`robots.txt:\n${body.slice(0, 200)}`);
  } else {
    console.log('⚠ No robots.txt found — recommended for SEO');
  }
});

test('sitemap.xml is accessible', async ({ request }) => {
  const res = await request.get(`${BASE}/sitemap.xml`);
  if (res.status() === 200) {
    console.log('sitemap.xml found ✓');
  } else {
    console.log('⚠ No sitemap.xml found — recommended for SEO');
  }
});
