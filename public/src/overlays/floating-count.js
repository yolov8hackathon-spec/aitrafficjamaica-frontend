import { sb } from '../core/supabase.js';

let _wrapper         = null;
let _lastTotal       = 0;
let _guessBaseline   = null;
let _guessTarget     = null;
let _currentCameraId = null;
let _totalEl    = null;
let _carsEl     = null;
let _trucksEl   = null;
let _busesEl    = null;
let _motosEl    = null;
let _fpsEl      = null;
let _normalEl   = null;
let _guessModeEl = null;
let _gmTargetEl = null;
let _gmCurrentEl = null;
let _gmBarEl    = null;

function init(streamWrapper) {
  _wrapper = streamWrapper;
  _totalEl    = document.getElementById('cw-total');
  _carsEl     = document.getElementById('cw-cars');
  _trucksEl   = document.getElementById('cw-trucks');
  _busesEl    = document.getElementById('cw-buses');
  _motosEl    = document.getElementById('cw-motos');
  _fpsEl      = document.getElementById('cw-fps');
  _normalEl   = document.getElementById('cw-normal');
  _guessModeEl = document.getElementById('cw-guess-mode');
  _gmTargetEl = document.getElementById('cw-gm-target');
  _gmCurrentEl = document.getElementById('cw-gm-current');
  _gmBarEl    = document.getElementById('cw-gm-bar');

  window.addEventListener('count:update', (e) => {
    const data = e.detail;
    if (_currentCameraId && data.camera_id && data.camera_id !== _currentCameraId) return;
    update(data);
  });

  window.addEventListener('camera:switched', (e) => {
    const { cameraId, name, isAI } = e.detail || {};
    _currentCameraId = cameraId || null;
    _setCamLabel(name || null, isAI);
    if (isAI) {
      _lastTotal = 0;
      if (_totalEl)  _totalEl.textContent  = '0';
      if (_carsEl)   _carsEl.textContent   = '0';
      if (_trucksEl) _trucksEl.textContent = '0';
      if (_busesEl)  _busesEl.textContent  = '0';
      if (_motosEl)  _motosEl.textContent  = '0';
      if (_fpsEl)    _fpsEl.textContent    = '--';
    } else if (cameraId) {
      _loadCameraSnapshot(cameraId);
    }
  });

  window.addEventListener('bet:placed', (e) => {
    const detail = e.detail || {};
    _guessTarget   = detail.exact_count ?? null;
    _guessBaseline = _lastTotal;
    _enterGuessMode();
  });

  window.addEventListener('bet:resolved', _exitGuessMode);
}

function _enterGuessMode() {
  _normalEl?.classList.add('hidden');
  _guessModeEl?.classList.remove('hidden');
  if (_gmTargetEl) _gmTargetEl.textContent = _guessTarget ?? '—';
  _setGuessProgress(0);
}

function _exitGuessMode() {
  _guessBaseline = null;
  _guessTarget   = null;
  _normalEl?.classList.remove('hidden');
  _guessModeEl?.classList.add('hidden');
}

function _setGuessProgress(sinceGuess) {
  if (_gmCurrentEl) _gmCurrentEl.textContent = sinceGuess;
  if (_gmBarEl && _guessTarget > 0) {
    const pct = Math.min(100, (sinceGuess / _guessTarget) * 100);
    _gmBarEl.style.width = pct + '%';
    _gmBarEl.style.background =
      pct >= 100 ? '#ef4444' :
      pct >= 80  ? '#eab308' :
                   '#22c55e';
  }
}

function update(data) {
  const total     = data.total ?? 0;
  const bd        = data.vehicle_breakdown ?? {};
  const crossings = data.new_crossings ?? 0;
  _lastTotal = total;
  window._lastCountPayload = data;
  if (_totalEl)  _totalEl.textContent  = total.toLocaleString();
  if (_carsEl)   _carsEl.textContent   = bd.car        ?? 0;
  if (_trucksEl) _trucksEl.textContent = bd.truck      ?? 0;
  if (_busesEl)  _busesEl.textContent  = bd.bus        ?? 0;
  if (_motosEl)  _motosEl.textContent  = bd.motorcycle ?? 0;
  if (_fpsEl) {
    const fps = data.fps ?? data.fps_estimate ?? null;
    _fpsEl.textContent = fps != null ? `${Number(fps).toFixed(1)} fps` : '--.- fps';
    _fpsEl.className = 'cw-fps' + (fps == null ? ' cw-fps-na' : fps < 3 ? ' cw-fps-bad' : '');
  }
  if (_guessBaseline !== null && _guessTarget !== null) {
    _setGuessProgress(Math.max(0, total - _guessBaseline));
  }
  if (crossings > 0) spawnPop(crossings);
}

function setStatus(ok) {
  const dot = document.getElementById('cw-ws-dot');
  if (!dot) return;
  dot.className = ok ? 'cw-ws-dot cw-ws-ok' : 'cw-ws-dot cw-ws-err';
}

function _setCamLabel(name, isAI) {
  const el = document.getElementById('cw-cam-label');
  if (!el) return;
  if (name) { el.textContent = name; el.classList.remove('hidden'); }
  else el.classList.add('hidden');
  const badge = document.getElementById('cw-snapshot-badge');
  if (badge) badge.classList.toggle('hidden', !!isAI);
}

async function _loadCameraSnapshot(cameraId) {
  try {
    const [snapResp, fpsResp] = await Promise.all([
      sb.from('count_snapshots')
        .select('camera_id, captured_at, total, count_in, count_out, vehicle_breakdown')
        .eq('camera_id', cameraId)
        .order('captured_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      sb.from('ml_detection_events')
        .select('captured_at')
        .eq('camera_id', cameraId)
        .gte('captured_at', new Date(Date.now() - 5 * 60_000).toISOString())
        .order('captured_at', { ascending: true }),
    ]);
    let fps = null;
    const rows = fpsResp?.data || [];
    if (rows.length >= 2) {
      const elapsed = (new Date(rows.at(-1).captured_at) - new Date(rows[0].captured_at)) / 1000;
      if (elapsed > 0) fps = rows.length / elapsed;
    }
    const snap = snapResp?.data;
    update({
      camera_id: cameraId,
      total: snap?.total || 0,
      vehicle_breakdown: snap?.vehicle_breakdown || {},
      new_crossings: 0,
      fps,
      snapshot: true,
    });
  } catch {}
}

function spawnPop(n) {
  if (!_wrapper) return;
  const el = document.createElement('div');
  el.className = 'count-pop';
  el.textContent = '+' + n;
  const widget = document.getElementById('count-widget');
  if (widget) {
    const rect  = widget.getBoundingClientRect();
    const wRect = _wrapper.getBoundingClientRect();
    el.style.left = (rect.left - wRect.left + rect.width / 2) + 'px';
    el.style.top  = (rect.top  - wRect.top  - 10) + 'px';
  } else {
    el.style.left   = '80px';
    el.style.bottom = '60px';
  }
  _wrapper.appendChild(el);
  setTimeout(() => el.remove(), 1050);
}

export const FloatingCount = { init, update, setStatus };
