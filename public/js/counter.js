/**
 * counter.js — WebSocket consumer for /ws/live.
 * Fires count:update and round:update events for other modules.
 * Also updates FloatingCount WS status dot.
 */

const Counter = (() => {
  let ws = null;
  let reconnectTimer = null;
  let backoff = 2000;
  let started = false;
  let lastRoundSig = "";
  let lastCountTsMs = 0;
  let lastKnownTotal = 0;
  const MAX_BACKOFF = 30000;
  // detection-overlay.js now queues detections and delays rendering by measured
  // video lag, so we pass detections through for up to 12s. The overlay's queue
  // pruning handles anything older. 350ms was stripping boxes before they could
  // be time-matched to the video frame.
  const MAX_BOX_STALE_MS = 12_000;

  function setStatus(ok) {
    if (window.FloatingCount) FloatingCount.setStatus(ok);
  }

  function update(data) {
    window.dispatchEvent(new CustomEvent("count:update", { detail: data }));
  }

  function sanitizeCountPayload(data) {
    if (!data || typeof data !== "object") return data;
    const tsRaw = data.captured_at;
    const tsMs = tsRaw ? Date.parse(tsRaw) : NaN;
    const now = Date.now();

    if (Number.isFinite(tsMs)) {
      // Keep the newest payload only; drop out-of-order frames.
      if (lastCountTsMs && tsMs < lastCountTsMs) return null;
      lastCountTsMs = tsMs;

      // If payload is old, keep totals but avoid drawing stale boxes.
      const ageMs = now - tsMs;
      if (ageMs > MAX_BOX_STALE_MS) {
        return { ...data, detections: [] };
      }
    }

    // Guard against zero-total live frames overriding a known bootstrapped count
    const newTotal = Number(data.total ?? 0);
    if (newTotal === 0 && lastKnownTotal > 0 && !data.bootstrap) {
      return { ...data, total: lastKnownTotal };
    }
    if (newTotal > lastKnownTotal) lastKnownTotal = newTotal;
    return data;
  }

  function roundSignature(round) {
    if (!round) return "none";
    return [
      round.id || "",
      round.status || "",
      round.opens_at || "",
      round.closes_at || "",
      round.ends_at || "",
    ].join("|");
  }

  function emitRoundIfChanged(round) {
    const sig = roundSignature(round);
    if (sig === lastRoundSig) return;
    lastRoundSig = sig;
    window.dispatchEvent(new CustomEvent("round:update", { detail: round || null }));
  }

  async function bootstrapFromHealth() {
    try {
      let health = window.AppCache?.get("health:latest");
      if (!health) {
        const res = await fetch("/api/health");
        if (!res.ok) return;
        health = await res.json();
        window.AppCache?.set("health:latest", health, 60_000);
      }
      const snap = health?.latest_snapshot;
      if (!snap || typeof snap !== "object") return;
      const payload = {
        type: "count",
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
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    let token, wssUrl;
    try {
      // Re-use token if it was fetched recently (stream.js may have fetched it first).
      // 4-min TTL aligns with backend token expiry; clears on WS auth failure below.
      let tokenData = window.AppCache?.get("ws:token");
      if (!tokenData) {
        const res = await fetch("/api/token");
        if (!res.ok) throw new Error(`token fetch ${res.status}`);
        tokenData = await res.json();
        window.AppCache?.set("ws:token", tokenData, 4 * 60 * 1000);
      }
      ({ token, wss_url: wssUrl } = tokenData);
      window._wsToken = token;
      // wssUrl is module-scoped — not written to window to avoid casual exposure.
    } catch (err) {
      setStatus(false);
      reconnectTimer = setTimeout(() => {
        backoff = Math.min(backoff * 2, MAX_BACKOFF);
        connect();
      }, backoff);
      return;
    }

    setStatus(false);
    ws = new WebSocket(`${wssUrl}?token=${encodeURIComponent(token)}`);

    ws.onopen = () => {
      setStatus(true);
      backoff = 2000;
    };

    ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === "count") {
          const sanitized = sanitizeCountPayload(data);
          if (!sanitized) return;
          update(sanitized);
          if ("round" in data) {
            emitRoundIfChanged(data.round);
          }
        } else if (data.type === "round") {
          emitRoundIfChanged(data.round);
        } else if (data.type === "scene:reset") {
          window.DetectionOverlay?.clearDetections?.();
          window.FpsOverlay?.reset?.();
          window.MlOverlay?.resetForNewScene?.();
        }
      } catch {}
    };

    ws.onerror = () => setStatus(false);

    ws.onclose = (e) => {
      setStatus(false);
      // 4001/4003 = auth failure — clear cached token so next connect fetches a fresh one
      if (e.code === 4001 || e.code === 4003) window.AppCache?.invalidate("ws:token");
      reconnectTimer = setTimeout(() => {
        backoff = Math.min(backoff * 2, MAX_BACKOFF);
        connect();
      }, backoff);
    };
  }

  // Clear cached WS token when user signs out so next connect fetches a fresh one
  window.addEventListener("auth:signed_out", () => {
    window.AppCache?.invalidate("ws:token");
  });

  function init() {
    if (started) return;
    started = true;
    bootstrapFromHealth();
    if (document.readyState === "complete") connect();
    else window.addEventListener("load", connect, { once: true });
    if (window._wsToken) connect();
  }

  function destroy() {
    clearTimeout(reconnectTimer);
    if (ws) ws.close();
  }

  return { init, destroy };
})();

window.Counter = Counter;
