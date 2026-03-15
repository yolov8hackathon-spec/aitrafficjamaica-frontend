import * as PIXI from 'pixi.js';
import { sb } from '../core/supabase.js';
import { getContentBounds, contentToPixel, pixelToContent } from '../utils/coord-utils.js'; // eslint-disable-line no-unused-vars
import { DetectionOverlay } from './detection-overlay.js';

  let canvas, ctx, video;
  let pixiApp = null;
  let pixiEnabled = false;
  let pixiGraphics = null;
  let pixiTexts = [];
  let _dpr = 1;
  let countLine = null;
  let detectZone = null;
  let landmarks = [];
  let latestDetections = [];
  let overlaySettings = {
    ground_overlay_enabled: true,
    ground_occlusion_cutout: 0.38,
  };
  let confirmedTotal = 0;
  let flashTimer = null;
  let isFlashing = false;
  let _hoverCountLine = false;   // true when mouse is over the count zone polygon

  // ── Animation state ─────────────────────────────────────────────────────────
  let _animRafId = null;
  const RING_DURATION_MS = 900;
  let _pulseRings = [];   // [{x, y, startMs}] — pre-count ripple rings

  function hexToPixi(hex) {
    const raw = String(hex || "").replace("#", "");
    const safe = raw.length === 3
      ? raw.split("").map((c) => c + c).join("")
      : raw.padEnd(6, "0").slice(0, 6);
    const n = Number.parseInt(safe, 16);
    return Number.isFinite(n) ? n : 0x66bb6a;
  }

  function _canUseUnsafeEval() {
    try {
      // eslint-disable-next-line no-new-func
      const fn = new Function("return 1;");
      return fn() === 1;
    } catch {
      return false;
    }
  }

  function _isMobileClient() {
    try {
      const coarse = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
      const narrow = window.matchMedia && window.matchMedia("(max-width: 980px)").matches;
      const ua = String(navigator.userAgent || "").toLowerCase();
      return Boolean(coarse || narrow || /android|iphone|ipad|ipod|mobile|tablet/.test(ua));
    } catch {
      return false;
    }
  }

  function initPixiRenderer() {
    if (!canvas || !PIXI) return false;
    if (!_canUseUnsafeEval()) return false;

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
    if (!hasWebGL) return false;

    const mobile = _isMobileClient();
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
    const tries = mobile ? [mobileCfg, desktopCfg] : [desktopCfg, mobileCfg];

    for (const cfg of tries) {
      try {
        pixiApp = new PIXI.Application(cfg);
        pixiGraphics = new PIXI.Graphics();
        pixiApp.stage.addChild(pixiGraphics);
        pixiEnabled = true;
        console.info(`[ZoneOverlay] Renderer: WebGL (PixiJS, ${mobile ? "mobile" : "desktop"})`);
        return true;
      } catch (e) {
        pixiApp = null;
        pixiGraphics = null;
      }
    }

    pixiEnabled = false;
    console.info("[ZoneOverlay] Renderer: Canvas2D fallback");
    return false;
  }

  function clearPixiTexts() {
    if (!pixiApp || !pixiTexts.length) return;
    for (const t of pixiTexts) {
      try {
        pixiApp.stage.removeChild(t);
        t.destroy();
      } catch {}
    }
    pixiTexts = [];
  }

  function addPixiLabel(text, x, y, color) {
    if (!pixiApp || !text) return;
    const node = new PIXI.Text(String(text), {
      fontFamily: "Manrope, sans-serif",
      fontWeight: "700",
      fontSize: 12,
      fill: color,
    });
    node.anchor.set(0.5, 0.5);
    node.x = x;
    node.y = y;
    pixiApp.stage.addChild(node);
    pixiTexts.push(node);
  }

  async function resolveCamera(alias) {
    // If alias provided, load that specific camera's zones
    if (alias) {
      const { data, error } = await sb
        .from("cameras")
        .select("id, ipcam_alias, created_at, count_line, detect_zone, feed_appearance, landmarks")
        .eq("ipcam_alias", alias)
        .limit(1);
      if (error) throw error;
      if (Array.isArray(data) && data.length) return data[0];
    }
    // Fallback: load the active camera's zones
    const { data, error } = await sb
      .from("cameras")
      .select("id, ipcam_alias, created_at, count_line, detect_zone, feed_appearance, landmarks")
      .eq("is_active", true);
    if (error) throw error;
    const cams = Array.isArray(data) ? data : [];
    if (!cams.length) return null;
    const rank = (cam) => {
      const a = String(cam?.ipcam_alias || "").trim();
      if (!a) return 0;
      if (a.toLowerCase() === "your-alias") return 1;
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

  function init(videoEl, canvasEl) {
    video = videoEl;
    canvas = canvasEl;

    syncSize();
    if (!initPixiRenderer()) {
      ctx = canvas.getContext("2d");
      ctx.setTransform(_dpr, 0, 0, _dpr, 0, 0);
      pixiEnabled = false;
    }
    window.addEventListener("resize", () => {
      syncSize();
      draw();
    });
    if (window.ResizeObserver) {
      // Debounce redraws — ResizeObserver fires on every CSS animation tick otherwise
      let _roTimer = null;
      new ResizeObserver(() => {
        clearTimeout(_roTimer);
        _roTimer = setTimeout(() => { syncSize(); draw(); }, 150);
      }).observe(video);
    }
    video.addEventListener("loadedmetadata", () => {
      syncSize();
      loadAndDraw();
    });

    loadAndDraw();
    setInterval(loadAndDraw, 30000);

    // Hover detection — listen on the video element (canvas is pointer-events:none)
    video.addEventListener("mousemove", _onMouseMove);
    video.addEventListener("mouseleave", _onMouseLeave);

    window.addEventListener("count:update", (e) => {
      const detail = e.detail || {};
      const crossings = detail.new_crossings ?? 0;
      confirmedTotal = Number(detail.confirmed_crossings_total ?? confirmedTotal ?? 0);
      latestDetections = Array.isArray(detail.detections) ? detail.detections : [];
      if (crossings > 0) {
        flash();
        firePulseRings(latestDetections);
      } else draw();
    });
  }

  function syncSize() {
    if (!video || !canvas) return;
    _dpr = window.devicePixelRatio || 1;
    const cssW = video.clientWidth;
    const cssH = video.clientHeight;
    if (pixiEnabled && pixiApp?.renderer) {
      // Pixi manages canvas backing store via autoDensity; pass CSS dimensions
      pixiApp.renderer.resize(Math.max(1, cssW), Math.max(1, cssH));
    } else {
      canvas.width  = Math.round(cssW * _dpr);
      canvas.height = Math.round(cssH * _dpr);
      canvas.style.width  = cssW + "px";
      canvas.style.height = cssH + "px";
      if (ctx) ctx.setTransform(_dpr, 0, 0, _dpr, 0, 0);
    }
  }

  async function loadAndDraw(alias) {
    try {
      const cam = await resolveCamera(alias || null);
      countLine  = cam?.count_line  ?? null;
      detectZone = cam?.detect_zone ?? null;
      landmarks  = Array.isArray(cam?.landmarks) ? cam.landmarks : [];
      DetectionOverlay.setDetectZone(detectZone);
      _startAnimLoop();  // start scan particle loop once zones are loaded
      const detOverlay = cam?.feed_appearance?.detection_overlay || {};
      overlaySettings = {
        ...overlaySettings,
        ground_overlay_enabled: detOverlay.ground_overlay_enabled !== false,
        ground_occlusion_cutout: Number(detOverlay.ground_occlusion_cutout ?? overlaySettings.ground_occlusion_cutout),
      };
      draw();
    } catch (e) {
      console.warn("[ZoneOverlay] Failed to load zones:", e);
    }
  }

  // ── Hover: point-in-polygon (ray casting) ────────────────────
  function _pointInPoly(px, py, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x, yi = poly[i].y;
      const xj = poly[j].x, yj = poly[j].y;
      if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) {
        inside = !inside;
      }
    }
    return inside;
  }

  let _lastHoverMs = 0;
  function _onMouseMove(e) {
    if (!countLine) return;
    // Throttle to ~12fps — point-in-polygon is expensive at full mousemove rate
    const now = Date.now();
    if (now - _lastHoverMs < 80) return;
    _lastHoverMs = now;

    const rect = video.getBoundingClientRect();
    const cssX = e.clientX - rect.left;
    const cssY = e.clientY - rect.top;
    const bounds = getContentBounds(video);
    const pt = (rx, ry) => contentToPixel(rx, ry, bounds);
    const poly = _toPoints(countLine, pt);
    const nowHover = poly ? _pointInPoly(cssX, cssY, poly) : false;
    if (nowHover !== _hoverCountLine) {
      _hoverCountLine = nowHover;
      video.style.cursor = nowHover ? "crosshair" : "";
      draw();
    }
  }

  function _onMouseLeave() {
    if (_hoverCountLine) {
      _hoverCountLine = false;
      video.style.cursor = "";
      draw();
    }
  }

  function flash() {
    isFlashing = true;
    draw();
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      isFlashing = false;
      draw();
    }, 600);
  }

  function _startAnimLoop() {
    if (_animRafId) return;
    function tick() {
      draw();
      const now = Date.now();
      // Keep looping while rings are alive OR scan particle needs redraws
      const hasRings = _pulseRings.some(r => now - r.startMs < RING_DURATION_MS);
      if (hasRings || countLine) {
        _animRafId = requestAnimationFrame(tick);
      } else {
        _animRafId = null;
      }
    }
    _animRafId = requestAnimationFrame(tick);
  }

  function firePulseRings(detections) {
    const now = Date.now();
    const inZone = (detections || []).filter(d => d?.in_detect_zone !== false);
    inZone.slice(0, 4).forEach(d => {
      _pulseRings.push({ x: (d.x1 + d.x2) / 2, y: (d.y1 + d.y2) / 2, startMs: now });
    });
    // Prune dead rings
    _pulseRings = _pulseRings.filter(r => now - r.startMs < RING_DURATION_MS + 200);
    _startAnimLoop();
  }

  function draw() {
    if (pixiEnabled && pixiGraphics) {
      drawPixi();
      return;
    }
    if (!ctx || !canvas || !video) return;
    ctx.setTransform(_dpr, 0, 0, _dpr, 0, 0);
    ctx.clearRect(0, 0, video.clientWidth, video.clientHeight);

    const bounds = getContentBounds(video);
    const pt = (rx, ry) => contentToPixel(rx, ry, bounds);

    if (detectZone) _drawDetectZoneCanvas(detectZone, pt);
    const _effectiveLine = countLine || { x1: 0.0, y1: 0.55, x2: 1.0, y2: 0.55 };
    _drawCountLineCanvas(_effectiveLine, pt);
    if (_pulseRings.length) _drawPulseRings(bounds);

    _drawLandmarks(bounds);
  }

  function drawPixi() {
    if (!pixiGraphics || !canvas) return;
    pixiGraphics.clear();
    clearPixiTexts();

    const bounds = getContentBounds(video);
    const pt = (rx, ry) => contentToPixel(rx, ry, bounds);

    if (detectZone) _drawDetectZonePixi(detectZone, pt);
    const _effectiveLineP = countLine || { x1: 0.0, y1: 0.55, x2: 1.0, y2: 0.55 };
    _drawCountLinePixi(_effectiveLineP, pt);

    // Landmarks render on the 2D ctx even when Pixi is active (text/labels)
    if (ctx) _drawLandmarks(getContentBounds(video));
  }

  function _toPoints(zone, pt) {
    if (zone && Array.isArray(zone.points) && zone.points.length >= 3) {
      return zone.points
        .filter((p) => p && typeof p.x === "number" && typeof p.y === "number")
        .map((p) => pt(p.x, p.y));
    }
    if (zone && zone.x3 !== undefined) {
      return [
        pt(zone.x1, zone.y1),
        pt(zone.x2, zone.y2),
        pt(zone.x3, zone.y3),
        pt(zone.x4, zone.y4),
      ];
    }
    return null;
  }

  function _drawZone(zone, color, flashing, label, pt, hovering = false) {
    const poly = _toPoints(zone, pt);
    if (poly && poly.length >= 3) {
      ctx.beginPath();
      ctx.moveTo(poly[0].x, poly[0].y);
      poly.slice(1).forEach((p) => ctx.lineTo(p.x, p.y));
      ctx.closePath();

      ctx.fillStyle = flashing
        ? "rgba(0,255,136,0.16)"
        : hovering
          ? (color === "#00BCD4" ? "rgba(0,188,212,0.22)" : "rgba(255,214,0,0.22)")
          : color === "#00BCD4"
            ? "rgba(0,188,212,0.08)"
            : "rgba(255,214,0,0.10)";
      ctx.fill();

      ctx.strokeStyle = color;
      ctx.lineWidth = flashing ? 3 : hovering ? 3 : 2;
      ctx.setLineDash(flashing || color !== "#00BCD4" ? [] : [8, 5]);

      // Glow on hover
      if (hovering && !flashing) {
        ctx.shadowColor = color;
        ctx.shadowBlur = 14;
      }
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.shadowColor = "transparent";
      ctx.setLineDash([]);

      if (label) {
        const cx = poly.reduce((s, p) => s + p.x, 0) / poly.length;
        const cy = poly.reduce((s, p) => s + p.y, 0) / poly.length;
        ctx.font = "700 12px Manrope, sans-serif";
        ctx.fillStyle = `${color}DD`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(label, cx, cy);
      }
      applyVehicleOcclusion();
      return;
    }

    if (zone && zone.x1 !== undefined) {
      const p1 = pt(zone.x1, zone.y1);
      const p2 = pt(zone.x2, zone.y2);
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.strokeStyle = color;
      ctx.lineWidth = flashing ? 4 : 3;
      ctx.setLineDash(flashing ? [] : [10, 6]);
      ctx.stroke();
      ctx.setLineDash([]);
      if (label) {
        const mx = (p1.x + p2.x) / 2;
        const my = (p1.y + p2.y) / 2 - 10;
        ctx.font = "700 12px Manrope, sans-serif";
        ctx.fillStyle = `${color}DD`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(label, mx, my);
      }
      applyVehicleOcclusion();
    }
  }

  function _drawZonePixi(zone, color, flashing, label, pt, hovering = false) {
    const poly = _toPoints(zone, pt);
    const colorNum = hexToPixi(color);
    if (poly && poly.length >= 3) {
      const fillAlpha = flashing
        ? 0.16
        : hovering
          ? 0.22
          : color === "#00BCD4"
            ? 0.08
            : 0.10;

      pixiGraphics.beginFill(colorNum, fillAlpha);
      pixiGraphics.lineStyle(flashing ? 3 : hovering ? 3 : 2, colorNum, 1);
      pixiGraphics.moveTo(poly[0].x, poly[0].y);
      for (let i = 1; i < poly.length; i += 1) {
        pixiGraphics.lineTo(poly[i].x, poly[i].y);
      }
      pixiGraphics.lineTo(poly[0].x, poly[0].y);
      pixiGraphics.endFill();

      if (label) {
        const cx = poly.reduce((s, p) => s + p.x, 0) / poly.length;
        const cy = poly.reduce((s, p) => s + p.y, 0) / poly.length;
        addPixiLabel(label, cx, cy, colorNum);
      }
      return;
    }

    if (zone && zone.x1 !== undefined) {
      const p1 = pt(zone.x1, zone.y1);
      const p2 = pt(zone.x2, zone.y2);
      pixiGraphics.lineStyle(flashing ? 4 : 3, colorNum, 1);
      pixiGraphics.moveTo(p1.x, p1.y);
      pixiGraphics.lineTo(p2.x, p2.y);
      if (label) {
        const mx = (p1.x + p2.x) / 2;
        const my = (p1.y + p2.y) / 2 - 10;
        addPixiLabel(label, mx, my, colorNum);
      }
    }
  }

  // ── New visual drawing functions ─────────────────────────────

  function _drawDetectZoneCanvas(zone, pt) {
    const poly = _toPoints(zone, pt);
    if (!poly || poly.length < 3) return;
    ctx.save();
    // Subtle fill
    ctx.beginPath();
    ctx.moveTo(poly[0].x, poly[0].y);
    poly.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
    ctx.closePath();
    ctx.fillStyle = 'rgba(0,212,255,0.04)';
    ctx.fill();
    // Dashed perimeter
    ctx.beginPath();
    ctx.moveTo(poly[0].x, poly[0].y);
    poly.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
    ctx.closePath();
    ctx.strokeStyle = '#00D4FF';
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.65;
    // Animated flowing dashes — offset shifts over time for "active scan" feel
    const dashOffset = (Date.now() / 40) % 20;
    ctx.setLineDash([6, 4]);
    ctx.lineDashOffset = -dashOffset;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;
    // SCAN label above the topmost vertex
    const top = poly.reduce((t, p) => p.y < t.y ? p : t, poly[0]);
    ctx.globalAlpha = 1;
    ctx.font = '700 9px "JetBrains Mono", monospace';
    ctx.fillStyle = 'rgba(0,212,255,0.7)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText('SCAN', top.x, top.y - 4);
    ctx.restore();
  }

  function _drawPulseRings(bounds) {
    // Expanding concentric rings at pre-counted vehicle positions
    const now = Date.now();
    _pulseRings.forEach(ring => {
      const age = now - ring.startMs;
      if (age > RING_DURATION_MS) return;
      const t = age / RING_DURATION_MS;            // 0→1
      const alpha = (1 - t) * 0.7;
      const px = bounds.x + ring.x * bounds.w;
      const py = bounds.y + ring.y * bounds.h;
      // Two rings: inner fast, outer slow
      [0.5, 1.0].forEach((scale, idx) => {
        const r = (30 + 60 * t * scale);
        ctx.save();
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(0,212,255,${alpha * (idx === 0 ? 0.9 : 0.5)})`;
        ctx.lineWidth = idx === 0 ? 1.5 : 1;
        ctx.shadowColor = '#00D4FF';
        ctx.shadowBlur = 6;
        ctx.stroke();
        ctx.restore();
      });
    });
    // Prune dead rings (keep only active ones)
    _pulseRings = _pulseRings.filter(r => now - r.startMs < RING_DURATION_MS);
  }

  function _drawCountLineCanvas(zone, pt) {
    if (!zone || zone.x1 === undefined) return;
    const p1 = pt(zone.x1, zone.y1);
    const p2 = pt(zone.x2, zone.y2);
    const flash = isFlashing;
    const lineColor = flash ? '#00FF88' : '#FFD600';
    const dx = p2.x - p1.x, dy = p2.y - p1.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const nx = -dy / len, ny = dx / len;  // unit perpendicular

    // Wide soft glow halo
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = flash ? 14 : 10;
    ctx.globalAlpha = 0.12;
    ctx.shadowColor = lineColor;
    ctx.shadowBlur = flash ? 28 : 18;
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.restore();

    // Glow halo pass (tighter)
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = flash ? 6 : 4;
    ctx.globalAlpha = 0.22;
    ctx.shadowColor = lineColor;
    ctx.shadowBlur = flash ? 16 : 10;
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.restore();

    // Main line
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = flash ? 2.5 : 1.5;
    ctx.globalAlpha = 1;
    ctx.shadowColor = lineColor;
    ctx.shadowBlur = flash ? 10 : 5;
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.restore();

    // Perpendicular tick marks — visually show the pixel-trigger zone
    const tickSpacing = 24;
    const nTicks = Math.floor(len / tickSpacing);
    const tickLen = flash ? 7 : 5;
    ctx.save();
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 1;
    ctx.globalAlpha = flash ? 0.55 : 0.30;
    ctx.lineCap = 'round';
    for (let i = 1; i < nTicks; i++) {
      const t = i / nTicks;
      const tx = p1.x + dx * t, ty = p1.y + dy * t;
      ctx.beginPath();
      ctx.moveTo(tx + nx * tickLen, ty + ny * tickLen);
      ctx.lineTo(tx - nx * tickLen, ty - ny * tickLen);
      ctx.stroke();
    }
    ctx.restore();

    // Scan particle — bright dot bouncing along the line
    if (!flash) {
      const period = 2400;
      const tRaw = (Date.now() % (period * 2)) / period;
      const tBounce = tRaw <= 1 ? tRaw : 2 - tRaw;
      const spx = p1.x + dx * tBounce, spy = p1.y + dy * tBounce;
      ctx.save();
      ctx.beginPath();
      ctx.arc(spx, spy, 3, 0, Math.PI * 2);
      ctx.fillStyle = '#FFFFFF';
      ctx.shadowColor = lineColor;
      ctx.shadowBlur = 10;
      ctx.globalAlpha = 0.85;
      ctx.fill();
      ctx.restore();
    }

    // End caps — filled circle + short perpendicular wings
    [p1, p2].forEach(p => {
      ctx.save();
      ctx.beginPath();
      ctx.arc(p.x, p.y, flash ? 5 : 4, 0, Math.PI * 2);
      ctx.fillStyle = lineColor;
      ctx.shadowColor = lineColor;
      ctx.shadowBlur = flash ? 14 : 8;
      ctx.fill();
      // Wing lines perpendicular to the count line
      ctx.beginPath();
      ctx.moveTo(p.x + nx * 8, p.y + ny * 8);
      ctx.lineTo(p.x - nx * 8, p.y - ny * 8);
      ctx.strokeStyle = lineColor;
      ctx.lineWidth = flash ? 2 : 1.5;
      ctx.globalAlpha = 0.6;
      ctx.stroke();
      ctx.restore();
    });

    // Count badge above midpoint
    const mx = (p1.x + p2.x) / 2;
    const my = (p1.y + p2.y) / 2;
    const label = String(confirmedTotal);
    ctx.save();
    ctx.font = '700 15px Rajdhani, sans-serif';
    const tw = ctx.measureText(label).width;
    const padX = 9, bh = 22;
    const bw = Math.max(tw + padX * 2, 34);
    const bx = mx - bw / 2;
    const by = my - bh - 10;
    // Badge background
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(bx, by, bw, bh, 4);
    else ctx.rect(bx, by, bw, bh);
    ctx.fillStyle = flash ? 'rgba(0,255,136,0.18)' : 'rgba(0,0,0,0.78)';
    ctx.fill();
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 1;
    ctx.shadowColor = lineColor;
    ctx.shadowBlur = flash ? 8 : 4;
    ctx.stroke();
    // Badge text
    ctx.shadowBlur = 0;
    ctx.fillStyle = lineColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, mx, by + bh / 2);
    ctx.restore();

    applyVehicleOcclusion();
  }

  function _drawDetectZonePixi(zone, pt) {
    const poly = _toPoints(zone, pt);
    if (!poly || poly.length < 3) return;
    // Subtle fill (Pixi solid — no dashes available)
    pixiGraphics.beginFill(0x00D4FF, 0.04);
    pixiGraphics.lineStyle(1.5, 0x00D4FF, 0.65);
    pixiGraphics.moveTo(poly[0].x, poly[0].y);
    for (let i = 1; i < poly.length; i++) pixiGraphics.lineTo(poly[i].x, poly[i].y);
    pixiGraphics.lineTo(poly[0].x, poly[0].y);
    pixiGraphics.endFill();
    // SCAN label
    const top = poly.reduce((t, p) => p.y < t.y ? p : t, poly[0]);
    addPixiLabel('SCAN', top.x, top.y - 10, 0x00D4FF);
  }

  function _drawCountLinePixi(zone, pt) {
    if (!zone || zone.x1 === undefined) return;
    const p1 = pt(zone.x1, zone.y1);
    const p2 = pt(zone.x2, zone.y2);
    const flash = isFlashing;
    const col = flash ? 0x00FF88 : 0xFFB800;

    // Glow pass
    pixiGraphics.lineStyle(flash ? 8 : 5, col, 0.20);
    pixiGraphics.moveTo(p1.x, p1.y);
    pixiGraphics.lineTo(p2.x, p2.y);

    // Main line
    pixiGraphics.lineStyle(flash ? 3 : 2, col, 1);
    pixiGraphics.moveTo(p1.x, p1.y);
    pixiGraphics.lineTo(p2.x, p2.y);

    // End caps
    [p1, p2].forEach(p => {
      pixiGraphics.beginFill(col, 1);
      pixiGraphics.lineStyle(0);
      pixiGraphics.drawCircle(p.x, p.y, 4);
      pixiGraphics.endFill();
    });

    // Count badge label
    const mx = (p1.x + p2.x) / 2;
    const my = (p1.y + p2.y) / 2 - 20;
    addPixiLabel(String(confirmedTotal), mx, my, col);
  }

  const LM_TYPE_COLOR = {
    busstop:  '#00d4ff',
    sign:     '#f59e0b',
    crossing: '#fbbf24',
    light:    '#22c55e',
    junction: '#94a3b8',
    camera:   '#64748b',
    road:     '#e2e8f0',
    note:     '#a78bfa',
  };
  const LM_TYPE_ABBR = {
    busstop: 'B', sign: 'S', crossing: 'X', light: 'L',
    junction: 'J', camera: 'C', road: 'R', note: 'N',
  };

  function _drawLandmarks(bounds) {
    if (!ctx || !Array.isArray(landmarks) || !landmarks.length) return;
    landmarks.forEach((lm) => {
      if (typeof lm.x !== 'number' || typeof lm.y !== 'number') return;
      const px  = lm.x * bounds.w + bounds.x;
      const py  = lm.y * bounds.h + bounds.y;
      const col = LM_TYPE_COLOR[lm.type] || '#a78bfa';
      const abbr = LM_TYPE_ABBR[lm.type] || 'N';
      const R   = 9;

      // Stem
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px, py - R - 4);
      ctx.strokeStyle = col + 'aa';
      ctx.lineWidth   = 1.5;
      ctx.stroke();

      // Circle
      ctx.beginPath();
      ctx.arc(px, py - R - 4, R, 0, Math.PI * 2);
      ctx.fillStyle   = '#0d1117cc';
      ctx.fill();
      ctx.strokeStyle = col;
      ctx.lineWidth   = 1.5;
      ctx.stroke();

      // Abbr
      ctx.font         = '700 8px "JetBrains Mono", monospace';
      ctx.fillStyle    = col;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(abbr, px, py - R - 4);

      // Label tag
      if (lm.label) {
        ctx.font = '500 9px Manrope, sans-serif';
        const tw  = ctx.measureText(lm.label).width;
        const pad = 4;
        const bw  = tw + pad * 2;
        const bh  = 9 + pad * 2;
        const bx  = px - bw / 2;
        const by  = py - R - 4 - R - 4 - bh;

        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(bx, by, bw, bh, 3);
        else ctx.rect(bx, by, bw, bh);
        ctx.fillStyle   = '#0d1117ee';
        ctx.fill();
        ctx.strokeStyle = col + '55';
        ctx.lineWidth   = 1;
        ctx.stroke();

        ctx.fillStyle    = col + 'ee';
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(lm.label, px, by + bh - pad - 1);
      }
    });
  }

  function applyVehicleOcclusion() {
    if (!ctx) return;
    if (!Array.isArray(latestDetections) || latestDetections.length === 0) return;
    const bounds = getContentBounds(video);
    const cut = Math.max(0, Math.min(0.85, Number(overlaySettings.ground_occlusion_cutout) || 0.38));
    if (cut <= 0) return;
    for (const det of latestDetections) {
      const dp1 = contentToPixel(det?.x1, det?.y1, bounds);
      const dp2 = contentToPixel(det?.x2, det?.y2, bounds);
      const bw = dp2.x - dp1.x;
      const bh = dp2.y - dp1.y;
      if (bw < 3 || bh < 3) continue;
      const ch = bh * cut;
      const cy = dp2.y - ch;
      ctx.clearRect(dp1.x - 1, cy, bw + 2, ch + 2);
    }
  }

  function reloadZones(alias) {
    // Clear stale detection boxes immediately before loading new zones
    latestDetections = [];
    confirmedTotal = 0;
    draw();
    loadAndDraw(alias || null);
  }

export const ZoneOverlay = { init, reloadZones };
