import { sb } from './core/supabase.js';
import { AppCache } from './core/cache.js';
import { Auth } from './services/auth.js';
import { Stream } from './services/stream.js';
import { Markets } from './services/markets.js';
import { Counter } from './services/counter.js';
import { FloatingCount } from './overlays/floating-count.js';
import { FpsOverlay } from './overlays/fps-overlay.js';
import { DetectionOverlay } from './overlays/detection-overlay.js';
import { ZoneOverlay } from './overlays/zone-overlay.js';
import { MlOverlay } from './overlays/ml-overlay.js';
import { MlShowcase } from './overlays/ml-showcase.js';
import { Activity } from './ui/activity.js';
import { Chat } from './ui/chat.js';
import { StreamChatOverlay } from './ui/chat.js';
import { Banners } from './ui/banners.js';
import { CameraSwitcher } from './ui/camera-switcher.js';
import { LiveBet } from './ui/live-bet.js';
import { getContentBounds, contentToPixel } from './utils/coord-utils.js';
import { Demo } from './services/demo.js';

// Expose to window for chart.js lazy imports (gov overlay uses window.Chart)
import './utils/site-views.js';

/**
 * index-init.js — Main page controller for WHITELINEZ index.html
 *
 * Responsibilities:
 *   - Public stream appearance (video filter, day/night profile)
 *   - Auth state → nav bar (avatar, balance, admin links)
 *   - WebSocket /ws/account → balance + bet resolution events
 *   - Login / Register / Guest modals
 *   - Mobile bottom-sheet nav
 *   - Vision HUD collapse + Bot HUD training counter
 *   - Logo pulse animation
 *   - Onboarding overlay
 *   - Gov Analytics overlay (analytics, live, export, agencies tabs)
 *   - Custom date-range calendar picker
 *   - Chart.js integration (lazy-loaded on first gov open)
 *   - Agency data package modals + CSV export
 *
 * Expected window globals (set by prior scripts in HTML load order):
 *   sb               — Supabase client          (supabase-init.js)
 *   Auth             — Auth module               (auth.js)
 *   Stream           — HLS stream module         (stream.js)
 *   Markets          — Round/market state        (markets.js)
 *   LiveBet          — Guess panel               (live-bet.js)
 *   Activity         — Leaderboard               (activity.js)
 *   CameraSwitcher   — Camera switching          (camera-switcher.js)
 *   ZoneOverlay      — Zone canvas overlay       (zone-overlay.js)
 *   DetectionOverlay — Detection boxes canvas    (detection-overlay.js)
 *   FloatingCount    — Count widget              (floating-count.js)
 *   FpsOverlay       — FPS counter               (fps-overlay.js)
 *   MlOverlay        — ML HUD display            (ml-overlay.js)
 *   getContentBounds — Coord util                (coord-utils.js)
 *   contentToPixel   — Coord util                (coord-utils.js)
 *
 * Window event contract:
 *   Dispatched:
 *     (none — events are consumed here, not originated)
 *   Consumed:
 *     "balance:update"  detail: number    — new balance from /ws/account
 *     "bet:placed"                        — guess submitted
 *     "bet:resolved"    detail: {...}     — resolved guess from /ws/account
 *     "count:update"    detail: {...}     — vehicle count payload from /ws/live
 *     "session:guest"                     — anonymous session created mid-session
 *     "stream:status"   detail: {status} — stream state changes
 *     "stream:switching"                  — camera switch in progress
 *     "camera:switched" detail: {isAI, alias}
 *
 * TODO (future infrastructure work):
 *   - RunPod GPU backend: detect via /api/health.gpu_active, show badge in HUD
 *   - WebRTC stream: replace HLS with lower-latency WebRTC when backend supports it
 *   - Detection confidence: expose threshold slider in gov overlay settings
 *   - Per-camera analytics: wire _camId into all chart queries when multi-camera is active
 */

// ── Module-scoped DOM helpers ─────────────────────────────────────────────────
// Available to ALL IIFEs in this file. Use these instead of raw getElementById.
const el  = (id) => document.getElementById(id);
const txt = (id, val) => { const e = el(id); if (e) e.textContent = String(val ?? "—"); };

// ── Toast notifications ───────────────────────────────────────────────────────
// Reuses .toast / .toast-info / .toast-win / .toast-loss CSS (leaderboard.css).
function _toast(msg, type = "info", ms = 4500) {
  const t = document.createElement("div");
  t.className = `toast toast-${type}`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

// ── Scroll lock ───────────────────────────────────────────────────────────────
// Single control point for body scroll — prevents double/missed overflow sets.
// Called by openGov() with true (lock) and closeGov() + _pl.hide() with false.
function _lockScroll(lock) { document.body.style.overflow = lock ? "hidden" : ""; }

const GUEST_TS_KEY = "wlz.guest.session_ts";

// ── Vision HUD collapse toggle ────────────────────────────────────────────
(function () {
  const hud = el("ml-hud");
  if (!hud) return;

  // Restore persisted state
  if (localStorage.getItem("wlz.hud.collapsed") === "1") {
    hud.classList.add("is-collapsed");
  }

  // Click anywhere on the hub to toggle collapse/expand
  hud.addEventListener("click", () => {
    const collapsed = hud.classList.toggle("is-collapsed");
    localStorage.setItem("wlz.hud.collapsed", collapsed ? "1" : "0");
  });
}());

(async () => {
  const PUBLIC_DAY_PRESET = {
    brightness: 102,
    contrast: 106,
    saturate: 104,
    hue: 0,
    blur: 0,
  };
  const PUBLIC_NIGHT_PRESET = {
    brightness: 132,
    contrast: 136,
    saturate: 122,
    hue: 0,
    blur: 0.2,
  };
  const PUBLIC_DETECTION_SETTINGS_KEY = "whitelinez.detection.overlay_settings.v4";
  /**
   * Returns the highest-priority active camera from Supabase.
   * Priority: real alias > placeholder alias > no alias.
   * Used to seed the stream and gov overlay with the correct camera_id.
   * @returns {Promise<object|null>} camera row or null if none active
   */
  async function resolveActiveCamera() {
    const { data, error } = await sb
      .from("cameras")
      .select("id, name, ipcam_alias, created_at, feed_appearance")
      .eq("is_active", true);
    if (error) throw error;
    const cams = Array.isArray(data) ? data : [];
    if (!cams.length) return null;
    // Cameras with a real alias (not blank/"your-alias") rank highest.
    // Among equal-rank cameras, newest created_at wins.
    const rank = (cam) => {
      const alias = String(cam?.ipcam_alias || "").trim();
      if (!alias) return 0;
      if (alias.toLowerCase() === "your-alias") return 1;
      return 2;
    };
    cams.sort((a, b) => {
      const ar = rank(a);
      const br = rank(b);
      if (ar !== br) return br - ar;
      const at = Date.parse(a?.created_at || 0) || 0;
      const bt = Date.parse(b?.created_at || 0) || 0;
      if (at !== bt) return bt - at;
      return String(b?.id || "").localeCompare(String(a?.id || ""));
    });
    return cams[0] || null;
  }

  function isNightWindowNow() {
    const h = new Date().getHours();
    return h >= 18 || h < 6;
  }
  function buildVideoFilter(a) {
    const brightness = Math.max(50, Math.min(180, Number(a?.brightness) || 100));
    const contrast = Math.max(50, Math.min(200, Number(a?.contrast) || 100));
    const saturate = Math.max(0, Math.min(220, Number(a?.saturate) || 100));
    const hue = Math.max(0, Math.min(360, Number(a?.hue) || 0));
    const blur = Math.max(0, Math.min(4, Number(a?.blur) || 0));
    return `brightness(${brightness}%) contrast(${contrast}%) saturate(${saturate}%) hue-rotate(${hue}deg) blur(${blur.toFixed(1)}px)`;
  }
  async function applyPublicFeedAppearance(videoEl) {
    if (!videoEl || !sb) return;
    try {
      const cam = await resolveActiveCamera();
      const cfg = cam?.feed_appearance && typeof cam.feed_appearance === "object"
        ? cam.feed_appearance
        : null;
      if (!cfg || cfg.push_public === false) {
        videoEl.style.filter = "";
        return;
      }
      if (cfg.detection_overlay && typeof cfg.detection_overlay === "object") {
        const publicOverlayCfg = {
          ...cfg.detection_overlay,
          outside_scan_show_labels: true,
        };
        try {
          localStorage.setItem(PUBLIC_DETECTION_SETTINGS_KEY, JSON.stringify(publicOverlayCfg));
        } catch {}
        window.dispatchEvent(new CustomEvent("detection:settings-update", { detail: publicOverlayCfg }));
      }
      const appearance = cfg.auto_day_night
        ? (isNightWindowNow() ? PUBLIC_NIGHT_PRESET : PUBLIC_DAY_PRESET)
        : (cfg.appearance || {});
      videoEl.style.filter = buildVideoFilter(appearance);
    } catch {
      // Keep public view resilient if appearance config fetch fails.
    }
  }

  // ── Guest session 48h expiry scrub ────────────────────────────────────────
  {
    const earlySession = await Auth.getSession();
    if (earlySession?.user?.is_anonymous) {
      const ts = Number(localStorage.getItem(GUEST_TS_KEY) || 0);
      if (ts > 0 && Date.now() - ts > 48 * 60 * 60 * 1000) {
        localStorage.removeItem(GUEST_TS_KEY);
        try { await sb.auth.signOut(); } catch {}
        window.location.reload();
        return;
      }
    }
  }

  // Handle OAuth redirect params — session injection + error display + URL cleanup
  {
    // Custom Google callback injects tokens in the URL fragment (#_sb_at=...&_sb_rt=...)
    // to keep them out of server logs and Referrer headers.
    const _hashStr = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : "";
    const _oauthParams = new URLSearchParams(_hashStr);

    const _sbAt = _oauthParams.get("_sb_at");
    const _sbRt = _oauthParams.get("_sb_rt");
    if (_sbAt && _sbRt) {
      try {
        await sb.auth.setSession({ access_token: _sbAt, refresh_token: _sbRt });
        window.dispatchEvent(new CustomEvent("auth:signed_in"));
      } catch (e) {
        console.error("[Auth] setSession failed:", e);
      }
    }

    const _oauthError = _oauthParams.get("error_description") || _oauthParams.get("error");
    if (_oauthError) {
      console.error("[Auth] OAuth callback error:", _oauthError);
      const _errBanner = document.createElement("div");
      _errBanner.style.cssText = "position:fixed;top:60px;left:50%;transform:translateX(-50%);background:#ef4444;color:#fff;padding:10px 18px;border-radius:6px;z-index:9999;font-size:13px;max-width:90vw;text-align:center";
      _errBanner.textContent = `Google login failed: ${_oauthError}`;
      document.body.appendChild(_errBanner);
      setTimeout(() => _errBanner.remove(), 8000);
    }

    if (
      _sbAt ||
      window.location.hash ||
      window.location.search.includes("code=") ||
      window.location.search.includes("error=")
    ) {
      history.replaceState(null, "", window.location.pathname);
    }
  }

  // Auto-open auth modal when redirected from a protected page
  if (window.location.search.includes("login=1")) {
    const _returnTo = new URLSearchParams(window.location.search).get("return") || "";
    history.replaceState(null, "", window.location.pathname);
    document.getElementById("btn-open-login")?.click();
    // After successful login, redirect to the page they were trying to reach
    if (_returnTo) {
      window.addEventListener("auth:signed_in", () => {
        window.location.href = decodeURIComponent(_returnTo);
      }, { once: true });
    }
  }

  const session = await Auth.getSession();
  let currentUserId = session?.user?.id || "";

  async function refreshNavBalance() {
    if (!currentUserId) return;
    try {
      const { data } = await sb
        .from("user_balances")
        .select("balance")
        .eq("user_id", currentUserId)
        .maybeSingle();
      const balEl = el("nav-balance");
      const balValEl = el("nav-balance-val");
      if (balEl && data?.balance != null) {
        if (balValEl) balValEl.textContent = Number(data.balance).toLocaleString();
        balEl.classList.remove("hidden");
      }
    } catch {
      // WS updates still handle most cases; keep silent on poll failures.
    }
  }

  function defaultAvatar(_seed) {
    const accent = '#FFD600';
    // Plain SVG silhouette: circle head + body fill, flat monochrome
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64' viewBox='0 0 64 64'>
      <rect width='64' height='64' rx='8' fill='#0c1320'/>
      <circle cx='32' cy='23' r='12' fill='${accent}' opacity='0.88'/>
      <path d='M8 62 Q8 44 32 40 Q56 44 56 62Z' fill='${accent}' opacity='0.7'/>
      <rect width='64' height='64' rx='8' fill='none' stroke='${accent}' stroke-width='1' opacity='0.22'/>
    </svg>`;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  }

  function isAllowedAvatarUrl(url) {
    if (!url || typeof url !== "string") return false;
    const u = url.trim();
    if (!u) return false;
    if (u.startsWith("data:image/")) return true;
    if (u.startsWith("blob:")) return true;
    if (u.startsWith("/")) return true;
    try {
      const parsed = new URL(u, window.location.origin);
      if (parsed.origin === window.location.origin) return true;
      if (parsed.hostname.endsWith(".supabase.co")) return true;
      return false;
    } catch {
      return false;
    }
  }

  function _applyNavSession(s) {
    if (!s) return;
    el("nav-auth")?.classList.add("hidden");
    el("nav-user")?.classList.remove("hidden");
    const user = s.user || {};
    const isAnon = Auth.isAnonymous(s);
    const avatarRaw = user.user_metadata?.avatar_url || "";
    const avatar = isAllowedAvatarUrl(avatarRaw)
      ? avatarRaw
      : defaultAvatar(user.id || user.email || "user");
    const navAvatar = el("nav-avatar");
    if (navAvatar) {
      navAvatar.onerror = () => { navAvatar.src = defaultAvatar(user.id || "user"); };
      navAvatar.src = avatar;
    }
    if (isAnon) {
      // Show a guest badge next to balance
      const balEl = el("nav-balance");
      if (balEl && !el("nav-guest-badge")) {
        const badge = document.createElement("span");
        badge.id = "nav-guest-badge";
        badge.className = "nav-guest-badge";
        badge.textContent = "Guest";
        balEl.insertAdjacentElement("afterend", badge);
      }
    }
    if (user.app_metadata?.role === "admin") {
      el("nav-admin-link")?.classList.remove("hidden");
      el("btn-layout-editor")?.classList.remove("hidden");
      el("header-demo-btn")?.classList.remove("hidden");
    }
  }

  // Nav auth state
  _applyNavSession(session);

  // When a guest session is created mid-session, update nav + balance
  window.addEventListener("session:guest", async () => {
    const newSession = await Auth.getSession();
    _applyNavSession(newSession);
    refreshNavBalance();
  });

  // Re-apply nav after OAuth redirect (PKCE code exchange fires SIGNED_IN async,
  // which may arrive after the initial getSession() call above returns null)
  window.addEventListener("auth:signed_in", (e) => {
    if (!currentUserId) currentUserId = e.detail?.user?.id || "";
    _applyNavSession(e.detail);
    refreshNavBalance();
  });

  // Play overlay
  el("btn-play")?.addEventListener("click", () => {
    el("live-video")?.play();
    el("play-overlay")?.classList.add("hidden");
  });

  // Logout
  el("btn-logout")?.addEventListener("click", () => Auth.logout());

  // ── Widget Layout Editor (admin only) ────────────────────────
  el("btn-layout-editor")?.addEventListener("click", () => {
    if (window.WidgetLayout) window.WidgetLayout.enter();
  });
  // Load saved layout for all visitors
  if (window.WidgetLayout) window.WidgetLayout.loadLayout();

  // Load all active cameras for failover
  let _streamCameras = [];
  let _streamCamIdx = 0;
  let _failoverPending = false;
  try {
    const { data: camData } = await sb
      .from("cameras")
      .select("id, name, ipcam_alias, created_at")
      .eq("is_active", true);
    if (Array.isArray(camData)) {
      _streamCameras = camData
        .filter(c => {
          const a = String(c.ipcam_alias || "").trim();
          return a && a.toLowerCase() !== "your-alias";
        })
        .sort((a, b) => Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0));
    }
  } catch { /* silent — stream works without failover list */ }

  // Stream switching overlay — shown when user picks a new AI camera
  let _switchTimer1 = null, _switchTimer2 = null;
  function _showSwitchOverlay() {
    const ov = el("stream-switching-overlay");
    if (!ov) return;
    ["sso-step-1","sso-step-2","sso-step-3"].forEach(id => {
      const stepEl = el(id);
      if (stepEl) { stepEl.classList.remove("active","done"); }
    });
    el("sso-step-1")?.classList.add("active");
    ov.classList.remove("hidden");
    clearTimeout(_switchTimer1); clearTimeout(_switchTimer2);
    // Animate through 3 steps (800ms, 1800ms) to give a visual sense of progress
    // while the HLS stream reconnects to the new camera alias in the background.
    _switchTimer1 = setTimeout(() => {
      el("sso-step-1")?.classList.replace("active","done");
      el("sso-step-2")?.classList.add("active");
    }, 800);
    _switchTimer2 = setTimeout(() => {
      el("sso-step-2")?.classList.replace("active","done");
      el("sso-step-3")?.classList.add("active");
    }, 1800);
  }
  function _hideSwitchOverlay() {
    clearTimeout(_switchTimer1); clearTimeout(_switchTimer2);
    const ov = el("stream-switching-overlay");
    ov?.classList.add("hidden");
  }

  window.addEventListener("stream:switching", () => { _showSwitchOverlay(); });

  // Backend broadcast (admin force-scene-reset) — clear stale boxes on all viewers
  window.addEventListener("scene:reset", () => {
    DetectionOverlay.clearDetections?.();
    FpsOverlay.reset();
    MlOverlay.resetForNewScene();
  });

  window.addEventListener("camera:switched", (e) => {
    const { isAI, alias } = e.detail || {};
    // Always clear stale detection boxes on any camera switch
    DetectionOverlay.clearDetections?.();
    if (!isAI) { _hideSwitchOverlay(); return; }
    // Reset FPS samples so we get clean readings for the new stream
    FpsOverlay.reset();
    // Reset Vision HUD counters + re-seed from new camera's telemetry
    MlOverlay.resetForNewScene();
    // Immediately reload detection zones + landmarks for the switched-to camera
    ZoneOverlay.reloadZones(alias || null);
    // Update header cam chip label
    const chipNameEl = el("header-cam-name");
    if (chipNameEl && alias) chipNameEl.textContent = alias;
    // Update scene chip location
    const chipLocEl = el("chip-location");
    if (chipLocEl && alias) {
      chipLocEl.textContent = "📍 " + alias;
      chipLocEl.classList.remove("hidden");
    }
    // Update active pill
    document.querySelectorAll(".cam-pill").forEach(p => {
      p.classList.toggle("active", (p.dataset.alias || "") === (alias || ""));
    });
  });

  // Stream offline overlay + camera failover
  window.addEventListener("stream:status", (e) => {
    const overlay = el("stream-offline-overlay");
    const infoEl = overlay?.querySelector(".stream-offline-info");

    if (e.detail?.status === "down") {
      overlay?.classList.remove("hidden");

      // Never failover when a YouTube camera is selected — yt: streams have their
      // own HLS.js retry loop and a separate alias; switching to an ipcam would
      // permanently override the user's camera choice.
      const _isYtStream = String(e.detail?.alias || '').startsWith('yt:');
      if (_isYtStream) {
        // YouTube stream unavailable (yt-dlp failure or first-load delay)
        if (infoEl) infoEl.textContent = "YouTube stream loading…";
      } else if (!_failoverPending && _streamCameras.length > 1) {
        // ipcam failover — try next camera if multiple are configured
        _failoverPending = true;
        _streamCamIdx = (_streamCamIdx + 1) % _streamCameras.length;
        const next = _streamCameras[_streamCamIdx];
        if (infoEl) infoEl.textContent = "Trying backup stream...";
        setTimeout(() => {
          Stream.setAlias(next?.ipcam_alias || "");
          _failoverPending = false;
        }, 2500);
      } else if (infoEl) {
        infoEl.textContent = "Reconnecting to live feed...";
      }
    } else if (e.detail?.status === "ok") {
      overlay?.classList.add("hidden");
      _failoverPending = false;
      _hideSwitchOverlay();
    }
  });

  // Stream — initialise with the AI-active camera alias so the correct feed
  // loads immediately without waiting for CameraSwitcher.init() to resolve.
  // Wrapped in try/catch: stream token failure (e.g. Railway down) must not
  // crash the IIFE and prevent Markets/CameraSwitcher from loading.
  const video = el("live-video");
  try {
    await Stream.init(video, { alias: _streamCameras[0]?.ipcam_alias || "" });
    await applyPublicFeedAppearance(video);
  } catch (streamErr) {
    console.warn("[Stream] init failed — page continues without stream:", streamErr.message);
  }
  // Re-apply on camera switch (immediate); also poll every 60s as fallback for
  // admin-side config changes (reduced from 15s — saves ~180 requests/user/hr)
  window.addEventListener("camera:switched", () => applyPublicFeedAppearance(video));
  setInterval(() => applyPublicFeedAppearance(video), 60000);
  FpsOverlay.init(video, el("fps-overlay"));

  // Canvas overlays
  const zoneCanvas = el("zone-canvas");
  ZoneOverlay.init(video, zoneCanvas);

  const detectionCanvas = el("detection-canvas");
  DetectionOverlay.init(video, detectionCanvas);

  // Floating count widget
  const streamWrapper = document.querySelector(".stream-wrapper");
  FloatingCount.init(streamWrapper);

  // Count widget — mobile tap toggle (desktop uses CSS :hover)
  const countWidget = el("count-widget");
  if (countWidget) {
    let _cwTouchMoved = false;
    countWidget.addEventListener("touchstart", () => { _cwTouchMoved = false; }, { passive: true });
    countWidget.addEventListener("touchmove",  () => { _cwTouchMoved = true;  }, { passive: true });
    countWidget.addEventListener("touchend", (e) => {
      if (_cwTouchMoved) return; // ignore scroll swipes
      e.stopPropagation();
      countWidget.classList.toggle("cw-active");
    }, { passive: true });
    document.addEventListener("touchstart", (e) => {
      if (!countWidget.contains(e.target)) countWidget.classList.remove("cw-active");
    }, { passive: true });
  }
  MlOverlay.init();

  // WS counter — hooks into floating widget
  Counter.init();

  // Patch Counter to update FloatingCount status dot
  window.addEventListener("count:update", () => FloatingCount.setStatus(true));

  // Markets + Live Bet panel
  LiveBet.init();
  Markets.init();

  // Banners — show/hide driven by markets event contract
  window.addEventListener("banners:show", () => Banners.show());
  window.addEventListener("banners:hide", () => Banners.hide());

  // Chat
  Chat.init(session);
  StreamChatOverlay.init();

  // Activity — broadcasts to chat; leaderboard loads lazily on tab open
  Activity.init();
  let _lbWindow = 60;

  document.querySelector('.tab-btn[data-tab="leaderboard"]')?.addEventListener("click", () => {
    Activity.loadLeaderboard(_lbWindow);
  });
  el("lb-refresh")?.addEventListener("click", () => {
    // Manual refresh — bypass cache so user always gets fresh data
    AppCache?.invalidate("lb:");
    Activity.loadLeaderboard(_lbWindow);
  });

  // Window tab switching on leaderboard
  el("tab-leaderboard")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".lb-wtab");
    if (!btn) return;
    _lbWindow = parseInt(btn.dataset.win, 10);
    document.querySelectorAll(".lb-wtab").forEach(b => b.classList.toggle("active", b === btn));
    Activity.loadLeaderboard(_lbWindow);
  });

  // ── Global heartbeat ─────────────────────────────────────────────────────
  // Supabase realtime: auto-refresh markets + banners when rounds/sessions/banners change.
  if (sb) {
    sb.channel("site-heartbeat")
      .on("postgres_changes", { event: "*", schema: "public", table: "bet_rounds" }, () => {
        // Real DB change — bust round cache so loadMarkets() fetches fresh data
        AppCache?.invalidate("round:");
        Markets.loadMarkets();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "round_sessions" }, () => {
        AppCache?.invalidate("round:");
        Markets.loadMarkets();
        // Re-poll session state in banners (triggers play/default tile swap)
        if (Banners) Banners.show();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "banners" }, () => {
        if (Banners) Banners.show();
      })
      .subscribe();
  }

  MlShowcase.init();
  CameraSwitcher.init();

  // ws_account — per-user events (balance, bet resolution)
  if (session) {
    refreshNavBalance();
    // balance:update WS event handles real-time updates; polling removed.
    // If WS is down the next page load will call refreshNavBalance() again.
    _connectUserWs(session);
  }

  // Nav balance display from ws_account
  window.addEventListener("balance:update", (e) => {
    const balEl    = el("nav-balance");
    const balValEl = el("nav-balance-val");
    if (balEl) {
      if (balValEl) balValEl.textContent = (e.detail ?? 0).toLocaleString();
      balEl.classList.remove("hidden");
    }
  });

  // Single handler for bet:placed — prevents double-firing on future refactors
  window.addEventListener("bet:placed", () => {
    Markets?.loadMarkets?.();
    refreshNavBalance();
  });

  // Handle bet resolution from ws_account
  window.addEventListener("bet:resolved", (e) => {
    LiveBet.onBetResolved(e.detail);
    refreshNavBalance();
    // Scores changed — bust leaderboard cache so next open shows fresh data
    AppCache?.invalidate("lb:");
  });

  // ── Header cam chip — initial set from loaded camera list ──────────────────
  {
    const firstCam = _streamCameras[0];
    if (firstCam) {
      const chipNameEl = el("header-cam-name");
      if (chipNameEl) chipNameEl.textContent = firstCam.name || firstCam.ipcam_alias || "Live Camera";
      const chipLocEl = el("chip-location");
      if (chipLocEl) {
        chipLocEl.textContent = "📍 " + (firstCam.name || firstCam.ipcam_alias || "Jamaica");
        chipLocEl.classList.remove("hidden");
      }
    }
  }

  // ── Camera pill strip render ────────────────────────────────────────────────
  {
    const pillStrip = el("cam-pill-strip");
    if (pillStrip && _streamCameras.length > 0) {
      const firstAlias = _streamCameras[0]?.ipcam_alias || "";
      pillStrip.innerHTML = _streamCameras.map(c => {
        const alias = c.ipcam_alias || "";
        const label = c.name || alias || "Camera";
        return `<button class="cam-pill${alias === firstAlias ? ' active' : ''}" data-alias="${alias}">
          <span class="cam-pill-dot"></span>${label}
        </button>`;
      }).join("");
      if (_streamCameras.length < 2) pillStrip.style.display = "none";
      pillStrip.addEventListener("click", (e) => {
        const pill = e.target.closest(".cam-pill");
        if (!pill || pill.classList.contains("active")) return;
        const alias = pill.dataset.alias || "";
        if (alias) CameraSwitcher.switchTo(alias);
      });
    }
  }

  // ── Health fetch — watching count ─────────────────────────────────────────
  try {
    const hRes = await fetch("/api/health");
    if (hRes.ok) {
      const hData = await hRes.json();
      const watchers = Number(hData.total_ws_connections || 0);
      const watchEl = el("header-watching");
      const watchValEl = el("header-watching-val");
      if (watchEl && watchers > 0) {
        if (watchValEl) watchValEl.textContent = watchers;
        watchEl.classList.remove("hidden");
      }
    }
  } catch { /* non-critical */ }
})();


// ── Bot info in VISION HUD — training day + knowledge % ──────────────────────
(function initBotHud() {
  const TRAIN_START  = new Date('2026-02-23T00:00:00');
  const BASE_KNOW    = 71.8;   // % on day 0
  const KNOW_PER_DAY = 0.35;   // % gained per day
  const KNOW_MAX     = 98.5;

  function update() {
    const days = Math.floor((Date.now() - TRAIN_START) / 86400000);
    const know = Math.min(KNOW_MAX, BASE_KNOW + days * KNOW_PER_DAY).toFixed(1);
    const botEl = el('ml-hud-bot');
    if (botEl) botEl.innerHTML = `<span>TRAIN · DAY ${days}</span><span>KNOW · ${know}%</span>`;
  }

  update();
  // Schedule a re-tick at the next midnight, then daily after that
  const now = new Date();
  const msToMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1) - now;
  setTimeout(() => { update(); setInterval(update, 86400000); }, msToMidnight);
})();


// ── Logo AI frame — random pulse ──────────────────────────────────────────────
(function initLogoPulse() {
  const frame = document.querySelector('.logo-ai-frame');
  const logo  = document.querySelector('.logo');
  if (!frame || !logo) return;

  function schedule() {
    const delay = 4000 + Math.random() * 10000; // 4–14 s between pulses
    setTimeout(() => {
      if (logo.matches(':hover') || frame.classList.contains('logo-ai-pulsing')) {
        schedule(); // hovering or already animating — skip, try again soon
        return;
      }
      frame.classList.add('logo-ai-pulsing');
      frame.addEventListener('animationend', () => {
        frame.classList.remove('logo-ai-pulsing');
        schedule();
      }, { once: true });
    }, delay);
  }

  schedule();
})();


// ── User WebSocket (/ws/account) ──────────────────────────────────────────────
/**
 * Opens /ws/account WebSocket for the authenticated user.
 * Receives: balance updates, bet resolution events.
 * Reconnects with exponential backoff (2s → 30s max).
 * Gives up after 8 failed connection attempts (falls back to HTTP polling).
 * @param {object} session - Supabase session object
 */
function _connectUserWs(session) {
  let ws = null;
  let backoff = 2000;
  let attempts = 0;
  let waitForToken = null;
  let reconnectTimer = null;

  async function connect() {
    const jwt = await Auth.getJwt();
    if (!jwt) return;
    const wssUrl = (typeof Stream !== "undefined" && Stream.getWssUrl)
      ? Stream.getWssUrl()
      : null;
    if (!wssUrl) {
      // WS URL not ready yet — retry after stream.js has fetched the token.
      setTimeout(connect, 3000);
      return;
    }
    const accountUrl = wssUrl.replace("/ws/live", "/ws/account");
    ws = new WebSocket(`${accountUrl}?token=${encodeURIComponent(jwt)}`);
    attempts += 1;
    let opened = false;

    ws.onopen = () => {
      opened = true;
      backoff = 2000;
      attempts = 0;
    };

    ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === "balance") {
          window.dispatchEvent(new CustomEvent("balance:update", { detail: data.balance }));
        } else if (data.type === "bet_resolved") {
          if (data.user_id && String(data.user_id) !== String(session?.user?.id || "")) return;
          window.dispatchEvent(new CustomEvent("bet:resolved", { detail: data }));
        }
      } catch {}
    };

    ws.onclose = (evt) => {
      ws = null;
      const hardRejected = evt?.code === 4001 || evt?.code === 4003;
      if (hardRejected) {
        // Auth/origin failures won't self-heal with rapid retries.
        reconnectTimer = setTimeout(connect, 60000);
        return;
      }
      if (!opened && attempts >= 8) {
        // Keep nav balance alive via HTTP polling; stop aggressive WS retry loop.
        _toast("Live updates paused — balance updates via polling", "info", 6000);
        return;
      }
      backoff = Math.min(backoff * 2, 30000);
      reconnectTimer = setTimeout(connect, backoff);
    };

    ws.onerror = () => {
      // Browser prints socket errors to console; keep handler silent.
    };
  }

  // Poll until stream.js has fetched the WSS URL from /api/token.
  // This avoids a race condition where index-init.js initialises before
  // the stream module has resolved the backend WebSocket endpoint.
  waitForToken = setInterval(() => {
    const ready = typeof Stream !== "undefined" && Stream.getWssUrl && Stream.getWssUrl();
    if (ready) {
      clearInterval(waitForToken);
      connect();
    }
  }, 1000);

  window.addEventListener("beforeunload", () => {
    if (waitForToken) clearInterval(waitForToken);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    try { ws?.close(); } catch {}
  });
}

// ── Login Modal ────────────────────────────────────────────────────────────────
(function _loginModal() {
  const modal    = el("login-modal");
  const backdrop = el("login-modal-backdrop");
  const closeBtn = el("login-modal-close");
  const openBtn  = el("btn-open-login");
  const form     = el("modal-login-form");
  const errorEl  = el("modal-auth-error");
  const submitBtn = el("modal-submit-btn");

  if (!modal) return;

  function open() {
    modal.classList.remove("hidden");
    el("modal-email")?.focus();
  }

  function close() {
    modal.classList.add("hidden");
    if (errorEl) errorEl.textContent = "";
    if (form) form.reset();
  }

  openBtn?.addEventListener("click", open);
  closeBtn?.addEventListener("click", close);
  backdrop?.addEventListener("click", close);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });

  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (errorEl) errorEl.textContent = "";
    submitBtn.disabled = true;
    submitBtn.textContent = "Signing in...";

    try {
      await Auth.login(
        el("modal-email").value,
        el("modal-password").value
      );
      // Reload the page with the active session
      window.location.reload();
    } catch (err) {
      if (errorEl) errorEl.textContent = err.message || "Login failed";
      submitBtn.disabled = false;
      submitBtn.textContent = "Sign In";
    }
  });

  // Switch to register modal
  el("switch-to-register")?.addEventListener("click", (e) => {
    e.preventDefault();
    close();
    el("register-modal")?.classList.remove("hidden");
    el("modal-reg-email")?.focus();
  });

  // Google login
  el("modal-google-btn")?.addEventListener("click", async () => {
    const btn = el("modal-google-btn");
    const errEl = el("modal-auth-error");
    if (errEl) errEl.textContent = "";
    btn.disabled = true;
    btn.textContent = "Redirecting to Google...";
    try {
      await Auth.signInWithGoogle();
    } catch (err) {
      if (errEl) errEl.textContent = err.message || "Google login failed.";
      btn.disabled = false;
      btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg> Continue with Google`;
    }
  });

  // Guest login
  el("modal-guest-btn")?.addEventListener("click", async () => {
    const btn = el("modal-guest-btn");
    const errEl = el("modal-auth-error");
    if (errEl) errEl.textContent = "";
    btn.disabled = true;
    btn.textContent = "Connecting...";
    try {
      await Auth.signInAnon();
      localStorage.setItem(GUEST_TS_KEY, String(Date.now()));
      window.location.reload();
    } catch (err) {
      console.error("[GuestLogin] Full error object:", err);
      const msg = err?.message || "Guest access unavailable.";
      // Surface actionable hint for the most common Supabase config issue
      const display = msg.toLowerCase().includes("disabled")
        ? "Anonymous sign-ins are disabled in Supabase. Enable under Authentication → Providers → Anonymous."
        : msg;
      if (errEl) errEl.textContent = display;
      btn.disabled = false;
      btn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-3.3 3.6-6 8-6s8 2.7 8 6"/></svg> Continue as Guest`;
    }
  });
}());

