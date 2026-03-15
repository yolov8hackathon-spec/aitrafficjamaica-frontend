import { sb } from '../core/supabase.js';

/**
 * admin-model.js — Live AI model status panel.
 * Polls /api/health every 5s + latest ml_detection_events from Supabase.
 * Auto-starts when panel-model becomes active.
 */
export const AdminModel = (() => {
  let _pollTimer = null;
  let _active = false;
  let _cachedIntel = null;

  // ── Lighting / weather icons ──────────────────────────────────
  const LIGHTING_ICON = {
    day:    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>',
    night:  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#818cf8" stroke-width="2" stroke-linecap="round"><path d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79z"/></svg>',
    dusk:   '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#f97316" stroke-width="2" stroke-linecap="round"><path d="M12 2v2M4.93 4.93l1.41 1.41M2 12h2M17.66 6.34l1.41-1.41"/><path d="M3 17h18M5 20h14"/><path d="M12 5a7 7 0 0 1 7 7H5a7 7 0 0 1 7-7z"/></svg>',
    dawn:   '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#fb923c" stroke-width="2" stroke-linecap="round"><path d="M3 17h18M5 20h14"/><path d="M12 5a7 7 0 0 1 7 7H5a7 7 0 0 1 7-7z"/></svg>',
    unknown:'<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#64748b" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/></svg>',
  };
  const WEATHER_ICON = {
    sunny:    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2"/></svg>',
    cloudy:   '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2" stroke-linecap="round"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>',
    rainy:    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" stroke-width="2" stroke-linecap="round"><path d="M20 17.58A5 5 0 0 0 18 8h-1.26A8 8 0 1 0 4 16.25"/><line x1="8" y1="19" x2="8" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/><line x1="16" y1="19" x2="16" y2="21"/></svg>',
    foggy:    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2" stroke-linecap="round"><path d="M5 5h3m4 0h6M3 10h11m4 0h2M5 15h5m4 0h4"/></svg>',
    overcast: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2" stroke-linecap="round"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>',
    unknown:  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#64748b" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/></svg>',
  };

  const CLASS_COLORS = {
    car:        '#00d4ff',
    truck:      '#f59e0b',
    bus:        '#a78bfa',
    motorcycle: '#34d399',
    person:     '#f87171',
  };

  const TASK_META = [
    { key: 'ai_task_running',       label: 'AI Loop',        restartKey: 'ai' },
    { key: 'watchdog_task_running',  label: 'Watchdog',       restartKey: null },
    { key: 'round_task_running',     label: 'Round Monitor',  restartKey: 'round' },
    { key: 'resolver_task_running',  label: 'Resolver',       restartKey: 'resolver' },
    { key: 'refresh_task_running',   label: 'URL Refresh',    restartKey: 'refresh' },
    { key: 'ml_retrain_task_running',label: 'ML Retrain',     restartKey: 'ml_retrain' },
  ];

  // ── Fetch ─────────────────────────────────────────────────────
  async function _fetchHealth() {
    const r = await fetch('/api/health');
    if (!r.ok) throw new Error(`health ${r.status}`);
    return r.json();
  }

  async function _fetchLatestDetection() {
    const { data } = await sb
      .from('ml_detection_events')
      .select('captured_at, model_name, model_conf_threshold, detections_count, avg_confidence, class_counts, new_crossings, camera_id')
      .order('captured_at', { ascending: false })
      .limit(1);
    return data?.[0] ?? null;
  }

  async function _fetchIntelStats() {
    const since24h = new Date(Date.now() - 86400000).toISOString();
    const [xTotal, x24h, zones, turns24h] = await Promise.allSettled([
      sb.from('vehicle_crossings').select('id', { count: 'exact', head: true }),
      sb.from('vehicle_crossings').select('id', { count: 'exact', head: true }).gte('captured_at', since24h),
      sb.from('camera_zones').select('id', { count: 'exact', head: true }).eq('active', true),
      sb.from('turning_movements').select('id', { count: 'exact', head: true }).gte('captured_at', since24h),
    ]);
    // Class breakdown for 24h crossings — wrapped so a slow query can't abort the return
    const TRAFFIC_CLASSES = new Set(['car', 'truck', 'bus', 'motorcycle']);
    const classCounts = {};
    try {
      const { data: clsData } = await sb
        .from('vehicle_crossings')
        .select('vehicle_class')
        .gte('captured_at', since24h)
        .limit(2000);
      (clsData || []).forEach(r => {
        if (TRAFFIC_CLASSES.has(r.vehicle_class))
          classCounts[r.vehicle_class] = (classCounts[r.vehicle_class] || 0) + 1;
      });
    } catch { /* non-critical */ }
    return {
      crossings_total: xTotal.status === 'fulfilled' ? (xTotal.value.count ?? 0) : 0,
      crossings_24h:   x24h.status === 'fulfilled'   ? (x24h.value.count ?? 0) : 0,
      zones_active:    zones.status === 'fulfilled'   ? (zones.value.count ?? 0) : 0,
      turnings_24h:    turns24h.status === 'fulfilled' ? (turns24h.value.count ?? 0) : 0,
      class_counts_24h: classCounts,
    };
  }

  async function _fetchCameraName(cameraId) {
    if (!cameraId) return null;
    const { data } = await sb
      .from('cameras')
      .select('ipcam_alias, feed_appearance')
      .eq('id', cameraId)
      .limit(1);
    const cam = data?.[0];
    return cam?.feed_appearance?.label || cam?.ipcam_alias || null;
  }

  // ── Helpers ───────────────────────────────────────────────────
  function _fmtAge(sec) {
    if (sec == null) return '—';
    if (sec < 2)   return 'just now';
    if (sec < 60)  return `${Math.round(sec)}s ago`;
    if (sec < 3600)return `${Math.round(sec / 60)}m ago`;
    return `${Math.round(sec / 3600)}h ago`;
  }

  function _fmtNum(n) {
    if (n == null) return '—';
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K';
    return String(n);
  }

  function _set(id, html, isHtml = false) {
    const el = document.getElementById(id);
    if (!el) return;
    if (isHtml) el.innerHTML = html;
    else        el.textContent = html;
  }

  // ── Render ────────────────────────────────────────────────────
  async function render() {
    let health = null, det = null, camName = null, intel = null;

    try {
      [health, det] = await Promise.all([_fetchHealth(), _fetchLatestDetection()]);
      if (det?.camera_id) camName = await _fetchCameraName(det.camera_id);
    } catch (e) {
      console.warn('[AdminModel] fetch error:', e);
      _set('mp-status-label', 'ERROR');
      document.getElementById('mp-status-dot')?.setAttribute('data-state', 'offline');
      return;
    }

    // Fetch intel stats in background (non-blocking); cache for crossings display
    _fetchIntelStats().then(stats => {
      intel = stats;
      _cachedIntel = stats;
      _renderIntel(intel);
      // Refresh crossings in detection card with 24h total
      _set('mp-det-crossings', _fmtNum(stats.crossings_24h));
    }).catch(() => {});

    // ── Hero ──────────────────────────────────────────────────
    const frameAge = health.ai_last_frame_age_sec ?? null;
    const isStale  = health.ai_heartbeat_stale ?? (frameAge != null && frameAge > 10);
    const isRunning = health.ai_task_running;
    const state = !isRunning ? 'offline' : isStale ? 'stale' : 'active';
    const stateLabel = !isRunning ? 'OFFLINE' : isStale ? 'STALE' : 'ACTIVE';

    const dotEl = document.getElementById('mp-status-dot');
    if (dotEl) dotEl.setAttribute('data-state', state);
    _set('mp-status-label', stateLabel);

    const modelName = det?.model_name || health.ai_last_error?.includes('yolov8') ? health.ai_last_error : '—';
    _set('mp-model-name', det?.model_name || '—');

    const device = health.ai_inference?.device ?? '—';
    _set('mp-chip-device', device.toUpperCase());
    const chipDevice = document.getElementById('mp-chip-device');
    if (chipDevice) {
      chipDevice.setAttribute('data-device', device.toLowerCase());
    }

    const conf = det?.model_conf_threshold ?? null;
    _set('mp-chip-conf', conf != null ? `conf ${conf.toFixed(2)}` : 'conf —');
    _set('mp-chip-frame', `frame ${_fmtAge(frameAge)}`);

    // ── Scene ─────────────────────────────────────────────────
    _set('mp-camera-name', camName || '—');

    const w = health.weather_api?.latest ?? {};
    const lighting = w.lighting || 'unknown';
    const weather  = w.weather  || 'unknown';
    const sceneCf  = w.confidence ?? 0;

    const lightIcon = LIGHTING_ICON[lighting] || LIGHTING_ICON.unknown;
    const weatherIcon = WEATHER_ICON[weather] || WEATHER_ICON.unknown;

    document.getElementById('mp-lighting')?.replaceChildren();
    if (document.getElementById('mp-lighting')) {
      document.getElementById('mp-lighting').innerHTML =
        `${lightIcon}<span style="margin-left:5px;text-transform:capitalize">${lighting}</span>`;
    }
    if (document.getElementById('mp-weather')) {
      document.getElementById('mp-weather').innerHTML =
        `${weatherIcon}<span style="margin-left:5px;text-transform:capitalize">${weather}</span>`;
    }
    _set('mp-scene-conf', `${Math.round(sceneCf * 100)}%`);
    const barEl = document.getElementById('mp-scene-conf-bar');
    if (barEl) barEl.style.width = `${Math.round(sceneCf * 100)}%`;

    // ── Detections ────────────────────────────────────────────
    const classCounts = det?.class_counts ?? {};
    const total = det?.detections_count ?? 0;
    const avgConf = det?.avg_confidence ?? null;
    // Show 24h total crossings (from intel cache) rather than per-frame new_crossings
    const crossings = _cachedIntel?.crossings_24h ?? null;

    const classOrder = ['car', 'truck', 'bus', 'motorcycle', 'person'];
    const maxCount = Math.max(1, ...Object.values(classCounts));
    const detClassesEl = document.getElementById('mp-det-classes');
    if (detClassesEl) {
      const rows = classOrder
        .filter(cls => classCounts[cls] != null || total > 0)
        .map(cls => {
          const count = classCounts[cls] ?? 0;
          const pct   = Math.round((count / maxCount) * 100);
          const color = CLASS_COLORS[cls] || '#64748b';
          return `<div class="mp-cls-row">
            <span class="mp-cls-name">${cls}</span>
            <div class="mp-cls-bar-wrap">
              <div class="mp-cls-bar" style="width:${pct}%;background:${color}20;border-color:${color}60"></div>
            </div>
            <span class="mp-cls-count" style="color:${count > 0 ? color : '#475569'}">${count}</span>
          </div>`;
        });
      detClassesEl.innerHTML = rows.join('') || '<span class="mp-muted">No detections yet</span>';
    }

    _set('mp-det-total', String(total));
    _set('mp-det-conf', avgConf != null ? `${(avgConf * 100).toFixed(1)}%` : '—');
    _set('mp-det-crossings', crossings != null ? _fmtNum(crossings) : '—');

    if (det?.captured_at) {
      const age = (Date.now() - new Date(det.captured_at)) / 1000;
      _set('mp-det-ts', _fmtAge(age));
    } else {
      _set('mp-det-ts', '—');
    }

    // ── Performance ───────────────────────────────────────────
    _set('mp-fps', health.ai_fps_estimate != null ? health.ai_fps_estimate.toFixed(1) : '—');
    _set('mp-frames', _fmtNum(health.ai_frames_total));
    _set('mp-device-full', health.ai_inference?.device_name || device.toUpperCase());
    const cudaOk = health.ai_inference?.cuda_available;
    const cudaEl = document.getElementById('mp-cuda');
    if (cudaEl) {
      cudaEl.textContent = cudaOk ? 'Available' : 'Not available';
      cudaEl.style.color = cudaOk ? '#22c55e' : '#94a3b8';
    }
    const dbLag = health.ai_last_db_write_age_sec;
    const dbLagEl = document.getElementById('mp-db-lag');
    if (dbLagEl) {
      dbLagEl.textContent = dbLag != null ? `${dbLag.toFixed(2)}s` : '—';
      dbLagEl.style.color = dbLag != null && dbLag > 5 ? '#f87171' : '#94a3b8';
    }
    const lastErr = health.ai_last_error;
    _set('mp-last-error', lastErr && lastErr !== 'start:startup' ? lastErr : 'none');

    // ── Tasks ─────────────────────────────────────────────────
    const tasksRowEl = document.getElementById('mp-tasks-row');
    if (tasksRowEl) {
      const restarts = health.watchdog_restart_counts ?? {};
      tasksRowEl.innerHTML = TASK_META.map(t => {
        const running  = health[t.key] ?? false;
        const rCount   = t.restartKey != null ? (restarts[t.restartKey] ?? 0) : null;
        const stateTag = running ? 'on' : 'off';
        const rBadge   = rCount != null && rCount > 0
          ? `<span class="mp-task-restarts">${rCount}↺</span>` : '';
        return `<div class="mp-task-pill" data-state="${stateTag}">
          <span class="mp-task-dot"></span>
          <span class="mp-task-name">${t.label}</span>
          ${rBadge}
        </div>`;
      }).join('');
    }
  }

  // ── Intel stats render ────────────────────────────────────────
  function _renderIntel(stats) {
    if (!stats) return;
    _set('mp-crossings-24h',   _fmtNum(stats.crossings_24h));
    _set('mp-crossings-total', _fmtNum(stats.crossings_total));
    _set('mp-zones-active',    String(stats.zones_active));
    _set('mp-turnings-24h',    _fmtNum(stats.turnings_24h));

    const clsColors = { car: '#00d4ff', truck: '#f59e0b', bus: '#a78bfa', motorcycle: '#34d399' };
    const TRAFFIC_CLASSES = ['car', 'truck', 'bus', 'motorcycle'];
    const clsEl = document.getElementById('mp-intel-classes');
    if (clsEl && stats.class_counts_24h) {
      const sorted = Object.entries(stats.class_counts_24h)
        .filter(([cls]) => TRAFFIC_CLASSES.includes(cls))
        .sort((a, b) => b[1] - a[1]);
      clsEl.innerHTML = sorted.length
        ? sorted.map(([cls, cnt]) =>
            `<span class="mp-intel-cls">
              <span class="mp-intel-cls-dot" style="background:${clsColors[cls]}"></span>
              <span>${cls}</span>
              <span class="mp-intel-cls-count" style="color:${clsColors[cls]}">${_fmtNum(cnt)}</span>
            </span>`
          ).join('')
        : '<span class="mp-muted">No data</span>';
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────
  function start() {
    if (_active) return;
    _active = true;
    render();
    _pollTimer = setInterval(render, 5000);
  }

  function stop() {
    _active = false;
    clearInterval(_pollTimer);
    _pollTimer = null;
  }

  function init() {
    // Watch for panel activation
    window.addEventListener('admin:panel-change', (e) => {
      if (e.detail?.panel === 'model') start();
      else stop();
    });
    // Also start if already active on load
    if (document.getElementById('panel-model')?.classList.contains('active')) {
      start();
    }
  }

  return { init, start, stop };
})();
