/**
 * admin-widget-layout.js
 * Drag-and-drop widget positioning for admins.
 * Grid-snapped (8px) with alignment guidelines.
 * Saves layout to Supabase; all visitors apply the saved positions.
 */
const WidgetLayout = (() => {
  const GRID = 8;
  const SNAP_PX = 6;
  const WIDGET_IDS = ['count-widget', 'ml-hud'];
  const TABLE = 'widget_layouts';
  const LAYOUT_KEY = 'default';

  let active = false;
  let container = null;
  let dragging = null;
  let draftLayout = {};
  let guideEls = [];
  let toolbar = null;

  // ── Enter edit mode ────────────────────────────────────────────
  function enter() {
    if (active) return;
    active = true;
    container = document.querySelector('.stream-wrapper');
    if (!container) return;

    _createGuides();
    _createToolbar();

    WIDGET_IDS.forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      _normalizePos(el);
      draftLayout[id] = { top: parseFloat(el.style.top), left: parseFloat(el.style.left) };
      el.classList.add('wl-draggable');
      el.addEventListener('pointerdown', _onDown);
    });

    container.classList.add('wl-edit-mode');
    document.addEventListener('pointermove', _onMove);
    document.addEventListener('pointerup', _onUp);
  }

  // ── Exit edit mode ─────────────────────────────────────────────
  function exit() {
    if (!active) return;
    active = false;

    WIDGET_IDS.forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.classList.remove('wl-draggable', 'wl-dragging');
      el.removeEventListener('pointerdown', _onDown);
    });

    _hideAllGuides();
    guideEls.forEach(g => g.remove());
    guideEls = [];
    toolbar?.remove();
    toolbar = null;

    container?.classList.remove('wl-edit-mode');
    document.removeEventListener('pointermove', _onMove);
    document.removeEventListener('pointerup', _onUp);
    container = null;
  }

  // ── Normalise right/bottom to top/left absolute positions ─────
  function _normalizePos(el) {
    const cr = container.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    el.style.top    = (er.top  - cr.top)  + 'px';
    el.style.left   = (er.left - cr.left) + 'px';
    el.style.bottom = 'auto';
    el.style.right  = 'auto';
    el.style.position = 'absolute';
  }

  // ── Pointer events ─────────────────────────────────────────────
  function _onDown(e) {
    if (!active) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const cr = container.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    dragging = {
      el,
      id: el.id,
      startX: e.clientX,
      startY: e.clientY,
      origLeft: er.left - cr.left,
      origTop:  er.top  - cr.top,
    };
    el.classList.add('wl-dragging');
  }

  function _onMove(e) {
    if (!dragging) return;
    const { el, origLeft, origTop, startX, startY } = dragging;
    const cr  = container.getBoundingClientRect();
    const elW = el.offsetWidth;
    const elH = el.offsetHeight;
    const cW  = cr.width;
    const cH  = cr.height;

    let rawL = Math.max(0, Math.min(cW - elW, origLeft + (e.clientX - startX)));
    let rawT = Math.max(0, Math.min(cH - elH, origTop  + (e.clientY - startY)));

    // Grid snap
    let L = _snap(rawL);
    let T = _snap(rawT);

    // Guideline snap
    const result = _computeGuides(dragging.id, L, T, elW, elH, cW, cH);
    L = result.left;
    T = result.top;
    _showGuides(result.lines);

    el.style.left = L + 'px';
    el.style.top  = T + 'px';
    draftLayout[dragging.id] = { top: T, left: L };
  }

  function _onUp() {
    if (!dragging) return;
    dragging.el.classList.remove('wl-dragging');
    dragging = null;
    _hideAllGuides();
  }

  function _snap(v) { return Math.round(v / GRID) * GRID; }

  // ── Alignment guidelines ───────────────────────────────────────
  function _computeGuides(draggedId, L, T, W, H, cW, cH) {
    const lines = [];
    let bestL = L, bestT = T;

    const others = WIDGET_IDS
      .filter(id => id !== draggedId)
      .map(id => {
        const el = document.getElementById(id);
        if (!el) return null;
        const l = parseFloat(el.style.left) || 0;
        const t = parseFloat(el.style.top)  || 0;
        const w = el.offsetWidth, h = el.offsetHeight;
        return { l, t, r: l + w, b: t + h, cx: l + w / 2, cy: t + h / 2 };
      }).filter(Boolean);

    // X candidates: edges + center + other widget edges
    const xTargets = [0, cW - W, cW / 2 - W / 2,
      ...others.flatMap(o => [o.l, o.r, o.r - W, o.l - W])];

    // Y candidates
    const yTargets = [0, cH - H, cH / 2 - H / 2,
      ...others.flatMap(o => [o.t, o.b, o.b - H, o.t - H])];

    let bxD = SNAP_PX + 1;
    xTargets.forEach(tx => {
      const s = _snap(tx), d = Math.abs(L - s);
      if (d < bxD) { bxD = d; bestL = s; }
    });
    if (bxD <= SNAP_PX) lines.push({ type: 'v', pos: bestL });

    let byD = SNAP_PX + 1;
    yTargets.forEach(ty => {
      const s = _snap(ty), d = Math.abs(T - s);
      if (d < byD) { byD = d; bestT = s; }
    });
    if (byD <= SNAP_PX) lines.push({ type: 'h', pos: bestT });

    // Center-of-container vertical
    const cxSnap = _snap(cW / 2 - W / 2);
    if (Math.abs(L - cxSnap) <= SNAP_PX) {
      bestL = cxSnap;
      lines.push({ type: 'v', pos: Math.round(cW / 2) });
    }

    return { left: bestL, top: bestT, lines };
  }

  function _createGuides() {
    ['wl-guide-h', 'wl-guide-h', 'wl-guide-v', 'wl-guide-v'].forEach(cls => {
      const g = document.createElement('div');
      g.className = `wl-guide ${cls}`;
      g.style.display = 'none';
      container.appendChild(g);
      guideEls.push(g);
    });
  }

  function _showGuides(lines) {
    guideEls.forEach(g => (g.style.display = 'none'));
    let hi = 0, vi = 0;
    lines.forEach(l => {
      if (l.type === 'h' && hi < 2) {
        const g = guideEls[hi++];
        g.style.display = 'block';
        g.style.top = l.pos + 'px';
      } else if (l.type === 'v' && vi < 2) {
        const g = guideEls[2 + vi++];
        g.style.display = 'block';
        g.style.left = l.pos + 'px';
      }
    });
  }

  function _hideAllGuides() {
    guideEls.forEach(g => (g.style.display = 'none'));
  }

  // ── Toolbar ────────────────────────────────────────────────────
  function _createToolbar() {
    toolbar = document.createElement('div');
    toolbar.className = 'wl-toolbar';
    toolbar.innerHTML = `
      <span class="wl-label">LAYOUT EDITOR</span>
      <button class="wl-btn wl-btn-reset">Reset</button>
      <button class="wl-btn wl-btn-push">Push to Public</button>
      <button class="wl-btn wl-btn-exit">✕ Exit</button>
    `;
    container.appendChild(toolbar);
    toolbar.querySelector('.wl-btn-reset').addEventListener('click', _reset);
    toolbar.querySelector('.wl-btn-push').addEventListener('click', pushToPublic);
    toolbar.querySelector('.wl-btn-exit').addEventListener('click', exit);
    // Prevent toolbar drags from bubbling to container
    toolbar.addEventListener('pointerdown', e => e.stopPropagation());
  }

  // ── Reset to default positions ─────────────────────────────────
  function _reset() {
    const cr = container.getBoundingClientRect();
    const defaults = {
      'count-widget': { top: 12, left: 12 },
      'ml-hud': { top: cr.height - (document.getElementById('ml-hud')?.offsetHeight || 120) - 10,
                  left: cr.width  - (document.getElementById('ml-hud')?.offsetWidth  || 180) - 10 },
    };
    WIDGET_IDS.forEach(id => {
      const el = document.getElementById(id);
      if (!el || !defaults[id]) return;
      el.style.top  = defaults[id].top  + 'px';
      el.style.left = defaults[id].left + 'px';
      draftLayout[id] = { ...defaults[id] };
    });
  }

  // ── Save to Supabase ───────────────────────────────────────────
  async function pushToPublic() {
    const btn = toolbar?.querySelector('.wl-btn-push');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }

    try {
      const cr = container.getBoundingClientRect();
      // Store positions as percentages so they scale with the container
      const pct = {};
      WIDGET_IDS.forEach(id => {
        const pos = draftLayout[id];
        if (!pos) return;
        pct[id] = {
          topPct:  +((pos.top  / cr.height) * 100).toFixed(3),
          leftPct: +((pos.left / cr.width)  * 100).toFixed(3),
        };
      });

      const { error } = await window.sb.from(TABLE).upsert(
        { id: LAYOUT_KEY, layout_json: pct, updated_at: new Date().toISOString() },
        { onConflict: 'id' }
      );
      if (error) throw error;

      if (btn) {
        btn.textContent = '✓ Published';
        btn.style.cssText += 'border-color:rgba(0,200,100,0.7);color:rgba(0,220,120,0.9)';
        setTimeout(() => {
          if (btn) { btn.disabled = false; btn.textContent = 'Push to Public'; btn.style.cssText = ''; }
        }, 2500);
      }
    } catch (err) {
      console.error('[WidgetLayout] Push failed:', err);
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Push Failed';
        btn.style.cssText += 'border-color:rgba(255,80,80,0.6);color:rgba(255,100,100,0.9)';
        setTimeout(() => { if (btn) { btn.textContent = 'Push to Public'; btn.style.cssText = ''; } }, 2500);
      }
    }
  }

  // ── Load + apply saved layout (called for all visitors) ───────
  async function loadLayout() {
    try {
      const { data, error } = await window.sb
        .from(TABLE).select('layout_json').eq('id', LAYOUT_KEY).maybeSingle();
      if (error || !data?.layout_json) return;
      _applyLayout(data.layout_json);
    } catch {}
  }

  function _applyLayout(layout) {
    const cont = document.querySelector('.stream-wrapper');
    if (!cont) return;
    // Wait for container to have dimensions
    const apply = () => {
      const cr = cont.getBoundingClientRect();
      if (!cr.width || !cr.height) { requestAnimationFrame(apply); return; }
      Object.entries(layout).forEach(([id, pos]) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.style.top    = ((pos.topPct  / 100) * cr.height) + 'px';
        el.style.left   = ((pos.leftPct / 100) * cr.width)  + 'px';
        el.style.bottom = 'auto';
        el.style.right  = 'auto';
      });
    };
    requestAnimationFrame(apply);
  }

  return { enter, exit, loadLayout };
})();

window.WidgetLayout = WidgetLayout;
