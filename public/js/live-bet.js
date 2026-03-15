/**
 * live-bet.js — Exact-count micro-bet panel logic.
 * Works with the bet-panel in the sidebar.
 */

const LiveBet = (() => {
  let _round = null;
  let _vehicleClass = "";    // "" = all
  let _windowSec = 60;
  let _countdownTimer = null;
  let _wsAccountRef = null;  // set by index-init

  function _ensureSpinnerStyle() {
    if (document.getElementById("live-bet-spinner-style")) return;
    const style = document.createElement("style");
    style.id = "live-bet-spinner-style";
    style.textContent = `
      .wlz-inline-spinner {
        display: inline-block;
        width: 12px;
        height: 12px;
        margin-right: 6px;
        border-radius: 50%;
        border: 2px solid rgba(255,255,255,0.25);
        border-top-color: currentColor;
        animation: wlzSpin .8s linear infinite;
        vertical-align: -2px;
      }
      @keyframes wlzSpin { to { transform: rotate(360deg); } }
    `;
    document.head.appendChild(style);
  }

  // ── Open / close panel ────────────────────────────────────────────

  function open(round) {
    _round = round;

    const panel = document.getElementById("bet-panel");
    if (!panel) return;

    // Reset form
    document.getElementById("bp-error").textContent = "";
    document.getElementById("bp-count").value = "5";
    _hideBpActiveBet();
    _hideBpResult();

    // Reset pills
    _setPill("bp-vehicle-pills", "");
    _setPill("bp-window-pills", "60");

    panel.classList.remove("hidden");
    requestAnimationFrame(() => panel.classList.add("visible"));
  }

  function close() {
    const panel = document.getElementById("bet-panel");
    if (!panel) return;
    panel.classList.remove("visible");
    setTimeout(() => panel.classList.add("hidden"), 260);
  }

  // ── Pill selection ────────────────────────────────────────────────

  function _setPill(groupId, val) {
    const group = document.getElementById(groupId);
    if (!group) return;
    group.querySelectorAll(".pill").forEach(p => {
      p.classList.toggle("active", p.dataset.val === val);
    });
  }

  // ── Submit ────────────────────────────────────────────────────────

  async function submit() {
    const errorEl = document.getElementById("bp-error");
    const submitBtn = document.getElementById("bp-submit");
    errorEl.textContent = "";

    const amount = 10;
    const exact = parseInt(document.getElementById("bp-count")?.value ?? 0, 10);

    if (!_round) { errorEl.textContent = "No active round"; return; }
    if (isNaN(exact) || exact < 0) { errorEl.textContent = "Enter a valid count"; return; }
    if (String(_round.status || "").toLowerCase() !== "open") { errorEl.textContent = "Round is not open for guesses"; return; }
    if (_round.closes_at) {
      const closesAt = new Date(_round.closes_at).getTime();
      if (Number.isFinite(closesAt) && Date.now() >= closesAt) {
        errorEl.textContent = "Guess window has closed";
        return;
      }
    }
    if (_round.ends_at) {
      const endsAt = new Date(_round.ends_at).getTime();
      if (Number.isFinite(endsAt) && (Date.now() + (_windowSec * 1000)) > endsAt) {
        errorEl.textContent = "Selected window extends past match end";
        return;
      }
    }

    let jwt = await Auth.getJwt();
    if (!jwt) {
      submitBtn.disabled = true;
      errorEl.textContent = "Starting guest session…";
      try {
        jwt = await Auth.signInAnon();
        if (!jwt) throw new Error("Guest session failed");
        window.dispatchEvent(new CustomEvent("session:guest"));
      } catch (e) {
        errorEl.textContent = e.message || "Login required to submit a guess";
        submitBtn.disabled = false;
        return;
      }
    }

    if (submitBtn && !submitBtn.dataset.defaultHtml) {
      submitBtn.dataset.defaultHtml = submitBtn.innerHTML;
    }
    submitBtn.disabled = true;
    submitBtn.innerHTML = `<span class="wlz-inline-spinner" aria-hidden="true"></span>Submitting...`;
    errorEl.textContent = "";

    try {
      const res = await fetch("/api/bets/place?live=1", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify({
          round_id: _round.id,
          window_duration_sec: _windowSec,
          vehicle_class: _vehicleClass || null,
          exact_count: exact,
          amount,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        errorEl.textContent =
          res.status === 400 ? (data?.detail || data?.error || "Invalid guess — check your input") :
          res.status === 401 ? "Session expired — please sign in again" :
          res.status === 403 ? "Round is no longer accepting guesses" :
          res.status === 409 ? "You already have an active guess for this round" :
          (data?.detail || data?.error || "Something went wrong — try again");
        return;
      }

      // Show countdown + receipt
      _showBpActiveBet(data.window_end, exact);
      window.dispatchEvent(new CustomEvent("bet:placed", {
        detail: {
          ...data,
          bet_type: "exact_count",
          round_id: _round?.id || null,
          window_duration_sec: _windowSec,
          vehicle_class: _vehicleClass || null,
          exact_count: exact,
        },
      }));

    } catch (e) {
      errorEl.textContent = "Network error — try again";
    } finally {
      submitBtn.disabled = false;
      submitBtn.innerHTML = submitBtn.dataset.defaultHtml || "Submit Guess";
    }
  }

  function _showBpActiveBet(windowEndIso, guessCount) {
    const activeEl  = document.getElementById("bp-active-bet");
    const cdEl      = document.getElementById("bp-countdown");
    const hintEl    = document.getElementById("bp-active-hint");
    const submitBtn = document.getElementById("bp-submit");
    if (!activeEl || !cdEl) return;

    // Receipt fields
    const receiptGuessEl = document.getElementById("bpa-receipt-guess");
    if (receiptGuessEl) receiptGuessEl.textContent = guessCount ?? "—";

    const winTagEl = document.getElementById("bpa-window-tag");
    if (winTagEl) {
      const labels = { 60: "1 MIN", 180: "3 MIN", 300: "5 MIN" };
      winTagEl.textContent = labels[_windowSec] || `${Math.round(_windowSec / 60)} MIN`;
    }

    activeEl.classList.remove("hidden");
    submitBtn.classList.add("hidden");

    const endTime = new Date(windowEndIso).getTime();

    clearInterval(_countdownTimer);
    _countdownTimer = setInterval(() => {
      const diffRaw = Math.max(0, Math.ceil((endTime - Date.now()) / 1000));
      const m = Math.floor(diffRaw / 60).toString().padStart(2, "0");
      const s = (diffRaw % 60).toString().padStart(2, "0");
      cdEl.textContent = `${m}:${s}`;
      if (diffRaw === 0) {
        clearInterval(_countdownTimer);
        cdEl.textContent = "00:00";
        if (hintEl) hintEl.textContent = "Calculating your score...";
      }
    }, 200);
  }

  function _hideBpActiveBet(showSubmit = true) {
    clearInterval(_countdownTimer);
    document.getElementById("bp-active-bet")?.classList.add("hidden");
    if (showSubmit) document.getElementById("bp-submit")?.classList.remove("hidden");
  }

  // ── Handle ws_account bet_resolved event ─────────────────────────

  function onBetResolved(data) {
    _hideBpActiveBet(false); // don't show submit — result panel takes over
    _showBpResult(data);
  }

  let _replayChart = null;

  function _showBpResult(data) {
    const resultEl = document.getElementById("bp-result");
    if (!resultEl) {
      // Fallback toast if HTML not present
      const tier = data.score_tier || (data.won ? (String(data.actual) === String(data.exact) ? "exact" : "close") : "miss");
      const toastMsg = tier === "exact"
        ? `EXACT! +${Number(data.payout || 0).toLocaleString()} pts — count was ${data.actual}`
        : tier === "close"
          ? `CLOSE! +${Number(data.payout || 0).toLocaleString()} pts — count was ${data.actual}, you guessed ${data.exact}`
          : `MISS — count was ${data.actual}, you guessed ${data.exact}`;
      _showToast(toastMsg, tier === "miss" ? "loss" : "win");
      return;
    }

    const won    = !!data.won;
    const payout = Number(data.payout || 0);
    const actual = data.actual ?? "—";
    const exact  = data.exact  ?? "—";
    const isExact = won && String(actual) === String(exact);

    const badgeEl = document.getElementById("bpr-badge");
    if (badgeEl) {
      if (isExact) {
        badgeEl.textContent = "EXACT";
        badgeEl.className   = "bpr-badge bpr-badge-exact";
      } else if (won) {
        badgeEl.textContent = "CLOSE";
        badgeEl.className   = "bpr-badge bpr-badge-close";
      } else {
        badgeEl.textContent = "MISS";
        badgeEl.className   = "bpr-badge bpr-badge-miss";
      }
    }

    const ptsEl = document.getElementById("bpr-pts");
    if (ptsEl) {
      ptsEl.textContent = won ? `+${payout.toLocaleString()} pts` : "No pts";
      ptsEl.className   = `bpr-pts ${won ? "bpr-pts-win" : "bpr-pts-miss"}`;
    }

    const guessEl  = document.getElementById("bpr-guess");
    const actualEl = document.getElementById("bpr-actual");
    const payEl    = document.getElementById("bpr-payout");
    if (guessEl)  guessEl.textContent  = exact;
    if (actualEl) actualEl.textContent = actual;
    if (payEl)    payEl.textContent    = won ? `+${payout.toLocaleString()} pts` : "0 pts";

    document.getElementById("bp-submit")?.classList.add("hidden");
    resultEl.classList.remove("hidden");

    // Load replay sparkline if window info is available
    if (data.window_start && data.window_end && data.camera_id) {
      _loadReplayChart(data).catch(() => {});
    } else {
      const replayEl = document.getElementById("bpr-replay");
      if (replayEl) replayEl.classList.add("hidden");
    }
  }

  async function _loadReplayChart(data) {
    const replayEl = document.getElementById("bpr-replay");
    const canvas   = document.getElementById("bpr-replay-canvas");
    if (!replayEl || !canvas || !window.Chart) return;

    try {
      // Fetch count_snapshots for the window period
      const { createClient } = window.supabase || {};
      if (!createClient && !window.sb) return;
      const sb = window.sb;
      if (!sb) return;

      const { data: snaps } = await sb
        .from("count_snapshots")
        .select("captured_at,total,vehicle_breakdown")
        .eq("camera_id", data.camera_id)
        .gte("captured_at", data.window_start)
        .lte("captured_at", data.window_end)
        .order("captured_at", { ascending: true })
        .limit(200);

      if (!snaps || snaps.length < 2) {
        replayEl.classList.add("hidden");
        return;
      }

      // Build relative counts (subtract baseline)
      const baseline = data.baseline || 0;
      const vcls = data.vehicle_class;
      const labels = snaps.map(s => {
        const t = new Date(s.captured_at);
        return `${t.getMinutes().toString().padStart(2,"0")}:${t.getSeconds().toString().padStart(2,"0")}`;
      });
      const counts = snaps.map(s => {
        const raw = vcls ? ((s.vehicle_breakdown || {})[vcls] || 0) : (s.total || 0);
        return Math.max(0, raw - baseline);
      });

      // Destroy previous chart instance
      if (_replayChart) { _replayChart.destroy(); _replayChart = null; }

      const isDark = document.body.classList.contains("dark");
      const guessColor = "#facc15";
      const lineColor  = "#29B6F6";
      const mutedColor = isDark ? "rgba(255,255,255,0.15)" : "rgba(0,0,0,0.1)";

      _replayChart = new window.Chart(canvas, {
        type: "line",
        data: {
          labels,
          datasets: [
            {
              label: "Count",
              data: counts,
              borderColor: lineColor,
              backgroundColor: `${lineColor}22`,
              fill: true,
              tension: 0.3,
              pointRadius: 0,
              borderWidth: 2,
            },
            {
              label: "Your guess",
              data: new Array(counts.length).fill(data.exact),
              borderColor: guessColor,
              borderWidth: 1.5,
              borderDash: [4, 3],
              pointRadius: 0,
              fill: false,
              tension: 0,
            },
          ],
        },
        options: {
          animation: false,
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: { enabled: false },
          },
          scales: {
            x: { display: false },
            y: {
              display: true,
              ticks: { maxTicksLimit: 3, font: { size: 9 }, color: mutedColor },
              grid: { color: mutedColor },
              border: { display: false },
            },
          },
        },
      });

      replayEl.classList.remove("hidden");
    } catch (err) {
      if (replayEl) replayEl.classList.add("hidden");
    }
  }

  function _hideBpResult() {
    document.getElementById("bp-result")?.classList.add("hidden");
    document.getElementById("bp-submit")?.classList.remove("hidden");
    if (_replayChart) { _replayChart.destroy(); _replayChart = null; }
    document.getElementById("bpr-replay")?.classList.add("hidden");
  }

  function _shareResult() {
    const badge   = document.getElementById("bpr-badge")?.textContent || "";
    const guess   = document.getElementById("bpr-guess")?.textContent || "?";
    const actual  = document.getElementById("bpr-actual")?.textContent || "?";
    const ptsEl   = document.getElementById("bpr-pts");
    const pts     = ptsEl?.textContent || "";
    const emoji   = badge === "EXACT" ? "🎯" : badge === "CLOSE" ? "🔥" : "😅";
    const text = `${emoji} ${badge}! I guessed ${guess} vehicles — actual was ${actual}. ${pts} — AI Traffic Jamaica aitrafficja.com`;
    if (navigator.share) {
      navigator.share({ text, url: "https://aitrafficja.com/" }).catch(() => {});
    } else {
      navigator.clipboard?.writeText(text).then(() => {
        _showToast("Result copied to clipboard!", "win");
      }).catch(() => {});
    }
  }

  function _showToast(msg, type = "info") {
    const el = document.createElement("div");
    el.className = `toast toast-${type}`;
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 5000);
  }

  // ── Init ──────────────────────────────────────────────────────────

  function init() {
    _ensureSpinnerStyle();
    // Back button
    document.getElementById("bet-panel-back")?.addEventListener("click", close);

    // Window pill selection
    document.getElementById("bp-window-pills")?.addEventListener("click", (e) => {
      const pill = e.target.closest(".pill");
      if (!pill) return;
      _windowSec = parseInt(pill.dataset.val, 10);
      _setPill("bp-window-pills", pill.dataset.val);
    });

    // Count adjusters
    document.getElementById("bp-count-minus")?.addEventListener("click", () => {
      const el = document.getElementById("bp-count");
      if (el) el.value = Math.max(0, parseInt(el.value || 0, 10) - 1);
    });
    document.getElementById("bp-count-plus")?.addEventListener("click", () => {
      const el = document.getElementById("bp-count");
      if (el) el.value = Math.min(10000, parseInt(el.value || 0, 10) + 1);
    });

    // Submit
    document.getElementById("bp-submit")?.addEventListener("click", submit);

    // Result panel actions
    document.getElementById("bpr-again-btn")?.addEventListener("click", () => {
      _hideBpResult();
    });

    // Share button
    document.getElementById("bpr-share-btn")?.addEventListener("click", _shareResult);

    document.getElementById("bpr-leaderboard-btn")?.addEventListener("click", () => {
      close();
      // Activate the leaderboard sidebar tab
      const lbTab = document.querySelector('.tab-btn[data-tab="leaderboard"]');
      if (lbTab) lbTab.click();
    });
  }

  return { init, open, close, onBetResolved, setRound: (r) => { _round = r; } };
})();

window.LiveBet = LiveBet;
