/**
 * admin-line.js — Dual zone canvas editor for admin.
 * Three modes toggled by buttons:
 *   - DETECT ZONE (cyan): bounding-box filter zone
 *   - COUNT ZONE (yellow): crossing/counting zone
 *   - GROUND QUAD (aqua): perspective quad for ground overlay
 * Click points to define zones:
 *   - Detect: unlimited points (more complex polygon)
 *   - Count: fixed 4 points (counting polygon)
 *   - Ground: fixed 4 points (top-left -> top-right -> bottom-right -> bottom-left)
 */

const AdminLine = (() => {
  // Preset A — Day / clear conditions
  const DEFAULT_COUNT_SETTINGS = {
    min_track_frames: 2,
    min_box_area_ratio: 0.001,
    min_confidence: 0.28,
    allowed_classes: ["car", "truck", "bus", "motorcycle"],
    class_min_confidence: {
      car: 0.22,
      truck: 0.25,
      bus: 0.25,
      motorcycle: 0.22,
    },
  };
  // Preset B — Night / low-light
  const COUNT_SETTINGS_NIGHT_PRESET = {
    min_track_frames: 2,
    min_box_area_ratio: 0.001,
    min_confidence: 0.22,
    allowed_classes: ["car", "truck", "bus", "motorcycle"],
    class_min_confidence: {
      car: 0.20,
      truck: 0.22,
      bus: 0.22,
      motorcycle: 0.20,
    },
  };

  let canvas, ctx, video;
  let cameraId = null;
  let isSaving = false;
  let isInitialized = false;
  let feedAppearanceCache = {};

  // Active mode: "detect" | "count" | "ground"
  let activeMode = "count";

  // Points per zone
  let detectPoints = [];  // [{rx, ry}]
  let countPoints  = [];  // [{rx, ry}]
  let groundPoints = [];  // [{rx, ry}]
  let showGuides = true;
  let snapToGuides = true;
  let autoGroundFromZones = true;
  const DETECT_MAX_POINTS = Number.POSITIVE_INFINITY;
  const COUNT_MAX_POINTS = 4;
  const COUNT_MIN_POINTS = 2;
  const GROUND_MAX_POINTS = 4;
  const GUIDE_ROWS = 8;
  const GUIDE_SNAP_PX = 14;
  const DETECTION_SETTINGS_STORAGE_KEY = "whitelinez.detection.overlay_settings.v4";

  function init(videoEl, canvasEl, camId) {
    video    = videoEl;
    canvas   = canvasEl;
    ctx      = canvas?.getContext?.("2d") || null;
    cameraId = camId;

    if (!video || !canvas || !ctx) {
      console.warn("[AdminLine] init skipped: missing video/canvas/context");
      return;
    }

    if (!isInitialized) {
      window.addEventListener("resize", () => refresh());
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) refresh();
      });
      video.addEventListener("loadedmetadata", () => {
        refresh();
        loadExistingZones();
      });
      video.addEventListener("playing", refresh);

      canvas.addEventListener("click", handleClick);
      document.getElementById("btn-clear-line")?.addEventListener("click", clearActive);
      document.getElementById("btn-save-line")?.addEventListener("click", saveZones);
      document.getElementById("btn-save-count-settings")?.addEventListener("click", saveCountSettingsOnly);
      document.getElementById("btn-count-preset-balanced")?.addEventListener("click", () => {
        applyCountSettingsToForm(DEFAULT_COUNT_SETTINGS);
        updateCountSettingsStatus("Preset A applied. Click Save Count Tuning.");
      });
      document.getElementById("btn-count-preset-night")?.addEventListener("click", () => {
        applyCountSettingsToForm(COUNT_SETTINGS_NIGHT_PRESET);
        updateCountSettingsStatus("Preset B applied. Click Save Count Tuning.");
      });

      // Zone toggle buttons
      document.getElementById("btn-zone-detect")?.addEventListener("click", () => setMode("detect"));
      document.getElementById("btn-zone-count")?.addEventListener("click",  () => setMode("count"));
      document.getElementById("btn-zone-ground")?.addEventListener("click", () => setMode("ground"));
      document.getElementById("btn-zone-guides")?.addEventListener("click", toggleGuides);
      document.getElementById("btn-zone-snap")?.addEventListener("click", toggleSnap);
      isInitialized = true;
    }

    refresh();
    setTimeout(refresh, 120);
    setTimeout(refresh, 380);
    if (video.videoWidth) loadExistingZones();
    updateModeUI();
  }

  function setMode(mode) {
    activeMode = mode;
    updateModeUI();
    let label = "Count Band — click 4 points over the road. Yellow midline = crossing trigger.";
    if (mode === "detect") label = "Detect Filter — draw polygon around road area (optional).";
    if (mode === "ground") label = "3D Mask — click 4 corners of road surface for ground overlay.";
    if (mode === "landmarks") label = "Labels — click to place landmark markers.";
    updateStatus(label);
  }

  function updateModeUI() {
    const btnDetect = document.getElementById("btn-zone-detect");
    const btnCount  = document.getElementById("btn-zone-count");
    const btnGround = document.getElementById("btn-zone-ground");
    const btnGuides = document.getElementById("btn-zone-guides");
    const btnSnap = document.getElementById("btn-zone-snap");
    if (btnDetect) btnDetect.classList.toggle("active", activeMode === "detect");
    if (btnCount)  btnCount.classList.toggle("active",  activeMode === "count");
    if (btnGround) btnGround.classList.toggle("active", activeMode === "ground");
    if (btnGuides) {
      btnGuides.classList.toggle("active", showGuides);
      btnGuides.textContent = showGuides ? "Guides On" : "Guides Off";
      btnGuides.setAttribute("aria-pressed", showGuides ? "true" : "false");
    }
    if (btnSnap) {
      btnSnap.classList.toggle("active", snapToGuides);
      btnSnap.textContent = snapToGuides ? "Snap On" : "Snap Off";
      btnSnap.setAttribute("aria-pressed", snapToGuides ? "true" : "false");
    }
  }

  function toggleGuides() {
    showGuides = !showGuides;
    updateModeUI();
    redraw();
    updateStatus(showGuides ? "Perspective guides enabled" : "Perspective guides hidden");
  }

  function toggleSnap() {
    snapToGuides = !snapToGuides;
    updateModeUI();
    updateStatus(snapToGuides ? "Snap-to-guides enabled" : "Snap-to-guides disabled");
  }

  function syncSize() {
    if (!video || !canvas || !ctx) return;
    const w = Math.round(video.clientWidth || video.getBoundingClientRect().width || 0);
    const h = Math.round(video.clientHeight || video.getBoundingClientRect().height || 0);
    if (w > 0 && h > 0) {
      canvas.width = w;
      canvas.height = h;
    }
  }

  function refresh() {
    if (!canvas || !video) return;
    if (!ctx && canvas?.getContext) {
      ctx = canvas.getContext("2d");
    }
    if (!ctx) return;
    syncSize();
    redraw();
  }

  async function loadExistingZones() {
    if (!cameraId) return;
    try {
      let data = null;
      try {
        const primary = await window.sb
          .from("cameras")
          .select("count_line, detect_zone, count_settings, feed_appearance")
          .eq("id", cameraId)
          .single();
        if (primary.error) throw primary.error;
        data = primary.data;
      } catch {
        const fallback = await window.sb
          .from("cameras")
          .select("count_line, detect_zone, feed_appearance")
          .eq("id", cameraId)
          .single();
        if (fallback.error) throw fallback.error;
        data = fallback.data;
      }

      const countLine  = data?.count_line;
      const detectZone = data?.detect_zone;
      const feedAppearance = data?.feed_appearance || {};
      feedAppearanceCache = feedAppearance && typeof feedAppearance === "object" ? { ...feedAppearance } : {};
      applyCountSettingsToForm(data?.count_settings);

      if (countLine?.x3 !== undefined) {
        countPoints = [
          { rx: countLine.x1, ry: countLine.y1 },
          { rx: countLine.x2, ry: countLine.y2 },
          { rx: countLine.x3, ry: countLine.y3 },
          { rx: countLine.x4, ry: countLine.y4 },
        ];
      } else if (countLine?.x1 !== undefined) {
        countPoints = [
          { rx: countLine.x1, ry: countLine.y1 },
          { rx: countLine.x2, ry: countLine.y2 },
        ];
      }

      if (Array.isArray(detectZone?.points) && detectZone.points.length >= 3) {
        detectPoints = detectZone.points
          .filter((p) => p && typeof p.x === "number" && typeof p.y === "number")
          .map((p) => ({ rx: p.x, ry: p.y }));
      } else if (detectZone?.x3 !== undefined) {
        detectPoints = [
          { rx: detectZone.x1, ry: detectZone.y1 },
          { rx: detectZone.x2, ry: detectZone.y2 },
          { rx: detectZone.x3, ry: detectZone.y3 },
          { rx: detectZone.x4, ry: detectZone.y4 },
        ];
      } else if (detectZone?.x1 !== undefined) {
        detectPoints = [
          { rx: detectZone.x1, ry: detectZone.y1 },
          { rx: detectZone.x2, ry: detectZone.y2 },
        ];
      }

      const groundQuad = feedAppearance?.detection_overlay?.ground_quad;
      if (groundQuad && typeof groundQuad === "object") {
        const pts = [
          { rx: Number(groundQuad.x1), ry: Number(groundQuad.y1) },
          { rx: Number(groundQuad.x2), ry: Number(groundQuad.y2) },
          { rx: Number(groundQuad.x3), ry: Number(groundQuad.y3) },
          { rx: Number(groundQuad.x4), ry: Number(groundQuad.y4) },
        ];
        if (pts.every((p) => Number.isFinite(p.rx) && Number.isFinite(p.ry))) {
          groundPoints = pts;
          applyGroundQuadToControls(groundPoints);
        }
      } else {
        groundPoints = readGroundQuadFromControls();
      }

      redraw();
      updateZoneValidityStatus("Zones loaded — click to redraw active zone");
    } catch (e) {
      console.warn("[AdminLine] Could not load zones:", e);
    }
  }

  function handleClick(e) {
    const rect  = canvas.getBoundingClientRect();
    let px    = e.clientX - rect.left;
    let py    = e.clientY - rect.top;
    if (snapToGuides && showGuides && activeMode !== "ground") {
      const snapped = snapPointToGuides(px, py);
      if (snapped) {
        px = snapped.x;
        py = snapped.y;
      }
    }
    const bounds = getContentBounds(video);
    const { x: rx, y: ry } = pixelToContent(px, py, bounds);

    const maxPts =
      activeMode === "detect"
        ? DETECT_MAX_POINTS
        : activeMode === "ground"
          ? GROUND_MAX_POINTS
          : COUNT_MAX_POINTS;
    if (activeMode === "detect") {
      detectPoints.push({ rx, ry });
    } else if (activeMode === "ground") {
      if (groundPoints.length >= maxPts) groundPoints = [];
      groundPoints.push({ rx, ry });
      if (groundPoints.length === GROUND_MAX_POINTS) {
        applyGroundQuadToControls(groundPoints);
        updateStatus("3D mask updated. Click Save Zones to persist.");
      }
    } else {
      if (countPoints.length >= maxPts) countPoints = [];
      countPoints.push({ rx, ry });
    }

    if (autoGroundFromZones && activeMode !== "ground") {
      autoUpdateGroundFromZones();
    }
    redraw();

    updateZoneValidityStatus();
  }

  function toCanvas(rp) {
    const bounds = getContentBounds(video);
    return contentToPixel(rp.rx, rp.ry, bounds);
  }

  function redraw() {
    if (!canvas) return;
    if (!ctx && canvas?.getContext) {
      ctx = canvas.getContext("2d");
    }
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawPerspectiveGuides();

    // Draw detect zone (cyan) — optional filter area
    if (detectPoints.length > 0) {
      _drawPoints(detectPoints, "#00BCD4", "DETECT FILTER");
    }

    // Draw count band (yellow) — with midline when 4 points defined
    if (countPoints.length > 0) {
      if (countPoints.length === 4) {
        _drawCountBand(countPoints);
      } else {
        _drawPoints(countPoints, "#FFD600", "COUNT BAND");
      }
    }

    // Draw ground quad (aqua)
    if (groundPoints.length > 0) {
      _drawPoints(groundPoints, "#36CCFF", "GROUND QUAD");
    }
  }

  function drawPerspectiveGuides() {
    if (!showGuides || !ctx) return;
    const geom = getGuideGeometry();
    if (!geom) return;
    const { tl, tr, br, bl } = geom;

    // Baseline road plane fill (very subtle).
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(tl.x, tl.y);
    ctx.lineTo(tr.x, tr.y);
    ctx.lineTo(br.x, br.y);
    ctx.lineTo(bl.x, bl.y);
    ctx.closePath();
    ctx.fillStyle = "rgba(54, 204, 255, 0.05)";
    ctx.fill();

    // Outer rails.
    ctx.strokeStyle = "rgba(140, 224, 255, 0.55)";
    ctx.lineWidth = 1.2;
    ctx.setLineDash([6, 4]);
    drawLine(tl, bl);
    drawLine(tr, br);
    ctx.setLineDash([]);

    // Perspective row guides inside the quad.
    for (let i = 1; i < GUIDE_ROWS; i += 1) {
      const t = i / GUIDE_ROWS;
      const u = t * t; // denser near horizon.
      const l = lerpPoint(tl, bl, u);
      const r = lerpPoint(tr, br, u);
      ctx.strokeStyle = "rgba(140, 224, 255, 0.22)";
      ctx.lineWidth = 1;
      drawLine(l, r);
    }

    // Center guide.
    const topMid = lerpPoint(tl, tr, 0.5);
    const botMid = lerpPoint(bl, br, 0.5);
    ctx.strokeStyle = "rgba(255, 214, 0, 0.36)";
    ctx.lineWidth = 1.1;
    ctx.setLineDash([4, 4]);
    drawLine(topMid, botMid);
    ctx.setLineDash([]);

    ctx.restore();
  }

  function getGuideGeometry() {
    const src = groundPoints.length >= 4 ? groundPoints.slice(0, 4) : readGroundQuadFromControls();
    if (!Array.isArray(src) || src.length < 4) return null;
    const quad = src.map(toCanvas);
    if (quad.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return null;
    return { tl: quad[0], tr: quad[1], br: quad[2], bl: quad[3] };
  }

  function getGuideSegments() {
    const geom = getGuideGeometry();
    if (!geom) return [];
    const { tl, tr, br, bl } = geom;
    const topMid = lerpPoint(tl, tr, 0.5);
    const botMid = lerpPoint(bl, br, 0.5);
    const segs = [
      { a: tl, b: bl, kind: "left rail" },
      { a: tr, b: br, kind: "right rail" },
      { a: topMid, b: botMid, kind: "center line" },
    ];
    for (let i = 0; i <= GUIDE_ROWS; i += 1) {
      const t = i / GUIDE_ROWS;
      const u = t * t;
      segs.push({
        a: lerpPoint(tl, bl, u),
        b: lerpPoint(tr, br, u),
        kind: "grid row",
      });
    }
    return segs;
  }

  function snapPointToGuides(px, py) {
    const p = { x: px, y: py };
    const segments = getGuideSegments();
    if (!segments.length) return null;

    let best = null;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const seg of segments) {
      const proj = projectPointToSegment(p, seg.a, seg.b);
      if (!proj) continue;
      if (proj.dist < bestDist) {
        bestDist = proj.dist;
        best = { x: proj.x, y: proj.y, kind: seg.kind };
      }
    }
    if (!best || bestDist > GUIDE_SNAP_PX) return null;
    return best;
  }

  function projectPointToSegment(p, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-6) return null;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    const x = a.x + t * dx;
    const y = a.y + t * dy;
    const dist = Math.hypot(p.x - x, p.y - y);
    return { x, y, dist };
  }

  function drawLine(a, b) {
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  function lerpPoint(a, b, t) {
    return {
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
    };
  }

  function lineIntersection(p1, p2, p3, p4) {
    const x1 = p1.x; const y1 = p1.y;
    const x2 = p2.x; const y2 = p2.y;
    const x3 = p3.x; const y3 = p3.y;
    const x4 = p4.x; const y4 = p4.y;
    const den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
    if (Math.abs(den) < 1e-8) return null;
    const numX = (x1 * y2 - y1 * x2) * (x3 - x4) - (x1 - x2) * (x3 * y4 - y3 * x4);
    const numY = (x1 * y2 - y1 * x2) * (y3 - y4) - (y1 - y2) * (x3 * y4 - y3 * x4);
    return { x: numX / den, y: numY / den };
  }

  function _drawPoints(pts, color, label) {
    const px = pts.map(toCanvas);
    if (pts.length >= 3) {
      ctx.beginPath();
      ctx.moveTo(px[0].x, px[0].y);
      px.slice(1).forEach((p) => ctx.lineTo(p.x, p.y));
      ctx.closePath();

      const fill = color === "#00BCD4" ? "rgba(0,188,212,0.10)" : "rgba(255,214,0,0.12)";
      ctx.fillStyle = fill;
      ctx.fill();

      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.setLineDash([8, 5]);
      ctx.stroke();
      ctx.setLineDash([]);

      const cx = px.reduce((s, p) => s + p.x, 0) / px.length;
      const cy = px.reduce((s, p) => s + p.y, 0) / px.length;
      ctx.font = "bold 11px sans-serif";
      ctx.fillStyle = color;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, cx, cy);
    } else if (pts.length > 1) {
      ctx.beginPath();
      ctx.moveTo(px[0].x, px[0].y);
      px.slice(1).forEach((p) => ctx.lineTo(p.x, p.y));
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.setLineDash([8, 5]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Corner dots
    px.forEach((p, i) => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = "#000";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = "#000";
      ctx.font = "bold 9px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(i + 1, p.x, p.y);
    });
  }

  function _drawCountBand(pts) {
    const px = pts.map(toCanvas);
    const [p1, p2, p3, p4] = px;

    // Band fill
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.lineTo(p3.x, p3.y);
    ctx.lineTo(p4.x, p4.y);
    ctx.closePath();
    ctx.fillStyle = "rgba(255,214,0,0.10)";
    ctx.fill();

    // Band outline (dashed)
    ctx.strokeStyle = "rgba(255,214,0,0.55)";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([7, 5]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Midline: midpoint(p1,p4) → midpoint(p2,p3)  — matches backend formula
    const mx1 = (p1.x + p4.x) / 2;
    const my1 = (p1.y + p4.y) / 2;
    const mx2 = (p2.x + p3.x) / 2;
    const my2 = (p2.y + p3.y) / 2;

    // Midline glow
    ctx.beginPath();
    ctx.moveTo(mx1, my1);
    ctx.lineTo(mx2, my2);
    ctx.strokeStyle = "rgba(255,214,0,0.25)";
    ctx.lineWidth = 8;
    ctx.stroke();

    // Midline solid
    ctx.beginPath();
    ctx.moveTo(mx1, my1);
    ctx.lineTo(mx2, my2);
    ctx.strokeStyle = "#FFD600";
    ctx.lineWidth = 2.5;
    ctx.stroke();

    // Direction arrows along midline
    const dx = mx2 - mx1;
    const dy = my2 - my1;
    const len = Math.hypot(dx, dy);
    if (len > 0) {
      const ux = dx / len;
      const uy = dy / len;
      // Perpendicular arrows at 30% and 70%
      [0.30, 0.70].forEach(t => {
        const ax = mx1 + dx * t;
        const ay = my1 + dy * t;
        const arrowLen = 9;
        const angle = Math.PI / 6; // 30°
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(
          ax - arrowLen * (ux * Math.cos(angle) - uy * Math.sin(angle)),
          ay - arrowLen * (uy * Math.cos(angle) + ux * Math.sin(angle)),
        );
        ctx.moveTo(ax, ay);
        ctx.lineTo(
          ax - arrowLen * (ux * Math.cos(-angle) - uy * Math.sin(-angle)),
          ay - arrowLen * (uy * Math.cos(-angle) + ux * Math.sin(-angle)),
        );
        ctx.strokeStyle = "#FFD600";
        ctx.lineWidth = 2;
        ctx.stroke();
      });
    }

    // Label on midline
    const labelX = (mx1 + mx2) / 2;
    const labelY = (my1 + my2) / 2;
    ctx.font = "bold 11px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(0,0,0,0.65)";
    ctx.fillText("CROSSING LINE", labelX + 1, labelY + 1);
    ctx.fillStyle = "#FFD600";
    ctx.fillText("CROSSING LINE", labelX, labelY);

    // Corner dots with numbers
    px.forEach((p, i) => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
      ctx.fillStyle = "#FFD600";
      ctx.fill();
      ctx.strokeStyle = "#000";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = "#000";
      ctx.font = "bold 9px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(i + 1, p.x, p.y);
    });
  }

  function clearActive() {
    if (activeMode === "detect") detectPoints = [];
    else if (activeMode === "ground") {
      groundPoints = [];
      applyGroundQuadToControls(groundPoints);
    }
    else countPoints = [];
    redraw();
    updateZoneValidityStatus("Zone cleared");
  }

  async function saveZones() {
    if (isSaving) return;
    const validity = getZoneValidity();
    if (!validity.ok) {
      updateStatus(`Fix zone before save: ${validity.errors[0]}`);
      return;
    }
    isSaving = true;
    updateStatus("Saving...");

    const toRel4 = (pts) => {
      if (pts.length < 4) return null;
      return {
        x1: pts[0].rx, y1: pts[0].ry,
        x2: pts[1].rx, y2: pts[1].ry,
        x3: pts[2].rx, y3: pts[2].ry,
        x4: pts[3].rx, y4: pts[3].ry,
      };
    };
    const toRel2 = (pts) => {
      if (pts.length < 2) return null;
      return {
        x1: pts[0].rx, y1: pts[0].ry,
        x2: pts[1].rx, y2: pts[1].ry,
      };
    };

    const updateData = {};
    if (countPoints.length >= COUNT_MAX_POINTS) {
      updateData.count_line = toRel4(countPoints);
    } else if (countPoints.length >= COUNT_MIN_POINTS) {
      updateData.count_line = toRel2(countPoints);
    }
    if (detectPoints.length >= 3) {
      updateData.detect_zone = {
        points: detectPoints.map((p) => ({ x: p.rx, y: p.ry })),
      };
    } else if (detectPoints.length === 0) {
      updateData.detect_zone = null; // clear if empty
    }
    updateData.count_settings = readCountSettingsFromForm();
    const groundFromControls = readGroundQuadFromControls();
    const finalGround = (groundPoints.length >= 4 ? groundPoints : groundFromControls).slice(0, 4);
    updateData.feed_appearance = {
      ...(feedAppearanceCache && typeof feedAppearanceCache === "object" ? feedAppearanceCache : {}),
      detection_overlay: {
        ...(feedAppearanceCache?.detection_overlay && typeof feedAppearanceCache.detection_overlay === "object"
          ? feedAppearanceCache.detection_overlay
          : {}),
        ground_quad: {
          x1: finalGround[0]?.rx ?? 0.34, y1: finalGround[0]?.ry ?? 0.58,
          x2: finalGround[1]?.rx ?? 0.78, y2: finalGround[1]?.ry ?? 0.58,
          x3: finalGround[2]?.rx ?? 0.98, y3: finalGround[2]?.ry ?? 0.98,
          x4: finalGround[3]?.rx ?? 0.08, y4: finalGround[3]?.ry ?? 0.98,
        },
      },
    };

    try {
      let err = null;
      const primary = await window.sb
        .from("cameras")
        .update(updateData)
        .eq("id", cameraId);
      err = primary.error || null;

      if (err) {
        const msg = String(err.message || "").toLowerCase();
        if (msg.includes("count_settings") || msg.includes("feed_appearance") || msg.includes("column")) {
          const fallbackPayload = { ...updateData };
          delete fallbackPayload.count_settings;
          delete fallbackPayload.feed_appearance;
          const fallback = await window.sb
            .from("cameras")
            .update(fallbackPayload)
            .eq("id", cameraId);
          err = fallback.error || null;
        }
      }

      if (err) throw err;
      feedAppearanceCache = updateData.feed_appearance;
      updateStatus("Count + Detect + 3D mask saved ✓ — AI picks up within 30s");
    } catch (e) {
      console.error("[AdminLine] Save failed:", e);
      updateStatus(`Error: ${e.message}`);
    } finally {
      isSaving = false;
    }
  }

  function toBoundedNumber(raw, fallback, min, max) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }

  function parseAllowedClasses(raw) {
    if (!raw) return [];
    return String(raw)
      .split(",")
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean);
  }

  function parseClassMinConfidence(raw) {
    const out = {};
    const src = String(raw || "").trim();
    if (!src) return out;
    src.split(",").forEach((pair) => {
      const [cls, conf] = pair.split(":");
      const key = String(cls || "").trim().toLowerCase();
      if (!key) return;
      const val = Number(conf);
      if (!Number.isFinite(val)) return;
      out[key] = Math.max(0, Math.min(1, val));
    });
    return out;
  }

  function classMinConfidenceToText(obj) {
    if (!obj || typeof obj !== "object") return "";
    return Object.entries(obj)
      .filter(([k, v]) => String(k).trim() && Number.isFinite(Number(v)))
      .map(([k, v]) => `${String(k).trim().toLowerCase()}:${Number(v)}`)
      .join(", ");
  }

  function readCountSettingsFromForm() {
    const getVal = (id) => document.getElementById(id)?.value ?? "";
    return {
      min_track_frames: Math.round(toBoundedNumber(getVal("count-min-track-frames"), 6, 1, 30)),
      min_confidence: toBoundedNumber(getVal("count-min-confidence"), 0.30, 0, 1),
      min_box_area_ratio: toBoundedNumber(getVal("count-min-box-area-ratio"), 0.004, 0, 1),
      allowed_classes: parseAllowedClasses(getVal("count-allowed-classes")),
      class_min_confidence: parseClassMinConfidence(getVal("count-class-min-confidence")),
    };
  }

  function applyCountSettingsToForm(rawSettings) {
    const s = {
      ...DEFAULT_COUNT_SETTINGS,
      ...(rawSettings && typeof rawSettings === "object" ? rawSettings : {}),
    };
    const setVal = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.value = val;
    };
    setVal("count-min-track-frames", String(Math.round(toBoundedNumber(s.min_track_frames, 6, 1, 30))));
    setVal("count-min-confidence", String(toBoundedNumber(s.min_confidence, 0.30, 0, 1)));
    setVal("count-min-box-area-ratio", String(toBoundedNumber(s.min_box_area_ratio, 0.004, 0, 1)));
    setVal("count-allowed-classes", Array.isArray(s.allowed_classes) ? s.allowed_classes.join(", ") : "");
    setVal("count-class-min-confidence", classMinConfidenceToText(s.class_min_confidence));
  }

  function updateCountSettingsStatus(msg, isError = false) {
    const el = document.getElementById("count-settings-status");
    if (!el) return;
    el.textContent = msg;
    el.style.color = isError ? "var(--danger)" : "var(--green)";
  }

  async function saveCountSettingsOnly() {
    if (!cameraId || isSaving) return;
    isSaving = true;
    updateCountSettingsStatus("Saving...");
    try {
      const countSettings = readCountSettingsFromForm();
      const { error } = await window.sb
        .from("cameras")
        .update({ count_settings: countSettings })
        .eq("id", cameraId);
      if (error) {
        const msg = String(error.message || "").toLowerCase();
        if (msg.includes("count_settings") || msg.includes("column")) {
          updateCountSettingsStatus("count_settings column missing in DB. Run latest schema.", true);
          updateStatus("Zones still save. Apply schema to enable count tuning save.");
          return;
        }
        throw error;
      }
      updateCountSettingsStatus("Count tuning saved");
      updateStatus("Count tuning saved - AI picks up within 30s");
    } catch (e) {
      console.error("[AdminLine] Count settings save failed:", e);
      updateCountSettingsStatus(`Error: ${e.message}`, true);
    } finally {
      isSaving = false;
    }
  }

  function updateStatus(msg) {
    const el = document.getElementById("line-status");
    if (el) el.textContent = msg;
  }

  function samePoint(a, b) {
    return Math.abs(a.rx - b.rx) < 1e-9 && Math.abs(a.ry - b.ry) < 1e-9;
  }

  function hasDuplicatePoints(pts) {
    for (let i = 0; i < pts.length; i += 1) {
      for (let j = i + 1; j < pts.length; j += 1) {
        if (samePoint(pts[i], pts[j])) return true;
      }
    }
    return false;
  }

  function ccw(a, b, c) {
    return (c.ry - a.ry) * (b.rx - a.rx) > (b.ry - a.ry) * (c.rx - a.rx);
  }

  function segmentsIntersect(a, b, c, d) {
    return ccw(a, c, d) !== ccw(b, c, d) && ccw(a, b, c) !== ccw(a, b, d);
  }

  function polygonSelfIntersects(pts) {
    const n = pts.length;
    if (n < 4) return false;
    for (let i = 0; i < n; i += 1) {
      const a1 = pts[i];
      const a2 = pts[(i + 1) % n];
      for (let j = i + 1; j < n; j += 1) {
        const b1 = pts[j];
        const b2 = pts[(j + 1) % n];

        // Adjacent edges share a vertex and are allowed.
        if (i === j) continue;
        if ((i + 1) % n === j) continue;
        if (i === (j + 1) % n) continue;

        if (segmentsIntersect(a1, a2, b1, b2)) return true;
      }
    }
    return false;
  }

  function getZoneValidity() {
    const errors = [];

    if (countPoints.length === 2 && samePoint(countPoints[0], countPoints[1])) {
      errors.push("Count line points cannot be identical.");
    }
    if (countPoints.length >= 3) {
      if (hasDuplicatePoints(countPoints)) errors.push("Count zone has duplicate points.");
      if (polygonSelfIntersects(countPoints)) errors.push("Count zone polygon is self-intersecting.");
    }

    if (detectPoints.length >= 3) {
      if (hasDuplicatePoints(detectPoints)) errors.push("Detect zone has duplicate points.");
      if (polygonSelfIntersects(detectPoints)) errors.push("Detect zone polygon is self-intersecting.");
    }

    return { ok: errors.length === 0, errors };
  }

  function updateZoneValidityStatus(prefixMsg = "") {
    const validity = getZoneValidity();
    const saveBtn = document.getElementById("btn-save-line");
    const canSave = validity.ok && (countPoints.length >= COUNT_MIN_POINTS || detectPoints.length >= 3);
    if (saveBtn) {
      if (canSave) saveBtn.removeAttribute("disabled");
      else saveBtn.setAttribute("disabled", "disabled");
    }
    if (prefixMsg) {
      if (!validity.ok) updateStatus(`${prefixMsg}. ${validity.errors[0]}`);
      else updateStatus(prefixMsg);
      return;
    }
    if (!validity.ok) {
      updateStatus(`Zone warning: ${validity.errors[0]}`);
    } else if (countPoints.length || detectPoints.length) {
      updateStatus("Zone ready to save");
    }
  }

  function readGroundQuadFromControls() {
    const getNum = (id, fallback) => {
      const val = Number(document.getElementById(id)?.value);
      if (!Number.isFinite(val)) return fallback;
      return Math.max(0, Math.min(1, val));
    };
    return [
      { rx: getNum("det-ground-x1", 0.34), ry: getNum("det-ground-y1", 0.58) },
      { rx: getNum("det-ground-x2", 0.78), ry: getNum("det-ground-y2", 0.58) },
      { rx: getNum("det-ground-x3", 0.98), ry: getNum("det-ground-y3", 0.98) },
      { rx: getNum("det-ground-x4", 0.08), ry: getNum("det-ground-y4", 0.98) },
    ];
  }

  function autoUpdateGroundFromZones() {
    const derived = deriveGroundFromZones();
    if (!derived) return;
    groundPoints = derived;
    applyGroundQuadToControls(groundPoints);
  }

  function deriveGroundFromZones() {
    if (countPoints.length >= 4) {
      return countPoints.slice(0, 4).map((p) => ({ rx: p.rx, ry: p.ry }));
    }

    const source = detectPoints.length >= 3
      ? detectPoints
      : (countPoints.length >= 2 ? countPoints : []);
    if (source.length < 3) return null;

    const pts = source.map((p) => ({ rx: clamp01(p.rx), ry: clamp01(p.ry) }));
    const byY = [...pts].sort((a, b) => a.ry - b.ry);
    const band = Math.max(2, Math.ceil(pts.length * 0.35));
    const topPool = byY.slice(0, band);
    const bottomPool = byY.slice(Math.max(0, byY.length - band));

    const topLeft = topPool.reduce((m, p) => (p.rx < m.rx ? p : m), topPool[0]);
    const topRight = topPool.reduce((m, p) => (p.rx > m.rx ? p : m), topPool[0]);
    const bottomLeft = bottomPool.reduce((m, p) => (p.rx < m.rx ? p : m), bottomPool[0]);
    const bottomRight = bottomPool.reduce((m, p) => (p.rx > m.rx ? p : m), bottomPool[0]);
    const quad = [topLeft, topRight, bottomRight, bottomLeft].map((p) => ({ rx: p.rx, ry: p.ry }));

    // Reject inverted quads.
    const topY = (quad[0].ry + quad[1].ry) * 0.5;
    const bottomY = (quad[2].ry + quad[3].ry) * 0.5;
    if (topY >= bottomY) return null;
    return quad;
  }

  function clamp01(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
  }

  function applyGroundQuadToControls(points) {
    const pts = Array.isArray(points) && points.length >= 4 ? points.slice(0, 4) : readGroundQuadFromControls();
    const setVal = (id, val) => {
      const node = document.getElementById(id);
      if (node) node.value = String(Math.max(0, Math.min(1, Number(val) || 0)).toFixed(3));
    };
    setVal("det-ground-x1", pts[0].rx); setVal("det-ground-y1", pts[0].ry);
    setVal("det-ground-x2", pts[1].rx); setVal("det-ground-y2", pts[1].ry);
    setVal("det-ground-x3", pts[2].rx); setVal("det-ground-y3", pts[2].ry);
    setVal("det-ground-x4", pts[3].rx); setVal("det-ground-y4", pts[3].ry);

    try {
      const raw = localStorage.getItem(DETECTION_SETTINGS_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      const next = {
        ...parsed,
        ground_quad: {
          x1: pts[0].rx, y1: pts[0].ry,
          x2: pts[1].rx, y2: pts[1].ry,
          x3: pts[2].rx, y3: pts[2].ry,
          x4: pts[3].rx, y4: pts[3].ry,
        },
      };
      localStorage.setItem(DETECTION_SETTINGS_STORAGE_KEY, JSON.stringify(next));
      window.dispatchEvent(new CustomEvent("detection:settings-update", { detail: next }));
    } catch {}
  }

  return { init, clearActive, saveZones, refresh, saveCountSettingsOnly, loadZones: loadExistingZones };
})();

window.AdminLine = AdminLine;