// ── Register Modal ─────────────────────────────────────────────────────────────
(function _registerModal() {
  const modal    = el("register-modal");
  const backdrop = el("register-modal-backdrop");
  const closeBtn = el("register-modal-close");
  const openBtn  = el("btn-open-register");
  const form     = el("modal-register-form");
  const errorEl  = el("modal-register-error");
  const submitBtn = el("register-submit-btn");

  if (!modal) return;

  function open() {
    modal.classList.remove("hidden");
    el("modal-reg-email")?.focus();
  }

  function close() {
    modal.classList.add("hidden");
    if (errorEl) errorEl.textContent = "";
    if (form) form.reset();
  }

  openBtn?.addEventListener("click", open);
  closeBtn?.addEventListener("click", close);
  backdrop?.addEventListener("click", close);

  // Google login (register modal)
  el("reg-google-btn")?.addEventListener("click", async () => {
    const btn = el("reg-google-btn");
    if (errorEl) errorEl.textContent = "";
    btn.disabled = true;
    btn.textContent = "Redirecting to Google...";
    try {
      await Auth.signInWithGoogle();
    } catch (err) {
      if (errorEl) errorEl.textContent = err.message || "Google login failed.";
      btn.disabled = false;
      btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg> Continue with Google`;
    }
  });

  // Switch back to login
  el("switch-to-login")?.addEventListener("click", (e) => {
    e.preventDefault();
    close();
    el("login-modal")?.classList.remove("hidden");
    el("modal-email")?.focus();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });

  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (errorEl) errorEl.textContent = "";
    const pass    = el("modal-reg-password").value;
    const confirm = el("modal-reg-confirm").value;
    if (pass !== confirm) {
      if (errorEl) errorEl.textContent = "Passwords do not match.";
      return;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = "Creating account...";
    try {
      await Auth.register(
        el("modal-reg-email").value,
        pass
      );
      close();
      // Open login modal with success hint
      el("login-modal")?.classList.remove("hidden");
      const authErr = el("modal-auth-error");
      if (authErr) {
        authErr.style.color = "#00d4ff";
        authErr.textContent = "Account created. Please sign in.";
      }
      el("modal-email")?.focus();
    } catch (err) {
      if (errorEl) errorEl.textContent = err.message || "Registration failed.";
      submitBtn.disabled = false;
      submitBtn.textContent = "Create Account";
    }
  });
}());



// ── Government Mode Overlay (Analytics) ─────────────────────────────────────


// ── ML HUD expand / collapse toggle (new AI Pulse design) ───────────────────
(function _initAiPulseToggle() {
  const hud = el("ml-hud");
  if (!hud) return;

  // Replace old is-collapsed toggle with new is-expanded toggle
  // (old code still runs for is-collapsed; this adds is-expanded)
  hud.addEventListener("click", () => {
    hud.classList.toggle("is-expanded");
  });
}());


// ── Onboarding Overlay ───────────────────────────────────────────────────────
(function _initOnboarding() {
  const OB_KEY    = "wlz.onboarding.done";
  const overlay   = el("onboarding-overlay");
  const skipBtn   = el("ob-skip");
  const nextBtn   = el("ob-next");
  const steps     = Array.from(document.querySelectorAll(".ob-step"));
  const dots      = Array.from(document.querySelectorAll(".ob-dot"));

  if (!overlay || !steps.length) return;
  if (localStorage.getItem(OB_KEY)) return; // already seen

  let _step = 0;

  function _setStep(n) {
    _step = n;
    steps.forEach((s, i) => s.classList.toggle("active", i === n));
    dots.forEach((d,  i) => d.classList.toggle("active", i === n));
    if (nextBtn) nextBtn.textContent = n < steps.length - 1 ? "NEXT →" : "LET'S GO →";
  }

  function _done() {
    localStorage.setItem(OB_KEY, "1");
    overlay.classList.add("hidden");
  }

  _setStep(0);
  overlay.classList.remove("hidden");

  nextBtn?.addEventListener("click", () => {
    if (_step < steps.length - 1) _setStep(_step + 1);
    else _done();
  });
  skipBtn?.addEventListener("click", _done);

  document.addEventListener("keydown", (e) => {
    if (!overlay.classList.contains("hidden")) {
      if (e.key === "ArrowRight" || e.key === "Enter") nextBtn?.click();
      if (e.key === "Escape") _done();
    }
  });
}());


// ── Mobile Nav — bottom sheet + swipe gestures ───────────────────────────────
(function _initMobileNav() {
  const sidebar      = document.querySelector(".sidebar");
  const streamPanel  = document.querySelector(".stream-panel");
  const tabBtns      = document.querySelectorAll(".tab-btn");
  if (!sidebar || !tabBtns.length) return;

  const isMobile = () => window.innerWidth < 768;

  // ── Bottom sheet toggle ──────────────────────────────────────────────────
  function expandTo(tabBtn) {
    sidebar.classList.add("expanded");
    tabBtns.forEach(b => b.classList.remove("active"));
    if (tabBtn) tabBtn.classList.add("active");
    // Show the right tab content
    const target = tabBtn?.dataset?.tab;
    if (target) {
      document.querySelectorAll(".tab-content").forEach(el => {
        el.classList.toggle("active", el.id === `tab-${target}`);
      });
    }
  }

  function collapse() {
    sidebar.classList.remove("expanded");
  }

  tabBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      if (!isMobile()) return; // desktop handles tabs via existing logic

      const alreadyActive = btn.classList.contains("active") && sidebar.classList.contains("expanded");
      if (alreadyActive) {
        collapse();
        tabBtns.forEach(b => b.classList.remove("active"));
      } else {
        expandTo(btn);
        // Trigger lazy-load for leaderboard
        if (btn.dataset.tab === "leaderboard" && Activity) {
          const lbWin = parseInt(document.querySelector(".lb-wtab.active")?.dataset?.win || 60);
          Activity.loadLeaderboard(lbWin);
        }
      }
    });
  });

  // Auto-expand PLAY tab on mobile — always show game content by default
  function _autoExpand() {
    if (!isMobile()) return;
    const playBtn = document.querySelector('.tab-btn[data-tab="markets"]');
    if (playBtn) expandTo(playBtn);
  }
  setTimeout(_autoExpand, 300); // after DOM settles

  // ── Swipe up on stream → expand PLAY tab ───────────────────────────────
  let _touchStartY = 0;
  let _touchStartX = 0;

  streamPanel?.addEventListener("touchstart", e => {
    _touchStartY = e.touches[0].clientY;
    _touchStartX = e.touches[0].clientX;
  }, { passive: true });

  streamPanel?.addEventListener("touchend", e => {
    if (!isMobile()) return;
    const deltaY = _touchStartY - e.changedTouches[0].clientY;
    const deltaX = Math.abs(_touchStartX - e.changedTouches[0].clientX);
    if (deltaY > 55 && deltaX < 40) {
      const playBtn = document.querySelector('.tab-btn[data-tab="markets"]');
      expandTo(playBtn);
    }
  }, { passive: true });


  // ── Visual viewport — keyboard detection for chat ────────────────────────
  if ("visualViewport" in window) {
    window.visualViewport.addEventListener("resize", () => {
      const keyboardOpen = window.visualViewport.height < window.innerHeight * 0.75;
      document.querySelector("#tab-chat")?.classList.toggle("keyboard-open", keyboardOpen);
      // Scroll chat to bottom when keyboard opens
      if (keyboardOpen) {
        const msgs = el("chat-messages");
        if (msgs) msgs.scrollTop = msgs.scrollHeight;
      }
    });
  }

  // ── Resize: on desktop restore normal layout ────────────────────────────
  window.addEventListener("resize", () => {
    if (!isMobile()) {
      sidebar.classList.remove("expanded");
      // Re-activate first active tab on desktop
      const activeContent = document.querySelector(".tab-content.active");
      if (activeContent) {
        const tabId = activeContent.id.replace("tab-", "");
        tabBtns.forEach(b => {
          b.classList.toggle("active", b.dataset.tab === tabId);
        });
      }
    }
  });

  // ── Nav user dropdown ───────────────────────────────────────────────────
  (function _initNavDropdown() {
    const trigger  = el("nav-avatar-trigger");
    const dropdown = el("nav-dropdown");
    if (!trigger || !dropdown) return;
    trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = !dropdown.hidden;
      dropdown.hidden = open;
      trigger.setAttribute("aria-expanded", String(!open));
    });
    document.addEventListener("click", () => {
      dropdown.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
    });
    // Clicks inside dropdown don't close it
    dropdown.addEventListener("click", (e) => e.stopPropagation());
  }());

}());
// ── Gov Analytics Overlay ──────────────────────────────────────────────────
(function initGovOverlay() {
  const overlay  = el("gov-overlay");
  const openBtn  = el("btn-gov-mode");
  const closeBtn = el("btn-close-gov");
  if (!overlay) return;

  // ── State ────────────────────────────────────────────────────────────────
  let _open         = false;
  let _camId        = null;
  let _camName      = null;
  let _lastPayload  = null;   // most recent count:update payload
  let _analyticsData      = null;  // most recent analytics API response
  let _govAnalyticsZones  = [];    // camera_zones for current camera (entry/exit/speed/etc)
  let _govExitTotal       = null;  // total exit completions from turnings matrix (Traffic Intelligence)
  // Custom calendar state
  let _calMonth    = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  let _calAvailSet = new Set();    // "YYYY-MM-DD" strings with traffic_daily data
  let _calFetched  = false;
  let _calPicking  = null;         // "from" | "to"
  let _govHours     = 24;
  let _govFrom      = null;   // ISO date string or null
  let _govTo        = null;   // ISO date string or null
  let _govGranularity = "hour"; // "hour" | "day" | "week"
  let _chartJsReady = false;
  let _trendChart   = null;
  let _chartsBuilding = false; // guard against concurrent _initAllCharts calls
  let _donutChart   = null;
  let _clsChart     = null;
  let _peakChart    = null;
  let _queueChart   = null;
  let _speedChart   = null;
  let _crossingsInterval = null;
  let _activeTab    = "live";
  let _dbKpisLoaded = false;  // true once analytics data has updated KPI cards from DB

  // ── Admin: detection confidence slider ───────────────────────────────────
  // Shown only to admin users. Reads/writes cameras.count_settings.min_confidence
  // via /api/admin/ml-runtime-profile (GET/PATCH proxied to Railway).
  let _confDebounceTimer = null;

  function _confSetStatus(msg, ok) {
    const s = el("gov-conf-status");
    if (!s) return;
    s.textContent = msg;
    s.className = "gov-conf-status" + (ok === true ? " ok" : ok === false ? " err" : "");
  }

  async function _confLoad() {
    if (!_camId) return;
    try {
      const jwt = await Auth.getJwt();
      const res = await fetch(`/api/admin/ml-runtime-profile?camera_id=${encodeURIComponent(_camId)}`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      if (!res.ok) return;
      const data = await res.json();
      const conf = data?.count_settings?.min_confidence;
      if (typeof conf === "number") {
        const slider = el("gov-conf-slider");
        const valEl  = el("gov-conf-val");
        const pct = Math.round(conf * 100);
        if (slider) slider.value = pct;
        if (valEl)  valEl.textContent = pct + "%";
      }
    } catch { /* silent — non-critical */ }
  }

  async function _confApply(pct) {
    if (!_camId) return;
    _confSetStatus("Saving…");
    try {
      const jwt = await Auth.getJwt();
      const res = await fetch(`/api/admin/ml-runtime-profile?camera_id=${encodeURIComponent(_camId)}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
        body: JSON.stringify({ min_confidence: pct / 100 }),
      });
      if (res.ok) _confSetStatus("Saved — applies on next counter refresh", true);
      else        _confSetStatus("Save failed (" + res.status + ")", false);
    } catch (err) {
      _confSetStatus("Error: " + err.message, false);
    }
  }

  async function _initConfSlider() {
    const session = await Auth.getSession();
    const isAdmin = session?.user?.app_metadata?.role === "admin";
    const section = el("gov-conf-section");
    if (!section) return;
    if (!isAdmin) { section.classList.add("hidden"); return; }
    section.classList.remove("hidden");
    await _confLoad();
    const slider = el("gov-conf-slider");
    slider?.addEventListener("input", () => {
      const pct = Number(slider.value);
      const valEl = el("gov-conf-val");
      if (valEl) valEl.textContent = pct + "%";
      clearTimeout(_confDebounceTimer);
      _confDebounceTimer = setTimeout(() => _confApply(pct), 600);
    });
  }

  // ── Admin: recording start date override ─────────────────────────────────
  async function _initRecordingOverride() {
    const session = await Auth.getSession();
    const isAdmin = session?.user?.app_metadata?.role === "admin";
    const section = el("gov-rec-admin-section");
    if (!section) return;
    if (!isAdmin) return; // stays hidden

    section.classList.remove("hidden");

    const dateInput  = el("gov-rec-admin-date");
    const saveBtn    = el("gov-rec-admin-save");
    const resetBtn   = el("gov-rec-admin-reset");
    const statusEl   = el("gov-rec-admin-status");

    // Pre-fill with current override or today as fallback
    const current = localStorage.getItem(REC_OVERRIDE_KEY);
    if (current && dateInput) dateInput.value = current;

    function _setStatus(msg, ok) {
      if (!statusEl) return;
      statusEl.textContent = msg;
      statusEl.className = "gov-rec-admin-status" + (ok === true ? " ok" : ok === false ? " err" : "");
    }

    saveBtn?.addEventListener("click", () => {
      const val = dateInput?.value;
      if (!val) { _setStatus("Pick a date first", false); return; }
      localStorage.setItem(REC_OVERRIDE_KEY, val);
      _setStatus("Saved", true);
      // Re-render notice with override
      _renderRecordingNotice(_analyticsData?.summary?.first_date || val);
    });

    resetBtn?.addEventListener("click", () => {
      localStorage.removeItem(REC_OVERRIDE_KEY);
      if (dateInput) dateInput.value = "";
      _setStatus("Reset — using auto-detected date", true);
      _renderRecordingNotice(_analyticsData?.summary?.first_date || null);
    });
  }

  // ── Analytics loading progress ────────────────────────────────────────────
  function _setProgress(pct, label) {
    const wrap = el("gov-an-progress");
    const bar  = el("gov-an-progress-bar");
    const pctEl = el("gov-an-progress-pct");
    const lblEl = el("gov-an-progress-label");
    if (!wrap) return;
    if (pct >= 100) { wrap.classList.add("hidden"); return; }
    wrap.classList.remove("hidden");
    if (bar)   bar.style.width      = pct + "%";
    if (pctEl) pctEl.textContent    = pct + "%";
    if (lblEl) lblEl.textContent    = label || "Loading…";
  }

  // Chart color map
  const CLS_COLOR = { car:"#29B6F6", truck:"#FF7043", bus:"#AB47BC", motorcycle:"#FFD600" };
  const CLS_CSS   = { car:"gov-td-car", truck:"gov-td-truck", bus:"gov-td-bus", motorcycle:"gov-td-moto" };
  const CLS_SVG = {
    car:        '<svg class="gov-veh-svg" viewBox="0 0 24 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-label="Car"><path d="M1 10V8a1 1 0 0 1 1-1h20a1 1 0 0 1 1 1v2H1z"/><path d="M5 7V6c0-1 1.5-3 3.5-3h7c2 0 3.5 2 3.5 3v1"/><circle cx="5.5" cy="13" r="1.8"/><circle cx="18.5" cy="13" r="1.8"/></svg>',
    truck:      '<svg class="gov-veh-svg" viewBox="0 0 28 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-label="Truck"><rect x="1" y="3" width="14" height="9" rx="1"/><path d="M15 6h7l2 4v3H15V6z"/><line x1="19" y1="6" x2="19" y2="13"/><circle cx="5" cy="14" r="1.8"/><circle cx="11" cy="14" r="1.8"/><circle cx="21.5" cy="14" r="1.8"/></svg>',
    bus:        '<svg class="gov-veh-svg" viewBox="0 0 28 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-label="Bus"><rect x="1" y="2" width="26" height="11" rx="2"/><line x1="1" y1="6" x2="27" y2="6"/><line x1="14" y1="2" x2="14" y2="13"/><circle cx="6" cy="14.5" r="1.5"/><circle cx="22" cy="14.5" r="1.5"/><rect x="3" y="3" width="4" height="2.5" rx="0.5"/><rect x="9" y="3" width="4" height="2.5" rx="0.5"/><rect x="15" y="3" width="4" height="2.5" rx="0.5"/><rect x="21" y="3" width="4" height="2.5" rx="0.5"/></svg>',
    motorcycle: '<svg class="gov-veh-svg" viewBox="0 0 28 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-label="Motorcycle"><circle cx="6" cy="12" r="3.5"/><circle cx="22" cy="12" r="3.5"/><path d="M9.5 12H16l3-6h3"/><path d="M13 6l2 6"/><path d="M19 4h4l1 2"/></svg>',
  };

  // ── Listen for live count updates ────────────────────────────────────────
  // Named so it can be removed when the overlay closes (see closeGov).
  function _onGovCountUpdate(e) {
    _lastPayload = e.detail || {};
    _lastDetTime = Date.now();
    if (_open) _populateLive(_lastPayload);
  }
  let _lastDetTime = null;
  window.addEventListener("count:update", _onGovCountUpdate);

  // Tick the "Last detection: Xs ago" in the agencies live bar
  setInterval(() => {
    if (!_lastDetTime) return;
    const s = Math.round((Date.now() - _lastDetTime) / 1000);
    const label = s < 5 ? "just now" : `${s}s ago`;
    txt("gov-ag-last-det", label);
  }, 2000);

  // ── Tab switching ────────────────────────────────────────────────────────
  el("gov-tabbar")?.addEventListener("click", (e) => {
    const tab = e.target.closest(".gov-tab");
    if (!tab) return;
    const name = tab.dataset.tab;
    _setTab(name);
  });

  // ── Move the real WebGL/Canvas2D canvases into gov-video-slot ────────────
  /**
   * Physically moves #detection-canvas and #zone-canvas into #gov-video-slot.
   * This is required (not just CSS) because the video element creates a GPU
   * compositor layer — canvases must be siblings in the same stacking context
   * to render above it. The renderer contexts survive the DOM move intact.
   */
  function _moveOverlaysToGov() {
    const govSlot  = el("gov-video-slot");
    const zoneC    = el("zone-canvas");
    const detC     = el("detection-canvas");
    if (!govSlot || !zoneC || !detC) return;
    govSlot.appendChild(detC);
    govSlot.appendChild(zoneC);
    [detC, zoneC].forEach(c => {
      c.style.position      = "absolute";
      c.style.top           = "0";
      c.style.left          = "0";
      c.style.width         = "100%";
      c.style.height        = "100%";
      c.style.pointerEvents = "none";
    });
    detC.style.zIndex  = "3";
    zoneC.style.zIndex = "4";
    // Force zone overlay to redraw at new canvas dimensions
    ZoneOverlay?.reloadZones?.();
  }

  function _moveOverlaysBack() {
    const wrapper = document.querySelector(".stream-wrapper");
    const zoneC   = el("zone-canvas");
    const detC    = el("detection-canvas");
    if (!wrapper || !zoneC || !detC) return;
    wrapper.appendChild(detC);
    wrapper.appendChild(zoneC);
    [detC, zoneC].forEach(c => {
      c.style.removeProperty("width");
      c.style.removeProperty("height");
      c.style.removeProperty("top");
      c.style.removeProperty("left");
      c.style.removeProperty("pointer-events");
      c.style.removeProperty("position");
    });
    detC.style.zIndex  = "1";
    zoneC.style.zIndex = "2";
  }

  // ── Move only the video element into a slot ───────────────────────────────
  function _moveVideoGroup(slotId) {
    const slot  = el(slotId);
    const video = el("live-video");
    if (slot && video && !slot.contains(video)) {
      slot.appendChild(video);
      window.dispatchEvent(new Event("resize"));
    }
  }

  // Update only DOM classes (no video/canvas movement)
  function _setTabDom(name) {
    document.querySelectorAll(".gov-tab").forEach(t =>
      t.classList.toggle("active", t.dataset.tab === name));
    document.querySelectorAll(".gov-panel").forEach(p =>
      p.classList.toggle("active", p.id === `gov-panel-${name}`));
  }

  function _setTab(name) {
    _activeTab = name;
    _setTabDom(name);
    if (!_open) return;
    if (name === "analytics") {
      _moveVideoGroup("gov-an-video-slot");
      _startZoneCanvas();
      if (window.Chart && !_trendChart) _initAllCharts(_govHours).then(() => _updatePeakKpiFromChart());
      if (_govHours) _loadGovCrossings();
    } else {
      _stopZoneCanvas();
      _moveVideoGroup("gov-video-slot");
      if (name === "live") {
        _startZoneCanvas();
        if (!_govAnalyticsZones.length) _loadZoneAnalytics();
      }
    }
    if (name === "agencies" && _analyticsData) _populateAgencyMetrics(_analyticsData.summary);
  }

  // ── Analytics zone canvas (draws admin zones on video in analytics slot) ──
  let _govAnZoneRaf = null;

  function _hexToRgba(hex, a) {
    const r = String(hex || "").replace("#", "").padEnd(6, "0").slice(0, 6);
    const n = parseInt(r, 16);
    return `rgba(${(n>>16)&255},${(n>>8)&255},${n&255},${Math.max(0,Math.min(1,a))})`;
  }

  const _ZONE_COLORS = {
    entry:"#4CAF50", exit:"#F44336", queue:"#FF9800",
    roi:"#AB47BC", speed_a:"#00BCD4", speed_b:"#009688",
  };

  /**
   * Resizes canvas to match the video element dimensions at device pixel ratio.
   * Must be called on every RAF tick to handle window resizes cleanly.
   * @param {HTMLCanvasElement} canvas
   * @param {HTMLVideoElement} video
   * @returns {CanvasRenderingContext2D|null}
   */
  function _syncZoneCanvas(canvas, video) {
    const dpr = window.devicePixelRatio || 1;
    // Use canvas parent dimensions as fallback if video hasn't reflowed yet
    let w = video.clientWidth, h = video.clientHeight;
    if (!w || !h) { w = canvas.parentElement?.clientWidth || 0; h = canvas.parentElement?.clientHeight || 0; }
    if (!w || !h) return null;
    const nw = Math.round(w * dpr), nh = Math.round(h * dpr);
    if (canvas.width !== nw || canvas.height !== nh) {
      canvas.width  = nw;  canvas.height  = nh;
      canvas.style.width = w + "px"; canvas.style.height = h + "px";
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }

  /**
   * Draws admin-configured zone polygons on the gov zone canvas.
   * Runs in a RAF loop (_zoneRafLoop). Uses _govAnalyticsZones populated by
   * _loadZoneAnalytics(). Scales points from [0,1] normalised coords to
   * canvas pixels using contentToPixel (coord-utils.js).
   */
  function _drawGovZones() {
    const isAnalytics = _activeTab === "analytics";
    const isLive      = _activeTab === "live";
    if (!isAnalytics && !isLive) return;

    const canvasId = isAnalytics ? "gov-an-zone-canvas" : "gov-live-zone-canvas";
    const canvas = el(canvasId);
    const video  = el("live-video");
    // Guard: coord-utils.js must be loaded for pixel mapping to work
    if (!canvas || !video || !getContentBounds || !contentToPixel) return;
    const ctx = _syncZoneCanvas(canvas, video);
    if (!ctx) return;
    const bounds = getContentBounds(video);
    ctx.clearRect(0, 0, video.clientWidth, video.clientHeight);

    const zones = _govAnalyticsZones;
    // Wait for _loadZoneAnalytics() to populate — no fallback needed
    if (!zones.length) return;

    ctx.save();
    const now = Date.now();
    for (const zone of zones) {
      const pts = zone.points || [];
      if (pts.length < 3) continue;
      const px  = pts.map(p => contentToPixel(p.x, p.y, bounds));
      const col = zone.color || _ZONE_COLORS[zone.zone_type] || "#64748b";

      // Dashed polygon fill
      ctx.beginPath();
      ctx.moveTo(px[0].x, px[0].y);
      for (let i = 1; i < px.length; i++) ctx.lineTo(px[i].x, px[i].y);
      ctx.closePath();
      ctx.fillStyle   = _hexToRgba(col, 0.10);
      ctx.fill();

      // Animated dash offset for a "scanning" effect
      const dashOffset = ((now / 40) % 18);
      ctx.strokeStyle = _hexToRgba(col, 0.85);
      ctx.lineWidth   = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.lineDashOffset = -dashOffset;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineDashOffset = 0;

      // Corner dots on each vertex
      ctx.fillStyle = _hexToRgba(col, 0.90);
      for (const p of px) {
        ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI * 2); ctx.fill();
      }

      // Centroid label badge
      const cx = px.reduce((s, p) => s + p.x, 0) / px.length;
      const cy = px.reduce((s, p) => s + p.y, 0) / px.length;
      const label = (zone.name || zone.zone_type || "zone").toUpperCase();
      ctx.font = "700 9px 'JetBrains Mono',monospace";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = "rgba(0,0,0,0.72)";
      ctx.beginPath();
      ctx.roundRect?.(cx - tw/2 - 5, cy - 8, tw + 10, 16, 3) || ctx.rect(cx - tw/2 - 5, cy - 8, tw + 10, 16);
      ctx.fill();
      ctx.fillStyle = col;
      ctx.fillText(label, cx, cy);
    }
    ctx.restore();
  }

  // RAF (requestAnimationFrame) is used instead of setInterval so the draw
  // loop automatically pauses when the tab is backgrounded, saving CPU.
  // The animated dash offset creates a "scanning" effect on zone outlines.
  function _zoneRafLoop() {
    _drawGovZones();
    _govAnZoneRaf = requestAnimationFrame(_zoneRafLoop);
  }

  function _startZoneCanvas() {
    if (_govAnZoneRaf) return; // already running
    _govAnZoneRaf = requestAnimationFrame(_zoneRafLoop);
  }

  function _stopZoneCanvas() {
    if (_govAnZoneRaf) { cancelAnimationFrame(_govAnZoneRaf); _govAnZoneRaf = null; }
    for (const id of ["gov-an-zone-canvas", "gov-live-zone-canvas"]) {
      const c = el(id);
      if (c) { const ctx = c.getContext("2d"); ctx?.clearRect(0, 0, c.width, c.height); }
    }
  }


  // ── Preloader (gov-preloader overlay) ─────────────────────────────────────
  const _pl = {
    el:    () => el("gov-preloader"),
    pct:   () => el("gov-pl-pct"),
    bar:   () => el("gov-pl-bar"),
    label: () => el("gov-pl-label"),
    show() {
      const e = this.el(); if (!e) return;
      e.classList.remove("hidden", "fading");
      _lockScroll(true);
    },
    set(pct, label) {
      const p = pct + "%";
      const pe = this.pct(); if (pe) pe.textContent = p;
      const be = this.bar(); if (be) be.style.width  = p;
      const le = this.label(); if (le && label) le.textContent = label;
    },
    hide() {
      const e = this.el(); if (!e) return;
      e.classList.add("fading");
      setTimeout(() => e.classList.add("hidden"), 380);
    },
  };

  // ── Analytics preload entry point ─────────────────────────────────────────
  async function openGovAnalytics() {
    if (_open) { _setTab("analytics"); return; }

    _pl.show();
    _pl.set(0, "Initialising…");
    await new Promise(r => setTimeout(r, 300));

    // Step 1 — fire-and-forget zone reload (best-effort, must not block)
    _pl.set(15, "Loading zone data…");
    try { DetectionOverlay?.forceReloadZones?.(); } catch {}
    await new Promise(r => setTimeout(r, 350));
    _pl.set(35, "Zone data ready");

    // Step 2 — load Chart.js (5s timeout so a slow CDN never blocks the overlay)
    _pl.set(45, "Loading chart engine…");
    await new Promise(resolve => {
      _loadChartJs(resolve);
      // 5-second fallback so a slow CDN never permanently blocks the overlay.
      // Charts will lazy-init from cached data if Chart.js loads late.
      setTimeout(resolve, 5000);
    });
    _pl.set(65, "Chart engine ready");
    await new Promise(r => setTimeout(r, 300));

    // Default to today's data if no date range has been chosen yet
    if (!_govFrom) {
      _setPreset("1d");
      document.querySelectorAll(".gov-period-pills .gov-pill").forEach(p =>
        p.classList.toggle("active", p.dataset.preset === "1d"));
    }

    // Step 3 — pre-fetch analytics data + camera id
    _pl.set(72, "Fetching analytics data…");
    if (!_camId && sb) {
      try {
        const { data, error } = await sb.from("cameras")
          .select("id,ipcam_alias,name").eq("is_active", true).limit(1).single();
        if (error) console.warn("[GovAnalytics] Camera query error:", error.message);
        _camId   = data?.id ?? null;
        _camName = data?.name || data?.ipcam_alias || "Camera 1";
      } catch (e) { console.warn("[GovAnalytics] Camera query threw:", e); }
    }
    try { await _prefetchAnalytics(); } catch {}
    _pl.set(95, "Almost ready…");

    await new Promise(r => setTimeout(r, 500));
    _pl.set(100, "Opening analytics…");
    await new Promise(r => setTimeout(r, 350));

    _pl.hide();
    _activeTab = "analytics"; // open directly on analytics tab
    openGov();
  }

  // Pre-fetches analytics data into _analyticsData before the overlay opens
  async function _prefetchAnalytics() {
    if (_analyticsData) return; // already loaded
    let url;
    if (_govFrom || _govTo) {
      url = `/api/analytics/traffic?granularity=${_govGranularity}${_govFrom?`&from=${_govFrom}`:""}${_govTo?`&to=${_govTo}`:""}${_camId?`&camera_id=${_camId}`:""}`;
    } else {
      url = `/api/analytics/traffic?hours=${_govHours}&granularity=${_govGranularity}${_camId ? `&camera_id=${_camId}` : ""}`;
    }
    try {
      const res  = await fetch(url);
      const json = res.ok ? await res.json() : null;
      if (json) _analyticsData = json;
    } catch {}
  }

  // ── Round-open flash cue: pulse the PLAY tab when a new round starts ─────
  window.addEventListener("round:new", () => {
    const playBtn = document.querySelector('.tab-btn[data-tab="markets"]');
    if (!playBtn) return;
    playBtn.classList.remove("tab-round-pulse"); // reset if already pulsing
    void playBtn.offsetWidth; // force reflow to restart animation
    playBtn.classList.add("tab-round-pulse");
    playBtn.addEventListener("animationend", () => playBtn.classList.remove("tab-round-pulse"), { once: true });
  });

  // ── Open / Close ─────────────────────────────────────────────────────────
  openBtn?.addEventListener("click", openGovAnalytics);
  el("header-analytics-cta")?.addEventListener("click", openGovAnalytics);
  closeBtn?.addEventListener("click", closeGov);

  // ── Demo mode toggle (admin only) ─────────────────────────────────────────
  el("header-demo-btn")?.addEventListener("click", () => {
    if (Demo.isActive()) Demo.deactivate();
    else Demo.activate();
  });
  el("btn-close-demo")?.addEventListener("click", () => Demo.deactivate());
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (Demo.isActive()) Demo.deactivate();
      else if (_open) closeGov();
    }
  });

  // ── AI demo-mode overlay (shown to all users when admin runs demo) ────────
  window.addEventListener("demo:mode", (e) => {
    const active = Boolean(e.detail?.active);
    const overlay = el("ai-demo-overlay");
    if (!overlay) return;
    overlay.classList.toggle("hidden", !active);
    if (active) {
      const msgEl = overlay.querySelector(".ai-demo-sub");
      if (msgEl && e.detail?.message) msgEl.textContent = e.detail.message;
    }
  });

  // ── Reset analytics camera when user switches cameras ─────────────────────
  window.addEventListener("camera:switched", () => {
    _camId   = null;
    _camName = null;
    // If overlay is open, reload analytics for the new active camera
    if (_open) openGovAnalytics();
  });

  // ── Restore overlay state after page refresh ──────────────────────────────
  try {
    const savedTab = localStorage.getItem("wl_gov_open");
    if (savedTab) {
      if (savedTab === "analytics") {
        setTimeout(() => openGovAnalytics(), 250);
      } else {
        _activeTab = savedTab;
        setTimeout(() => openGov(), 250);
      }
    }
  } catch {}

  function _setKpiLoading(on) {
    document.querySelector(".gov-kpi-strip")?.classList.toggle("is-loading", on);
  }

  // ── Intro card dismiss (persisted in localStorage) ───────────────────────
  const _INTRO_LS_PREFIX = "wl_intro_";

  function _dismissIntro(key) {
    try { localStorage.setItem(_INTRO_LS_PREFIX + key, "1"); } catch {}
    const card = el("gov-intro-" + key);
    if (card) card.style.display = "none";
  }

  function _restoreIntros() {
    ["live", "analytics", "agencies", "export"].forEach(key => {
      try {
        if (localStorage.getItem(_INTRO_LS_PREFIX + key)) {
          const card = el("gov-intro-" + key);
          if (card) card.style.display = "none";
        }
      } catch {}
    });
  }

  // Delegated listener (catches dynamically shown cards)
  overlay.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-intro-key]");
    if (btn) _dismissIntro(btn.dataset.introKey);
  });
  // Direct listeners on each button (belt-and-suspenders)
  document.querySelectorAll("[data-intro-key]").forEach(btn => {
    btn.addEventListener("click", () => _dismissIntro(btn.dataset.introKey));
  });

  // ── Open / Close gov overlay ──────────────────────────────────────────────
  /**
   * Opens the gov analytics overlay.
   * Moves live canvases into the gov video slot (preserving WebGL contexts).
   * Resolves camera_id from Supabase if not already cached.
   * @returns {Promise<void>}
   */
  async function openGov() {
    if (_open) return;
    _open = true;
    try { localStorage.setItem("wl_gov_open", _activeTab || "live"); } catch {}
    overlay.classList.remove("hidden");
    _lockScroll(true);
    _restoreIntros();
    _moveOverlaysToGov();

    // Show loading bar until first live data arrives
    if (!_lastPayload) _setKpiLoading(true);

    // Resolve camera (may already be resolved by preloader)
    if (!_camId && sb) {
      try {
        const { data, error } = await sb.from("cameras")
          .select("id, ipcam_alias, name").eq("is_active", true).limit(1).single();
        if (error) console.warn("[GovAnalytics] Camera resolve error:", error.message);
        _camId   = data?.id ?? null;
        _camName = data?.name || data?.ipcam_alias || "Camera 1";
      } catch (e) { console.warn("[GovAnalytics] Camera resolve threw:", e); }
    }
    txt("gov-cam-subtitle", `Live Feed · ${_camName}`);
    const _todayFmt = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }).toUpperCase();
    txt("gov-hdr-today", _todayFmt);
    txt("gov-cam-name", _camName);
    txt("gov-vid-cam", _camName);

    // Activate correct tab in DOM and route video/canvases
    _setTabDom(_activeTab);
    if (_activeTab === "analytics") {
      _moveVideoGroup("gov-an-video-slot");
      _startZoneCanvas();
      // Charts already loaded by preloader — build from prefetched data then populate everything
      _initDonut();
      _loadChartJs(() => _initAllCharts(_govHours).then(() => _updatePeakKpiFromChart()));
    } else {
      _moveVideoGroup("gov-video-slot");
      _startZoneCanvas(); // draw admin zones over live feed
      if (!_govAnalyticsZones.length) _loadZoneAnalytics(); // fetch entry/exit/speed zones
      // Populate live stats from last known payload
      if (_lastPayload) _populateLive(_lastPayload);
      // Auto-set "Today" so peak hour, class totals etc. query from midnight today
      if (!_govFrom) _setPreset("1d");
      _loadChartJs(() => { _initDonut(); _initAllCharts(_govHours).then(() => _updatePeakKpiFromChart()); });
    }

    // Admin confidence slider (no-op for non-admins)
    _initConfSlider();

    // Admin recording override (no-op for non-admins)
    _initRecordingOverride();

    // Start crossings refresh
    _loadGovCrossings();
    _crossingsInterval = setInterval(_loadGovCrossings, 10000);

    // Set today's date defaults in export form
    const today = new Date().toISOString().slice(0, 10);
    const fromEl = el("gov-exp-from");
    const toEl   = el("gov-exp-to");
    if (fromEl && !fromEl.value) fromEl.value = today;
    if (toEl   && !toEl.value)   toEl.value   = today;
  }

  /**
   * Closes the gov analytics overlay and restores canvas positions.
   * count:update listener stays registered (permanent) — handler checks _open guard.
   */
  function closeGov() {
    if (!_open) return;
    _open = false;
    try { localStorage.removeItem("wl_gov_open"); } catch {}
    overlay.classList.add("hidden");
    _lockScroll(false);
    clearInterval(_crossingsInterval);
    _crossingsInterval = null;
    _stopZoneCanvas();
    _moveOverlaysBack();
    _govAnalyticsZones = [];
    _govExitTotal      = null;

    // Return video to stream-wrapper
    const wrapper = document.querySelector(".stream-wrapper");
    const video   = el("live-video");
    if (wrapper && video && !wrapper.contains(video)) {
      wrapper.insertBefore(video, wrapper.firstChild);
      window.dispatchEvent(new Event("resize"));
    }
  }

  // ── Live tab — data population ────────────────────────────────────────────
  /**
   * Populates the gov overlay live tab with the latest count:update payload.
   * @param {object} p - payload from /ws/live count:update event
   * @param {number} p.total - cumulative vehicle count
   * @param {object} p.vehicle_breakdown - {car, truck, bus, motorcycle} counts
   * @param {number} [p.queue_depth] - current queue depth
   * @param {number} [p.avg_speed_kmh] - average speed
   */
  function _populateLive(p) {
    _setKpiLoading(false);
    const bd    = p.per_class_total || p.vehicle_breakdown || {};
    const total = p.total ?? p.confirmed_crossings_total ?? 0;
    const fps   = p.fps != null ? Number(p.fps).toFixed(1) : null;
    const profile = p.runtime_profile || p.traffic_load || null;

    // Header strip — only use WS total until analytics loads
    txt("gov-hdr-fps",   fps ?? "—");
    txt("gov-hdr-load",  profile ? profile.replace(/_/g, " ").toUpperCase() : "—");
    if (!_dbKpisLoaded) txt("gov-hdr-total", total.toLocaleString());

    // KPI total — WS placeholder until DB analytics loads
    if (!_dbKpisLoaded) {
      txt("gov-kpi-total", total.toLocaleString());
      txt("gov-kpi-in",    p.count_in != null ? Number(p.count_in).toLocaleString() : "—");
    }
    // Traffic Flow in/out — sourced exclusively from zone analytics; WS never writes these
    // gov-kpi-peak is filled from analytics data

    // Scene
    const scene = [p.scene_lighting, p.scene_weather].filter(Boolean).join(" / ") || p.scene_lighting || "—";
    txt("gov-scene", scene.toUpperCase());

    // (AI health stripe removed from UI)

    // Class breakdown with progress bars
    const classes  = ["car","truck","bus","motorcycle"];
    const barIds   = { car:"gov-bar-car", truck:"gov-bar-truck", bus:"gov-bar-bus", motorcycle:"gov-bar-moto" };
    const valIds   = { car:"gov-cars", truck:"gov-trucks", bus:"gov-buses", motorcycle:"gov-motos" };
    const pctIds   = { car:"gov-pct-car", truck:"gov-pct-truck", bus:"gov-pct-bus", motorcycle:"gov-pct-moto" };
    const counts   = classes.map(c => Number(bd[c] || 0));
    const maxCount = Math.max(...counts, 1);

    classes.forEach((cls, i) => {
      const cnt = counts[i];
      const pct = total > 0 ? Math.round((cnt / total) * 100) : 0;
      txt(valIds[cls], cnt.toLocaleString());
      txt(pctIds[cls], `${pct}%`);
      const bar = el(barIds[cls]);
      if (bar) bar.style.width = `${Math.round((cnt / maxCount) * 100)}%`;
    });

    // System info
    txt("gov-model", fps ? `YOLOv8 · ${fps} fps` : "YOLOv8");
    txt("gov-last",  p.snapshot_at
      ? new Date(p.snapshot_at).toLocaleTimeString()
      : new Date().toLocaleTimeString());  // WS message received = detection happened now

    // Live donut update
    if (_donutChart) {
      _donutChart.data.datasets[0].data = counts;
      _donutChart.update("none");
    }

    // Agency metrics (computed from live data)
    _populateAgencyMetricsLive(bd, total);
  }

  function _populateAgencyMetricsLive(bd, total) {
    const heavy    = (Number(bd.truck || 0) + Number(bd.bus || 0));
    const busCount = Number(bd.bus || 0);
    const heavyPct = total > 0 ? Math.round((heavy / total) * 100) : 0;
    const truckN   = Number(bd.truck || 0);
    const busN     = Number(bd.bus   || 0);

    txt("gov-nwa-metric",     heavy.toLocaleString());
    txt("gov-nwa-sub",        total > 0 ? `${heavyPct}% of today's traffic` : "—");
    txt("gov-taj-metric",     heavy.toLocaleString());
    txt("gov-taj-sub",        `${truckN.toLocaleString()} trucks · ${busN.toLocaleString()} buses`);
    txt("gov-jutc-metric",    busCount.toLocaleString());
    txt("gov-jutc-sub",       "detected at monitored junction");
    txt("gov-tourism-metric", total.toLocaleString());
    txt("gov-tourism-sub",    "verified passes today");
    txt("gov-ins-metric",     heavy.toLocaleString());
    txt("gov-ins-sub",        total > 0 ? `${heavyPct}% high-load vehicles on road` : "monitoring active");
    txt("gov-ooh-metric",     total.toLocaleString());
    txt("gov-ooh-sub",        `= ${total.toLocaleString()} guaranteed impressions`);

    // Live pulse bar + trust badge total
    txt("gov-ag-total",       total.toLocaleString());
    txt("gov-ag-live-total",  total.toLocaleString());
  }

  // ── Chart.js lazy loading ─────────────────────────────────────────────────
  let _chartJsLoading = false;
  const _chartJsCbs = [];
  function _loadChartJs(cb) {
    if (window.Chart) { cb(); return; }
    _chartJsCbs.push(cb);
    if (_chartJsLoading) return; // script tag already injected — callback queued above
    _chartJsLoading = true;
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js";
    s.onload = () => { _chartJsReady = true; _chartJsCbs.splice(0).forEach(fn => fn()); };
    document.head.appendChild(s);
  }

  const CHART_DARK = {
    responsive: true, maintainAspectRatio: false, animation: false,
    plugins: { legend: { display: false }, tooltip: { mode: "index", intersect: false } },
    scales: {
      x: { grid: { color: "rgba(26,45,66,0.8)" }, ticks: { color: "#7A9BB5", font: { size: 9, family: "JetBrains Mono" } } },
      y: { grid: { color: "rgba(26,45,66,0.8)" }, ticks: { color: "#7A9BB5", font: { size: 9, family: "JetBrains Mono" } }, beginAtZero: true },
    },
  };
  const CHART_LIGHT = {
    responsive: true, maintainAspectRatio: false, animation: false,
    plugins: { legend: { display: false }, tooltip: { mode: "index", intersect: false } },
    scales: {
      x: { grid: { color: "#e2e8f0" }, ticks: { color: "#64748b", font: { size: 9, family: "JetBrains Mono" } } },
      y: { grid: { color: "#e2e8f0" }, ticks: { color: "#64748b", font: { size: 9, family: "JetBrains Mono" } }, beginAtZero: true },
    },
  };
  // Gov overlay analytics theme — white panels, clean grid, dark tooltip
  const CHART_GOV = {
    responsive: true, maintainAspectRatio: false,
    animation: { duration: 500, easing: "easeOutQuart" },
    plugins: {
      legend: { display: false },
      tooltip: {
        mode: "index", intersect: false,
        backgroundColor: "#0f1c2e",
        titleColor: "#94a3b8", bodyColor: "#e2e8f0",
        borderColor: "rgba(2,132,199,0.3)", borderWidth: 1,
        padding: 10, cornerRadius: 6,
        titleFont: { family: "JetBrains Mono", size: 8 },
        bodyFont:  { family: "JetBrains Mono", size: 10 },
      },
    },
    scales: {
      x: {
        grid: { color: "rgba(226,232,240,0.8)" },
        border: { display: false },
        ticks: { color: "#94a3b8", font: { size: 9, family: "JetBrains Mono" }, maxRotation: 0, maxTicksLimit: 8 },
      },
      y: {
        grid: { color: "rgba(226,232,240,0.8)" },
        border: { display: false },
        ticks: { color: "#94a3b8", font: { size: 9, family: "JetBrains Mono" } },
        beginAtZero: true,
      },
    },
  };
  // Helper: gradient fill using Chart.js 4 chartArea (correct across all DPR/resize)
  function _govGrad(ctx, colors) {
    return function(context) {
      const { chartArea } = context.chart;
      if (!chartArea) return colors[0];
      const g = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
      colors.forEach(([stop, color]) => g.addColorStop(stop, color));
      return g;
    };
  }

  // ── Mini donut (LIVE sidebar) ─────────────────────────────────────────────
  function _initDonut() {
    const canvas = el("gov-donut-canvas");
    if (!canvas || !window.Chart) return;
    if (_donutChart) { _donutChart.destroy(); _donutChart = null; }
    _donutChart = new window.Chart(canvas, {
      type: "doughnut",
      data: {
        labels: ["Cars","Trucks","Buses","Motorcycles"],
        datasets: [{ data: [1,1,1,1], backgroundColor: ["#29B6F6","#FF7043","#AB47BC","#FFD600"], borderColor: "#080C14", borderWidth: 2 }],
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: "68%", animation: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ` ${c.label}: ${c.parsed}` } } },
      },
    });
  }

  // ── Analytics loading skeleton helpers ───────────────────────────────────
  function _skelBars(count) {
    const heights = [60,80,45,90,55,70,40,85,65,75,50,88].slice(0, count);
    return `<div class="gov-chart-skel-bars">${heights.map(h => `<span style="height:${h}%"></span>`).join("")}</div>`;
  }

  function _setAnalyticsLoading(on) {
    // Summary bar — add/remove class that CSS uses to render shimmer placeholders
    const strip = document.querySelector(".gov-an-sumbar");
    if (strip) strip.classList.toggle("is-loading", on);

    // Chart cards — show/hide loading overlay + skeleton bars placeholder
    document.querySelectorAll(".gov-chart-card").forEach(card => {
      card.classList.toggle("is-loading", on);
      const body = card.querySelector(".gov-chart-body");
      if (!body) return;
      const skelId = "gov-skel-" + (card.id || Math.random());
      if (on) {
        if (!body.querySelector(".gov-chart-skel-bars")) {
          const d = document.createElement("div");
          d.className = "gov-chart-skel-bars"; d.id = skelId;
          d.innerHTML = [60,80,45,90,55,70,40,85,65,75,50,88].map(h => `<span style="height:${h}%"></span>`).join("");
          body.appendChild(d);
        }
      } else {
        body.querySelectorAll(".gov-chart-skel-bars").forEach(el => el.remove());
      }
    });
  }

  function _turningsSkeleton() {
    const rows = Array.from({length:5}, (_,i) => {
      const w1 = 60 + i * 10, w2 = 40 + (i % 3) * 15;
      return `<div class="gov-tur-skel-row">
        <div class="gov-tur-skel-label" style="width:${w1}px"></div>
        <div class="gov-tur-skel-bar" style="max-width:${w2}%"></div>
      </div>`;
    }).join("");
    return `<div class="gov-turnings-skel">${rows}</div>`;
  }

  function _crossingsSkeleton(count) {
    const widths = [[55,48,24,32,60,28],[60,52,28,36,55,30],[50,44,22,30,65,24]];
    return Array.from({length: count || 6}, (_, i) => {
      const w = widths[i % widths.length];
      return `<tr class="gov-xing-skel-row">
        ${w.map(pw => `<td><div class="gov-xing-skel-cell" style="width:${pw}px"></div></td>`).join("")}
      </tr>`;
    }).join("");
  }

  // ── Analytics charts ──────────────────────────────────────────────────────
  async function _initAllCharts(hours) {
    if (!window.Chart) return;
    if (_chartsBuilding) return; // prevent concurrent double-call
    _chartsBuilding = true;
    _setAnalyticsLoading(true);
    _setProgress(30, "Fetching traffic data…");

    // Build URL — use date range if set, else fall back to hours
    let url;
    if (_govFrom || _govTo) {
      url = `/api/analytics/traffic?granularity=${_govGranularity}${_govFrom?`&from=${_govFrom}`:""}${_govTo?`&to=${_govTo}`:""}${_camId?`&camera_id=${_camId}`:""}`;
    } else {
      url = `/api/analytics/traffic?hours=${hours || _govHours}&granularity=${_govGranularity}${_camId?`&camera_id=${_camId}`:""}`;
    }
    try {
      const res  = await fetch(url);
      const json = res.ok ? await res.json() : null;
      if (!json) { _setAnalyticsLoading(false); _setProgress(100); return; }
      _analyticsData = json;
      const rows    = json.rows || [];
      const summary = json.summary || {};

      // ── Update KPI cards with DB-backed data ──────────────────────────────
      const totalPeriod = summary.period_total ?? rows.reduce((a, r) => a + (r.total || 0), 0);
      const totalIn  = rows.reduce((a, r) => a + (r.in  || 0), 0);
      const totalOut = rows.reduce((a, r) => a + (r.out || 0), 0);
      txt("gov-kpi-total",  Number(totalPeriod).toLocaleString());
      txt("gov-hdr-total",  Number(totalPeriod).toLocaleString());
      // gov-inbound / gov-outbound are sourced exclusively from zone analytics (_loadZoneAnalytics)
      // vehicle_crossings direction field is unreliable — do not set them here
      _dbKpisLoaded = true;  // stop WS from overwriting total/hdr with session counter

      // ── Update class breakdown bars from DB class totals ──────────────────
      const ct = summary.class_totals || {};
      const grandTotal = Object.values(ct).reduce((a, b) => a + b, 0) || 1;
      const barIds = { car:"gov-bar-car", truck:"gov-bar-truck", bus:"gov-bar-bus", motorcycle:"gov-bar-moto" };
      const valIds = { car:"gov-cars", truck:"gov-trucks", bus:"gov-buses", motorcycle:"gov-motos" };
      const pctIds = { car:"gov-pct-car", truck:"gov-pct-truck", bus:"gov-pct-bus", motorcycle:"gov-pct-moto" };
      for (const cls of ["car","truck","bus","motorcycle"]) {
        const count = ct[cls] || 0;
        const pct   = Math.round((count / grandTotal) * 100);
        const barEl = el(barIds[cls]);
        if (barEl) barEl.style.width = pct + "%";
        txt(valIds[cls], count.toLocaleString());
        txt(pctIds[cls], pct + "%");
      }

      // ── Summary strip ─────────────────────────────────────────────────────
      const peakLabel   = _formatPeriodLabel(summary.peak_period, summary.granularity || _govGranularity);
      const peakVal     = summary.peak_value || 0;
      const heavyPct    = summary.class_pct
        ? Math.round(((summary.class_pct.truck||0) + (summary.class_pct.bus||0))) + "%"
        : "—";
      const granLabel = _govGranularity === "week" ? "weekly" : _govGranularity === "day" ? "daily" : "hourly";
      txt("gov-sum-total",  Number(totalPeriod).toLocaleString());
      txt("gov-sum-peak",   `${peakLabel} (${peakVal})`);
      txt("gov-sum-heavy",  heavyPct);
      txt("gov-sum-queue",  summary.avg_queue_depth != null ? summary.avg_queue_depth.toFixed(1) : "—");
      // Speed card visibility controlled by zone analytics (_buildSpeedChart / _loadZoneAnalytics)
      // _initAllCharts only sets the value if the traffic API happens to include speed
      txt("gov-kpi-peak",   peakLabel);
      txt("gov-trend-label", `— ${granLabel} view`);

      // Global lifetime total — also update header ticker
      const g = summary.global;
      if (g) {
        txt("gov-sum-global", Number(g.total||0).toLocaleString() + " total");
        _updateHeaderTicker(g.total);
      }

      // Recording since notice
      _renderRecordingNotice(summary.first_date);

      _populateAgencyMetrics(summary);
      _setProgress(60, "Rendering charts…");
      _buildTrendChart(rows);
      _buildClsChart(summary);
      _buildPeakChart(rows);
      _setAnalyticsLoading(false);

      // Zone analytics (queue + turnings + speed) — progress continues inside
      _setProgress(80, "Loading zone analytics…");
      _loadZoneAnalytics();

    } catch (err) {
      console.warn("[GovAnalytics] Chart load failed:", err);
      _setAnalyticsLoading(false);
      _setProgress(100);
    } finally {
      _chartsBuilding = false;
    }
  }

  function _formatPeriodLabel(period, gran) {
    if (!period) return "—";
    if (gran === "day" || gran === "week") return period.slice(0, 10);
    const d = new Date(period);
    if (isNaN(d)) return period;
    return `${String(d.getHours()).padStart(2,"0")}:00`;
  }

  function _buildTrendChart(rows) {
    const canvas = el("gov-trend-canvas");
    if (!canvas || !window.Chart) return;
    if (_trendChart) { _trendChart.destroy(); _trendChart = null; }
    const labels = rows.map(r => _formatPeriodLabel(r.period || r.hour, _govGranularity));
    const mk = (f) => rows.map(r => r[f] || 0);
    // Stacked area — each class fills its own colored band, bottom→top
    const band = (label, field, border, fill) => ({
      label, data: mk(field),
      borderColor: border, backgroundColor: fill,
      borderWidth: 1.5, tension: 0.42, pointRadius: 0, fill: true,
    });
    _trendChart = new window.Chart(canvas, {
      type: "line",
      data: {
        labels,
        datasets: [
          band("Motorcycles", "motorcycle", "#d97706",         "rgba(217,119,6,0.55)"),
          band("Buses",       "bus",        "#7c3aed",         "rgba(124,58,237,0.50)"),
          band("Trucks",      "truck",      "#dc2626",         "rgba(220,38,38,0.50)"),
          band("Cars",        "car",        "rgba(2,132,199,0.9)", "rgba(2,132,199,0.45)"),
        ],
      },
      options: {
        ...CHART_GOV,
        scales: {
          ...CHART_GOV.scales,
          y: { ...CHART_GOV.scales.y, stacked: true },
        },
        plugins: {
          ...CHART_GOV.plugins,
          legend: {
            display: true,
            labels: {
              color: "#64748b", font: { size: 9, family: "JetBrains Mono" },
              boxWidth: 12, padding: 14, usePointStyle: true, pointStyle: "rect",
            },
          },
        },
      },
    });
  }

  function _buildClsChart(summary) {
    const canvas = el("gov-cls-canvas");
    if (!canvas || !window.Chart) return;
    if (_clsChart) { _clsChart.destroy(); _clsChart = null; }
    const ct = summary.class_totals || {};
    const total = Math.max((ct.car||0)+(ct.truck||0)+(ct.bus||0)+(ct.motorcycle||0), 1);
    const entries = [
      { label:"Cars",        val:ct.car||0,        color:"#0284c7" },
      { label:"Motorcycles", val:ct.motorcycle||0,  color:"#f59e0b" },
      { label:"Trucks",      val:ct.truck||0,       color:"#ef4444" },
      { label:"Buses",       val:ct.bus||0,         color:"#8b5cf6" },
    ].sort((a,b) => b.val - a.val);
    _clsChart = new window.Chart(canvas, {
      type: "bar",
      data: {
        labels: entries.map(e => e.label),
        datasets: [{
          data: entries.map(e => e.val),
          backgroundColor: entries.map(e => e.color + "cc"),
          borderColor:     entries.map(e => e.color),
          borderWidth: 1.5, borderRadius: 5, borderSkipped: false,
        }],
      },
      options: {
        ...CHART_GOV,
        indexAxis: "y",
        plugins: { ...CHART_GOV.plugins, legend:{ display:false },
          tooltip:{ callbacks:{ label:(c)=>` ${c.parsed.x.toLocaleString()} (${Math.round(c.parsed.x/total*100)}%)` } } },
      },
    });
  }

  function _buildPeakChart(rows) {
    const canvas = el("gov-peak-canvas");
    if (!canvas || !window.Chart) return;
    if (_peakChart) { _peakChart.destroy(); _peakChart = null; }
    const labels = rows.map(r => _formatPeriodLabel(r.period || r.hour, _govGranularity));
    const totals = rows.map(r => r.total || 0);
    const maxVal = Math.max(...totals, 1);
    const colors = totals.map(v =>
      v >= maxVal * 0.85 ? "rgba(239,68,68,0.85)"   :
      v >= maxVal * 0.6  ? "rgba(245,158,11,0.75)"  :
                           "rgba(2,132,199,0.55)"
    );
    _peakChart = new window.Chart(canvas, {
      type: "bar",
      data: { labels, datasets: [{ data:totals, backgroundColor:colors, borderRadius:3, borderWidth:0 }] },
      options: { ...CHART_GOV },
    });
  }

  // ── Peak KPI back-fill from chart data ───────────────────────────────────
  // Called after _initAllCharts() resolves. Extracts peak from the already-built
  // _peakChart (which holds per-period totals) and writes it into gov-kpi-peak
  // if the tile still shows "—" (i.e. summary.peak_period was null/empty from API).
  function _updatePeakKpiFromChart() {
    const canvas = el("gov-peak-canvas");
    if (!canvas || !window.Chart) return;
    const chart = window.Chart.getChart(canvas);
    if (!chart) return;
    const data   = chart.data.datasets[0]?.data || [];
    const labels = chart.data.labels || [];
    if (!data.length) return;
    let peakIdx = 0;
    data.forEach((v, i) => { if ((v || 0) > (data[peakIdx] || 0)) peakIdx = i; });
    const peakLabel = labels[peakIdx] || "—";
    const peakCount = data[peakIdx]   || 0;
    const kpiEl = el("gov-kpi-peak");
    if (kpiEl && (kpiEl.textContent === "—" || !kpiEl.textContent.trim())) {
      kpiEl.textContent = peakLabel;
    }
    const sumEl = el("gov-sum-peak");
    if (sumEl && (sumEl.textContent === "—" || !sumEl.textContent.trim() || sumEl.textContent.startsWith("—"))) {
      sumEl.textContent = `${peakLabel} (${peakCount})`;
    }
  }

  // ── Zone analytics (Turnings / Queue / Speed) ─────────────────────────────
  async function _loadZoneAnalytics() {
    _govExitTotal = null; // reset so stale period values don't persist

    // Show turnings skeleton while loading
    const tBody = el("gov-turnings-body");
    if (tBody) tBody.innerHTML = _turningsSkeleton();

    // Load zone geometry, turnings, and per-zone vehicle counts in parallel
    const fromParam = _govFrom || new Date(Date.now() - _govHours * 3600 * 1000).toISOString();
    const toParam   = _govTo   || new Date().toISOString();
    const camQ      = _camId ? `&camera_id=${_camId}` : "";

    const [zonesRes, turningsRes, zoneCountsRes] = await Promise.allSettled([
      fetch(`/api/analytics/data?type=zones${camQ}`),
      fetch(`/api/analytics/data?type=turnings${camQ}&from=${fromParam}&to=${toParam}&granularity=${_govGranularity}`),
      fetch(`/api/analytics/zones?${camQ ? `camera_id=${_camId}&` : ""}from=${fromParam}&to=${toParam}`),
    ]);

    // Render active zones bar + store for canvas draw loop
    let zones = [];
    if (zonesRes.status === "fulfilled" && zonesRes.value.ok) {
      zones = await zonesRes.value.json();
      _govAnalyticsZones = zones;   // used by _drawGovZones() RAF loop
      _renderZonesBar(zones);
    }

    // Render WHERE VEHICLES ENTER breakdown
    if (zoneCountsRes.status === "fulfilled" && zoneCountsRes.value.ok) {
      _renderZonesBreakdown(await zoneCountsRes.value.json());
    }

    // Render turnings / queue / speed
    try {
      if (turningsRes.status !== "fulfilled" || !turningsRes.value.ok) throw new Error("turnings fetch failed");
      const data = await turningsRes.value.json();
      _buildQueueChart(data.queue_series || []);
      _buildSpeedChart(data);
      _renderTurningMovements(data);

      // ── Zone intelligence — queue, speed, class, traffic flow ──────────────
      // NOTE: gov-sum-total / gov-kpi-total / gov-hdr-total are NOT overwritten
      // here. turning_movements logs one row per detection frame (not per vehicle),
      // so total_movements is inflated and unreliable as a vehicle count.
      // Those KPIs stay sourced from vehicle_crossings via _initAllCharts().
      const tm = data;

      // Queue depth — only show when queue actually formed (active_samples > 0)
      const queueCard = el("gov-sum-queue-card");
      if (tm.queue_summary?.active_samples > 0) {
        txt("gov-sum-queue", Number(tm.queue_summary.avg).toFixed(1));
        if (queueCard) queueCard.style.display = "";
      } else {
        if (queueCard) queueCard.style.display = "none";
      }

      // Speed — only show summary card when speed data is available
      const speedCard = el("gov-sum-speed-card");
      if (tm.speed?.avg_kmh != null) {
        txt("gov-sum-speed", `${Number(tm.speed.avg_kmh).toFixed(1)} km/h`);
        if (speedCard) speedCard.style.display = "";
      } else {
        if (speedCard) speedCard.style.display = "none";
      }

      // Heavy % from zone class_totals
      if (tm.class_totals) {
        const clsTotal = Object.values(tm.class_totals).reduce((s, v) => s + (v || 0), 0);
        const heavy    = (tm.class_totals.truck || 0) + (tm.class_totals.bus || 0);
        if (clsTotal > 0) txt("gov-sum-heavy", Math.round((heavy / clsTotal) * 100) + "%");
      }

      // Traffic Flow — total zone crossings + dominant turning movement
      const zoneTotal = tm.period?.total_movements || 0;
      if (zoneTotal > 0) {
        txt("gov-inbound", zoneTotal.toLocaleString());
        _govExitTotal = zoneTotal; // prevent WS from overwriting
      }
      // Top movement (most common entry→exit pair)
      const topMov = (tm.top_movements || [])[0];
      if (topMov) {
        // Shorten zone names: "South Entry" → "S.Entry", "North Exit" → "N.Exit"
        const shorten = s => s.replace(/North/i,"N.").replace(/South/i,"S.").replace(/East/i,"E.").replace(/West/i,"W.").replace(/\s+/g,"");
        txt("gov-top-movement",     topMov.total.toLocaleString());
        txt("gov-top-movement-lbl", `${shorten(topMov.from)}→${shorten(topMov.to)}`);
        txt("gov-kpi-out",  topMov.total.toLocaleString());
        txt("gov-outbound", topMov.total.toLocaleString());
      }

      // Class distribution chart — rebuild with zone class_totals
      if (tm.class_totals && window.Chart) {
        const clsTotal = Object.values(tm.class_totals).reduce((s, v) => s + (v || 0), 0);
        const clsPct   = clsTotal > 0 ? Object.fromEntries(
          Object.entries(tm.class_totals).map(([k, v]) => [k, Math.round((v || 0) / clsTotal * 100)])
        ) : {};
        _buildClsChart({ class_totals: tm.class_totals, class_pct: clsPct });
      }

      // Trend + Peak charts — use zone time series only if it has non-zero crossings.
      // If time_series is empty/all-zeros, keep the vehicle_crossings chart from _initAllCharts.
      const hasZoneData = tm.time_series?.some(r => (r.total || 0) > 0);
      if (hasZoneData && window.Chart) {
        _buildTrendChart(tm.time_series);
        _buildPeakChart(tm.time_series);
        _updatePeakKpiFromChart();
        const granLabel = _govGranularity === "week" ? "weekly" : _govGranularity === "day" ? "daily" : "hourly";
        const unitLabel = _govGranularity === "week" ? "by week" : _govGranularity === "day" ? "by day" : "by hour";
        txt("gov-trend-label", `— zone entries ${unitLabel} · ${granLabel} view`);
      }
    } catch (err) {
      console.warn("[GovAnalytics] Zone analytics failed:", err);
      if (tBody) tBody.innerHTML = `<p class="gov-turnings-empty">Failed to load zone analytics.</p>`;
    }
    _setProgress(100);
  }

  const _ZONE_TYPE_META = {
    entry:   { label: "Entry",    color: "#4CAF50" },
    exit:    { label: "Exit",     color: "#F44336" },
    queue:   { label: "Queue",    color: "#FF9800" },
    roi:     { label: "ROI",      color: "#AB47BC" },
    speed_a: { label: "Speed A",  color: "#00BCD4" },
    speed_b: { label: "Speed B",  color: "#009688" },
  };

  function _renderZonesBar(zones) {
    const chips = el("gov-zones-chips");
    if (!chips) return;
    if (!zones || !zones.length) {
      chips.innerHTML = `<span class="gov-zone-chip gov-zone-chip-loading">No active zones</span>`;
      return;
    }
    // Group by zone_type
    const groups = {};
    for (const z of zones) {
      const t = z.zone_type || "roi";
      groups[t] = (groups[t] || 0) + 1;
    }
    const order = ["entry", "exit", "queue", "roi", "speed_a", "speed_b"];
    chips.innerHTML = order
      .filter(t => groups[t])
      .map(t => {
        const meta  = _ZONE_TYPE_META[t] || { label: t, color: "#64748b" };
        const count = groups[t];
        const bg    = meta.color + "18";
        return `<span class="gov-zone-chip" style="background:${bg};border-color:${meta.color}60;color:${meta.color}">
          <span class="gov-zone-chip-dot" style="background:${meta.color}"></span>
          ${meta.label} ×${count}
        </span>`;
      }).join("") +
      `<span class="gov-zone-chip" style="background:rgba(122,155,181,0.06);border-color:rgba(122,155,181,0.2);color:#7A9BB5">
        Total ${zones.length}
      </span>`;
  }

  /** Renders the WHERE VEHICLES ENTER breakdown bars into gov-zones-breakdown-body. */
  function _renderZonesBreakdown(data) {
    const body = el("gov-zones-breakdown-body");
    if (!body) return;
    const zoneList = data?.zones || [];
    if (!zoneList.length) {
      body.innerHTML = `<p class="gov-turnings-empty">No entry zone data for this period.</p>`;
      return;
    }
    const maxTotal = Math.max(...zoneList.map(z => z.total), 1);
    body.innerHTML = zoneList.map(z => {
      const pct     = Math.round((z.total / maxTotal) * 100);
      const ofTotal = z.pct_of_total ?? Math.round((z.total / (data.period_total || 1)) * 100);
      const cls     = [
        z.car       ? `<span class="zbd-cls" style="color:var(--cls-car)">${z.car.toLocaleString()} car</span>` : "",
        z.truck     ? `<span class="zbd-cls" style="color:var(--cls-truck)">${z.truck.toLocaleString()} truck</span>` : "",
        z.bus       ? `<span class="zbd-cls" style="color:var(--cls-bus)">${z.bus.toLocaleString()} bus</span>` : "",
        z.motorcycle? `<span class="zbd-cls" style="color:var(--cls-moto)">${z.motorcycle.toLocaleString()} moto</span>` : "",
      ].filter(Boolean).join(" · ");
      return `<div class="zbd-row">
        <div class="zbd-label">${z.zone_name}</div>
        <div class="zbd-bar-wrap">
          <div class="zbd-bar" style="width:${pct}%"></div>
        </div>
        <div class="zbd-count">${z.total.toLocaleString()}</div>
        <div class="zbd-pct">${ofTotal}%</div>
        <div class="zbd-detail">${cls}</div>
      </div>`;
    }).join("");
  }

  /** Show a text placeholder inside a chart body when there's no data to render. */
  function _chartEmpty(canvasId, msg) {
    const canvas = el(canvasId);
    if (!canvas) return;
    canvas.style.display = "none";
    const body = canvas.closest(".gov-chart-body");
    if (!body) return;
    let ph = body.querySelector(".gov-chart-empty");
    if (!ph) {
      ph = document.createElement("div");
      ph.className = "gov-chart-empty";
      body.appendChild(ph);
    }
    ph.textContent = msg;
  }

  function _buildQueueChart(series) {
    const canvas = el("gov-queue-canvas");
    if (!canvas || !window.Chart) return;
    if (_queueChart) { _queueChart.destroy(); _queueChart = null; }
    const card = canvas.closest(".gov-chart-card");
    if (!series.length) {
      if (card) card.style.display = "none";
      return;
    }
    // Restore card and canvas in case it was hidden by a previous empty state
    if (card) card.style.display = "";
    canvas.style.display = "";
    canvas.closest(".gov-chart-body")?.querySelector(".gov-chart-empty")?.remove();
    const labels = series.map(r => new Date(r.ts).toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" }));
    const data   = series.map(r => r.depth || 0);
    const ctx    = canvas.getContext("2d");
    _queueChart = new window.Chart(canvas, {
      type: "line",
      data: {
        labels,
        datasets: [{
          label: "Queue",
          data,
          borderColor: "#f59e0b",
          backgroundColor: _govGrad(ctx, [[0,"rgba(245,158,11,0.30)"],[0.65,"rgba(245,158,11,0.07)"],[1,"rgba(245,158,11,0)"]]),
          tension: 0.42, pointRadius: 0, borderWidth: 2.2, fill: true,
        }],
      },
      options: {
        ...CHART_GOV,
        plugins: { ...CHART_GOV.plugins, legend:{ display:false },
          tooltip:{ ...CHART_GOV.plugins.tooltip, callbacks:{ label:(c)=>` ${c.parsed.y} vehicles` } } },
      },
    });
  }

  function _buildSpeedChart(data) {
    const canvas = el("gov-speed-canvas");
    const card   = el("gov-speed-card");
    if (!canvas || !window.Chart) return;
    if (_speedChart) { _speedChart.destroy(); _speedChart = null; }
    const sp = data.speed;
    if (!sp || !sp.samples) {
      if (card) card.style.display = "none";
      return;
    }
    if (card) card.style.display = "";
    _speedChart = new window.Chart(canvas, {
      type: "bar",
      data: {
        labels: ["Average", "85th Pct", "Max"],
        datasets: [{
          data: [sp.avg_kmh, sp.p85_kmh, sp.max_kmh],
          backgroundColor: ["rgba(22,163,74,0.75)","rgba(245,158,11,0.75)","rgba(239,68,68,0.75)"],
          borderColor:     ["#16a34a","#f59e0b","#ef4444"],
          borderWidth: 1.5, borderRadius: 5, borderSkipped: false,
        }],
      },
      options: {
        ...CHART_GOV,
        indexAxis: "y",
        plugins: { ...CHART_GOV.plugins, legend:{ display:false },
          tooltip:{ callbacks:{ label:(c)=>` ${c.parsed.x} km/h` } } },
      },
    });
  }

  function _renderTurningMovements(data) {
    const body = el("gov-turnings-body");
    if (!body) return;
    const top = data.top_movements || [];
    if (!top.length) {
      body.innerHTML = `<p class="gov-turnings-empty">No turning movement data for this period. Ensure entry and exit zones are defined in Admin → Analytics Zones.</p>`;
      return;
    }
    const maxTotal = Math.max(...top.map(m => m.total), 1);
    const qs = data.queue_summary || {};
    const sp = data.speed || {};
    body.innerHTML = `
      <div class="gov-turnings-summary">
        <div class="gov-tur-kpi"><div class="gov-tur-kpi-val">${data.period?.total_movements?.toLocaleString() || "—"}</div><div class="gov-tur-kpi-lbl">Total Movements</div></div>
        <div class="gov-tur-kpi"><div class="gov-tur-kpi-val">${qs.avg?.toFixed?.(1) || "—"}</div><div class="gov-tur-kpi-lbl">Avg Queue Depth</div></div>
        <div class="gov-tur-kpi"><div class="gov-tur-kpi-val">${qs.peak || "—"}</div><div class="gov-tur-kpi-lbl">Peak Queue</div></div>
        ${sp ? `<div class="gov-tur-kpi"><div class="gov-tur-kpi-val">${sp.avg_kmh || "—"}</div><div class="gov-tur-kpi-lbl">Avg Speed km/h</div></div>` : ""}
      </div>
      <div class="gov-turnings-list">
        ${top.map(m => {
          const pct = Math.round((m.total / maxTotal) * 100);
          const dominant = ["car","truck","bus","motorcycle"].reduce((a,b) => (m[a]||0) > (m[b]||0) ? a : b, "car");
          const color = { car:"#29B6F6", truck:"#FF7043", bus:"#AB47BC", motorcycle:"#FFD600" }[dominant] || "#29B6F6";
          return `<div class="gov-turning-row" data-from="${m.from}" data-to="${m.to}">
            <div class="gov-turning-route"><span class="gov-turning-from">${m.from}</span><span class="gov-turning-arrow">→</span><span class="gov-turning-to">${m.to}</span></div>
            <div class="gov-turning-bar-wrap"><div class="gov-turning-bar" style="width:${pct}%;background:${color}"></div></div>
            <span class="gov-turning-count" style="color:${color}">${m.total.toLocaleString()}</span>
          </div>`;
        }).join("")}
      </div>`;

    // Click turning row → modal with class breakdown
    body.querySelectorAll(".gov-turning-row").forEach(row => {
      row.addEventListener("click", () => {
        const from = row.dataset.from, toZone = row.dataset.to;
        const m = top.find(x => x.from === from && x.to === toZone);
        if (!m) return;
        _showModal(`${from} → ${toZone}`, `
          <div class="gov-modal-kpi-grid">
            <div class="gov-modal-kpi"><div class="gov-modal-kpi-val">${m.total.toLocaleString()}</div><div class="gov-modal-kpi-lbl">Total Vehicles</div></div>
            <div class="gov-modal-kpi"><div class="gov-modal-kpi-val">${m.avg_dwell_ms ? (m.avg_dwell_ms/1000).toFixed(1)+"s" : "—"}</div><div class="gov-modal-kpi-lbl">Avg Dwell Time</div></div>
          </div>
          <div class="gov-modal-data-rows">
            <div class="gov-modal-data-row"><span class="gov-modal-data-key">Cars</span><span class="gov-modal-data-val" style="color:#29B6F6">${m.car||0}</span></div>
            <div class="gov-modal-data-row"><span class="gov-modal-data-key">Trucks</span><span class="gov-modal-data-val" style="color:#FF7043">${m.truck||0}</span></div>
            <div class="gov-modal-data-row"><span class="gov-modal-data-key">Buses</span><span class="gov-modal-data-val" style="color:#AB47BC">${m.bus||0}</span></div>
            <div class="gov-modal-data-row"><span class="gov-modal-data-key">Motorcycles</span><span class="gov-modal-data-val" style="color:#FFD600">${m.motorcycle||0}</span></div>
          </div>`);
      });
    });
  }

  // ── Recording since notice ────────────────────────────────────────────────
  const REC_OVERRIDE_KEY = "wl.recording_start";

  function _renderRecordingNotice(firstDate) {
    const el_ = el("gov-recording-notice");
    if (!el_) return;
    // Admin override takes precedence over DB-derived date
    const override = localStorage.getItem(REC_OVERRIDE_KEY);
    const dateToUse = override || firstDate;
    if (!dateToUse) { el_.classList.add("hidden"); return; }
    // Alias for rest of function
    firstDate = dateToUse;

    const start   = new Date(firstDate + "T00:00:00Z");
    const now     = new Date();
    const daysSince = Math.floor((now - start) / (1000 * 60 * 60 * 24));
    const fmtDate = start.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

    const milestones = [
      { days: 1,  label: "START" },
      { days: 7,  label: "7-DAY" },
      { days: 30, label: "30-DAY" },
    ];
    const milestonesHtml = milestones.map(m => {
      const reached = daysSince >= m.days;
      const dateStr = new Date(start.getTime() + m.days * 864e5)
        .toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
      return `<span class="gov-rec-milestone ${reached ? "reached" : "pending"}">${m.label}${!reached ? ` <span class="gov-rec-eta">· ${dateStr}</span>` : ""}</span>`;
    }).join("");

    const daysLabel  = daysSince === 0 ? "DAY 1 — LIVE" : `DAY ${daysSince + 1}`;
    const growingTag = daysSince < 7
      ? `<span class="gov-rec-growing">Dataset growing · ${(daysSince + 1) === 1 ? "first 24 hrs" : `${daysSince + 1} days collected`}</span>`
      : "";
    el_.innerHTML = `
      <span class="gov-rec-label">RECORDING SINCE</span>
      <span class="gov-rec-date">${fmtDate}</span>
      <span class="gov-rec-days">${daysLabel}</span>
      ${growingTag}
      <span class="gov-rec-milestones">${milestonesHtml}</span>`;
    el_.classList.remove("hidden");
  }

  // ── Agency metrics from analytics data ────────────────────────────────────
  // ── Header ticker — public live vehicles count ─────────────────────────────
  let _tickerVal = 0;
  function _updateHeaderTicker(n) {
    const num = Number(n) || 0;
    if (num <= 0) return;
    _tickerVal = num;
    const tickerEl = el("header-ticker-val");
    if (tickerEl) tickerEl.textContent = num.toLocaleString();
  }
  // Wire to WS count:update so ticker reflects live session count when no DB total yet
  window.addEventListener("count:update", (e) => {
    const wsTotal = e.detail?.total_in ?? e.detail?.count_in ?? 0;
    if (!_tickerVal && wsTotal > 0) _updateHeaderTicker(wsTotal);
  });

  function _populateAgencyMetrics(summary) {
    if (!summary) return;
    const ct       = summary.class_totals || {};
    const total    = summary.period_total || summary.today_total || 0;
    const heavy    = (ct.truck||0) + (ct.bus||0);
    const heavyPct = total > 0 ? Math.round((heavy / total) * 100) : 0;

    txt("gov-nwa-metric",     heavy.toLocaleString());
    txt("gov-nwa-sub",        total > 0 ? `${heavyPct}% of period traffic` : "—");
    txt("gov-taj-metric",     heavy.toLocaleString());
    txt("gov-taj-sub",        `${(ct.truck||0).toLocaleString()} trucks · ${(ct.bus||0).toLocaleString()} buses`);
    txt("gov-jutc-metric",    (ct.bus||0).toLocaleString());
    txt("gov-jutc-sub",       "detected at monitored junction");
    txt("gov-tourism-metric", Number(total).toLocaleString());
    txt("gov-tourism-sub",    "verified passes in period");
    txt("gov-ins-metric",     heavy.toLocaleString());
    txt("gov-ins-sub",        total > 0 ? `${heavyPct}% high-load vehicles` : "monitoring active");
    txt("gov-ooh-metric",     Number(total).toLocaleString());
    txt("gov-ooh-sub",        `= ${Number(total).toLocaleString()} guaranteed impressions`);

    txt("gov-ag-total",       Number(total).toLocaleString());
    txt("gov-ag-live-total",  Number(total).toLocaleString());
  }

  // ── Crossings data (recent vehicle events) ────────────────────────────────
  async function _loadGovCrossings() {
    if (!sb) return;
    const tbody = el("gov-crossings-body");
    if (tbody) tbody.innerHTML = _crossingsSkeleton(6);
    try {
      let q = sb.from("vehicle_crossings")
        .select("captured_at,vehicle_class,direction,confidence,scene_lighting,scene_weather,dwell_frames")
        .order("captured_at", { ascending: false }).limit(20);
      if (_camId) q = q.eq("camera_id", _camId);
      const { data } = await q;
      if (!tbody || !data?.length) {
        if (tbody) tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:20px">No crossings recorded yet</td></tr>`;
        return;
      }
      tbody.innerHTML = data.map(r => {
        const cls  = String(r.vehicle_class || "car").toLowerCase();
        const css  = CLS_CSS[cls]  || "gov-td-car";
        const icon = CLS_SVG[cls] || CLS_SVG.car;
        const dirCss = r.direction === "in" ? "gov-td-in" : "gov-td-out";
        const conf = r.confidence != null ? `${(Number(r.confidence)*100).toFixed(0)}%` : "—";
        const scene = [r.scene_lighting, r.scene_weather].filter(Boolean).join(" / ") || "—";
        const time  = r.captured_at ? new Date(r.captured_at).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit",second:"2-digit"}) : "—";
        const dwell = r.dwell_frames != null ? `${r.dwell_frames}f` : "—";
        return `<tr data-crossing='${JSON.stringify({time,cls,dir:r.direction,conf,scene,dwell}).replace(/'/g,"&apos;")}'>
          <td>${time}</td>
          <td class="${css}">${icon} ${cls.toUpperCase()}</td>
          <td class="${dirCss}">${r.direction || "—"}</td>
          <td>${conf}</td>
          <td style="color:var(--muted);font-size:10px">${scene}</td>
          <td style="color:var(--dim);font-size:10px">${dwell}</td>
        </tr>`;
      }).join("");
    } catch (err) {
      console.warn("[GovAnalytics] Crossings failed:", err);
    }
  }

  // ── Date-range calendar picker ────────────────────────────────────────────

  async function _fetchAvailDates() {
    if (_calFetched || !sb) return;
    _calFetched = true;
    try {
      const { data } = await sb
        .from("traffic_daily").select("date").order("date");
      if (data) data.forEach(r => { if (r.date) _calAvailSet.add(r.date); });
      _renderCal();
    } catch {}
  }

  function _openCal(field) {
    _calPicking = field;
    // Navigate to the currently-selected date's month
    const d = field === "from" ? _govFrom : (_govTo ? _govTo.slice(0, 10) : null);
    if (d) _calMonth = new Date(d.slice(0, 7) + "-01");
    _fetchAvailDates();
    _renderCal();
    const popup   = el("wl-cal-popup");
    const trigger = el("gov-date-" + field);
    if (!popup || !trigger) return;
    const rect = trigger.getBoundingClientRect();
    // Clamp to viewport so the calendar never renders off-screen on small viewports.
    popup.style.top  = (rect.bottom + 6) + "px";
    popup.style.left = Math.min(rect.left, window.innerWidth - 320) + "px";
    popup.classList.remove("hidden");
    setTimeout(() => {
      const close = (e) => {
        if (!popup.contains(e.target) && e.target !== trigger) {
          popup.classList.add("hidden");
          document.removeEventListener("click", close, true);
        }
      };
      document.addEventListener("click", close, true);
    }, 0);
  }

  function _renderCal() {
    const popup = el("wl-cal-popup");
    if (!popup || popup.classList.contains("hidden")) return;

    const y    = _calMonth.getFullYear();
    const m    = _calMonth.getMonth();
    const mTitle = _calMonth.toLocaleDateString("en-US", { month: "long", year: "numeric" }).toUpperCase();
    const today  = new Date().toISOString().slice(0, 10);

    const firstDow   = new Date(y, m, 1).getDay();
    const offset     = firstDow === 0 ? 6 : firstDow - 1; // Mon-first grid
    const daysInMon  = new Date(y, m + 1, 0).getDate();

    const fromD = _govFrom || null;
    const toD   = _govTo ? _govTo.slice(0, 10) : null;

    let cells = "";
    for (let i = 0; i < offset; i++) cells += `<div class="wl-cal-day wl-cal-empty"></div>`;
    for (let d = 1; d <= daysInMon; d++) {
      const ds    = `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const avail = _calAvailSet.has(ds) && ds <= today;
      const isTod = ds === today;
      const isSel = ds === fromD || ds === toD;
      const inRng = fromD && toD && ds > fromD && ds < toD;

      let cls = "wl-cal-day";
      if (avail) cls += " wl-cal-avail";
      if (isTod) cls += " wl-cal-today";
      if (isSel) cls += " wl-cal-sel";
      else if (inRng) cls += " wl-cal-inrange";
      cells += `<div class="${cls}" data-date="${ds}">${d}</div>`;
    }

    const hint = !_calFetched
      ? `<div class="wl-cal-hint">Loading data dates…</div>`
      : _calAvailSet.size === 0
        ? `<div class="wl-cal-hint">No recorded data yet</div>` : "";

    popup.innerHTML = `
      <div class="wl-cal-hdr-row">
        <button class="wl-cal-nav" id="wl-cal-prev" aria-label="Prev">‹</button>
        <span class="wl-cal-title">${mTitle}</span>
        <button class="wl-cal-nav" id="wl-cal-next" aria-label="Next">›</button>
      </div>
      <div class="wl-cal-wdays">
        <div>Mo</div><div>Tu</div><div>We</div><div>Th</div><div>Fr</div><div>Sa</div><div>Su</div>
      </div>
      <div class="wl-cal-grid">${cells}</div>
      ${hint}
      <div class="wl-cal-actions">
        <button class="wl-cal-btn wl-cal-btn--today" id="wl-cal-today">Today</button>
        <button class="wl-cal-btn wl-cal-btn--clear" id="wl-cal-clear">Clear</button>
      </div>
      <div class="wl-cal-mode">Selecting <strong>${_calPicking === "from" ? "start date" : "end date"}</strong></div>
    `;

    el("wl-cal-prev")?.addEventListener("click", (e) => {
      e.stopPropagation();
      _calMonth = new Date(y, m - 1, 1); _renderCal();
    });
    el("wl-cal-next")?.addEventListener("click", (e) => {
      e.stopPropagation();
      _calMonth = new Date(y, m + 1, 1); _renderCal();
    });
    el("wl-cal-today")?.addEventListener("click", (e) => {
      e.stopPropagation();
      _setCalDate("from", today); _setCalDate("to", today);
      popup.classList.add("hidden");
      _loadChartJs(() => _initAllCharts(_govHours).then(() => _updatePeakKpiFromChart()));
    });
    el("wl-cal-clear")?.addEventListener("click", (e) => {
      e.stopPropagation();
      _govFrom = null; _govTo = null;
      _updateCalBtns();
      popup.classList.add("hidden");
      _loadChartJs(() => _initAllCharts(_govHours).then(() => _updatePeakKpiFromChart()));
    });

    popup.querySelectorAll(".wl-cal-avail").forEach(cell => {
      cell.addEventListener("click", (e) => {
        e.stopPropagation();
        const ds = cell.dataset.date;
        if (_calPicking === "from") {
          _setCalDate("from", ds);
          if (_govTo && _govTo.slice(0, 10) < ds) { _govTo = null; _updateCalBtns(); }
          _calPicking = "to";
          _renderCal();
        } else {
          if (fromD && ds < fromD) {
            _setCalDate("from", ds); _calPicking = "to"; _renderCal();
          } else {
            _setCalDate("to", ds);
            popup.classList.add("hidden");
            _loadChartJs(() => _initAllCharts(_govHours).then(() => _updatePeakKpiFromChart()));
          }
        }
      });
    });
  }

  function _setCalDate(field, ds) {
    if (field === "from") _govFrom = ds;
    else _govTo = ds + "T23:59:59Z";
    _updateCalBtns();
  }

  function _updateCalBtns() {
    const fromEl = el("gov-date-from");
    const toEl   = el("gov-date-to");
    if (fromEl) fromEl.textContent = _govFrom
      ? new Date(_govFrom + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })
      : "From";
    if (toEl) toEl.textContent = _govTo
      ? new Date(_govTo.slice(0, 10) + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })
      : "To";
  }

  function _setPreset(preset) {
    const today    = new Date();
    const todayStr = today.toISOString().slice(0, 10);
    _govTo = null;
    if (preset === "1d") {
      _govFrom = null; // use hours-based rolling window, not calendar date
      _govHours = 24;
      _govGranularity = "hour";
    } else if (preset === "7d") {
      _govFrom = new Date(today - 7 * 86400000).toISOString().slice(0, 10);
      _govGranularity = "day";
    } else if (preset === "30d") {
      _govFrom = new Date(today - 30 * 86400000).toISOString().slice(0, 10);
      _govGranularity = "day";
    } else if (preset === "all") {
      _govFrom = null; _govTo = null;
      _govGranularity = "day";
    }
    _updateCalBtns();
    // Sync granularity pills
    document.querySelectorAll(".gov-gran-pill").forEach(p => {
      p.classList.toggle("active", p.dataset.gran === _govGranularity);
    });
  }

  // Preset pill clicks
  overlay.addEventListener("click", (e) => {
    const pill = e.target.closest(".gov-period-pills .gov-pill");
    if (pill) {
      document.querySelectorAll(".gov-period-pills .gov-pill").forEach(p => p.classList.remove("active"));
      pill.classList.add("active");
      _setPreset(pill.dataset.preset || "1d");
      _loadChartJs(() => _initAllCharts(_govHours).then(() => _updatePeakKpiFromChart()));
      return;
    }

    const gran = e.target.closest(".gov-gran-pill");
    if (gran) {
      document.querySelectorAll(".gov-gran-pill").forEach(p => p.classList.remove("active"));
      gran.classList.add("active");
      _govGranularity = gran.dataset.gran || "hour";
      _loadChartJs(() => _initAllCharts(_govHours).then(() => _updatePeakKpiFromChart()));
      return;
    }
  });

  // Custom calendar — wire date buttons
  el("gov-date-from")?.addEventListener("click", (e) => { e.stopPropagation(); _openCal("from"); });
  el("gov-date-to")?.addEventListener("click",   (e) => { e.stopPropagation(); _openCal("to"); });

  // ── CSV Export ────────────────────────────────────────────────────────────
  el("gov-export-btn")?.addEventListener("click", _triggerExport);
  el("gov-export-dl-btn")?.addEventListener("click", _triggerExport);

  async function _triggerExport() {
    const fromEl = el("gov-exp-from");
    const toEl   = el("gov-exp-to");
    const today  = new Date().toISOString().slice(0,10);
    const from   = new Date((fromEl?.value || today) + "T00:00:00");
    const to     = new Date((toEl?.value   || today) + "T23:59:59");
    const jwt    = await (Auth?.getJwt?.() || Promise.resolve(null));
    if (!jwt) {
      _showModal("EXPORT", `<p class="gov-modal-pitch">Please log in to export traffic data.</p>
        <button class="gov-modal-login-btn" onclick="Auth?.openLoginModal?.();document.querySelector('.gov-modal-close')?.click()">Login to Download →</button>`);
      return;
    }
    const url = `/api/analytics/export?from=${from.toISOString()}&to=${to.toISOString()}${_camId ? `&camera_id=${_camId}` : ""}`;
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${jwt}` } });
      if (!res.ok) { _showModal("EXPORT", `<p class="gov-modal-pitch">No data available for the selected date range.</p>`); return; }
      const blob    = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement("a"), { href: blobUrl, download: `traffic-${from.toISOString().slice(0,10)}.csv` });
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
    } catch { _showModal("EXPORT", `<p class="gov-modal-pitch">Export failed — please try again.</p>`); }
  }

  // ── Modal system ──────────────────────────────────────────────────────────
  const modal       = el("gov-modal");
  const modalTitle  = el("gov-modal-title");
  const modalBody   = el("gov-modal-body");
  let   _modalChart = null;

  function _showModal(title, bodyHtml) {
    if (!modal) return;
    if (modalTitle) modalTitle.innerHTML = title;
    if (modalBody)  modalBody.innerHTML = bodyHtml;
    modal.classList.remove("hidden");
    // Render chart if canvas#gov-modal-chart exists in bodyHtml.
    // setTimeout 50ms ensures the modal layout fully reflows before Chart.js
    // reads the container dimensions — rAF fires too early on mobile.
    setTimeout(() => {
      const c = el("gov-modal-chart");
      if (c && c.dataset.chartConfig && window.Chart) {
        try {
          if (_modalChart) { _modalChart.destroy(); _modalChart = null; }
          _modalChart = new window.Chart(c, JSON.parse(c.dataset.chartConfig));
        } catch {}
      }
    }, 50);
  }

  function _closeModal() {
    if (!modal) return;
    modal.classList.add("hidden");
    if (_modalChart) { _modalChart.destroy(); _modalChart = null; }
  }

  el("gov-modal-close")?.addEventListener("click", _closeModal);
  el("gov-modal-backdrop")?.addEventListener("click", _closeModal);

  // ── KPI detail modals ─────────────────────────────────────────────────────
  el("gov-panel-live")?.addEventListener("click", (e) => {
    const card = e.target.closest(".gov-kpi-card");
    if (!card) return;
    const type = card.dataset.modal;
    _openKpiModal(type);
  });

  function _openKpiModal(type) {
    _loadChartJs(() => {
      const rows    = _analyticsData?.rows     || [];
      const summary = _analyticsData?.summary  || {};
      const ct      = summary.class_totals     || {};
      const mkLabel = r => _formatPeriodLabel(r.period || r.hour, _govGranularity);
      const granLbl = _govGranularity === "week" ? "Periods" : _govGranularity === "day" ? "Days" : "Hours";

      if (type === "total") {
        const labels = rows.map(mkLabel);
        const data   = rows.map(r => r.total || 0);
        const cfg    = { type:"bar", data:{ labels, datasets:[{ data, backgroundColor:"#0284c7", borderRadius:3, borderWidth:0 }] }, options:{ ...CHART_LIGHT, plugins:{legend:{display:false}} } };
        _showModal("VEHICLES — BREAKDOWN", `
          <div class="gov-modal-kpi-grid">
            <div class="gov-modal-kpi"><div class="gov-modal-kpi-val">${Number(summary.period_total||0).toLocaleString()}</div><div class="gov-modal-kpi-lbl">Total (period)</div></div>
            <div class="gov-modal-kpi"><div class="gov-modal-kpi-val">${summary.peak_value||"—"}</div><div class="gov-modal-kpi-lbl">Peak Count</div></div>
            <div class="gov-modal-kpi"><div class="gov-modal-kpi-val">${rows.length}</div><div class="gov-modal-kpi-lbl">${granLbl} Recorded</div></div>
          </div>
          <div class="gov-modal-chart-wrap"><canvas id="gov-modal-chart" data-chart-config='${JSON.stringify(cfg).replace(/'/g,"&#39;")}'></canvas></div>`);

      } else if (type === "peak") {
        const labels = rows.map(mkLabel);
        const totals = rows.map(r => r.total || 0);
        const maxV   = Math.max(...totals, 1);
        const colors = totals.map(v => v >= maxV * 0.8 ? "#ef4444" : v >= maxV * 0.5 ? "#f59e0b" : "#94a3b8");
        const cfg    = { type:"bar", data:{ labels, datasets:[{ data:totals, backgroundColor:colors, borderRadius:3, borderWidth:0 }] }, options:{ ...CHART_LIGHT, plugins:{legend:{display:false}} } };
        const peakLabel = _formatPeriodLabel(summary.peak_period, summary.granularity || _govGranularity);
        _showModal("PEAK PERIOD ANALYSIS", `
          <div class="gov-modal-kpi-grid">
            <div class="gov-modal-kpi"><div class="gov-modal-kpi-val">${peakLabel}</div><div class="gov-modal-kpi-lbl">Peak Period</div></div>
            <div class="gov-modal-kpi"><div class="gov-modal-kpi-val">${summary.peak_value||"—"}</div><div class="gov-modal-kpi-lbl">Vehicles at Peak</div></div>
            <div class="gov-modal-kpi"><div class="gov-modal-kpi-val">${totals.filter(v => v >= maxV*0.8).length}</div><div class="gov-modal-kpi-lbl">High-Load Periods</div></div>
          </div>
          <div class="gov-modal-chart-wrap"><canvas id="gov-modal-chart" data-chart-config='${JSON.stringify(cfg).replace(/'/g,"&#39;")}'></canvas></div>
          <p class="gov-modal-note">Red bars = high load (&ge;80% of peak). Orange bars = moderate load (&ge;50%).</p>`);

      } else if (type === "flow") {
        const labels  = rows.map(mkLabel);
        const inData  = rows.map(r => r.in  || 0);
        const outData = rows.map(r => r.out || 0);
        const cfg     = { type:"line", data:{ labels, datasets:[
          { label:"Inbound",  data:inData,  borderColor:"#16a34a", backgroundColor:"rgba(22,163,74,0.08)", tension:0.4, pointRadius:0, borderWidth:2 },
          { label:"Outbound", data:outData, borderColor:"#64748b", backgroundColor:"rgba(100,116,139,0.08)", tension:0.4, pointRadius:0, borderWidth:2 },
        ]}, options:{...CHART_LIGHT, plugins:{...CHART_LIGHT.plugins, legend:{display:true, labels:{color:"#64748b",font:{size:9,family:"JetBrains Mono"},boxWidth:10}}}} };
        const totalIn  = inData.reduce((a,b)=>a+b,0);
        const totalOut = outData.reduce((a,b)=>a+b,0);
        _showModal("TRAFFIC FLOW ANALYSIS", `
          <div class="gov-modal-kpi-grid">
            <div class="gov-modal-kpi"><div class="gov-modal-kpi-val" style="color:#16a34a">${totalIn.toLocaleString()}</div><div class="gov-modal-kpi-lbl">Total Inbound</div></div>
            <div class="gov-modal-kpi"><div class="gov-modal-kpi-val" style="color:#64748b">${totalOut.toLocaleString()}</div><div class="gov-modal-kpi-lbl">Total Outbound</div></div>
            <div class="gov-modal-kpi"><div class="gov-modal-kpi-val">${totalIn+totalOut > 0 ? Math.round(totalIn/(totalIn+totalOut)*100) : "—"}%</div><div class="gov-modal-kpi-lbl">Inbound Ratio</div></div>
          </div>
          <div class="gov-modal-chart-wrap"><canvas id="gov-modal-chart" data-chart-config='${JSON.stringify(cfg).replace(/'/g,"&#39;")}'></canvas></div>`);
      }
    });
  }

  // ── Class row clicks ──────────────────────────────────────────────────────
  el("gov-cls-rows") || document.querySelector(".gov-cls-rows");
  overlay.addEventListener("click", (e) => {
    const row = e.target.closest(".gov-cls-row");
    if (!row) return;
    const cls = row.dataset.modal?.replace("class-","");
    if (!cls) return;
    _loadChartJs(() => _openClassModal(cls));
  });

  function _openClassModal(cls) {
    const rows   = _analyticsData?.rows    || [];
    const summary = _analyticsData?.summary || {};
    const ct     = summary.class_totals     || {};
    const color  = CLS_COLOR[cls] || "#29B6F6";
    const icon   = CLS_SVG[cls]  || CLS_SVG.car;
    const labels = rows.map(r => _formatPeriodLabel(r.period || r.hour, _govGranularity));
    const data   = rows.map(r => r[cls] || 0);
    const total  = ct[cls] || data.reduce((a,b)=>a+b,0);
    const grandT = summary.period_total || 1;
    const pct    = Math.round((total / grandT) * 100);
    const cfg    = { type:"line", data:{ labels, datasets:[{ label:cls, data, borderColor:color, backgroundColor:`${color}22`, tension:0.4, pointRadius:0, borderWidth:2 }] }, options:{ ...CHART_LIGHT, plugins:{legend:{display:false}} } };
    _showModal(`${icon} ${cls.toUpperCase()} — TREND DETAIL`, `
      <div class="gov-modal-kpi-grid">
        <div class="gov-modal-kpi"><div class="gov-modal-kpi-val" style="color:${color}">${total.toLocaleString()}</div><div class="gov-modal-kpi-lbl">Total (period)</div></div>
        <div class="gov-modal-kpi"><div class="gov-modal-kpi-val">${pct}%</div><div class="gov-modal-kpi-lbl">Share of Traffic</div></div>
        <div class="gov-modal-kpi"><div class="gov-modal-kpi-val">${data.length > 0 ? Math.round(total/Math.max(data.length,1)) : "—"}</div><div class="gov-modal-kpi-lbl">Avg / Hour</div></div>
      </div>
      <div class="gov-modal-chart-wrap"><canvas id="gov-modal-chart" data-chart-config='${JSON.stringify(cfg).replace(/'/g,"&#39;")}'></canvas></div>`);
  }

  // ── Crossing row clicks ───────────────────────────────────────────────────
  el("gov-crossings-body")?.addEventListener("click", (e) => {
    const row = e.target.closest("tr[data-crossing]");
    if (!row) return;
    try {
      const d = JSON.parse(row.dataset.crossing.replace(/&apos;/g,"'"));
      const cls = d.cls || "car";
      const color = CLS_COLOR[cls] || "#29B6F6";
      const icon  = CLS_SVG[cls]  || CLS_SVG.car;
      _showModal(`${icon} CROSSING DETAIL`, `
        <div class="gov-modal-data-rows">
          <div class="gov-modal-data-row"><span class="gov-modal-data-key">Time</span><span class="gov-modal-data-val">${d.time}</span></div>
          <div class="gov-modal-data-row"><span class="gov-modal-data-key">Class</span><span class="gov-modal-data-val" style="color:${color}">${icon} ${cls.toUpperCase()}</span></div>
          <div class="gov-modal-data-row"><span class="gov-modal-data-key">Direction</span><span class="gov-modal-data-val">${d.dir}</span></div>
          <div class="gov-modal-data-row"><span class="gov-modal-data-key">Confidence</span><span class="gov-modal-data-val">${d.conf}</span></div>
          <div class="gov-modal-data-row"><span class="gov-modal-data-key">Scene</span><span class="gov-modal-data-val">${d.scene}</span></div>
          <div class="gov-modal-data-row"><span class="gov-modal-data-key">Dwell Frames</span><span class="gov-modal-data-val">${d.dwell}</span></div>
        </div>`);
    } catch {}
  });

  // ── Agency data package modals ────────────────────────────────────────────
  overlay.addEventListener("click", (e) => {
    const btn = e.target.closest(".gov-agency-btn[data-modal]");
    if (!btn) return;
    _openAgencyModal(btn.dataset.modal.replace("agency-",""));
  });

  const AGENCY_DATA = {
    nwa: {
      abbr:"NWA", name:"National Works Agency", color:"#29B6F6", avail:"Available Now",
      logo:"/img/agencies/nwa.png",
      problem:"Which roads are taking the heaviest commercial load?",
      desc:"Per-crossing log of every truck, bus, car, and motorcycle detected at this junction — with timestamp, direction (inbound/outbound), YOLO confidence score, and AI-assessed scene conditions (day/night/rain). Aggregated hourly totals included for trend analysis.",
      fields:["captured_at","vehicle_class","direction","confidence","scene_lighting","scene_weather","dwell_frames"],
      formats:"CSV export · REST API · Hourly aggregates",
    },
    taj: {
      abbr:"TAJ", name:"Tax Administration Jamaica", color:"#FF7043", avail:"Available Now",
      logo:"/img/agencies/taj.png",
      problem:"Are the trucks on the road matching what's declared at customs?",
      desc:"Timestamped commercial vehicle log — every truck and bus that crossed the detection line, with direction and confidence. Hourly summaries show commercial vs. passenger vehicle ratios, enabling cross-reference against declared freight and licensing data.",
      fields:["captured_at","vehicle_class","direction","confidence","track_id","scene_lighting"],
      formats:"CSV export · Hourly aggregates · REST API",
    },
    jutc: {
      abbr:"JUTC", name:"Jamaica Urban Transit Co.", color:"#AB47BC", avail:"Available Now",
      logo:"/img/agencies/jutc.png",
      problem:"Is bus frequency actually matching commuter demand?",
      desc:"Bus detection log with timestamp and direction. Combined with total vehicle counts at the same junction, this shows the actual bus-to-car ratio at any hour — enabling real headway analysis against published schedules and commuter demand windows.",
      fields:["captured_at","vehicle_class","direction","confidence","dwell_frames","scene_lighting"],
      formats:"CSV export · REST API · Hourly feed",
    },
    tourism: {
      abbr:"JTB", name:"Jamaica Tourism Board", color:"#FFD600", avail:"Available Now",
      logo:"/img/agencies/jtb.png",
      problem:"Which tourist corridors are congested, and when?",
      desc:"Full vehicle count log at monitored corridor junctions. Includes bus frequency data, total volume by hour, and scene conditions. Identifies peak congestion windows and tour bus movement patterns — ready for corridor planning and visitor mobility reports.",
      fields:["captured_at","vehicle_class","direction","confidence","scene_lighting","scene_weather"],
      formats:"CSV export · Dashboard API · Periodic briefing",
    },
    insurance: {
      abbr:"FSC", name:"Financial Services Commission", color:"#66BB6A", avail:"Available Now",
      logo:"/img/agencies/ins.png",
      problem:"Where and when do high-risk traffic conditions occur?",
      desc:"Heavy vehicle proportion log — trucks and buses by hour, with total volume context. Enables corridor risk scoring based on actual vehicle mix and density. Scene conditions (weather, lighting) included for environmental risk factors. Exportable for actuarial model input.",
      fields:["captured_at","vehicle_class","direction","confidence","scene_lighting","scene_weather","dwell_frames"],
      formats:"CSV export · Risk score API · Corridor reports",
    },
    ooh: {
      abbr:"OOH", name:"Out-of-Home Advertising", color:"#22C55E", avail:"Available Now",
      logo:null,
      problem:"How many vehicles actually passed your billboard today?",
      desc:"AI-verified vehicle pass count at this camera location — every crossing logged with timestamp, vehicle class, and direction. Total daily impressions are the actual number of vehicles that passed the line, broken down by car, truck, bus, and motorcycle. Auditable and exportable.",
      fields:["captured_at","vehicle_class","direction","confidence","scene_lighting","track_id"],
      formats:"Daily impression report · CSV export · API",
    },
  };

  // ── Agency modal backdrop (separate from KPI modal) ─────────────────────
  const agBackdrop = el("gov-agency-modal-backdrop");
  const agModal    = el("gov-agency-modal");
  const agContent  = el("gov-agency-modal-content");
  const agClose    = el("gov-agency-modal-close");

  function _openAgencyModal(agency) {
    const d = AGENCY_DATA[agency];
    if (!d || !agBackdrop || !agContent) return;

    // ── Derive metrics from analytics data ─────────────────────────────────
    const summary    = _analyticsData?.summary || {};
    const rows       = _analyticsData?.rows    || [];

    // ── Compute display period ──────────────────────────────────────────────
    const _fmtD = (iso) => {
      if (!iso) return null;
      const d = new Date(iso.includes("T") ? iso : iso + "T12:00:00");
      return isNaN(d) ? null : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    };
    const periodFrom = _govFrom
      ? _fmtD(_govFrom)
      : _fmtD(summary.first_date || new Date().toISOString().slice(0, 10));
    const periodTo   = _govTo
      ? _fmtD(_govTo.slice(0, 10))
      : _fmtD(new Date().toISOString().slice(0, 10));
    const periodLabel = (periodFrom && periodTo && periodFrom !== periodTo)
      ? `${periodFrom} — ${periodTo}`
      : (periodFrom || "Today");
    const _dcEst    = rows.length > 0 ? Math.max(1, Math.round(rows.length / 24)) : 1;
    const dataScope = rows.length > 0
      ? `${rows.length} hourly buckets · ${_dcEst} day${_dcEst !== 1 ? "s" : ""}`
      : "No data loaded";
    const ct         = summary.class_totals || {};
    const cp         = summary.class_pct    || {};
    const total      = summary.period_total || 0;
    const truckCount = ct.truck || 0;
    const busCount   = ct.bus   || 0;
    const carCount   = ct.car   || 0;
    const heavy      = truckCount + busCount;
    const heavyPct   = total > 0 ? Math.round((heavy / total) * 100) : 0;
    const carPct     = Math.round(cp.car   || 0);
    const busPct     = Math.round(cp.bus   || 0);
    const truckPct   = Math.round(cp.truck || 0);
    const commPct    = total > 0 ? Math.round(((truckCount + busCount) / total) * 100) : 0;

    // Days of data & daily averages
    const dayCount   = rows.length > 0 ? Math.max(1, Math.round(rows.length / 24)) : 1;
    const dailyAvg   = dayCount > 0 ? Math.round(total / dayCount) : 0;
    const avgBusPerHour = rows.length > 0
      ? (busCount / rows.length).toFixed(1)
      : "—";
    const dailyCommercial = Math.round((truckCount + busCount) / dayCount);

    // Top 3 peak hours
    const sortedRows = [...rows].sort((a, b) => (b.total || 0) - (a.total || 0));
    const top3       = sortedRows.slice(0, 3);
    const peakVal    = summary.peak_value || top3[0]?.total || 0;
    const peakHour   = (() => {
      if (summary.peak_period) {
        const t = summary.peak_period;
        const m = t.match(/T(\d{2}:\d{2})/);
        return m ? m[1] : t.slice(0, 5);
      }
      const p = top3[0]?.period || top3[0]?.hour || "";
      const m = p.match(/T(\d{2}:\d{2})/);
      return m ? m[1] : (p || "—");
    })();

    // Risk score for FSC (0–10 based on vehicle class mix)
    const riskScore  = Math.min(10, ((heavyPct * 0.12) + (truckPct * 0.08) + 1)).toFixed(1);

    // ── Per-agency KPI + insight config ────────────────────────────────────
    const agCfg = {
      nwa: {
        kpis: [
          { label: "Total Crossings",  val: total.toLocaleString(),  note: "All vehicle classes" },
          { label: "Heavy Vehicles",   val: heavy.toLocaleString(),  note: `${heavyPct}% of all traffic` },
          { label: "Peak Hour",        val: peakHour,                note: `${peakVal.toLocaleString()} vehicles` },
        ],
        insights: [
          `${heavyPct}% of all crossings are trucks or buses — direct input for pavement stress models.`,
          `${truckCount.toLocaleString()} truck crossings detected — cross-reference with road maintenance schedules.`,
          `Peak load at ${peakHour} with ${peakVal.toLocaleString()} vehicles — highest wear window for infrastructure planning.`,
        ],
      },
      taj: {
        kpis: [
          { label: "Trucks Detected",   val: truckCount.toLocaleString(), note: `${truckPct}% of traffic` },
          { label: "Commercial Ratio",  val: `${commPct}%`,               note: "Trucks + Buses / Total" },
          { label: "Daily Commercial",  val: dailyCommercial.toLocaleString(), note: `Avg per day over ${dayCount}d` },
        ],
        insights: [
          `${commPct}% commercial traffic rate — cross-reference against cargo declaration records.`,
          `${truckCount.toLocaleString()} trucks logged over ${dayCount} day${dayCount !== 1 ? "s" : ""} — ~${Math.round(truckCount / dayCount)} per day.`,
          `Buses: ${busCount.toLocaleString()} (${busPct}%) — included for freight route displacement analysis.`,
        ],
      },
      jutc: {
        kpis: [
          { label: "Buses Detected",  val: busCount.toLocaleString(), note: `${busPct}% of traffic` },
          { label: "Avg Buses / Hr",  val: avgBusPerHour,             note: `Over ${rows.length} hour buckets` },
          { label: "Daily Bus Count", val: Math.round(busCount / dayCount).toLocaleString(), note: `Avg per day` },
        ],
        insights: [
          `${busCount.toLocaleString()} bus detections over ${dayCount} day${dayCount !== 1 ? "s" : ""} — avg ${Math.round(busCount / dayCount)} per day.`,
          `Average of ${avgBusPerHour} buses per hour at this junction — compare against scheduled headways.`,
          `${busPct}% bus share of total traffic — use for demand-supply gap analysis.`,
        ],
      },
      tourism: {
        kpis: [
          { label: "Total Volume",    val: total.toLocaleString(),     note: "All vehicle classes" },
          { label: "Passenger Cars",  val: carCount.toLocaleString(),  note: `${carPct}% of traffic` },
          { label: "Daily Average",   val: dailyAvg.toLocaleString(),  note: `Over ${dayCount} days` },
        ],
        insights: [
          `Peak congestion at ${peakHour} — ${peakVal.toLocaleString()} vehicles in a single hour.`,
          `${carPct}% passenger car ratio — primary indicator of corridor demand from private travellers.`,
          `Daily volume: ${dailyAvg.toLocaleString()} vehicles avg — use for corridor capacity and tour planning.`,
        ],
      },
      insurance: {
        kpis: [
          { label: "Heavy Vehicle %", val: `${heavyPct}%`,         note: "Trucks + Buses" },
          { label: "Risk Score",      val: `${riskScore} / 10`,    note: "Vehicle mix & density" },
          { label: "Peak Exposure",   val: peakHour,               note: `${peakVal.toLocaleString()} vehicles` },
        ],
        insights: [
          `${heavyPct}% heavy vehicle proportion — elevated corridor risk profile for actuarial modelling.`,
          `${truckCount.toLocaleString()} truck crossings recorded — key exposure factor for cargo and freight policies.`,
          `Risk score ${riskScore}/10 derived from class density and peak load — exportable for model input.`,
        ],
      },
      ooh: {
        kpis: [
          { label: "Total Impressions", val: total.toLocaleString(),    note: "AI-verified crossings" },
          { label: "Daily Average",     val: dailyAvg.toLocaleString(), note: `Over ${dayCount} days` },
          { label: "Peak Hour",         val: peakHour,                  note: `${peakVal.toLocaleString()} vehicles` },
        ],
        insights: [
          `${total.toLocaleString()} AI-verified vehicle crossings — your auditable billboard impression count.`,
          `${dailyAvg.toLocaleString()} average daily impressions — higher than self-reported estimates by definition.`,
          `Best advertising window: ${peakHour} with ${peakVal.toLocaleString()} vehicles passing per hour.`,
        ],
      },
    };

    const cfg      = agCfg[agency] || agCfg.ooh;
    const isLive   = d.avail === "Available Now";
    const badgeCls = isLive ? "gov-modal-badge--live" : "gov-modal-badge--dev";
    const badgeTxt = isLive ? "◈ Available Now" : "⊙ In Development";

    // KPI boxes HTML
    const kpiHtml = cfg.kpis.map(k => `
      <div class="gov-ag-kpi">
        <div class="gov-ag-kpi-val" style="color:${d.color}">${k.val}</div>
        <div class="gov-ag-kpi-label">${k.label}</div>
        <div class="gov-ag-kpi-note">${k.note}</div>
      </div>`).join("");

    // Insight bullets HTML
    const insightHtml = cfg.insights.map(i => `
      <div class="gov-ag-insight">
        <span class="gov-ag-insight-dot" style="background:${d.color}"></span>
        <span>${i}</span>
      </div>`).join("");

    // Top 3 peak hours mini-table
    const top3Html = top3.length > 0 ? `
      <div class="gov-modal-section-head">TOP TRAFFIC HOURS</div>
      <div class="gov-ag-hours">
        ${top3.map((r, i) => {
          const raw  = r.period || r.hour || "";
          const m    = raw.match(/T(\d{2}:\d{2})/);
          const hr   = m ? m[1] : (raw || "—");
          const pct  = peakVal > 0 ? Math.round(((r.total || 0) / peakVal) * 100) : 0;
          return `<div class="gov-ag-hour-row">
            <span class="gov-ag-hour-rank">#${i + 1}</span>
            <span class="gov-ag-hour-time">${hr}</span>
            <span class="gov-ag-hour-bar-wrap"><span class="gov-ag-hour-bar" style="width:${pct}%;background:${d.color}"></span></span>
            <span class="gov-ag-hour-val">${(r.total || 0).toLocaleString()}</span>
          </div>`;
        }).join("")}
      </div>` : "";

    // Logo (no dark-theme inversion — white bg)
    const logoHtml = d.logo
      ? `<img src="${d.logo}" alt="${d.abbr}" style="height:28px;object-fit:contain;opacity:0.85;margin-bottom:4px">`
      : `<div style="font-family:'Rajdhani','Archivo',sans-serif;font-size:26px;font-weight:900;color:${d.color};letter-spacing:-1px;line-height:1">${d.abbr}</div>`;

    const fields = d.fields.map(f => `<span class="gov-modal-field">${f}</span>`).join("");

    // ── Render ──────────────────────────────────────────────────────────────
    agContent.innerHTML = `
      <div class="gov-ag-header" style="border-top:3px solid ${d.color}; border-radius: 12px 12px 0 0">
        <div>${logoHtml}</div>
        <div class="gov-ag-header-meta">
          <div class="gov-modal-badge ${badgeCls}">${badgeTxt}</div>
          <div class="gov-modal-title">${d.abbr} — Data Package</div>
          <div class="gov-modal-sub" style="font-style:italic">"${d.problem}"</div>
          <div class="gov-ag-period-stamp">
            <span class="gov-ag-period-icon">📅</span>
            <span class="gov-ag-period-range">${periodLabel}</span>
            <span class="gov-ag-period-scope">${dataScope}</span>
          </div>
        </div>
      </div>
      <div class="gov-ag-body">
        <div class="gov-modal-section-head">METRICS FOR SELECTED PERIOD</div>
        <div class="gov-ag-kpi-row">${kpiHtml}</div>

        <div class="gov-modal-section-head">KEY INSIGHTS</div>
        <div class="gov-ag-insights">${insightHtml}</div>

        ${top3Html}

        <div class="gov-modal-section-head">WHAT THIS DATA CONTAINS</div>
        <div class="gov-modal-desc">${d.desc}</div>

        <div class="gov-modal-section-head">DATA FIELDS</div>
        <div class="gov-modal-fields">${fields}</div>
        <div style="font-family:'Inter',sans-serif;font-size:10px;color:#9ca3af;margin-top:6px">Formats: ${d.formats}</div>

        <button class="gov-modal-dl-btn" id="ag-dl-btn" data-agency="${agency}">↓ Download CSV Data Package</button>
        <div class="gov-modal-dl-success" id="ag-dl-success">✓ Download started — logged to your account</div>
        <div class="gov-modal-note">Account required. Download is logged for audit. Data covers all available historical records.</div>
      </div>
    `;
    agBackdrop.classList.remove("hidden");

    const dlBtn = el("ag-dl-btn");
    if (dlBtn) dlBtn.addEventListener("click", () => _downloadAgencyPackage(agency, dlBtn));
  }

  async function _downloadAgencyPackage(agency, btn) {
    const _setBtnState = (state, text) => {
      if (!btn) return;
      btn.disabled   = state !== "idle";
      btn.className  = `gov-modal-dl-btn gov-modal-dl-btn--${state}`;
      btn.innerHTML  = text;
    };

    const _showError = (msg) => {
      _setBtnState("error", `✕ ${msg}`);
      setTimeout(() => _setBtnState("idle", "↓ Download CSV Data Package"), 4000);
    };

    _setBtnState("loading", '<span class="gov-dl-spinner"></span> Verifying account…');

    try {
      const { data: { session } } = await sb.auth.getSession();

      if (!session) {
        // Replace button area with a visible login prompt (white modal safe colors)
        const loginDiv = document.createElement("div");
        loginDiv.className = "gov-agency-login-prompt";
        loginDiv.innerHTML = `
          <div style="font-family:'Inter',sans-serif;font-size:12px;color:#64748b;margin-bottom:12px;text-align:center">
            You need to be signed in to download this data package.
          </div>
          <button class="gov-modal-login-btn" onclick="Auth?.openLoginModal?.();document.getElementById('gov-agency-modal-backdrop')?.classList.add('hidden')">
            Sign in to Download →
          </button>`;
        if (btn) btn.replaceWith(loginDiv);
        return;
      }

      // ── Build download URL ────────────────────────────────────────────────
      const today    = new Date().toISOString().split("T")[0];
      const fromDate = _govFrom
        ? _govFrom.slice(0, 10)
        : (_analyticsData?.summary?.first_date || "2026-01-01");
      const toDate   = _govTo ? _govTo.slice(0, 10) : today;
      const filename = `whitelinez-${agency}-${fromDate}_${toDate}.csv`;
      const url      = `/api/analytics/export?camera_id=${_camId || ""}&from=${fromDate}&to=${toDate}`;

      _setBtnState("loading", '<span class="gov-dl-spinner"></span> Preparing data…');

      const resp = await fetch(url, { headers: { Authorization: `Bearer ${session.access_token}` } });
      if (resp.status === 204) return _showError("No data in selected range");
      if (resp.status === 400) {
        const msg = (await resp.json().catch(() => ({}))).error || "Invalid request";
        return _showError(msg);
      }
      if (!resp.ok) {
        const errText = await resp.text().catch(() => resp.status);
        console.error("[agency-dl] export API error:", errText);
        return _showError(`Server error (${resp.status}) — try again`);
      }

      // ── Trigger browser download ──────────────────────────────────────────
      const blob = await resp.blob();
      if (blob.size === 0) return _showError("No data in selected range");

      const a  = document.createElement("a");
      a.href   = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);

      // ── Success state ─────────────────────────────────────────────────────
      _setBtnState("success", "✓ Download complete");

      const successEl = el("ag-dl-success");
      if (successEl) {
        successEl.innerHTML = `
          ✓ <strong>${filename}</strong> downloaded
          <span style="color:#86efac;margin-left:4px">(${(blob.size / 1024).toFixed(0)} KB)</span>`;
        successEl.classList.add("visible");
      }

      // ── Audit log (fire-and-forget, failure is silent) ────────────────────
      sb.from("agency_downloads").insert({
        user_id: session.user.id, user_email: session.user.email,
        agency, from_date: fromDate, to_date: toDate, file_size_bytes: blob.size,
      }).then(() => {}).catch(() => {});

    } catch (err) {
      console.error("[agency-dl]", err);
      _showError("Download failed — check connection");
    }
  }

  if (agClose) agClose.addEventListener("click", () => agBackdrop.classList.add("hidden"));
  if (agBackdrop) agBackdrop.addEventListener("click", (e) => {
    if (e.target === agBackdrop) agBackdrop.classList.add("hidden");
  });

}());
