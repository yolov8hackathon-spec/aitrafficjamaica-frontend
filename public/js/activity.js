/**
 * activity.js — Bet activity broadcaster + leaderboard loader.
 * Dispatches `activity:bet` events consumed by chat.js (main chat + stream overlay).
 */

const Activity = (() => {
  let _channel = null;

  function init() {
    _loadHistory();
    _subscribe();
  }

  async function _loadHistory() {
    try {
      const { data, error } = await window.sb
        .from("bets")
        .select("amount, bet_type, exact_count, vehicle_class, window_duration_sec, placed_at")
        .order("placed_at", { ascending: false })
        .limit(20);
      if (error) throw error;
      if (!data?.length) return;
      // Dispatch in chronological order (oldest first = natural chat flow)
      [...data].reverse().forEach(bet => _dispatch(bet));
    } catch (e) {
      console.warn("[Activity] History load failed:", e);
    }
  }

  function _subscribe() {
    if (_channel) window.sb.removeChannel(_channel);
    _channel = window.sb
      .channel("activity")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "bets" },
        (payload) => { _dispatch(payload.new, true); }
      )
      .subscribe();
  }

  function _dispatch(bet, isNew = false) {
    window.dispatchEvent(new CustomEvent("activity:bet", { detail: { ...bet, isNew } }));
  }

  // ── Leaderboard ───────────────────────────────────────────────
  function _esc(v) {
    return String(v ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }

  function _winLabel(sec) {
    return sec <= 90 ? "1 MIN" : sec <= 240 ? "3 MIN" : "5 MIN";
  }

  async function loadLeaderboard(windowSec = 60) {
    const container = document.getElementById("leaderboard-list");
    if (!container) return;

    // 30-second cache per window duration — leaderboard data changes infrequently.
    // Invalidated by AppCache.invalidate("lb:") on bet:resolved or manual refresh.
    const cacheKey = `lb:${windowSec}`;
    const cachedHtml = window.AppCache?.get(cacheKey);
    if (cachedHtml !== null) {
      container.innerHTML = cachedHtml;
      return;
    }

    container.innerHTML = `<div class="lb-loading"><span class="skeleton" style="height:44px;border-radius:8px;display:block;margin-bottom:6px;"></span><span class="skeleton" style="height:44px;border-radius:8px;display:block;margin-bottom:6px;"></span><span class="skeleton" style="height:44px;border-radius:8px;display:block;"></span></div>`;

    try {
      // Pull all resolved bets for this window
      const { data: bets, error } = await window.sb
        .from("bets")
        .select("user_id, exact_count, potential_payout, window_duration_sec, placed_at")
        .eq("window_duration_sec", windowSec)
        .not("potential_payout", "is", null)
        .gt("potential_payout", 0);

      if (error) throw error;

      if (!bets?.length) {
        container.innerHTML = `<div class="empty-state">No ${_winLabel(windowSec)} scores yet.<br><span>Be the first to guess in this window.</span></div>`;
        window.AppCache?.set(cacheKey, container.innerHTML, 30_000);
        return;
      }

      // Aggregate per user
      const userMap = {};
      for (const b of bets) {
        if (!b.user_id) continue;
        if (!userMap[b.user_id]) {
          userMap[b.user_id] = { totalPts: 0, guesses: 0, topGuess: 0 };
        }
        const u = userMap[b.user_id];
        const pts = Number(b.potential_payout || 0);
        u.totalPts += pts;
        u.guesses  += 1;
        if (pts > u.topGuess) u.topGuess = pts;
      }

      // Sort by total points
      const sorted = Object.entries(userMap)
        .sort((a, b) => b[1].totalPts - a[1].totalPts)
        .slice(0, 20);

      // Resolve usernames
      const userIds = sorted.map(([id]) => id).filter(Boolean);
      let nameMap = {};
      try {
        const { data: profiles } = await window.sb
          .from("profiles").select("user_id, username").in("user_id", userIds);
        (profiles || []).forEach(p => { nameMap[p.user_id] = p.username; });
      } catch { /* graceful */ }

      const medalColors = ["#FFD700", "#C0C0C0", "#CD7F32"];
      container.innerHTML = sorted.map(([uid, stats], i) => {
        const name     = nameMap[uid] || ("Player " + uid.slice(0, 5));
        const rank     = i < 3
          ? `<span class="lb-medal" style="color:${medalColors[i]};border-color:${medalColors[i]}">${i + 1}</span>`
          : `<span class="lb-rank-num">#${i + 1}</span>`;
        const topClass = i < 3 ? ` lb-row-top lb-row-top-${i}` : "";
        const detail   = [
          `${stats.guesses} guess${stats.guesses !== 1 ? "es" : ""}`,
          `best ${stats.topGuess.toLocaleString()} pts`,
        ].join(" · ");
        return `
          <div class="lb-row${topClass}">
            ${rank}
            <div class="lb-name-col">
              <span class="lb-name">${_esc(name)}</span>
              <span class="lb-detail">${_esc(detail)}</span>
            </div>
            <span class="lb-balance">${stats.totalPts.toLocaleString()} pts</span>
          </div>`;
      }).join("");

      // Cache the rendered HTML — cheaper than re-fetching + re-aggregating
      window.AppCache?.set(cacheKey, container.innerHTML, 30_000);

    } catch (e) {
      console.error("[Activity] Leaderboard load failed:", e);
      container.innerHTML = `<div class="empty-state">Could not load leaderboard.<br><span>Please try again shortly.</span></div>`;
    }
  }

  return { init, loadLeaderboard };
})();

window.Activity = Activity;
