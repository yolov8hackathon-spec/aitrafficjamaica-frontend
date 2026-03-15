import { sb } from '../core/supabase.js';
import Hls from 'hls.js';
import { pixelToContent, contentToPixel } from '../utils/coord-utils.js';

/**
 * admin-mapping.js — Scene geometry annotation editor for admin panel.
 * Stores road polygons, lanes, junctions, stop signs, etc. in cameras.scene_map JSONB.
 * Coordinates are content-relative [0,1] — same system as zones and landmarks.
 *
 * Polygon tools: click to add points, double-click (or Enter) to close (min 3 pts).
 * Point tools: single click to place.
 */
export const AdminMapping = (() => {
  // ── State ───────────────────────────────────────────────────────
  let _video  = null;
  let _canvas = null;
  let _ctx    = null;
  let _camId  = null;

  let _features     = [];     // saved features
  let _activeTool   = null;   // current tool type string
  let _wip          = null;   // in-progress polygon: { type, points:[{x,y}] }
  let _mouseContent = null;   // current mouse pos in content coords {x,y}
  let _hoveredId    = null;   // hovered feature id
  let _selectedId   = null;   // selected feature id (click on feature list row)

  let _hls          = null;   // own HLS instance
  let _rafId        = null;
  let _resizeObs    = null;
  let _keyHandler   = null;

  // ── Feature type registry ───────────────────────────────────────
  const TYPES = [
    { value: 'road',          label: 'Road',          geom: 'polygon', color: '#3b82f6' },
    { value: 'lane',          label: 'Lane',          geom: 'polygon', color: '#06b6d4' },
    { value: 'junction',      label: 'Junction',      geom: 'polygon', color: '#f97316' },
    { value: 'crossing',      label: 'Crossing',      geom: 'polygon', color: '#e2e8f0' },
    { value: 'sidewalk',      label: 'Sidewalk',      geom: 'polygon', color: '#64748b' },
    { value: 'parking',       label: 'Parking',       geom: 'polygon', color: '#eab308' },
    { value: 'exclusion',     label: 'Exclusion',     geom: 'polygon', color: '#ef4444' },
    { value: 'stop_sign',     label: 'Stop Sign',     geom: 'point',   color: '#ef4444' },
    { value: 'traffic_light', label: 'Traffic Light', geom: 'point',   color: '#22c55e' },
    { value: 'split',         label: 'Road Split',    geom: 'point',   color: '#f97316' },
  ];

  function _typeInfo(type) {
    return TYPES.find(t => t.value === type) || TYPES[0];
  }

  function _uid() {
    return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, c =>
      (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)
    );
  }

  // ── Lifecycle ────────────────────────────────────────────────────
  function start(camId) {
    _camId = camId;

    // Use admin-video as the live preview source (always available, no extra HLS needed)
    _video  = document.getElementById('admin-video');
    _canvas = document.getElementById('mapping-canvas');
    if (!_canvas) return;
    _ctx = _canvas.getContext('2d');

    _syncSize();

    _resizeObs = new ResizeObserver(() => { _syncSize(); _scheduleRender(); });
    _resizeObs.observe(_canvas.parentElement || document.body);

    _canvas.addEventListener('click',     _onClick);
    _canvas.addEventListener('dblclick',  _onDblClick);
    _canvas.addEventListener('mousemove', _onMouseMove);
    _canvas.addEventListener('mouseleave',_onMouseLeave);
    _canvas.addEventListener('contextmenu', _onContextMenu);

    _keyHandler = _onKey.bind(null);
    window.addEventListener('keydown', _keyHandler);

    _buildToolUI();
    loadMap();

    // Continuous RAF loop for live video background
    const _liveLoop = () => {
      _render();
      if (_rafId !== null) _rafId = requestAnimationFrame(_liveLoop);
    };
    _rafId = requestAnimationFrame(_liveLoop);
  }

  function stop() {
    _canvas?.removeEventListener('click',      _onClick);
    _canvas?.removeEventListener('dblclick',   _onDblClick);
    _canvas?.removeEventListener('mousemove',  _onMouseMove);
    _canvas?.removeEventListener('mouseleave', _onMouseLeave);
    _canvas?.removeEventListener('contextmenu',_onContextMenu);
    if (_keyHandler) window.removeEventListener('keydown', _keyHandler);
    _keyHandler = null;
    _resizeObs?.disconnect();
    _resizeObs = null;
    _hls?.destroy();
    _hls = null;
    if (_rafId !== null) { cancelAnimationFrame(_rafId); _rafId = null; }
    _wip = null;
    _activeTool = null;
  }

  // ── Stream ───────────────────────────────────────────────────────
  async function _startStream() {
    if (!_video) return;
    try {
      const res  = await fetch('/api/stream');
      const data = await res.json();
      const url  = data?.url || data?.hls_url || '';
      if (!url) return;
      if (Hls && Hls.isSupported()) {
        if (_hls) _hls.destroy();
        _hls = new Hls({ enableWorker: false, maxBufferLength: 8, maxMaxBufferLength: 16 });
        _hls.loadSource(url);
        _hls.attachMedia(_video);
        _hls.on(Hls.Events.MANIFEST_PARSED, () => { _video.play().catch(() => {}); });
        _hls.on(Hls.Events.ERROR, (_, data) => {
          if (data.fatal) { _hls.destroy(); _hls = null; }
        });
      } else if (_video.canPlayType?.('application/vnd.apple.mpegurl')) {
        _video.src = url;
        _video.play().catch(() => {});
      }
    } catch (e) {
      console.warn('[AdminMapping] stream error:', e);
    }
  }

  // ── Canvas sizing ────────────────────────────────────────────────
  function _syncSize() {
    if (!_canvas) return;
    const wrap = _canvas.parentElement;
    const w = wrap ? wrap.clientWidth : (_canvas.clientWidth || 640);
    const adminVid = document.getElementById('admin-video');
    const ar = (adminVid?.videoWidth && adminVid?.videoHeight)
      ? adminVid.videoHeight / adminVid.videoWidth
      : 9 / 16;
    const h = Math.round(w * ar) || Math.round(w * 9 / 16);
    if (w > 0 && h > 0 && (_canvas.width !== w || _canvas.height !== h)) {
      _canvas.width  = w;
      _canvas.height = h;
      if (wrap) wrap.style.minHeight = h + 'px';
    }
  }

  // ── Coordinate bounds (contain-scaled within canvas) ─────────────
  function _getDrawBounds() {
    const W = _canvas?.width  || 640;
    const H = _canvas?.height || 360;
    const adminVid = document.getElementById('admin-video');
    if (adminVid?.videoWidth && adminVid?.videoHeight) {
      const vw = adminVid.videoWidth, vh = adminVid.videoHeight;
      const scale = Math.min(W / vw, H / vh);
      const dw = vw * scale, dh = vh * scale;
      return { x: (W - dw) / 2, y: (H - dh) / 2, w: dw, h: dh };
    }
    return { x: 0, y: 0, w: W, h: H };
  }

  // ── Load / Save ──────────────────────────────────────────────────
  async function loadMap() {
    if (!_camId || !sb) return;
    try {
      const { data, error } = await sb
        .from('cameras')
        .select('scene_map')
        .eq('id', _camId)
        .limit(1)
        .single();
      if (error) throw error;
      _features = Array.isArray(data?.scene_map?.features) ? data.scene_map.features : [];
      _scheduleRender();
      renderFeatureList();
    } catch (e) {
      console.warn('[AdminMapping] load error:', e);
    }
  }

  async function saveMap() {
    if (!_camId || !sb) return;
    const btn = document.getElementById('mapping-save-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
      const { error } = await sb
        .from('cameras')
        .update({ scene_map: { features: _features } })
        .eq('id', _camId);
      if (error) throw error;
      _setStatus('Scene map saved.');
    } catch (e) {
      _setStatus('Save failed: ' + (e.message || e), true);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Save Map'; }
    }
  }

  function _setStatus(msg, isErr = false) {
    const el = document.getElementById('mapping-status');
    if (!el) return;
    el.textContent = msg;
    el.style.color = isErr ? '#ef4444' : '#22c55e';
    setTimeout(() => { if (el.textContent === msg) el.style.color = ''; }, 3000);
  }

  // ── Tool UI ──────────────────────────────────────────────────────
  function _buildToolUI() {
    const grid = document.getElementById('mapping-tool-grid');
    if (!grid) return;
    grid.innerHTML = '';
    TYPES.forEach(t => {
      const btn = document.createElement('button');
      btn.className   = 'mapping-tool-btn';
      btn.dataset.tool = t.value;
      btn.title        = t.geom === 'polygon' ? `${t.label} — click to draw polygon` : `${t.label} — click to place`;
      btn.innerHTML = `
        <span class="mf-dot" style="background:${t.color};"></span>
        <span>${t.label}</span>
        <span class="mapping-tool-geom">${t.geom === 'polygon' ? '▣' : '●'}</span>`;
      btn.addEventListener('click', () => setTool(t.value));
      grid.appendChild(btn);
    });
  }

  function setTool(type) {
    if (_activeTool === type) {
      // Toggle off
      _activeTool = null;
      _wip        = null;
      _updateHint();
      _updateToolBtns();
      _scheduleRender();
      return;
    }
    _activeTool = type;
    _wip        = null;
    _updateToolBtns();
    _updateHint();
    _scheduleRender();
  }

  function _updateToolBtns() {
    document.querySelectorAll('.mapping-tool-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tool === _activeTool);
    });
    if (_canvas) {
      _canvas.style.cursor = _activeTool ? 'crosshair' : 'default';
    }
  }

  function _updateHint() {
    const el = document.getElementById('mapping-draw-hint');
    if (!el) return;
    if (!_activeTool) {
      el.textContent = 'Select a tool to start annotating.';
      return;
    }
    const info = _typeInfo(_activeTool);
    if (info.geom === 'polygon') {
      const pts = _wip?.points?.length || 0;
      if (pts === 0) {
        el.textContent = `${info.label} — click to start polygon`;
      } else if (pts < 3) {
        el.textContent = `${info.label} — ${pts} pt${pts > 1 ? 's' : ''} — need ${3 - pts} more to close`;
      } else {
        el.textContent = `${info.label} — ${pts} pts — double-click or Enter to close`;
      }
    } else {
      el.textContent = `${info.label} — click to place`;
    }
  }

  // ── Mouse / keyboard events ───────────────────────────────────────
  function _canvasCoords(e) {
    const r = _canvas.getBoundingClientRect();
    return { cx: e.clientX - r.left, cy: e.clientY - r.top };
  }

  function _onClick(e) {
    if (!_activeTool) {
      // Check if clicking on a feature to select
      const id = _hitTestFeature(e);
      if (id) { _selectedId = id; _scheduleRender(); renderFeatureList(); }
      return;
    }
    const info = _typeInfo(_activeTool);
    const bounds = _getDrawBounds();
    const { cx, cy } = _canvasCoords(e);
    const rel = pixelToContent(cx, cy, bounds);

    if (info.geom === 'point') {
      // Place immediately
      const count = _features.filter(f => f.type === _activeTool).length + 1;
      _features.push({
        id:    _uid(),
        type:  _activeTool,
        label: `${info.label} ${count}`,
        geom:  'point',
        x:     rel.x,
        y:     rel.y,
      });
      _scheduleRender();
      renderFeatureList();
      _updateHint();
      return;
    }

    // Polygon — check if this is a double-click (handled by dblclick event)
    // Single click just adds a point
    if (!_wip) {
      _wip = { type: _activeTool, points: [] };
    }
    _wip.points.push({ x: rel.x, y: rel.y });
    _updateHint();
    _scheduleRender();
  }

  function _onDblClick(e) {
    if (!_wip || _wip.points.length < 3) return;
    e.preventDefault();
    // Remove the last point (dblclick fires two clicks + dblclick; last click duplicated)
    _wip.points.pop();
    _closePolygon();
  }

  function _onKey(e) {
    if (e.key === 'Enter') {
      if (_wip && _wip.points.length >= 3) _closePolygon();
    }
    if (e.key === 'Escape') {
      _wip = null;
      _updateHint();
      _scheduleRender();
    }
    if (e.key === 'z' && (e.ctrlKey || e.metaKey)) {
      undoPoint();
    }
  }

  function _closePolygon() {
    if (!_wip || _wip.points.length < 3) return;
    const info = _typeInfo(_wip.type);
    const count = _features.filter(f => f.type === _wip.type).length + 1;
    _features.push({
      id:     _uid(),
      type:   _wip.type,
      label:  `${info.label} ${count}`,
      geom:   'polygon',
      points: _wip.points.slice(),
    });
    _wip = null;
    _scheduleRender();
    renderFeatureList();
    _updateHint();
  }

  function _onMouseMove(e) {
    if (!_video) return;
    const bounds = _getDrawBounds();
    const { cx, cy } = _canvasCoords(e);
    _mouseContent = pixelToContent(cx, cy, bounds);

    // Hover detection on features (when no tool active)
    if (!_activeTool) {
      const id = _hitTestFeature(e);
      if (id !== _hoveredId) {
        _hoveredId = id;
        _canvas.style.cursor = id ? 'pointer' : 'default';
        _scheduleRender();
      }
    } else {
      _scheduleRender();
    }
  }

  function _onMouseLeave() {
    _mouseContent = null;
    _hoveredId    = null;
    _scheduleRender();
  }

  function _onContextMenu(e) {
    e.preventDefault();
    const id = _hitTestFeature(e);
    if (id) { deleteFeature(id); }
  }

  function _hitTestFeature(e) {
    if (!_video) return null;
    const bounds = _getDrawBounds();
    const { cx, cy } = _canvasCoords(e);
    // Check in reverse order (top feature first)
    for (let i = _features.length - 1; i >= 0; i--) {
      const f = _features[i];
      if (f.geom === 'point') {
        const p = contentToPixel(f.x, f.y, bounds);
        const dx = cx - p.x, dy = cy - p.y;
        if (Math.sqrt(dx * dx + dy * dy) <= 10) return f.id;
      } else if (f.geom === 'polygon' && f.points?.length >= 3) {
        if (_pointInPolygon(cx, cy, f.points, bounds)) return f.id;
      }
    }
    return null;
  }

  function _pointInPolygon(cx, cy, relPoints, bounds) {
    let inside = false;
    const pts = relPoints.map(p => contentToPixel(p.x, p.y, bounds));
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i].x, yi = pts[i].y;
      const xj = pts[j].x, yj = pts[j].y;
      if (((yi > cy) !== (yj > cy)) && (cx < ((xj - xi) * (cy - yi)) / (yj - yi) + xi)) {
        inside = !inside;
      }
    }
    return inside;
  }

  // ── Actions ──────────────────────────────────────────────────────
  function undoPoint() {
    if (!_wip || !_wip.points.length) return;
    _wip.points.pop();
    if (_wip.points.length === 0) _wip = null;
    _updateHint();
    _scheduleRender();
  }

  function cancelDrawing() {
    _wip = null;
    _updateHint();
    _scheduleRender();
  }

  function deleteFeature(id) {
    const idx = _features.findIndex(f => f.id === id);
    if (idx === -1) return;
    _features.splice(idx, 1);
    if (_selectedId === id) _selectedId = null;
    if (_hoveredId  === id) _hoveredId  = null;
    _scheduleRender();
    renderFeatureList();
  }

  // ── Feature list ─────────────────────────────────────────────────
  function renderFeatureList() {
    const el = document.getElementById('mapping-feature-list');
    if (!el) return;
    if (!_features.length) {
      el.innerHTML = '<p class="mapping-no-features">No features yet. Select a tool and annotate the scene.</p>';
      return;
    }
    el.innerHTML = _features.map(f => {
      const info    = _typeInfo(f.type);
      const isSel   = f.id === _selectedId;
      const ptCount = f.geom === 'polygon' ? `<span class="mf-pts">${f.points?.length || 0} pts</span>` : '';
      return `<div class="mapping-feature-row${isSel ? ' selected' : ''}" data-fid="${f.id}">
        <span class="mf-dot" style="background:${info.color};"></span>
        <span class="mf-label">${f.label}</span>
        ${ptCount}
        <button class="mf-del-btn" data-fid="${f.id}" title="Delete">✕</button>
      </div>`;
    }).join('');

    el.querySelectorAll('.mapping-feature-row').forEach(row => {
      row.addEventListener('click', (e) => {
        if (e.target.classList.contains('mf-del-btn')) return;
        _selectedId = row.dataset.fid;
        _scheduleRender();
        renderFeatureList();
      });
    });
    el.querySelectorAll('.mf-del-btn').forEach(btn => {
      btn.addEventListener('click', () => deleteFeature(btn.dataset.fid));
    });
  }

  // ── Render ───────────────────────────────────────────────────────
  function _scheduleRender() {
    // Live loop is already running; render is called every frame.
    // This is kept for compatibility with event handlers that call it.
  }

  function _render() {
    if (!_ctx || !_canvas) return;
    _syncSize();
    const W = _canvas.width, H = _canvas.height;

    // Draw live video background
    _ctx.fillStyle = '#080C14';
    _ctx.fillRect(0, 0, W, H);
    const adminVid = document.getElementById('admin-video');
    if (adminVid && adminVid.readyState >= 2 && adminVid.videoWidth) {
      const b = _getDrawBounds();
      _ctx.drawImage(adminVid, b.x, b.y, b.w, b.h);
    }

    const bounds = _getDrawBounds();

    // Draw saved features
    _features.forEach(f => {
      const info    = _typeInfo(f.type);
      const isHover = f.id === _hoveredId;
      const isSel   = f.id === _selectedId;

      if (f.geom === 'polygon' && f.points?.length >= 3) {
        _drawPolygon(f.points, info.color, bounds, isHover || isSel);
      } else if (f.geom === 'point') {
        const p = contentToPixel(f.x, f.y, bounds);
        _drawPoint(p.x, p.y, info.color, isHover || isSel);
      }

      // Label
      if (f.geom === 'polygon' && f.points?.length >= 3) {
        const cx = f.points.reduce((s, p) => s + p.x, 0) / f.points.length;
        const cy = f.points.reduce((s, p) => s + p.y, 0) / f.points.length;
        const pp = contentToPixel(cx, cy, bounds);
        _drawFeatureLabel(pp.x, pp.y, f.label, info.color);
      } else if (f.geom === 'point') {
        const pp = contentToPixel(f.x, f.y, bounds);
        _drawFeatureLabel(pp.x, pp.y - 14, f.label, info.color);
      }
    });

    // Draw in-progress polygon
    if (_wip) {
      const info = _typeInfo(_wip.type);
      const pts  = _wip.points;

      if (pts.length >= 2) {
        _ctx.beginPath();
        const p0 = contentToPixel(pts[0].x, pts[0].y, bounds);
        _ctx.moveTo(p0.x, p0.y);
        for (let i = 1; i < pts.length; i++) {
          const pi = contentToPixel(pts[i].x, pts[i].y, bounds);
          _ctx.lineTo(pi.x, pi.y);
        }
        // Live cursor line
        if (_mouseContent) {
          const mp = contentToPixel(_mouseContent.x, _mouseContent.y, bounds);
          _ctx.lineTo(mp.x, mp.y);
        }
        _ctx.strokeStyle = info.color + 'cc';
        _ctx.lineWidth   = 1.5;
        _ctx.setLineDash([5, 4]);
        _ctx.stroke();
        _ctx.setLineDash([]);
      }

      // Draw each vertex
      pts.forEach((pt, idx) => {
        const pp = contentToPixel(pt.x, pt.y, bounds);
        _ctx.beginPath();
        _ctx.arc(pp.x, pp.y, idx === 0 ? 5 : 3.5, 0, Math.PI * 2);
        _ctx.fillStyle   = info.color;
        _ctx.fill();
        _ctx.strokeStyle = '#0d1117';
        _ctx.lineWidth   = 1;
        _ctx.stroke();
      });
    }
  }

  function _drawPolygon(relPoints, color, bounds, highlight) {
    const pts = relPoints.map(p => contentToPixel(p.x, p.y, bounds));
    _ctx.beginPath();
    _ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) _ctx.lineTo(pts[i].x, pts[i].y);
    _ctx.closePath();
    _ctx.fillStyle   = color + (highlight ? '33' : '1a');
    _ctx.fill();
    _ctx.strokeStyle = color + (highlight ? 'ff' : 'cc');
    _ctx.lineWidth   = highlight ? 2 : 1.5;
    _ctx.stroke();

    // Vertex dots
    pts.forEach(p => {
      _ctx.beginPath();
      _ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
      _ctx.fillStyle = color + 'cc';
      _ctx.fill();
    });
  }

  function _drawPoint(px, py, color, highlight) {
    const R = highlight ? 8 : 6;
    _ctx.save();
    if (highlight) {
      _ctx.shadowColor = color;
      _ctx.shadowBlur  = 10;
    }
    _ctx.beginPath();
    _ctx.arc(px, py, R, 0, Math.PI * 2);
    _ctx.fillStyle   = color + (highlight ? '55' : '33');
    _ctx.fill();
    _ctx.strokeStyle = color;
    _ctx.lineWidth   = highlight ? 2 : 1.5;
    _ctx.stroke();
    // Cross hair
    _ctx.beginPath();
    _ctx.moveTo(px - R - 3, py); _ctx.lineTo(px + R + 3, py);
    _ctx.moveTo(px, py - R - 3); _ctx.lineTo(px, py + R + 3);
    _ctx.strokeStyle = color + '88';
    _ctx.lineWidth   = 1;
    _ctx.stroke();
    _ctx.restore();
  }

  function _drawFeatureLabel(x, y, text, color) {
    _ctx.font = '600 9px Manrope, sans-serif';
    const tw  = _ctx.measureText(text).width;
    const pad = 3;
    const bw  = tw + pad * 2;
    const bh  = 13;

    _ctx.save();
    _ctx.beginPath();
    _ctx.roundRect(x - bw / 2, y - bh / 2, bw, bh, 2);
    _ctx.fillStyle   = '#0d1117cc';
    _ctx.fill();
    _ctx.strokeStyle = color + '44';
    _ctx.lineWidth   = 1;
    _ctx.stroke();
    _ctx.fillStyle    = color + 'ee';
    _ctx.textAlign    = 'center';
    _ctx.textBaseline = 'middle';
    _ctx.fillText(text, x, y);
    _ctx.restore();
  }

  // ── Public ───────────────────────────────────────────────────────
  return { start, stop, loadMap, saveMap, setTool, undoPoint, cancelDrawing, deleteFeature, renderFeatureList };
})();
