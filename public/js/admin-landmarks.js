/**
 * admin-landmarks.js — Place and edit landmark labels on a camera feed.
 * Uses its own canvas (#landmark-canvas) stacked above #line-canvas.
 * Landmarks are stored as {id, type, label, x, y} in cameras.landmarks (JSONB).
 * Coordinates x,y are content-relative [0,1] matching the coord-utils system.
 */
const AdminLandmarks = (() => {
  let _video = null, _canvas = null, _ctx = null, _camId = null;
  let _active = false;        // landmarks mode active (clicks place pins)
  let _landmarks = [];        // [{id, type, label, x, y}]
  let _hoveredIdx = null;
  let _dragIdx = null;
  let _dragOffX = 0, _dragOffY = 0;
  let _rafId = null;

  const TYPES = [
    { value: 'busstop',   label: 'Bus Stop',       color: '#00d4ff', abbr: 'B' },
    { value: 'sign',      label: 'Sign',            color: '#f59e0b', abbr: 'S' },
    { value: 'crossing',  label: 'Crossing',        color: '#fbbf24', abbr: 'X' },
    { value: 'light',     label: 'Traffic Light',   color: '#22c55e', abbr: 'L' },
    { value: 'junction',  label: 'Junction',        color: '#94a3b8', abbr: 'J' },
    { value: 'camera',    label: 'Camera / CCTV',   color: '#64748b', abbr: 'C' },
    { value: 'road',      label: 'Road Marking',    color: '#e2e8f0', abbr: 'R' },
    { value: 'note',      label: 'Note',            color: '#a78bfa', abbr: 'N' },
  ];

  function _typeInfo(type) {
    return TYPES.find(t => t.value === type) || TYPES[TYPES.length - 1];
  }

  function _uid() {
    return Math.random().toString(36).slice(2, 10);
  }

  // ── Init ──────────────────────────────────────────────────────
  function init(videoEl, canvasEl, camId) {
    _video  = videoEl;
    _canvas = canvasEl;
    _ctx    = canvasEl?.getContext('2d') || null;
    _camId  = camId;

    _syncSize();
    window.addEventListener('resize', _syncSize);
    _video?.addEventListener('loadedmetadata', _syncSize);

    _canvas.addEventListener('mousemove', _onMouseMove);
    _canvas.addEventListener('mouseleave', _onMouseLeave);
    _canvas.addEventListener('mousedown', _onMouseDown);
    _canvas.addEventListener('mouseup',   _onMouseUp);
    _canvas.addEventListener('click',     _onClick);

    _buildPopover();
    _scheduleRender();
  }

  function reinit(videoEl, canvasEl, camId) {
    _video  = videoEl;
    _canvas = canvasEl;
    _ctx    = canvasEl?.getContext('2d') || null;
    _camId  = camId;
    _syncSize();
    loadLandmarks();
  }

  function _syncSize() {
    if (!_video || !_canvas) return;
    const w = _video.clientWidth  || _video.getBoundingClientRect().width  || 0;
    const h = _video.clientHeight || _video.getBoundingClientRect().height || 0;
    if (w > 0 && h > 0) {
      _canvas.width  = w;
      _canvas.height = h;
    }
  }

  // ── Toggle mode ───────────────────────────────────────────────
  function setActive(bool) {
    _active = bool;
    _canvas.style.pointerEvents = bool ? 'auto' : 'none';
    _canvas.style.cursor = bool ? 'crosshair' : 'default';
    const btn = document.getElementById('btn-zone-landmarks');
    btn?.classList.toggle('active', bool);
    _hidePopover();
    _scheduleRender();
  }

  function toggle() { setActive(!_active); }

  // ── Load / Save ───────────────────────────────────────────────
  async function loadLandmarks() {
    if (!_camId || !window.sb) return;
    try {
      const { data, error } = await window.sb
        .from('cameras')
        .select('landmarks')
        .eq('id', _camId)
        .limit(1)
        .single();
      if (error) throw error;
      _landmarks = Array.isArray(data?.landmarks) ? data.landmarks : [];
      _scheduleRender();
    } catch (e) {
      console.warn('[AdminLandmarks] load error:', e);
    }
  }

  async function saveLandmarks() {
    if (!_camId || !window.sb) return;
    try {
      const { error } = await window.sb
        .from('cameras')
        .update({ landmarks: _landmarks })
        .eq('id', _camId);
      if (error) throw error;
      _setStatus('Landmarks saved.');
    } catch (e) {
      _setStatus('Save failed: ' + (e.message || e), true);
    }
  }

  function _setStatus(msg, isErr = false) {
    const el = document.getElementById('line-status');
    if (!el) return;
    el.textContent = msg;
    el.style.color = isErr ? '#ef4444' : '#22c55e';
    setTimeout(() => { if (el.textContent === msg) el.style.color = ''; }, 3000);
  }

  // ── Popover ───────────────────────────────────────────────────
  function _buildPopover() {
    if (document.getElementById('lm-popover')) return;
    const pop = document.createElement('div');
    pop.id = 'lm-popover';
    pop.className = 'lm-popover hidden';
    pop.innerHTML = `
      <div class="lm-pop-header">Add Landmark</div>
      <select id="lm-pop-type" class="lm-pop-select">
        ${TYPES.map(t => `<option value="${t.value}">${t.label}</option>`).join('')}
      </select>
      <input id="lm-pop-label" class="lm-pop-input" type="text" placeholder="Label (e.g. Stop Sign)" maxlength="40" />
      <div class="lm-pop-actions">
        <button id="lm-pop-add"    class="lm-pop-btn lm-pop-btn-add">Add</button>
        <button id="lm-pop-cancel" class="lm-pop-btn lm-pop-btn-cancel">Cancel</button>
      </div>`;

    const wrapper = _canvas?.closest('.stream-canvas-wrapper');
    if (wrapper) wrapper.appendChild(pop);
    else document.body.appendChild(pop);

    document.getElementById('lm-pop-add')?.addEventListener('click', _onPopoverAdd);
    document.getElementById('lm-pop-cancel')?.addEventListener('click', _hidePopover);
    document.getElementById('lm-pop-label')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') _onPopoverAdd();
      if (e.key === 'Escape') _hidePopover();
    });
    // Sync type label placeholder
    document.getElementById('lm-pop-type')?.addEventListener('change', (e) => {
      const t = _typeInfo(e.target.value);
      document.getElementById('lm-pop-label').placeholder = t.label;
    });
  }

  let _pendingRx = 0, _pendingRy = 0;

  function _showPopover(canvasX, canvasY, rx, ry) {
    _pendingRx = rx;
    _pendingRy = ry;
    const pop = document.getElementById('lm-popover');
    if (!pop) return;
    // Position near click but keep in view
    const wrapper = _canvas?.closest('.stream-canvas-wrapper');
    const wRect = wrapper?.getBoundingClientRect() ?? { left: 0, top: 0 };
    const cRect = _canvas.getBoundingClientRect();
    let left = cRect.left - wRect.left + canvasX + 10;
    let top  = cRect.top  - wRect.top  + canvasY - 20;
    // Clamp so it doesn't go off right edge
    const ww = wrapper?.offsetWidth ?? 400;
    const wh = wrapper?.offsetHeight ?? 300;
    if (left + 200 > ww) left = canvasX - 210;
    if (top  + 120 > wh) top  = canvasY - 130;
    pop.style.left = `${Math.max(0, left)}px`;
    pop.style.top  = `${Math.max(0, top)}px`;
    pop.classList.remove('hidden');
    const lbl = document.getElementById('lm-pop-label');
    if (lbl) { lbl.value = ''; lbl.focus(); }
  }

  function _hidePopover() {
    document.getElementById('lm-popover')?.classList.add('hidden');
    _pendingRx = 0; _pendingRy = 0;
  }

  function _onPopoverAdd() {
    const typeEl  = document.getElementById('lm-pop-type');
    const labelEl = document.getElementById('lm-pop-label');
    if (!typeEl || !labelEl) return;
    const type  = typeEl.value;
    const label = labelEl.value.trim() || _typeInfo(type).label;
    _landmarks.push({ id: _uid(), type, label, x: _pendingRx, y: _pendingRy });
    _hidePopover();
    _scheduleRender();
    _enableSaveBtn();
  }

  // ── Mouse events ──────────────────────────────────────────────
  function _canvasCoords(e) {
    const r = _canvas.getBoundingClientRect();
    return { cx: e.clientX - r.left, cy: e.clientY - r.top };
  }

  function _hitTest(cx, cy) {
    if (!_video) return -1;
    const bounds = getContentBounds(_video);
    for (let i = _landmarks.length - 1; i >= 0; i--) {
      const lm = _landmarks[i];
      const px = lm.x * bounds.w + bounds.x;
      const py = lm.y * bounds.h + bounds.y;
      const dx = cx - px, dy = cy - py;
      if (Math.sqrt(dx * dx + dy * dy) <= 14) return i;
    }
    return -1;
  }

  function _onMouseMove(e) {
    if (!_active) return;
    const { cx, cy } = _canvasCoords(e);
    // Drag
    if (_dragIdx !== null) {
      const bounds = getContentBounds(_video);
      const rx = Math.min(1, Math.max(0, (cx - _dragOffX - bounds.x) / bounds.w));
      const ry = Math.min(1, Math.max(0, (cy - _dragOffY - bounds.y) / bounds.h));
      _landmarks[_dragIdx].x = rx;
      _landmarks[_dragIdx].y = ry;
      _scheduleRender();
      return;
    }
    const hit = _hitTest(cx, cy);
    if (hit !== _hoveredIdx) {
      _hoveredIdx = hit;
      _canvas.style.cursor = hit >= 0 ? 'grab' : 'crosshair';
      _scheduleRender();
    }
  }

  function _onMouseLeave() {
    _hoveredIdx = null;
    _canvas.style.cursor = _active ? 'crosshair' : 'default';
    _scheduleRender();
  }

  function _onMouseDown(e) {
    if (!_active || e.button !== 0) return;
    const { cx, cy } = _canvasCoords(e);
    const hit = _hitTest(cx, cy);
    if (hit >= 0) {
      const bounds = getContentBounds(_video);
      const lm = _landmarks[hit];
      const px = lm.x * bounds.w + bounds.x;
      const py = lm.y * bounds.h + bounds.y;
      _dragIdx  = hit;
      _dragOffX = cx - px;
      _dragOffY = cy - py;
      _canvas.style.cursor = 'grabbing';
      e.stopPropagation();
    }
  }

  function _onMouseUp(e) {
    if (_dragIdx !== null) {
      _dragIdx = null;
      _canvas.style.cursor = _active ? 'crosshair' : 'default';
      _enableSaveBtn();
    }
  }

  function _onClick(e) {
    if (!_active) return;
    // Was a drag, not a click
    if (_dragIdx !== null) return;
    const { cx, cy } = _canvasCoords(e);
    const hit = _hitTest(cx, cy);
    if (hit >= 0) {
      // Right-click behavior on existing pin → delete (handled via context menu)
      return;
    }
    // Place new landmark — open popover
    const bounds = getContentBounds(_video);
    const rx = Math.min(1, Math.max(0, (cx - bounds.x) / bounds.w));
    const ry = Math.min(1, Math.max(0, (cy - bounds.y) / bounds.h));
    _showPopover(cx, cy, rx, ry);
  }

  function _onContextMenu(e) {
    if (!_active) return;
    e.preventDefault();
    const { cx, cy } = _canvasCoords(e);
    const hit = _hitTest(cx, cy);
    if (hit >= 0) {
      _landmarks.splice(hit, 1);
      _hoveredIdx = null;
      _scheduleRender();
      _enableSaveBtn();
    }
  }

  function _enableSaveBtn() {
    const btn = document.getElementById('btn-save-landmarks');
    if (btn) btn.disabled = false;
  }

  // ── Render ────────────────────────────────────────────────────
  function _scheduleRender() {
    if (_rafId) cancelAnimationFrame(_rafId);
    _rafId = requestAnimationFrame(_render);
  }

  function _render() {
    _rafId = null;
    if (!_ctx || !_canvas || !_video) return;
    _syncSize();
    _ctx.clearRect(0, 0, _canvas.width, _canvas.height);
    if (!_landmarks.length) return;

    const bounds = getContentBounds(_video);
    _landmarks.forEach((lm, i) => {
      const info  = _typeInfo(lm.type);
      const px    = lm.x * bounds.w + bounds.x;
      const py    = lm.y * bounds.h + bounds.y;
      const hover = i === _hoveredIdx;
      const R     = hover ? 13 : 11;

      // Shadow / glow
      _ctx.save();
      if (hover) {
        _ctx.shadowColor = info.color;
        _ctx.shadowBlur  = 10;
      }

      // Stem line
      _ctx.beginPath();
      _ctx.moveTo(px, py);
      _ctx.lineTo(px, py - R - 4);
      _ctx.strokeStyle = info.color + 'cc';
      _ctx.lineWidth = 1.5;
      _ctx.stroke();

      // Circle
      _ctx.beginPath();
      _ctx.arc(px, py - R - 4, R, 0, Math.PI * 2);
      _ctx.fillStyle   = hover ? info.color + '33' : '#0d1117cc';
      _ctx.fill();
      _ctx.strokeStyle = info.color;
      _ctx.lineWidth   = hover ? 2 : 1.5;
      _ctx.stroke();
      _ctx.restore();

      // Abbr
      _ctx.save();
      _ctx.font         = `700 ${hover ? 9 : 8}px "JetBrains Mono", monospace`;
      _ctx.fillStyle    = info.color;
      _ctx.textAlign    = 'center';
      _ctx.textBaseline = 'middle';
      _ctx.fillText(info.abbr, px, py - R - 4);
      _ctx.restore();

      // Label tag
      _drawLabel(px, py - R - 4 - R - 4, lm.label, info.color, hover);
    });
  }

  function _drawLabel(x, y, text, color, large) {
    const fs    = large ? 10 : 9;
    _ctx.font   = `600 ${fs}px Manrope, sans-serif`;
    const tw    = _ctx.measureText(text).width;
    const pad   = 4;
    const bw    = tw + pad * 2;
    const bh    = fs + pad * 2;

    _ctx.save();
    // Background pill
    _ctx.beginPath();
    _ctx.roundRect(x - bw / 2, y - bh, bw, bh, 3);
    _ctx.fillStyle = '#0d1117ee';
    _ctx.fill();
    _ctx.strokeStyle = color + '55';
    _ctx.lineWidth = 1;
    _ctx.stroke();
    // Text
    _ctx.fillStyle    = color + 'ee';
    _ctx.textAlign    = 'center';
    _ctx.textBaseline = 'alphabetic';
    _ctx.fillText(text, x, y - pad - 1);
    _ctx.restore();
  }

  // ── Public API ────────────────────────────────────────────────
  function getLandmarks()         { return _landmarks; }
  function setLandmarks(arr)      { _landmarks = Array.isArray(arr) ? arr : []; _scheduleRender(); }

  return { init, reinit, toggle, setActive, loadLandmarks, saveLandmarks, getLandmarks, setLandmarks };
})();

window.AdminLandmarks = AdminLandmarks;
