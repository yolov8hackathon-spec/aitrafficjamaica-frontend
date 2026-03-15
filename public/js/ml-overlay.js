/**
 * ml-overlay.js - Live vision status overlay for the public stream.
 * Uses count:update payloads + scene inference for user-friendly status text.
 */

const MlOverlay = (() => {
  const state = {
    startedAt: Date.now(),
    frames: 0,
    detections: 0,
    confSum: 0,
    confCount: 0,
    modelLoop: "unknown",
    seededFromTelemetry: false,
    runtimeProfile: "",
    runtimeReason: "",
    lastCaptureTsMs: null,
    sceneLighting: "unknown",
    sceneWeather: "unknown",
    sceneConfidence: 0,
    liveObjectsNow: 0,
    detRatePerMin: 0,
    crossingRatePerMin: 0,
    lastTickMs: null,
    lastCrossingTotal: null,
    // Sliding-window crossing events for stable rate calculation
    // Each entry: { ms: timestamp, count: new_crossings }
    _crossingWindow: [],
  };

  let _bound = false;
  let _pollTimer = null;
  let _titleTimer = null;
  let _titleIndex = 0;

  function init() {
    if (_bound) return;
    _bound = true;
    state.startedAt = Date.now();

    window.addEventListener("count:update", (e) => updateFromCount(e.detail || {}));
    seedFromTelemetry();
    pollHealth();
    _pollTimer = setInterval(pollHealth, 20000);
    render();
  }

  async function seedFromTelemetry() {
    if (state.seededFromTelemetry) return;
    if (!window.sb?.from) return;
    try {
      const since = new Date(Date.now() - 30 * 60_000).toISOString();
      const { data } = await window.sb
        .from("ml_detection_events")
        .select("avg_confidence,detections_count")
        .gte("captured_at", since)
        .order("captured_at", { ascending: false })
        .limit(120);
      const rows = Array.isArray(data) ? data : [];
      if (!rows.length) return;

      let detCount = 0;
      let confWeighted = 0;
      for (const row of rows) {
        const d = Number(row?.detections_count || 0);
        const c = Number(row?.avg_confidence);
        if (Number.isFinite(d) && d > 0 && Number.isFinite(c) && c >= 0 && c <= 1) {
          detCount += d;
          confWeighted += c * d;
        }
      }
      if (detCount > 0) {
        state.confSum += confWeighted;
        state.confCount += detCount;
        state.detections += detCount;
      }
      state.frames += rows.length;
      state.seededFromTelemetry = true;
      render();
    } catch {
      // Keep live-only mode if telemetry query fails.
    }
  }

  function updateFromCount(data) {
    const nowMs = Date.now();
    const dtMin = state.lastTickMs ? Math.max(1 / 1200, (nowMs - state.lastTickMs) / 60000) : null;
    state.lastTickMs = nowMs;

    state.frames += 1;
    const dets = Array.isArray(data?.detections) ? data.detections : [];
    // Only count detections from live frames — bootstrap + stale frames carry dets:[]
    // and would falsely collapse the EWMA. Use new_crossings as the rate signal when
    // the frame is a real WS tick (not bootstrap, not stale-stripped).
    const isLiveTick = !data?.bootstrap && dtMin != null;
    if (isLiveTick) {
      const newCrossings = Math.max(0, Number(data?.new_crossings ?? 0));
      state.detections += newCrossings;
      // detRatePerMin is computed in the sliding-window block below
    }
    // liveObjectsNow uses bounding-box count when fresh, otherwise holds its value
    if (dets.length > 0) {
      state.liveObjectsNow = Math.max(0, Math.round((state.liveObjectsNow * 0.45) + (dets.length * 0.55)));
    }

    for (const d of dets) {
      const conf = Number(d?.conf);
      if (Number.isFinite(conf) && conf >= 0 && conf <= 1) {
        state.confSum += conf;
        state.confCount += 1;
      }
    }

    const profile = String(data?.runtime_profile || "").trim();
    const reason = String(data?.runtime_profile_reason || "").trim();
    if (profile) state.runtimeProfile = profile;
    if (reason) state.runtimeReason = reason;
    const sceneLighting = String(data?.scene_lighting || "").trim();
    const sceneWeather = String(data?.scene_weather || "").trim();
    const sceneConfidence = Number(data?.scene_confidence);
    if (sceneLighting) state.sceneLighting = sceneLighting;
    if (sceneWeather) state.sceneWeather = sceneWeather;
    if (Number.isFinite(sceneConfidence)) {
      state.sceneConfidence = Math.max(0, Math.min(1, sceneConfidence));
    }

    // new_crossings = per-frame vehicle crossing count from backend.
    // Use a 60-second sliding window so the rate stays non-zero between events
    // rather than collapsing to 0 with a per-frame EWMA.
    if (!data?.bootstrap && dtMin != null) {
      const nowMs = Date.now();
      const newCrossings = Math.max(0, Number(data?.new_crossings ?? 0));
      if (newCrossings > 0) {
        state._crossingWindow.push({ ms: nowMs, count: newCrossings });
      }
      // Evict events older than 60s
      const cutoffMs = nowMs - 60000;
      while (state._crossingWindow.length && state._crossingWindow[0].ms < cutoffMs) {
        state._crossingWindow.shift();
      }
      // Rate = crossings in last 60s / 1 min
      const windowTotal = state._crossingWindow.reduce((s, e) => s + e.count, 0);
      const windowSec = state._crossingWindow.length > 0
        ? Math.max(1, (nowMs - state._crossingWindow[0].ms) / 1000)
        : 60;
      state.crossingRatePerMin = (windowTotal / windowSec) * 60;
      state.detRatePerMin = state.crossingRatePerMin;
    }

    const ts = Date.parse(String(data?.captured_at || ""));
    if (Number.isFinite(ts)) {
      state.lastCaptureTsMs = ts;
    }

    render();
  }

  async function pollHealth() {
    try {
      const res = await fetch("/api/health");
      if (!res.ok) return;
      const payload = await res.json();
      state.modelLoop = payload?.ml_retrain_task_running ? "active" : "idle";
      const latest = payload?.latest_ml_detection || null;
      const wx = payload?.weather_api?.latest || null;
      const conf = Number(latest?.avg_confidence);
      if (Number.isFinite(conf) && conf >= 0 && conf <= 1 && state.confCount === 0) {
        // Seed confidence immediately after deploy/reload even before first WS frame.
        state.confSum = conf;
        state.confCount = 1;
      }
      const latestTs = Date.parse(String(latest?.captured_at || ""));
      if (Number.isFinite(latestTs)) {
        state.lastCaptureTsMs = Math.max(state.lastCaptureTsMs || 0, latestTs);
      }

      // Fallback to weather API when WS scene fields are missing/unknown.
      if (wx && typeof wx === "object") {
        const light = String(wx.lighting || "").trim();
        const weather = String(wx.weather || "").trim();
        const sceneConf = Number(wx.confidence);
        const currLight = mapSceneValue(state.sceneLighting, "scanning");
        const currWeather = mapSceneValue(state.sceneWeather, "scanning");
        if ((currLight === "scanning" || currLight === "unknown") && light) state.sceneLighting = light;
        if ((currWeather === "scanning" || currWeather === "unknown") && weather) state.sceneWeather = weather;
        if (Number.isFinite(sceneConf) && sceneConf >= 0 && sceneConf <= 1 && (!Number.isFinite(state.sceneConfidence) || state.sceneConfidence <= 0)) {
          state.sceneConfidence = sceneConf;
        }
      }
      render();
    } catch {
      // Keep existing state.
    }
  }

  function getAvgConf() {
    if (!state.confCount) return null;
    return state.confSum / state.confCount;
  }

  function getLevel() {
    const elapsedMin = Math.max(1, (Date.now() - state.startedAt) / 60000);
    const frameRate = state.frames / elapsedMin;
    const detRate = state.detections / elapsedMin;
    const avgConf = getAvgConf();

    let score = 0;
    score += Math.min(50, (state.frames / 500) * 50);
    score += Math.min(30, (detRate / 40) * 30);
    if (avgConf != null) score += Math.min(20, (avgConf / 0.6) * 20);

    if (score >= 80) return { label: "Stabilizing", msg: "Detection quality is improving as more traffic is observed." };
    if (score >= 55) return { label: "Adapting", msg: "The model is adapting to this camera and roadway pattern." };
    if (score >= 30) return { label: "Learning", msg: "Vehicle detection gets better over time with more samples." };
    return { label: "Warming up", msg: "Early learning stage. Confidence will increase as data accumulates." };
  }

  function mapSceneValue(value, fallback) {
    const v = String(value || "").trim().toLowerCase();
    if (!v || v === "unknown" || v === "none" || v === "null" || v === "scanning") return fallback;
    return v.replaceAll("_", " ");
  }

  function sceneTitle(s) {
    const v = String(s || "").trim();
    return v ? (v.charAt(0).toUpperCase() + v.slice(1)) : "Scanning";
  }

  // Phosphor Icons SVG path data (viewBox 0 0 256 256) — sourced from svgrepo.com
  const WX_ICON_PATHS = {
    clear:   "M120,40V16a8,8,0,0,1,16,0V40a8,8,0,0,1-16,0Zm72,88a64,64,0,1,1-64-64A64.07,64.07,0,0,1,192,128Zm-16,0a48,48,0,1,0-48,48A48.05,48.05,0,0,0,176,128ZM58.34,69.66A8,8,0,0,0,69.66,58.34l-16-16A8,8,0,0,0,42.34,53.66Zm0,116.68-16,16a8,8,0,0,0,11.32,11.32l16-16a8,8,0,0,0-11.32-11.32ZM192,72a8,8,0,0,0,5.66-2.34l16-16a8,8,0,0,0-11.32-11.32l-16,16A8,8,0,0,0,192,72Zm5.66,114.34a8,8,0,0,0-11.32,11.32l16,16a8,8,0,0,0,11.32-11.32ZM48,128a8,8,0,0,0-8-8H16a8,8,0,0,0,0,16H40A8,8,0,0,0,48,128Zm80,80a8,8,0,0,0-8,8v24a8,8,0,0,0,16,0V216A8,8,0,0,0,128,208Zm112-88H216a8,8,0,0,0,0,16h24a8,8,0,0,0,0-16Z",
    overcast:"M160,40A88.09,88.09,0,0,0,81.29,88.67,64,64,0,1,0,72,216h88a88,88,0,0,0,0-176Zm0,160H72a48,48,0,0,1,0-96c1.1,0,2.2,0,3.29.11A88,88,0,0,0,72,128a8,8,0,0,0,16,0,72,72,0,1,1,72,72Z",
    rain:    "M158.66,196.44l-32,48a8,8,0,1,1-13.32-8.88l32-48a8,8,0,0,1,13.32,8.88ZM232,92a76.08,76.08,0,0,1-76,76H132.28l-29.62,44.44a8,8,0,1,1-13.32-8.88L113.05,168H76A52,52,0,0,1,76,64a53.26,53.26,0,0,1,8.92.76A76.08,76.08,0,0,1,232,92Zm-16,0A60.06,60.06,0,0,0,96,88.46a8,8,0,0,1-16-.92q.21-3.66.77-7.23A38.11,38.11,0,0,0,76,80a36,36,0,0,0,0,72h80A60.07,60.07,0,0,0,216,92Z",
    fog:     "M120,208H72a8,8,0,0,1,0-16h48a8,8,0,0,1,0,16Zm64-16H160a8,8,0,0,0,0,16h24a8,8,0,0,0,0-16Zm-24,32H104a8,8,0,0,0,0,16h56a8,8,0,0,0,0-16Zm72-124a76.08,76.08,0,0,1-76,76H76A52,52,0,0,1,76,72a53.26,53.26,0,0,1,8.92.76A76.08,76.08,0,0,1,232,100Zm-16,0A60.06,60.06,0,0,0,96,96.46a8,8,0,0,1-16-.92q.21-3.66.77-7.23A38.11,38.11,0,0,0,76,88a36,36,0,0,0,0,72h80A60.07,60.07,0,0,0,216,100Z",
    moon:    "M233.54,142.23a8,8,0,0,0-8-2,88.08,88.08,0,0,1-109.8-109.8,8,8,0,0,0-10-10,104.84,104.84,0,0,0-52.91,37A104,104,0,0,0,136,224a103.09,103.09,0,0,0,62.52-20.88,104.84,104.84,0,0,0,37-52.91A8,8,0,0,0,233.54,142.23ZM188.9,190.34A88,88,0,0,1,65.66,67.11a89,89,0,0,1,31.4-26A106,106,0,0,0,96,56,104.11,104.11,0,0,0,200,160a106,106,0,0,0,14.92-1.06A89,89,0,0,1,188.9,190.34Z",
    glare:   "M120,40V32a8,8,0,0,1,16,0v8a8,8,0,0,1-16,0Zm72,88a64,64,0,1,1-64-64A64.07,64.07,0,0,1,192,128Zm-16,0a48,48,0,1,0-48,48A48.05,48.05,0,0,0,176,128ZM58.34,69.66A8,8,0,0,0,69.66,58.34l-8-8A8,8,0,0,0,50.34,61.66Zm0,116.68-8,8a8,8,0,0,0,11.32,11.32l8-8a8,8,0,0,0-11.32-11.32ZM192,72a8,8,0,0,0,5.66-2.34l8-8a8,8,0,0,0-11.32-11.32l-8,8A8,8,0,0,0,192,72Zm5.66,114.34a8,8,0,0,0-11.32,11.32l8,8a8,8,0,0,0,11.32-11.32ZM40,120H32a8,8,0,0,0,0,16h8a8,8,0,0,0,0-16Zm88,88a8,8,0,0,0-8,8v8a8,8,0,0,0,16,0v-8A8,8,0,0,0,128,208Zm96-88h-8a8,8,0,0,0,0,16h8a8,8,0,0,0,0-16Z",
    default: "M164,72a76.2,76.2,0,0,0-20.26,2.73,55.63,55.63,0,0,0-9.41-11.54l9.51-13.57a8,8,0,1,0-13.11-9.18L121.22,54A55.9,55.9,0,0,0,96,48c-.58,0-1.16,0-1.74,0L91.37,31.71a8,8,0,1,0-15.75,2.77L78.5,50.82A56.1,56.1,0,0,0,55.23,65.67L41.61,56.14a8,8,0,1,0-9.17,13.11L46,78.77A55.55,55.55,0,0,0,40,104c0,.57,0,1.15,0,1.72L23.71,108.6a8,8,0,0,0,1.38,15.88,8.24,8.24,0,0,0,1.39-.12l16.32-2.88a55.74,55.74,0,0,0,5.86,12.42A52,52,0,0,0,84,224h80a76,76,0,0,0,0-152ZM56,104a40,40,0,0,1,72.54-23.24,76.26,76.26,0,0,0-35.62,40,52.14,52.14,0,0,0-31,4.17A40,40,0,0,1,56,104ZM164,208H84a36,36,0,1,1,4.78-71.69c-.37,2.37-.63,4.79-.77,7.23a8,8,0,0,0,16,.92,58.91,58.91,0,0,1,1.88-11.81c0-.16.09-.32.12-.48A60.06,60.06,0,1,1,164,208Z",
  };

  function weatherSvgPath(weather, lighting) {
    const w = mapSceneValue(weather, "");
    const l = mapSceneValue(lighting, "");
    if (w.includes("rain"))                        return WX_ICON_PATHS.rain;
    if (w === "clear" || w.includes("sun"))        return WX_ICON_PATHS.clear;
    if (w === "glare")                             return WX_ICON_PATHS.glare;
    if (w === "fog" || w === "foggy" ||
        w === "haze")                              return WX_ICON_PATHS.fog;
    if (w === "overcast" || w.includes("cloud"))   return WX_ICON_PATHS.overcast;
    // Fallback: use lighting
    if (l === "night" || l === "dusk" || l === "dawn") return WX_ICON_PATHS.moon;
    if (l === "day")                               return WX_ICON_PATHS.clear;
    return WX_ICON_PATHS.default;
  }

  function lightingIcon(lighting) {
    const l = mapSceneValue(lighting, "scanning");
    if (l === "night") return "\u{1F319}";
    if (l === "day") return "\u2600";
    return "\u25CC";
  }

  function getSceneDisplay() {
    let lighting = mapSceneValue(state.sceneLighting, "");
    const weather = mapSceneValue(state.sceneWeather, "");
    if (!lighting && !weather && state.frames === 0) return "Idle";
    // Time-of-day fallback when AI hasn't classified lighting yet
    if (!lighting) {
      const hr = new Date().getHours();
      lighting = (hr >= 6 && hr < 19) ? "day" : "night";
    }
    const parts = [sceneTitle(lighting)];
    if (weather) parts.push(sceneTitle(weather));
    return parts.join(" · ");
  }

  function getHudState(avgConf) {
    const sceneText = getSceneDisplay();
    if (state.frames === 0) return "Idle";
    if (sceneText === "Scanning...") return "Scanning";
    const lighting = mapSceneValue(state.sceneLighting, "scanning");
    if (lighting === "night") return "Night";
    if (lighting === "day") return "Day";
    if (Number.isFinite(avgConf) && avgConf >= 0.56 && state.detections > 150) return "Ready";
    return "Scanning";
  }

  function percent(n) {
    const v = Math.max(0, Math.min(100, Number(n) || 0));
    return `${Math.round(v)}%`;
  }

  function getVerboseScript({ confPct, scenePct, detections, frames, modelLoop }) {
    const lighting = mapSceneValue(state.sceneLighting, "scanning");
    const weather  = mapSceneValue(state.sceneWeather,  "scanning");
    const crossRate = Math.max(0, Number(state.crossingRatePerMin) || 0);
    const profile   = String(state.runtimeProfile || "").toLowerCase().replaceAll("_", " ");

    const parts = [];

    // ── Scene observation ──────────────────────────────────────
    if (frames < 6) {
      parts.push("initializing scene scan");
    } else {
      const lightDesc =
        lighting === "day"                   ? "daylight scene confirmed" :
        lighting === "night"                 ? "night scene active" :
        (lighting === "dusk" ||
         lighting === "dawn")               ? "low-light transition" :
        lighting === "overcast"              ? "overcast conditions" :
        lighting === "glare"                 ? "glare interference detected" :
        (lighting === "scanning" ||
         lighting === "unknown")            ? "scene lock calibrating" :
        `scene: ${lighting}`;
      parts.push(lightDesc);
    }

    // ── Weather ────────────────────────────────────────────────
    if (weather && weather !== "scanning" && weather !== "unknown") {
      const wxDesc =
        weather === "clear"                  ? "clear sky" :
        (weather === "rain" ||
         weather === "rainy")               ? "rain detected — wet road" :
        weather === "overcast"               ? "overcast sky" :
        (weather === "fog" ||
         weather === "foggy")               ? "fog — reduced visibility" :
        weather === "glare"                  ? "glare conditions" :
        weather === "haze"                   ? "haze detected" :
        `weather: ${weather}`;
      parts.push(wxDesc);
    } else {
      parts.push("weather scanning");
    }

    // ── Traffic load ───────────────────────────────────────────
    if (frames < 4) {
      parts.push("traffic baseline building");
    } else if (crossRate >= 12) {
      parts.push(`heavy volume · ${crossRate.toFixed(1)}/min`);
    } else if (crossRate >= 5) {
      parts.push(`moderate flow · ${crossRate.toFixed(1)}/min`);
    } else if (crossRate > 0) {
      parts.push(`light traffic · ${crossRate.toFixed(1)}/min`);
    } else {
      parts.push("monitoring traffic flow");
    }

    // ── Model / profile ────────────────────────────────────────
    if (profile && profile !== "balanced" && profile !== "") {
      parts.push(`profile: ${profile}`);
    } else {
      parts.push(modelLoop === "active" ? "retrain loop running" : "retrain idle");
    }

    return parts.join(" | ");
  }

  function getTrafficLoadSummary(crossRate, profile, reason) {
    const rate = Math.max(0, Number(crossRate) || 0);
    const p = String(profile || "").trim().toLowerCase();
    const r = String(reason || "").trim().toLowerCase();

    let load = "Light";
    if (rate >= 12) load = "Heavy";
    else if (rate >= 5) load = "Moderate";

    let msg = `Traffic is ${load.toLowerCase()} right now.`;
    if (load === "Heavy") {
      msg = "Heavy flow detected. Tight profile tuning helps prevent missed vehicles.";
    } else if (load === "Moderate") {
      msg = "Moderate flow. Runtime profile should stay balanced for stable counts.";
    }

    if (p.includes("heavy")) {
      msg = `Heavy profile active (${p.replaceAll("_", " ")}). Optimized for dense traffic.`;
    } else if (r.includes("heavy")) {
      msg = `Profile switched for heavy traffic (${r.replaceAll("_", " ")}).`;
    } else if (p.includes("glare")) {
      msg = "Glare profile active to reduce false positives in harsh lighting.";
    } else if (p.includes("night")) {
      msg = "Night profile active for low-light traffic detection.";
    }

    return { load, msg };
  }

  function getDelayMs() {
    if (!Number.isFinite(state.lastCaptureTsMs)) return null;
    return Math.max(0, Date.now() - state.lastCaptureTsMs);
  }

  function formatDelay(ms) {
    if (!Number.isFinite(ms)) return state.frames > 0 ? "Scanning..." : "Idle";
    if (ms < 1000) return `${Math.round(ms)}ms`;
    if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.round(ms / 1000)}s`;
  }

  function render() {
    const titleEl = document.querySelector(".ml-hud-title");
    const levelEl = document.getElementById("ml-hud-level");
    const msgEl = document.getElementById("ml-hud-msg");
    const framesEl = document.getElementById("ml-hud-frames");
    const detsEl = document.getElementById("ml-hud-dets");
    const confEl = document.getElementById("ml-hud-conf");
    const sceneEl = document.getElementById("ml-hud-profile");
    const sceneIconEl = document.getElementById("ml-hud-scene-icon");
    const delayEl = document.getElementById("ml-hud-delay");
    const confBarEl = document.getElementById("ml-hud-conf-bar");
    const sceneConfEl = document.getElementById("ml-hud-scene-conf");
    const trafficMsgEl = document.getElementById("ml-hud-traffic-msg");
    const verboseEl  = document.getElementById("ml-hud-verbose");
    const wxPathEl   = document.getElementById("ml-hud-wx-path");
    const wxTextEl   = document.getElementById("ml-hud-wx-text");
    if (!titleEl || !levelEl || !msgEl || !framesEl || !detsEl || !confEl || !sceneEl || !delayEl || !confBarEl || !sceneConfEl) return;

    const level = getLevel();
    const avgConf = getAvgConf();
    const isMobile = window.matchMedia("(max-width: 640px)").matches;
    const title = isMobile ? "VISION" : "LIVE VISION HUD";
    const hudState = getHudState(avgConf);
    const modeLabel = state.runtimeProfile ? state.runtimeProfile.replaceAll("_", " ") : "balanced";
    const sceneLabel = getSceneDisplay();
    const delayMs = getDelayMs();
    const delayText = formatDelay(delayMs);
    const reasonText = state.runtimeReason ? state.runtimeReason.replaceAll("_", " ") : "";
    const confPct = avgConf == null ? 0 : Math.max(0, Math.min(100, avgConf * 100));
    const scenePct = Math.max(0, Math.min(100, (Number(state.sceneConfidence) || 0) * 100));
    const hasRealScene = !!mapSceneValue(state.sceneLighting, "") || !!mapSceneValue(state.sceneWeather, "");
    titleEl.textContent = title;
    if (wxTextEl) wxTextEl.textContent = sceneLabel;
    levelEl.classList.toggle("is-live", hasRealScene);
    levelEl.classList.toggle("is-scan", !hasRealScene);
    levelEl.classList.toggle("is-delay", false);
    msgEl.textContent = `${level.label}. Mode: ${modeLabel}${reasonText ? ` (${reasonText})` : ""}.`;
    framesEl.textContent = state.frames.toLocaleString();
    detsEl.textContent = state.detections.toLocaleString();
    const detRate = Math.max(0, Number(state.detRatePerMin) || 0);
    const crossRate = Math.max(0, Number(state.crossingRatePerMin) || 0);
    const detRatePct = Math.max(0, Math.min(100, (detRate / 45) * 100));
    const trafficLoad = getTrafficLoadSummary(crossRate, state.runtimeProfile, state.runtimeReason);

    confEl.textContent = `${detRate.toFixed(1)}/m`;
    confBarEl.style.setProperty("--pct", detRatePct.toFixed(1));
    sceneConfEl.textContent = trafficLoad.load;
    if (trafficMsgEl) trafficMsgEl.textContent = trafficLoad.msg;
    delayEl.textContent = percent(confPct);
    const liveObjPct = Math.max(0, Math.min(100, (Number(state.liveObjectsNow) / 12) * 100));
    sceneEl.style.setProperty("--pct", liveObjPct.toFixed(1));
    delayEl.style.setProperty("--pct", confPct.toFixed(1));
    sceneEl.textContent = String(state.liveObjectsNow);
    if (sceneIconEl) sceneIconEl.textContent = "";
    if (verboseEl) {
      verboseEl.textContent = getVerboseScript({
        confPct,
        scenePct,
        detections: state.detections,
        frames: state.frames,
        modelLoop: state.modelLoop,
      });
    }

    // Weather icon in the level badge
    if (wxPathEl) {
      const weather = mapSceneValue(state.sceneWeather, "");
      const lighting = mapSceneValue(state.sceneLighting, "");
      const hr = new Date().getHours();
      const lightForIcon = lighting || ((hr >= 6 && hr < 19) ? "day" : "night");
      wxPathEl.setAttribute("d", weatherSvgPath(weather, lightForIcon));
    }
  }

  function destroy() {
    if (_pollTimer) clearInterval(_pollTimer);
    _pollTimer = null;
    _titleTimer = null;
    _bound = false;
  }

  function resetForNewScene() {
    state.startedAt      = Date.now();
    state.frames         = 0;
    state.detections     = 0;
    state.confSum        = 0;
    state.confCount      = 0;
    state.liveObjectsNow = 0;
    state.detRatePerMin  = 0;
    state.crossingRatePerMin = 0;
    state.lastTickMs     = null;
    state.lastCrossingTotal = null;
    state._crossingWindow = [];
    state.lastCaptureTsMs = null;
    state.sceneLighting  = "unknown";
    state.sceneWeather   = "unknown";
    state.sceneConfidence = 0;
    state.seededFromTelemetry = false;
    render();
    seedFromTelemetry();
  }

  return { init, destroy, resetForNewScene };
})();

window.MlOverlay = MlOverlay;



