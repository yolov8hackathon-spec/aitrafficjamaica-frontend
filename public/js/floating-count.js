/**
 * floating-count.js — Floating count widget on the video stream.
 *
 * NORMAL MODE: shows global total.
 * GUESS MODE: hides global total; shows X/Y progress toward the user's guess,
 *   with a colour-coded bar (green → yellow → red as it approaches/exceeds target).
 */

const FloatingCount = (() => {
  let _wrapper         = null;
  let _lastTotal       = 0;
  let _guessBaseline   = null;   // total at moment guess was placed
  let _guessTarget     = null;   // user's guessed count
  let _currentCameraId = null;   // null = show all; set when camera is switched

  // ── Cached DOM refs (populated in init; avoids getElementById on every update) ──
  let _totalEl    = null;
  let _fpsEl      = null;
  let _guessModeEl = null;
  let _gmTargetEl = null;
  let _gmCurrentEl = null;
  let _gmBarEl    = null;

  function init(streamWrapper) {
    _wrapper = streamWrapper;
    _totalEl    = document.getElementById("cw-total");
    _fpsEl      = document.getElementById("cw-fps");
    _guessModeEl = document.getElementById("cw-guess-mode");
    _gmTargetEl = document.getElementById("cw-gm-target");
    _gmCurrentEl = document.getElementById("cw-gm-current");
    _gmBarEl    = document.getElementById("cw-gm-bar");

    // RAF throttle — coalesce rapid count:update bursts to one DOM write per frame
    let _rafPending = false;
    let _pendingPayload = null;
    function _scheduleUpdate(data) {
      _pendingPayload = data;
      if (_rafPending) return;
      _rafPending = true;
      requestAnimationFrame(() => {
        _rafPending = false;
        if (_pendingPayload) { update(_pendingPayload); _pendingPayload = null; }
      });
    }

    window.addEventListener("count:update", (e) => {
      const data = e.detail;
      // Only update if no camera filter set, or payload matches current camera
      if (_currentCameraId && data.camera_id && data.camera_id !== _currentCameraId) return;
      _scheduleUpdate(data);
    });

    // Camera switched — show loading state until next count:update arrives
    window.addEventListener("camera:switched", (e) => {
      const { cameraId, name, isAI } = e.detail || {};
      _currentCameraId = cameraId || null;
      _setCamLabel(name || null, isAI);
      if (isAI) {
        _lastTotal = 0;
        if (_totalEl)  _totalEl.textContent  = "…";
        if (_fpsEl)    _fpsEl.textContent    = "--";
      } else if (cameraId) {
        if (_totalEl) _totalEl.textContent = "…";
        _loadCameraSnapshot(cameraId);
      }
    });

    // Enter guess mode when a guess is submitted.
    window.addEventListener("bet:placed", (e) => {
      const detail = e.detail || {};
      _guessTarget   = detail.exact_count ?? null;
      _guessBaseline = _lastTotal;
      _enterGuessMode();
      // Hide dev banner during active guess so it doesn't obscure X/Y progress
      const banner = document.getElementById("dev-banner");
      if (banner) banner.style.display = "none";
    });

    // Return to normal mode when result comes back.
    window.addEventListener("bet:resolved", () => {
      _exitGuessMode();
      // Restore dev banner unless user already dismissed it
      if (localStorage.getItem("wlz.dev-banner.dismissed") !== "1") {
        const banner = document.getElementById("dev-banner");
        if (banner) banner.style.display = "";
      }
    });
  }

  // ── Mode switches ─────────────────────────────────────────────

  function _enterGuessMode() {
    _guessModeEl?.classList.remove("hidden");
    if (_gmTargetEl) _gmTargetEl.textContent = _guessTarget ?? "—";
    _setGuessProgress(0);
  }

  function _exitGuessMode() {
    _guessBaseline = null;
    _guessTarget   = null;
    _guessModeEl?.classList.add("hidden");
  }

  function _setGuessProgress(sinceGuess) {
    if (_gmCurrentEl) _gmCurrentEl.textContent = sinceGuess;
    if (_gmBarEl && _guessTarget > 0) {
      const pct = Math.min(100, (sinceGuess / _guessTarget) * 100);
      _gmBarEl.style.width = pct + "%";
      _gmBarEl.style.background =
        pct >= 100 ? "#ef4444" :   // red — overshot
        pct >= 80  ? "#eab308" :   // yellow — getting close
                     "#22c55e";    // green — on track
    }
  }

  // ── Count update ──────────────────────────────────────────────

  function update(data) {
    const total     = data.total ?? 0;
    const crossings = data.new_crossings ?? 0;

    _lastTotal = total;
    window._lastCountPayload = data;

    if (_totalEl)  _totalEl.textContent  = total.toLocaleString();
    if (_fpsEl) {
      const fps = data.fps ?? data.fps_estimate ?? null;
      _fpsEl.textContent = fps != null ? `${Number(fps).toFixed(1)} fps` : "--.- fps";
      _fpsEl.className = "cw-fps" + (fps == null ? " cw-fps-na" : fps < 3 ? " cw-fps-bad" : "");
    }

    // Update guess-mode progress bar if active
    if (_guessBaseline !== null && _guessTarget !== null) {
      const sinceGuess = Math.max(0, total - _guessBaseline);
      _setGuessProgress(sinceGuess);
    }

    if (crossings > 0) spawnPop(crossings);
  }

  function setStatus(ok) {
    const dot = document.getElementById("cw-ws-dot");
    if (!dot) return;
    dot.className = ok ? "cw-ws-dot cw-ws-ok" : "cw-ws-dot cw-ws-err";
  }

  function _setCamLabel(name, isAI) {
    const el = document.getElementById("cw-cam-label");
    if (!el) return;
    if (name) {
      el.textContent = name;
      el.classList.remove("hidden");
    } else {
      el.classList.add("hidden");
    }
    // Show snapshot badge when not on the AI cam
    const badge = document.getElementById("cw-snapshot-badge");
    if (badge) badge.classList.toggle("hidden", !!isAI);
  }

  async function _loadCameraSnapshot(cameraId) {
    try {
      const [snapResp, fpsResp] = await Promise.all([
        window.sb
          .from("count_snapshots")
          .select("camera_id, captured_at, total, count_in, count_out, vehicle_breakdown")
          .eq("camera_id", cameraId)
          .order("captured_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        // Compute FPS: events in last 5 min / elapsed seconds
        window.sb
          .from("ml_detection_events")
          .select("captured_at")
          .eq("camera_id", cameraId)
          .gte("captured_at", new Date(Date.now() - 5 * 60_000).toISOString())
          .order("captured_at", { ascending: true }),
      ]);

      let fps = null;
      const rows = fpsResp?.data || [];
      if (rows.length >= 2) {
        const elapsed = (new Date(rows.at(-1).captured_at) - new Date(rows[0].captured_at)) / 1000;
        if (elapsed > 0) fps = rows.length / elapsed;
      }

      const snap = snapResp?.data;
      update({
        camera_id: cameraId,
        total: snap?.total || 0,
        vehicle_breakdown: snap?.vehicle_breakdown || {},
        new_crossings: 0,
        fps,
        snapshot: true,
      });
    } catch {}
  }

  function spawnPop(n) {
    if (!_wrapper) return;
    const el = document.createElement("div");
    el.className = "count-pop";
    el.textContent = "+" + n;

    const widget = document.getElementById("count-widget");
    if (widget) {
      const rect  = widget.getBoundingClientRect();
      const wRect = _wrapper.getBoundingClientRect();
      el.style.left = (rect.left - wRect.left + rect.width / 2) + "px";
      el.style.top  = (rect.top  - wRect.top  - 10) + "px";
    } else {
      el.style.left   = "80px";
      el.style.bottom = "60px";
    }

    _wrapper.appendChild(el);
    setTimeout(() => el.remove(), 1050);
  }

  return { init, update, setStatus };
})();

window.FloatingCount = FloatingCount;
