import * as PIXI from 'pixi.js';
import { sb } from '../core/supabase.js';
import { contentToPixel, getContentBounds } from '../utils/coord-utils.js'; // eslint-disable-line no-unused-vars

  let canvas, ctx, video;
  let _dpr = 1;
  let latestDetections = [];
  let _detectZone = null;   // {points:[{x,y}]} or null — set by ZoneOverlay on load
  let rafId = null;

  // ── Time-sync queue ───────────────────────────────────────────
  // Detections arrive ~175ms after captured_at (real-time), but the HLS video
  // is buffered 2-10s behind. We queue detections with their server timestamp
  // and hold them until the video catches up to that moment in time.
  const detectionQueue = [];         // [{ capturedAtMs, detections }], oldest first
  const QUEUE_MAX_AGE_MS  = 15_000;  // drop entries older than 15s
  const QUEUE_MATCH_TOL_MS = 800;    // ±800ms — tighter now that lag is stable at ~4s
  const QUEUE_POLL_MS = 200;         // continuous poll interval (ms) independent of WS
  const SETTINGS_KEY = "whitelinez.detection.overlay_settings.v7";
  let pixiApp = null;
  let pixiEnabled = false;
  let isMobileClient = false;
  const pixiGraphicsPool = [];
  const pixiTextPool = [];
  let pixiGraphicsUsed = 0;
  let pixiTextUsed = 0;
  let forceRender = true;
  let lastFrameKey = "";
  let ghostSeq = 0;
  const laneSmoothing = new Map();

  // ── Analytics zone overlay ────────────────────────────────────
  let _analyticsZones  = [];
  let _zonesLoadedAt   = 0;
  const _ZONE_CACHE_MS = 120000;
  const _ZONE_TYPE_COLOR = {
    entry:   "#4CAF50",
    exit:    "#F44336",
    queue:   "#FF9800",
    roi:     "#AB47BC",
    speed_a: "#00BCD4",
    speed_b: "#009688",
  };

  let settings = {
    box_style: "corner",
    line_width: 1.5,
    fill_alpha: 0.0,
    max_boxes: 20,
    show_labels: true,
    detect_zone_only: false,
    outside_scan_enabled: true,
    outside_scan_min_conf: 0.22,
    outside_scan_max_boxes: 20,
    outside_scan_hold_ms: 220,
    outside_scan_show_labels: false,
    ground_overlay_enabled: true,
    show_ground_plane_public: false,
    ground_overlay_alpha: 0.16,
    ground_grid_density: 6,
    ground_occlusion_cutout: 0.38,
    ground_quad: {
      x1: 0.34, y1: 0.58,
      x2: 0.78, y2: 0.58,
      x3: 0.98, y3: 0.98,
      x4: 0.08, y4: 0.98,
    },
    colors: {
      car: "#29B6F6",
      truck: "#FF7043",
      bus: "#AB47BC",
      motorcycle: "#FFD600",
    },
  };
  const outsideGhosts = new Map();

  function detectMobileClient() {
    try {
      const coarse = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
      const narrow = window.matchMedia && window.matchMedia("(max-width: 980px)").matches;
      const ua = String(navigator.userAgent || "").toLowerCase();
      const uaMobile = /android|iphone|ipad|ipod|mobile|tablet/.test(ua);
      return Boolean(coarse || narrow || uaMobile);
    } catch {
      return false;
    }
  }

  function hexToPixi(hex) {
    const raw = String(hex || "").replace("#", "");
    const safe = raw.length === 3
      ? raw.split("").map((c) => c + c).join("")
      : raw.padEnd(6, "0").slice(0, 6);
    const n = Number.parseInt(safe, 16);
    return Number.isFinite(n) ? n : 0x66bb6a;
  }

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      settings = {
        ...settings,
        ...parsed,
        colors: { ...settings.colors, ...(parsed?.colors || {}) },
      };
    } catch {}
  }

  function applySettings(nextSettings) {
    if (!nextSettings || typeof nextSettings !== "object") return;
    settings = {
      ...settings,
      ...nextSettings,
      colors: { ...settings.colors, ...(nextSettings?.colors || {}) },
    };
    forceRender = true;
  }

  function buildFrameKey(detections) {
    if (!Array.isArray(detections) || detections.length === 0) return "empty";
    const lim = Math.min(detections.length, 80);
    let key = `${lim}|`;
    for (let i = 0; i < lim; i += 1) {
      const d = detections[i] || {};
      key += [
        d.tracker_id ?? -1,
        d.cls || "u",
        Number(d.conf || 0).toFixed(2),
        Number(d.x1 || 0).toFixed(3),
        Number(d.y1 || 0).toFixed(3),
        Number(d.x2 || 0).toFixed(3),
        Number(d.y2 || 0).toFixed(3),
        d.in_detect_zone === false ? "0" : "1",
      ].join(",");
      key += ";";
    }
    return key;
  }

  function hexToRgba(hex, alpha) {
    const raw = String(hex || "").replace("#", "");
    const safe = raw.length === 3
      ? raw.split("").map((c) => c + c).join("")
      : raw.padEnd(6, "0").slice(0, 6);
    const n = Number.parseInt(safe, 16);
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, Number(alpha) || 0))})`;
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function getGroundQuadPixels(bounds) {
    const q = settings.ground_quad || {};
    const pts = [
      { x: Number(q.x1), y: Number(q.y1) },
      { x: Number(q.x2), y: Number(q.y2) },
      { x: Number(q.x3), y: Number(q.y3) },
      { x: Number(q.x4), y: Number(q.y4) },
    ];
    if (!pts.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) return null;
    if (!pts.every((p) => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1)) return null;
    return pts.map((p) => contentToPixel(p.x, p.y, bounds));
  }

  function drawGroundOverlayCanvas(bounds, detections) {
    if (!ctx || settings.ground_overlay_enabled === false) return;
    const quad = getGroundQuadPixels(bounds);
    if (!quad) return;

    const alpha = Math.max(0, Math.min(0.45, Number(settings.ground_overlay_alpha) || 0.16));
    const gridDensity = Math.max(2, Math.min(16, Number(settings.ground_grid_density) || 6));

    const p1 = quad[0];
    const p2 = quad[1];
    const p3 = quad[2];
    const p4 = quad[3];

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.lineTo(p3.x, p3.y);
    ctx.lineTo(p4.x, p4.y);
    ctx.closePath();
    ctx.fillStyle = hexToRgba("#17d1ff", alpha * 0.55);
    ctx.fill();
    ctx.strokeStyle = hexToRgba("#33d8ff", Math.min(0.9, alpha + 0.25));
    ctx.lineWidth = 1.25;
    ctx.stroke();

    ctx.strokeStyle = hexToRgba("#36ccff", Math.min(0.9, alpha + 0.14));
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 5]);
    for (let i = 1; i <= gridDensity; i += 1) {
      const t = i / (gridDensity + 1);
      const pt = Math.pow(t, 1.25);
      const lx = lerp(p1.x, p4.x, pt);
      const ly = lerp(p1.y, p4.y, pt);
      const rx = lerp(p2.x, p3.x, pt);
      const ry = lerp(p2.y, p3.y, pt);
      ctx.beginPath();
      ctx.moveTo(lx, ly);
      ctx.lineTo(rx, ry);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    const cxTop = { x: (p1.x + p2.x) * 0.5, y: (p1.y + p2.y) * 0.5 };
    const cxBot = { x: (p4.x + p3.x) * 0.5, y: (p4.y + p3.y) * 0.5 };
    ctx.strokeStyle = hexToRgba("#86e8ff", Math.min(0.95, alpha + 0.3));
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(cxTop.x, cxTop.y);
    ctx.lineTo(cxBot.x, cxBot.y);
    ctx.stroke();

    // Keep the ground projection visually behind overlays; do not punch holes under boxes.
    ctx.restore();
  }

  function drawGroundOverlayPixi(bounds) {
    if (!pixiEnabled || !pixiApp || settings.ground_overlay_enabled === false) return;
    const quad = getGroundQuadPixels(bounds);
    if (!quad) return;
    const alpha = Math.max(0, Math.min(0.45, Number(settings.ground_overlay_alpha) || 0.16));
    const gridDensity = Math.max(2, Math.min(16, Number(settings.ground_grid_density) || 6));
    const colorMain = 0x17d1ff;
    const colorGrid = 0x36ccff;
    const g = getPixiGraphic();
    if (!g) return;

    const p1 = quad[0];
    const p2 = quad[1];
    const p3 = quad[2];
    const p4 = quad[3];

    g.beginFill(colorMain, alpha * 0.55);
    g.moveTo(p1.x, p1.y);
    g.lineTo(p2.x, p2.y);
    g.lineTo(p3.x, p3.y);
    g.lineTo(p4.x, p4.y);
    g.lineTo(p1.x, p1.y);
    g.endFill();

    g.lineStyle(1.25, colorMain, Math.min(0.95, alpha + 0.28));
    g.moveTo(p1.x, p1.y); g.lineTo(p2.x, p2.y);
    g.lineTo(p3.x, p3.y); g.lineTo(p4.x, p4.y); g.lineTo(p1.x, p1.y);

    g.lineStyle(1, colorGrid, Math.min(0.95, alpha + 0.16));
    for (let i = 1; i <= gridDensity; i += 1) {
      const t = i / (gridDensity + 1);
      const pt = Math.pow(t, 1.25);
      const lx = lerp(p1.x, p4.x, pt);
      const ly = lerp(p1.y, p4.y, pt);
      const rx = lerp(p2.x, p3.x, pt);
      const ry = lerp(p2.y, p3.y, pt);
      g.moveTo(lx, ly);
      g.lineTo(rx, ry);
    }

    const cxTop = { x: (p1.x + p2.x) * 0.5, y: (p1.y + p2.y) * 0.5 };
    const cxBot = { x: (p4.x + p3.x) * 0.5, y: (p4.y + p3.y) * 0.5 };
    g.lineStyle(1.4, 0x86e8ff, Math.min(0.95, alpha + 0.3));
    g.moveTo(cxTop.x, cxTop.y);
    g.lineTo(cxBot.x, cxBot.y);
  }

  function drawCornerBox(x, y, w, h, color, lineWidth) {
    const c = Math.max(6, Math.min(20, Math.floor(Math.min(w, h) * 0.22)));
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = 'round';
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(x, y + c); ctx.lineTo(x, y); ctx.lineTo(x + c, y);
    ctx.moveTo(x + w - c, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + c);
    ctx.moveTo(x + w, y + h - c); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w - c, y + h);
    ctx.moveTo(x + c, y + h); ctx.lineTo(x, y + h); ctx.lineTo(x, y + h - c);
    ctx.stroke();
    ctx.lineCap = 'butt';
  }

  function drawCornerBoxPixi(g, x, y, w, h, colorNum, lineWidth) {
    const c = Math.max(6, Math.min(20, Math.floor(Math.min(w, h) * 0.22)));
    g.lineStyle(lineWidth, colorNum, 1, 0.5, true);
    g.moveTo(x, y + c); g.lineTo(x, y); g.lineTo(x + c, y);
    g.moveTo(x + w - c, y); g.lineTo(x + w, y); g.lineTo(x + w, y + c);
    g.moveTo(x + w, y + h - c); g.lineTo(x + w, y + h); g.lineTo(x + w - c, y + h);
    g.moveTo(x + c, y + h); g.lineTo(x, y + h); g.lineTo(x, y + h - c);
  }

  // ── Outside-scan reticle (unvalidated vehicles) ───────────────
  // Thin pulsing cyan crosshair corners — "I see you but not counting yet"
  function _drawScanReticle(det, bounds) {
    const p1 = contentToPixel(det.x1, det.y1, bounds);
    const p2 = contentToPixel(det.x2, det.y2, bounds);
    const bw = p2.x - p1.x, bh = p2.y - p1.y;
    if (bw < 4 || bh < 4) return;
    const t = Date.now() / 1000;
    const pulse = 0.3 + 0.25 * Math.sin(t * Math.PI * 2.2);
    const tc = Math.max(5, Math.min(16, Math.floor(Math.min(bw, bh) * 0.20)));
    ctx.save();
    ctx.strokeStyle = `rgba(0,212,255,${pulse})`;
    ctx.lineWidth = 1;
    ctx.lineCap = 'round';
    ctx.setLineDash([]);
    ctx.beginPath();
    // TL
    ctx.moveTo(p1.x, p1.y + tc); ctx.lineTo(p1.x, p1.y); ctx.lineTo(p1.x + tc, p1.y);
    // TR
    ctx.moveTo(p2.x - tc, p1.y); ctx.lineTo(p2.x, p1.y); ctx.lineTo(p2.x, p1.y + tc);
    // BR
    ctx.moveTo(p2.x, p2.y - tc); ctx.lineTo(p2.x, p2.y); ctx.lineTo(p2.x - tc, p2.y);
    // BL
    ctx.moveTo(p1.x + tc, p2.y); ctx.lineTo(p1.x, p2.y); ctx.lineTo(p1.x, p2.y - tc);
    ctx.stroke();
    // Label: cls + conf, same pulsing cyan, smaller font
    const CLS_NAME_S = { car: 'Car', truck: 'Truck', bus: 'Bus', motorcycle: 'Moto' };
    const clsS = CLS_NAME_S[String(det?.cls || '').toLowerCase()] || 'Vehicle';
    const colorSS = det.color && det.color !== 'unknown' ? ` · ${det.color}` : '';
    const confS = det.conf != null ? ` ${Math.round(Number(det.conf) * 100)}%` : '';
    const labelS = clsS + colorSS + confS;
    const fsS = isMobileClient ? 8 : 9;
    ctx.font = `600 ${fsS}px "JetBrains Mono", monospace`;
    const twS = ctx.measureText(labelS).width;
    const pxS = 3, pyS = 1;
    const txS = p1.x, tyS = p1.y - (fsS + pyS * 2);
    const tyS2 = tyS >= 0 ? tyS : p1.y;
    ctx.fillStyle = `rgba(0,212,255,${pulse})`;
    ctx.fillRect(txS, tyS2, twS + pxS * 2, fsS + pyS * 2);
    ctx.fillStyle = '#000';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(labelS, txS + pxS, tyS2 + pyS);
    ctx.restore();
  }

  // ── Inside-zone validation box (being confirmed/counted) ──────
  // Glowing corner brackets with label — "this one counts"
  function _drawValidationBox(det, bounds) {
    const p1 = contentToPixel(det.x1, det.y1, bounds);
    const p2 = contentToPixel(det.x2, det.y2, bounds);
    const bw = p2.x - p1.x, bh = p2.y - p1.y;
    if (bw < 4 || bh < 4) return;
    const color = settings.colors?.[det.cls] || '#66BB6A';
    const lw = Math.max(1.5, Number(settings.line_width || 2));
    ctx.save();
    // Glow halo
    ctx.shadowColor = color;
    ctx.shadowBlur = 10;
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    ctx.lineCap = 'round';
    ctx.setLineDash([]);
    drawCornerBox(p1.x, p1.y, bw, bh, color, lw);
    ctx.shadowBlur = 0;
    // Label: "Car · blue 73%"
    const CLS_NAME = { car: 'Car', truck: 'Truck', bus: 'Bus', motorcycle: 'Moto' };
    const clsStr = CLS_NAME[String(det?.cls || '').toLowerCase()] || 'Vehicle';
    const colorStr = det.color && det.color !== 'unknown' ? ` · ${det.color}` : '';
    const confStr = det.conf != null ? ` ${Math.round(Number(det.conf) * 100)}%` : '';
    const label = clsStr + colorStr + confStr;
    const fs = isMobileClient ? 9 : 10;
    ctx.font = `700 ${fs}px "JetBrains Mono", monospace`;
    const tw = ctx.measureText(label).width;
    const px = 4, py = 2;
    const tx = p1.x, ty = p1.y - (fs + py * 2);
    const ty2 = ty >= 0 ? ty : p1.y;
    ctx.fillStyle = color;
    ctx.fillRect(tx, ty2, tw + px * 2, fs + py * 2);
    ctx.fillStyle = '#000';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(label, tx + px, ty2 + py);
    ctx.restore();
  }

  function canUseUnsafeEval() {
    try {
      // Pixi shader bootstrap uses Function/eval under the hood unless unsafe-eval is allowed.
      // Probe once so we can skip noisy init failures when CSP forbids it.
      // eslint-disable-next-line no-new-func
      const fn = new Function("return 1;");
      return fn() === 1;
    } catch {
      return false;
    }
  }

  function initPixiRenderer() {
    if (!canvas) {
      console.warn("[DetectionOverlay] Pixi init skipped: missing canvas");
      return false;
    }
    if (!PIXI) {
      console.warn("[DetectionOverlay] Pixi init skipped: PIXI not loaded (CDN blocked or script failed)");
      return false;
    }
    let hasWebGL = false;
    try {
      const probe = document.createElement("canvas");
      hasWebGL = Boolean(
        probe.getContext("webgl2", { failIfMajorPerformanceCaveat: true }) ||
        probe.getContext("webgl", { failIfMajorPerformanceCaveat: true }) ||
        probe.getContext("experimental-webgl", { failIfMajorPerformanceCaveat: true })
      );
    } catch {
      hasWebGL = false;
    }
    if (!hasWebGL) {
      console.warn("[DetectionOverlay] WebGL unsupported/blocked on this browser context");
    }
    if (!canUseUnsafeEval()) {
      console.warn("[DetectionOverlay] Pixi init skipped: CSP blocks unsafe-eval; using Canvas2D fallback");
      return false;
    }
    const dpr = Math.max(1, Number(window.devicePixelRatio) || 1);
    const cssW = Math.max(1, (video?.clientWidth) || 1);
    const cssH = Math.max(1, (video?.clientHeight) || 1);
    const desktopCfg = {
      view: canvas,
      width: cssW,
      height: cssH,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(dpr, 2),
      powerPreference: "high-performance",
      preference: "webgl",
    };
    const mobileCfg = {
      view: canvas,
      width: cssW,
      height: cssH,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(dpr, 2),
      powerPreference: "low-power",
      preference: "webgl",
    };
    const tries = isMobileClient ? [mobileCfg, desktopCfg] : [desktopCfg, mobileCfg];
    try {
      let lastErr = null;
      for (const cfg of tries) {
        try {
          pixiApp = new PIXI.Application(cfg);
          pixiEnabled = true;
          const mode = isMobileClient ? "mobile" : "desktop";
          console.info(`[DetectionOverlay] Renderer: WebGL (PixiJS, ${mode})`);
          window.dispatchEvent(new CustomEvent("detection:renderer", { detail: { mode: "webgl", profile: mode } }));
          return true;
        } catch (e) {
          lastErr = e;
          pixiApp = null;
        }
      }
      if (lastErr) {
        console.warn("[DetectionOverlay] Pixi WebGL init failed:", lastErr);
      }
      return false;
    } catch (err) {
      console.warn("[DetectionOverlay] Pixi init failed, falling back to 2D:", err);
      pixiEnabled = false;
      pixiApp = null;
      return false;
    }
  }

  function beginPixiFrame() {
    pixiGraphicsUsed = 0;
    pixiTextUsed = 0;
  }

  function endPixiFrame() {
    for (let i = pixiGraphicsUsed; i < pixiGraphicsPool.length; i += 1) {
      pixiGraphicsPool[i].visible = false;
    }
    for (let i = pixiTextUsed; i < pixiTextPool.length; i += 1) {
      pixiTextPool[i].visible = false;
    }
  }

  function getPixiGraphic() {
    if (!pixiApp) return null;
    if (pixiGraphicsUsed >= pixiGraphicsPool.length) {
      const g = new PIXI.Graphics();
      g.visible = false;
      pixiGraphicsPool.push(g);
      pixiApp.stage.addChild(g);
    }
    const g = pixiGraphicsPool[pixiGraphicsUsed];
    pixiGraphicsUsed += 1;
    g.clear();
    g.visible = true;
    return g;
  }

  function getPixiText() {
    if (!pixiApp) return null;
    if (pixiTextUsed >= pixiTextPool.length) {
      const t = new PIXI.Text("", {
        fontFamily: "Inter, sans-serif",
        fontSize: 11,
        fill: 0x0d1118,
      });
      t.visible = false;
      pixiTextPool.push(t);
      pixiApp.stage.addChild(t);
    }
    const t = pixiTextPool[pixiTextUsed];
    pixiTextUsed += 1;
    t.visible = true;
    return t;
  }

  function buildGhostKey(det) {
    const tid = Number(det?.tracker_id);
    if (Number.isFinite(tid) && tid >= 0) return `t:${tid}:${String(det?.cls || "vehicle")}`;
    const x1 = Math.round(Number(det?.x1 || 0) * 100);
    const y1 = Math.round(Number(det?.y1 || 0) * 100);
    const x2 = Math.round(Number(det?.x2 || 0) * 100);
    const y2 = Math.round(Number(det?.y2 || 0) * 100);
    return `b:${String(det?.cls || "vehicle")}:${x1}:${y1}:${x2}:${y2}`;
  }

  function centerOf(det) {
    return {
      x: (Number(det?.x1 || 0) + Number(det?.x2 || 0)) * 0.5,
      y: (Number(det?.y1 || 0) + Number(det?.y2 || 0)) * 0.5,
    };
  }

  function findMatchingGhostKey(det) {
    const target = centerOf(det);
    let bestKey = null;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const [k, v] of outsideGhosts.entries()) {
      const gd = v?.det;
      if (!gd) continue;
      if (String(gd?.cls || "") !== String(det?.cls || "")) continue;
      const c = centerOf(gd);
      const dx = target.x - c.x;
      const dy = target.y - c.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 0.08 && dist < bestDist) {
        bestDist = dist;
        bestKey = k;
      }
    }
    return bestKey;
  }

  function smoothLaneDetections(detections, now) {
    const out = [];
    for (const det of detections) {
      const tid = Number(det?.tracker_id);
      if (!Number.isFinite(tid) || tid < 0) {
        out.push(det);
        continue;
      }
      const key = `lane:${tid}:${String(det?.cls || "vehicle")}`;
      const prev = laneSmoothing.get(key);
      if (!prev) {
        laneSmoothing.set(key, {
          x1: det.x1, y1: det.y1, x2: det.x2, y2: det.y2, ts: now,
        });
        out.push(det);
        continue;
      }
      const alpha = 0.28;  // lower = smoother box coasting between frames
      const sm = {
        ...det,
        x1: prev.x1 + (det.x1 - prev.x1) * alpha,
        y1: prev.y1 + (det.y1 - prev.y1) * alpha,
        x2: prev.x2 + (det.x2 - prev.x2) * alpha,
        y2: prev.y2 + (det.y2 - prev.y2) * alpha,
      };
      laneSmoothing.set(key, {
        x1: sm.x1, y1: sm.y1, x2: sm.x2, y2: sm.y2, ts: now,
      });
      out.push(sm);
    }

    for (const [k, v] of laneSmoothing.entries()) {
      if (!v || Number(v.ts || 0) + 1200 < now) laneSmoothing.delete(k);
    }
    return out;
  }

  function drawDetectionBox(det, bounds, opts = {}) {
    if (pixiEnabled && pixiApp) {
      return drawDetectionBoxPixi(det, bounds, opts);
    }
    if (!ctx) return;
    const p1 = contentToPixel(det.x1, det.y1, bounds);
    const p2 = contentToPixel(det.x2, det.y2, bounds);
    const bw = p2.x - p1.x;
    const bh = p2.y - p1.y;
    if (bw < 4 || bh < 4) return;

    const color = opts.color || settings.colors?.[det.cls] || "#66BB6A";
    const lineWidth = Math.max(1, Number(opts.lineWidth ?? settings.line_width) || 1.5);
    const alpha = Math.max(0, Math.min(0.45, Number(opts.alpha ?? settings.fill_alpha) || 0));
    const doFill = opts.fill !== false;
    const style = String(opts.style || settings.box_style || "solid");
    const showLabels = opts.showLabels !== false;
    const labelText = opts.labelText;

    if (doFill) {
      ctx.fillStyle = hexToRgba(color, alpha);
      ctx.fillRect(p1.x, p1.y, bw, bh);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    if (style === "dashed") ctx.setLineDash([8, 4]);
    else ctx.setLineDash([]);
    if (style === "corner") drawCornerBox(p1.x, p1.y, bw, bh, color, lineWidth);
    else ctx.strokeRect(p1.x, p1.y, bw, bh);

    if (showLabels) {
      const CLS_NAME = { car: 'Car', truck: 'Truck', bus: 'Bus', motorcycle: 'Moto' };
      const clsStr = labelText || CLS_NAME[String(det?.cls || '').toLowerCase()] || String(det?.cls || 'Vehicle');
      const confStr = (det.conf != null && !labelText) ? ` ${Math.round(Number(det.conf) * 100)}%` : '';
      const txt = clsStr + confStr;
      ctx.setLineDash([]);
      const fs = isMobileClient ? 9 : 10;
      ctx.font = `700 ${fs}px "JetBrains Mono", monospace`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      const tw = ctx.measureText(txt).width;
      const px = 4, py = 2;
      const tagW = tw + px * 2;
      const tagH = fs + py * 2;
      const tx = p1.x;
      const ty = (p1.y - tagH >= 0) ? p1.y - tagH : p1.y;
      ctx.fillStyle = hexToRgba(color, 0.88);
      ctx.fillRect(tx, ty, tagW, tagH);
      ctx.fillStyle = '#000000';
      ctx.fillText(txt, tx + px, ty + py);
    }
  }

  function drawDetectionBoxPixi(det, bounds, opts = {}) {
    const g = getPixiGraphic();
    if (!g) return;
    const p1 = contentToPixel(det.x1, det.y1, bounds);
    const p2 = contentToPixel(det.x2, det.y2, bounds);
    const bw = p2.x - p1.x;
    const bh = p2.y - p1.y;
    if (bw < 4 || bh < 4) {
      g.visible = false;
      return;
    }

    const color = opts.color || settings.colors?.[det.cls] || "#66BB6A";
    const colorNum = hexToPixi(color);
    const lineWidth = Math.max(1, Number(opts.lineWidth ?? settings.line_width) || 1.5);
    const alpha = Math.max(0, Math.min(0.45, Number(opts.alpha ?? settings.fill_alpha) || 0));
    const doFill = opts.fill !== false;
    const style = String(opts.style || settings.box_style || "solid");
    const showLabels = opts.showLabels !== false;
    const labelText = opts.labelText;

    if (doFill) {
      g.beginFill(colorNum, alpha);
      g.drawRect(p1.x, p1.y, bw, bh);
      g.endFill();
    }

    if (style === "corner") {
      drawCornerBoxPixi(g, p1.x, p1.y, bw, bh, colorNum, lineWidth);
    } else {
      g.lineStyle(lineWidth, colorNum, 1);
      g.drawRect(p1.x, p1.y, bw, bh);
    }

    if (!showLabels) return;

    const CLS_NAME = { car: 'Car', truck: 'Truck', bus: 'Bus', motorcycle: 'Moto' };
    const clsStr = labelText || CLS_NAME[String(det?.cls || '').toLowerCase()] || String(det?.cls || 'Vehicle');
    const confStr = (det.conf != null && !labelText) ? ` ${Math.round(Number(det.conf) * 100)}%` : '';
    const labelStr = clsStr + confStr;

    // background pill via Graphics
    const bg = getPixiGraphic();
    if (bg) {
      const fs = 10;
      const px = 4, py = 2;
      const approxCharW = fs * 0.62;
      const tagW = labelStr.length * approxCharW + px * 2;
      const tagH = fs + py * 2;
      const ty = (p1.y - tagH >= 0) ? p1.y - tagH : p1.y;
      bg.beginFill(colorNum, 0.88);
      bg.drawRect(p1.x, ty, tagW, tagH);
      bg.endFill();
    }

    const txt = getPixiText();
    if (!txt) return;
    const fs = 10;
    const py = 2;
    const ty = (p1.y - (fs + py * 2) >= 0) ? p1.y - (fs + py * 2) : p1.y;
    txt.text = labelStr;
    txt.style.fill = 0x000000;
    txt.style.fontWeight = '700';
    txt.x = p1.x + 4;
    txt.y = ty + py;
  }

  /**
   * Returns how many ms the video display lags behind the live edge.
   * Used to compute which detection frame to render for the currently shown frame.
   */
  function estimateVideoLagMs() {
    if (!video) return 0;
    try {
      if (!video.buffered.length) return 0;
      const liveEdge = video.buffered.end(video.buffered.length - 1);
      return Math.max(0, (liveEdge - video.currentTime) * 1000);
    } catch { return 0; }
  }

  /**
   * Picks the best matching entry from the detectionQueue for the video's
   * current playback position. Prunes entries too old to be relevant.
   * Falls back to latestDetections if the queue is empty or no match found.
   */
  function _pickFromQueue() {
    if (!detectionQueue.length) return latestDetections;

    const lagMs    = estimateVideoLagMs();
    const targetMs = Date.now() - lagMs;

    // Prune entries older than the target window
    const cutoff = targetMs - QUEUE_MAX_AGE_MS;
    while (detectionQueue.length > 1 && detectionQueue[0].capturedAtMs < cutoff) {
      detectionQueue.shift();
    }

    // Find entry whose captured_at is closest to the video's current moment
    let best = detectionQueue[0];
    let bestDelta = Math.abs(best.capturedAtMs - targetMs);
    for (let i = 1; i < detectionQueue.length; i++) {
      const d = Math.abs(detectionQueue[i].capturedAtMs - targetMs);
      if (d < bestDelta) { bestDelta = d; best = detectionQueue[i]; }
    }

    return bestDelta <= QUEUE_MATCH_TOL_MS ? best.detections : latestDetections;
  }

  // ── Zone overlay helpers ──────────────────────────────────────
  const _ZONE_LS_KEY = "wlz.zones.cache";

  async function _loadZones() {
    if (Date.now() - _zonesLoadedAt < _ZONE_CACHE_MS) return;
    if (!sb) return;
    try {
      const { data } = await sb
        .from("camera_zones")
        .select("id,name,zone_type,points,color")
        .eq("active", true);
      if (data) {
        _analyticsZones = data;
        _zonesLoadedAt  = Date.now();
        forceRender = true;
        try { localStorage.setItem(_ZONE_LS_KEY, JSON.stringify(data)); } catch {}
      }
    } catch { /* silent — telemetry overlay is non-critical */ }
  }

  function _drawZonesCanvas(bounds) {
    if (!ctx || !_analyticsZones.length) return;
    ctx.save();
    for (const zone of _analyticsZones) {
      const pts = zone.points || [];
      if (pts.length < 3) continue;
      const px = pts.map(p => contentToPixel(p.x, p.y, bounds));
      const col = zone.color || _ZONE_TYPE_COLOR[zone.zone_type] || "#64748b";

      // filled polygon
      ctx.beginPath();
      ctx.moveTo(px[0].x, px[0].y);
      for (let i = 1; i < px.length; i++) ctx.lineTo(px[i].x, px[i].y);
      ctx.closePath();
      ctx.fillStyle   = hexToRgba(col, 0.07);
      ctx.fill();
      ctx.strokeStyle = hexToRgba(col, 0.60);
      ctx.lineWidth   = 1.2;
      ctx.setLineDash([5, 4]);
      ctx.stroke();
      ctx.setLineDash([]);

      // name label at centroid
      const cx = px.reduce((s, p) => s + p.x, 0) / px.length;
      const cy = px.reduce((s, p) => s + p.y, 0) / px.length;
      const label = zone.name || zone.zone_type;
      ctx.font = "700 9px 'JetBrains Mono', monospace";
      ctx.textAlign    = "center";
      ctx.textBaseline = "middle";
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = "rgba(0,0,0,0.65)";
      ctx.fillRect(cx - tw / 2 - 3, cy - 7, tw + 6, 14);
      ctx.fillStyle = col;
      ctx.fillText(label, cx, cy);
    }
    ctx.restore();
  }

  function _drawZonesPixi(bounds) {
    if (!_analyticsZones.length) return;
    for (const zone of _analyticsZones) {
      const pts = zone.points || [];
      if (pts.length < 3) continue;
      const px   = pts.map(p => contentToPixel(p.x, p.y, bounds));
      const col  = zone.color || _ZONE_TYPE_COLOR[zone.zone_type] || "#64748b";
      const colN = hexToPixi(col);

      const g = getPixiGraphic();
      g.clear();
      g.visible = true;
      g.lineStyle(1.2, colN, 0.65, 0.5, false);
      g.beginFill(colN, 0.07);
      g.drawPolygon(px.flatMap(p => [p.x, p.y]));
      g.endFill();

      // label
      const cx = px.reduce((s, p) => s + p.x, 0) / px.length;
      const cy = px.reduce((s, p) => s + p.y, 0) / px.length;
      const t  = getPixiText();
      t.text   = zone.name || zone.zone_type;
      t.style.fill     = col;
      t.style.fontSize = 9;
      t.style.fontFamily = "JetBrains Mono, monospace";
      t.style.fontWeight = "700";
      t.anchor.set(0.5);
      t.x = cx;
      t.y = cy;
      t.visible = true;
    }
  }

  function init(videoEl, canvasEl) {
    video  = videoEl;
    canvas = canvasEl;
    isMobileClient = detectMobileClient();
    loadSettings();

    syncSize();
    // Seed from localStorage so zones are available immediately (survives network outages)
    try {
      const cached = localStorage.getItem(_ZONE_LS_KEY);
      if (cached) {
        _analyticsZones = JSON.parse(cached);
        forceRender = true;
      }
    } catch {}
    // Kick off zone load immediately; cache refreshes every 2 min
    _loadZones();
    setInterval(_loadZones, _ZONE_CACHE_MS);

    if (!initPixiRenderer()) {
      ctx = canvas.getContext("2d");
      ctx.setTransform(_dpr, 0, 0, _dpr, 0, 0);
      pixiEnabled = false;
      const hasPixi = Boolean(PIXI);
      let webglAvailable = false;
      try {
        const probe = document.createElement("canvas");
        webglAvailable = Boolean(
          probe.getContext("webgl2") ||
          probe.getContext("webgl") ||
          probe.getContext("experimental-webgl")
        );
      } catch {
        webglAvailable = false;
      }
      console.info(`[DetectionOverlay] Renderer: Canvas2D fallback (PIXI=${hasPixi}, WebGL=${webglAvailable})`);
      window.dispatchEvent(new CustomEvent("detection:renderer", { detail: { mode: "canvas", profile: isMobileClient ? "mobile" : "desktop" } }));
    }

    window.addEventListener("resize", syncSize);
    video.addEventListener("loadedmetadata", syncSize);
    if (window.ResizeObserver) {
      new ResizeObserver(syncSize).observe(video);
    }

    window.addEventListener("count:update", (e) => {
      latestDetections = e.detail?.detections ?? [];

      // Push into time-sync queue so the poll loop can delay rendering to match video
      const capturedAtMs = e.detail?.captured_at ? Date.parse(e.detail.captured_at) : NaN;
      if (Number.isFinite(capturedAtMs)) {
        detectionQueue.push({ capturedAtMs, detections: latestDetections });
      }

      // Debounce: only mark dirty when the detection set actually changed.
      // The continuous poll loop drives rendering; WS events just feed the queue.
      const nextKey = buildFrameKey(latestDetections);
      if (nextKey !== lastFrameKey) {
        lastFrameKey = nextKey;
        forceRender = true;
      }
    });

    window.addEventListener("detection:settings-update", (e) => {
      applySettings(e.detail);
      forceRender = true;
    });

    // ── Continuous queue poll ────────────────────────────────────
    // Runs every QUEUE_POLL_MS regardless of WS cadence so the canvas
    // re-evaluates _pickFromQueue() as video playback advances.
    _startQueuePoll();
  }

  let _pollTimer = null;
  function _startQueuePoll() {
    if (_pollTimer) return;
    _pollTimer = setInterval(() => {
      const picked = _pickFromQueue();
      const key    = buildFrameKey(picked);
      if (key !== lastFrameKey) {
        lastFrameKey = key;
        forceRender  = true;
      }
      if (forceRender && !rafId) {
        rafId = requestAnimationFrame(renderFrame);
      }
    }, QUEUE_POLL_MS);
  }

  function renderFrame() {
    rafId = null;
    if (!forceRender) return;
    draw(_pickFromQueue());
    // forceRender cleared inside draw()
  }

  function syncSize() {
    if (!video || !canvas) return;
    _dpr = window.devicePixelRatio || 1;
    const cssW = video.clientWidth;
    const cssH = video.clientHeight;
    if (pixiEnabled && pixiApp?.renderer) {
      // Pixi manages canvas backing store via autoDensity; pass CSS dimensions
      pixiApp.renderer.resize(Math.max(1, cssW), Math.max(1, cssH));
      forceRender = true;
      return;
    }
    const newW = Math.round(cssW * _dpr);
    const newH = Math.round(cssH * _dpr);
    const changed = canvas.width !== newW || canvas.height !== newH;
    canvas.width  = newW;
    canvas.height = newH;
    canvas.style.width  = cssW + "px";
    canvas.style.height = cssH + "px";
    if (changed) forceRender = true;
    if (ctx) ctx.setTransform(_dpr, 0, 0, _dpr, 0, 0);
  }

  function draw(detections) {
    if (!canvas) return;
    if (pixiEnabled) beginPixiFrame();
    else if (ctx) {
      ctx.setTransform(_dpr, 0, 0, _dpr, 0, 0);
      ctx.clearRect(0, 0, video.clientWidth, video.clientHeight);
    }
    else return;
    const bounds = getContentBounds(video);
    if (settings.show_ground_plane_public === true) {
      if (pixiEnabled) drawGroundOverlayPixi(bounds);
      else drawGroundOverlayCanvas(bounds, detections);
    }

    if (!detections.length) {
      if (pixiEnabled) endPixiFrame();
      return;
    }

    const laneHardCap = isMobileClient ? 12 : 15;
    const laneMaxBoxes = Math.max(1, Math.min(laneHardCap, Number(settings.max_boxes) || 10));
    const laneDetections = [];
    const outsideDetections = [];
    for (const det of detections) {
      if (det?.in_detect_zone === false) outsideDetections.push(det);
      else laneDetections.push(det);
    }

    const smoothed  = smoothLaneDetections(laneDetections, Date.now());
    const liveLane  = smoothed.slice(0, laneMaxBoxes);
    if (!pixiEnabled && ctx) {
      for (const det of liveLane) {
        _drawValidationBox(det, bounds);
      }
    } else {
      for (const det of liveLane) {
        drawDetectionBox(det, bounds, {
          style: settings.box_style,
          lineWidth: Math.max(1, Number(settings.line_width || 2)),
          alpha: 0,
          fill: false,
          showLabels: settings.show_labels !== false,
        });
      }
    }

    if (settings.detect_zone_only || settings.outside_scan_enabled === false) {
      if (pixiEnabled) endPixiFrame();
      return;
    }

    const minConf = Math.max(0, Math.min(1, Number(settings.outside_scan_min_conf) || 0.20));
    const outsideHardCap = isMobileClient ? 24 : 35;
    const outsideMax = Math.max(1, Math.min(outsideHardCap, Number(settings.outside_scan_max_boxes) || 25));
    const fresh = outsideDetections
      .filter((d) => Number(d?.conf || 0) >= minConf)
      .sort((a, b) => Number(b?.conf || 0) - Number(a?.conf || 0))
      .slice(0, outsideMax);

    if (fresh.length && !pixiEnabled && ctx) {
      for (const det of fresh) {
        _drawScanReticle(det, bounds);
      }
    } else if (fresh.length && pixiEnabled) {
      for (const det of fresh) {
        drawDetectionBox(det, bounds, {
          style: "dashed",
          lineWidth: 1.0,
          alpha: 0,
          fill: false,
          showLabels: true,
        });
      }
    }
    if (pixiEnabled) endPixiFrame();
    forceRender = false;
  }

  function clearDetections() {
    latestDetections = [];
    detectionQueue.length = 0;  // flush time-sync queue for old camera
    lastFrameKey = "";
    forceRender = true;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(renderFrame);
  }

  // Called by ZoneOverlay when it loads a new camera's detect_zone
  function setDetectZone(zone) {
    _detectZone = zone || null;
  }

  // Build a canvas clip path from the detect zone polygon and apply it.
  // Returns true if clipping was applied (caller must ctx.restore() after drawing).
  function _buildDetectZonePath(bounds) {
    if (!ctx || !_detectZone) return false;
    let pts = null;
    if (Array.isArray(_detectZone.points) && _detectZone.points.length >= 3) {
      pts = _detectZone.points.map(p => contentToPixel(p.x, p.y, bounds));
    } else if (_detectZone.x3 !== undefined) {
      pts = [
        contentToPixel(_detectZone.x1, _detectZone.y1, bounds),
        contentToPixel(_detectZone.x2, _detectZone.y2, bounds),
        contentToPixel(_detectZone.x3, _detectZone.y3, bounds),
        contentToPixel(_detectZone.x4, _detectZone.y4, bounds),
      ];
    }
    if (!pts || pts.length < 3) return false;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.clip();
    return true;
  }

  async function _forceLoadZones() {
    _zonesLoadedAt = 0;
    await _loadZones();
  }

export const DetectionOverlay = {
  init,
  clearDetections,
  setDetectZone,
  reloadZones:      _loadZones,
  forceReloadZones: _forceLoadZones,
  getZones:         () => _analyticsZones,
};
