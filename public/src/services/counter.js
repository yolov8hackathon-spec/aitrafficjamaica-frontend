import { AppCache } from '../core/cache.js';
import { FloatingCount } from '../overlays/floating-count.js';

let ws = null;
let reconnectTimer = null;
let backoff = 2000;
let started = false;
let lastRoundSig = '';
let lastCountTsMs = 0;
let lastKnownTotal = 0;
const MAX_BACKOFF = 30000;
const MAX_BOX_STALE_MS = 12_000;

function setStatus(ok) { FloatingCount.setStatus(ok); }

function update(data) {
  window.dispatchEvent(new CustomEvent('count:update', { detail: data }));
}

function sanitizeCountPayload(data) {
  if (!data || typeof data !== 'object') return data;
  const tsRaw = data.captured_at;
  const tsMs = tsRaw ? Date.parse(tsRaw) : NaN;
  const now = Date.now();
  if (Number.isFinite(tsMs)) {
    if (lastCountTsMs && tsMs < lastCountTsMs) return null;
    lastCountTsMs = tsMs;
    const ageMs = now - tsMs;
    if (ageMs > MAX_BOX_STALE_MS) return { ...data, detections: [] };
  }
  const newTotal = Number(data.total ?? 0);
  if (newTotal === 0 && lastKnownTotal > 0 && !data.bootstrap) return { ...data, total: lastKnownTotal };
  if (newTotal > lastKnownTotal) lastKnownTotal = newTotal;
  return data;
}

function roundSignature(round) {
  if (!round) return 'none';
  return [round.id || '', round.status || '', round.opens_at || '', round.closes_at || '', round.ends_at || ''].join('|');
}

function emitRoundIfChanged(round) {
  const sig = roundSignature(round);
  if (sig === lastRoundSig) return;
  lastRoundSig = sig;
  window.dispatchEvent(new CustomEvent('round:update', { detail: round || null }));
}

async function bootstrapFromHealth() {
  try {
    const res = await fetch('/api/health');
    if (!res.ok) return;
    const health = await res.json();
    const snap = health?.latest_snapshot;
    if (!snap || typeof snap !== 'object') return;
    const payload = {
      type: 'count',
      camera_id: snap.camera_id || null,
      captured_at: snap.captured_at || null,
      count_in: Number(snap.count_in || 0),
      count_out: Number(snap.count_out || 0),
      total: Number(snap.total || 0),
      vehicle_breakdown: snap.vehicle_breakdown || {},
      new_crossings: 0,
      detections: [],
      bootstrap: true,
    };
    const t = Number(payload.total || 0);
    if (t > lastKnownTotal) lastKnownTotal = t;
    update(payload);
  } catch {}
}

async function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  let token, wssUrl;
  try {
    let tokenData = AppCache.get('ws:token');
    if (!tokenData) {
      const res = await fetch('/api/token');
      if (!res.ok) throw new Error(`token fetch ${res.status}`);
      tokenData = await res.json();
      AppCache.set('ws:token', tokenData, 4 * 60 * 1000);
    }
    ({ token, wss_url: wssUrl } = tokenData);
    window._wsToken = token;
  } catch {
    setStatus(false);
    reconnectTimer = setTimeout(() => { backoff = Math.min(backoff * 2, MAX_BACKOFF); connect(); }, backoff);
    return;
  }
  setStatus(false);
  let _opened = false;
  ws = new WebSocket(`${wssUrl}?token=${encodeURIComponent(token)}`);
  ws.onopen = () => { _opened = true; setStatus(true); backoff = 2000; };
  ws.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.type === 'count') {
        const sanitized = sanitizeCountPayload(data);
        if (!sanitized) return;
        update(sanitized);
        if ('round' in data) emitRoundIfChanged(data.round);
      } else if (data.type === 'round') {
        emitRoundIfChanged(data.round);
      } else if (data.type === 'scene:reset') {
        // Reset timestamp filter so next count messages aren't silently dropped
        lastCountTsMs = 0;
        lastKnownTotal = 0;
        window.dispatchEvent(new CustomEvent('scene:reset'));
      } else if (data.type === 'demo_mode') {
        window.dispatchEvent(new CustomEvent('demo:mode', { detail: { active: Boolean(data.active), message: data.message || '' } }));
      }
    } catch {}
  };
  ws.onerror = () => setStatus(false);
  ws.onclose = (e) => {
    setStatus(false);
    // 4001/4003 = explicit auth rejection from server
    // 1006 without ever opening = handshake rejected (e.g. HMAC replay) — must fetch fresh token
    if (e.code === 4001 || e.code === 4003 || (e.code === 1006 && !_opened)) {
      AppCache.invalidate('ws:token');
    }
    reconnectTimer = setTimeout(() => { backoff = Math.min(backoff * 2, MAX_BACKOFF); connect(); }, backoff);
  };
}

let _paused = false;

function pause() {
  _paused = true;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (ws) {
    ws.onclose = null;   // prevent the onclose handler from scheduling a reconnect
    ws.onerror = null;
    ws.close();
    ws = null;
  }
  setStatus(false);
}

function resume() {
  if (!_paused) return;
  _paused = false;
  lastCountTsMs = 0;
  lastKnownTotal = 0;
  backoff = 2000;
  connect();
}

function init() {
  if (started) return;
  started = true;
  bootstrapFromHealth();
  if (document.readyState === 'complete') connect();
  else window.addEventListener('load', connect, { once: true });
  if (window._wsToken) connect();
}

function destroy() {
  clearTimeout(reconnectTimer);
  if (ws) ws.close();
}

export const Counter = { init, destroy, pause, resume };
