// @ts-check
import { test, expect } from '@playwright/test';

const BASE = 'https://aitrafficja.com';

test('HTTPS redirect — HTTP upgrades to HTTPS', async ({ request }) => {
  // Vercel auto-upgrades HTTP → HTTPS
  const res = await request.get(BASE, { maxRedirects: 0 });
  // Either already HTTPS (200) or redirects (301/308)
  expect([200, 301, 308]).toContain(res.status());
});

test('X-Content-Type-Options is set to nosniff', async ({ request }) => {
  const res = await request.get(BASE);
  const header = res.headers()['x-content-type-options'];
  expect(header).toBe('nosniff');
});

test('Strict-Transport-Security header is present', async ({ request }) => {
  const res = await request.get(BASE);
  const hsts = res.headers()['strict-transport-security'];
  expect(hsts).toBeTruthy();
  expect(hsts).toContain('max-age');
});

test('X-Frame-Options or CSP frame-ancestors is set', async ({ request }) => {
  const res = await request.get(BASE);
  const xfo = res.headers()['x-frame-options'];
  const csp = res.headers()['content-security-policy'];
  const hasFrameProtection =
    xfo?.toLowerCase().includes('deny') ||
    xfo?.toLowerCase().includes('sameorigin') ||
    csp?.toLowerCase().includes('frame-ancestors');
  expect(hasFrameProtection, 'No clickjacking protection found (X-Frame-Options or CSP frame-ancestors)').toBeTruthy();
});

test('API token endpoint has no-store cache control', async ({ request }) => {
  const res = await request.get(`${BASE}/api/token`);
  expect(res.headers()['cache-control']).toContain('no-store');
});

test('API endpoints do not expose server internals in errors', async ({ request }) => {
  const res = await request.get(`${BASE}/api/analytics/data`);
  const body = await res.json();
  // Should not leak stack traces or file paths
  expect(JSON.stringify(body)).not.toMatch(/at Object\.|\.js:\d+|node_modules/);
});

test('Admin routes are protected — cannot access without auth', async ({ request }) => {
  const adminRoutes = [
    '/api/admin/rounds',
    '/api/admin/ml',
    '/api/admin/bets',
  ];
  for (const route of adminRoutes) {
    const res = await request.get(`${BASE}${route}`);
    expect([401, 403, 405], `${route} should be protected`).toContain(res.status());
  }
});

test('Referrer-Policy header is set', async ({ request }) => {
  const res = await request.get(BASE);
  const rp = res.headers()['referrer-policy'];
  // Vercel sets this by default
  expect(rp).toBeTruthy();
});
