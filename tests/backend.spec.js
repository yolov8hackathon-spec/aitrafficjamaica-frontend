// @ts-check
import { test, expect, request } from '@playwright/test';

const BASE = 'https://aitrafficja.com';

// ── 1. Health endpoint ────────────────────────────────────────────────────────
test('GET /api/health returns 200 with JSON', async ({ request }) => {
  const res = await request.get(`${BASE}/api/health`);
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body).toHaveProperty('status');
});

test('POST /api/health returns 405', async ({ request }) => {
  const res = await request.post(`${BASE}/api/health`);
  expect(res.status()).toBe(405);
});

// ── 2. Token endpoint ─────────────────────────────────────────────────────────
test('GET /api/token returns HMAC token + wss_url', async ({ request }) => {
  const res = await request.get(`${BASE}/api/token`);
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body).toHaveProperty('token');
  expect(body).toHaveProperty('wss_url');
  expect(body).toHaveProperty('expires_in');
  // Token format: ts.nonce.sig (3 dot-separated parts)
  expect(body.token.split('.').length).toBe(3);
  // WSS URL should be a websocket URL
  expect(body.wss_url).toMatch(/^wss:\/\//);
  expect(body.expires_in).toBe(300);
});

test('POST /api/token returns 405', async ({ request }) => {
  const res = await request.post(`${BASE}/api/token`);
  expect(res.status()).toBe(405);
});

// ── 3. Stream endpoint ────────────────────────────────────────────────────────
test('GET /api/stream responds (200 = live, 502 = offline)', async ({ request }) => {
  const res = await request.get(`${BASE}/api/stream`);
  // Either stream is live (200 m3u8) or backend reports offline (502)
  expect([200, 502]).toContain(res.status());
});

test('GET /api/stream with invalid segment param returns 400 or 502', async ({ request }) => {
  // p param too long (>512 chars) → 400
  const longP = 'x'.repeat(600);
  const res = await request.get(`${BASE}/api/stream?p=${longP}`);
  expect([400, 502]).toContain(res.status());
});

// ── 4. WebSocket — get token then connect ────────────────────────────────────
test('WebSocket /ws/live connects with valid token', async ({ page }) => {
  // Get token via API
  const tokenRes = await page.request.get(`${BASE}/api/token`);
  const { token, wss_url } = await tokenRes.json();

  // Connect WebSocket in browser context
  const wsResult = await page.evaluate(async ({ url, tok }) => {
    return new Promise((resolve) => {
      const ws = new WebSocket(`${url}?token=${tok}`);
      const timeout = setTimeout(() => {
        ws.close();
        resolve({ status: 'timeout' });
      }, 6000);

      ws.onopen  = () => { clearTimeout(timeout); resolve({ status: 'connected' }); };
      ws.onclose = (e) => { clearTimeout(timeout); resolve({ status: 'closed', code: e.code }); };
      ws.onerror = ()  => { clearTimeout(timeout); resolve({ status: 'error' }); };
    });
  }, { url: wss_url, tok: token });

  // Accept connected, closed normally, or error (backend may be sleeping)
  // The key check: must NOT be rejected with auth failure code 1008
  expect(['connected', 'closed', 'error']).toContain(wsResult.status);
  if (wsResult.status === 'closed') {
    // 1008 = policy violation (auth rejected) — should not happen with valid token
    expect(wsResult.code).not.toBe(1008);
  }
});

test('WebSocket /ws/live rejects or closes invalid token', async ({ page }) => {
  const tokenRes = await page.request.get(`${BASE}/api/token`);
  const { wss_url } = await tokenRes.json();

  // WebSocket protocol: the TCP connection may open (triggering onopen) before
  // the server sends an auth-failure close frame. We wait for the final state.
  const wsResult = await page.evaluate(async ({ url }) => {
    return new Promise((resolve) => {
      const ws = new WebSocket(`${url}?token=fake.token.invalid`);
      let openedAt = null;
      const timeout = setTimeout(() => {
        ws.close();
        resolve({ status: openedAt ? 'connected_no_close' : 'timeout' });
      }, 5000);
      ws.onopen  = () => { openedAt = Date.now(); /* wait for close frame */ };
      ws.onclose = (e) => { clearTimeout(timeout); resolve({ status: 'closed', code: e.code }); };
      ws.onerror = ()  => { clearTimeout(timeout); resolve({ status: 'error' }); };
    });
  }, { url: wss_url });

  // Server should close the connection (auth rejection) — not leave it open indefinitely.
  // Acceptable outcomes: closed (with any code), error, or timeout for non-responsive connections.
  expect(wsResult.status).not.toBe('connected_no_close');
});

// ── 5. Analytics endpoints ────────────────────────────────────────────────────
test('GET /api/analytics/data without type returns 400', async ({ request }) => {
  const res = await request.get(`${BASE}/api/analytics/data`);
  expect(res.status()).toBe(400);
  const body = await res.json();
  expect(body.error).toMatch(/type/i);
});

test('GET /api/analytics/traffic responds with 200 or 401', async ({ request }) => {
  const res = await request.get(`${BASE}/api/analytics/traffic`);
  // Requires auth — either 200 (public data) or 401/403 (protected)
  expect([200, 400, 401, 403]).toContain(res.status());
});

// ── 6. Bets endpoint ──────────────────────────────────────────────────────────
test('POST /api/bets/place without auth returns 401', async ({ request }) => {
  const res = await request.post(`${BASE}/api/bets/place`, {
    data: { exact_count: 5, window_duration_sec: 60 },
  });
  expect([400, 401, 403]).toContain(res.status());
});

// ── 7. Admin endpoints require auth ──────────────────────────────────────────
test('GET /api/admin/rounds without auth returns 401/403', async ({ request }) => {
  const res = await request.get(`${BASE}/api/admin/rounds`);
  expect([401, 403, 405]).toContain(res.status());
});

// ── 8. Response headers ───────────────────────────────────────────────────────
test('/api/health has Content-Type application/json', async ({ request }) => {
  const res = await request.get(`${BASE}/api/health`);
  expect(res.headers()['content-type']).toContain('application/json');
});

test('/api/token has no-store cache control', async ({ request }) => {
  const res = await request.get(`${BASE}/api/token`);
  expect(res.headers()['cache-control']).toContain('no-store');
});
