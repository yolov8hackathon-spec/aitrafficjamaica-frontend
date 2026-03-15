/**
 * camera-switcher.js
 * Camera picker modal triggered by the CAMERAS banner tile.
 * Cameras are grouped by category: "trafficwatcha" (ipcam) | "see_jamaica" (YouTube).
 * Live previews: ipcam via ipcamlive iframes, YouTube via embed iframes.
 */
const CameraSwitcher = (() => {
  let _cameras = [];
  let _aiCam    = null;   // the is_active camera object
  let _aiAlias  = null;   // ipcam_alias of AI cam (null for YouTube AI cam)
  let _activeId = null;   // id of currently displayed camera
  let _modal    = null;
  let _previewsLoaded = false;

  const _AI_SHOW = ['live-video', 'detection-canvas', 'zone-canvas', 'fps-overlay'];

  const _CATEGORY_LABELS = {
    trafficwatcha: 'TrafficWatcha',
    see_jamaica:   'See Jamaica',
  };

  function _ytVideoId(ytUrl) {
    try { return new URL(ytUrl).searchParams.get('v'); } catch { return null; }
  }

  async function init() {
    try {
      const { data } = await window.sb
        .from('cameras')
        .select('id, name, area, ipcam_alias, player_host, is_active, quality_snapshot, category, youtube_url')
        .order('category', { ascending: true })
        .order('name',  { ascending: true });

      if (!data?.length) return;
      _cameras = data;
      _aiCam   = _cameras.find(c => c.is_active) || null;
      _aiAlias = _aiCam?.ipcam_alias || null;
      _activeId = _aiCam?.id || null;

      // Set header cam chip to active camera name
      const camNameEl = document.getElementById('header-cam-name');
      if (camNameEl && _aiCam) camNameEl.textContent = _aiCam.name || _aiCam.ipcam_alias || '';

      _buildIframe();
      _buildModal();
      _wireCameraTile();
      _wireNonAiOverlay();
      _loadFpsBadges();
    } catch {}
  }

  // ── Fetch FPS per camera from ml_detection_events ────────────
  async function _loadFpsBadges() {
    try {
      const since = new Date(Date.now() - 5 * 60_000).toISOString();
      const { data: rows } = await window.sb
        .from("ml_detection_events")
        .select("camera_id, captured_at")
        .gte("captured_at", since)
        .order("captured_at", { ascending: true });

      if (!rows?.length) return;

      const groups = {};
      rows.forEach(r => {
        (groups[r.camera_id] = groups[r.camera_id] || []).push(r.captured_at);
      });

      let aiFps = null;
      try {
        const h = await fetch("/api/health").then(r => r.json());
        aiFps = h?.ai_fps_estimate ?? null;
      } catch {}

      _cameras.forEach(cam => {
        const fpsEl = _modal?.querySelector(`.cp-cam-card[data-cam-id="${cam.id}"] .cp-fps-badge`);
        if (!fpsEl) return;

        let fps = null;
        if (cam.is_active && aiFps != null) {
          fps = Number(aiFps);
        } else {
          const ts = groups[cam.id];
          if (ts && ts.length >= 2) {
            const elapsed = (new Date(ts.at(-1)) - new Date(ts[0])) / 1000;
            if (elapsed > 0) fps = ts.length / elapsed;
          }
        }
        if (fps == null) return;
        const label = fps >= 8 ? 'Smooth' : fps >= 4 ? 'Live' : fps > 0 ? 'Slow' : null;
        if (!label) return;
        fpsEl.textContent = label;
        fpsEl.classList.remove("hidden");
      });
    } catch {}
  }

  // ── Inject full-cover iframe into stream-wrapper ──────────────
  function _buildIframe() {
    const wrapper = document.querySelector('.stream-wrapper');
    if (!wrapper || document.getElementById('camera-iframe')) return;
    const iframe = document.createElement('iframe');
    iframe.id = 'camera-iframe';
    iframe.className = 'camera-iframe';
    iframe.allow = 'autoplay';
    iframe.setAttribute('allowfullscreen', '');
    iframe.style.display = 'none';
    wrapper.insertBefore(iframe, document.getElementById('count-widget') || null);
  }

  // ── Build picker modal ────────────────────────────────────────
  function _qualityLabel(score) {
    if (score == null) return '';
    if (score >= 80) return 'Excellent';
    if (score >= 60) return 'Good';
    if (score >= 40) return 'Fair';
    return 'Poor';
  }

  function _buildCamCard(c) {
    const isAI = c.is_active;
    const q = c.quality_snapshot;
    const qScore = q?.quality_score != null ? Math.round(q.quality_score) : null;
    const qCls = qScore == null ? '' : qScore >= 60 ? 'cp-quality-good' : qScore >= 40 ? 'cp-quality-mid' : 'cp-quality-bad';
    const lightIcon = q?.lighting === 'night' ? '🌙' : q?.lighting === 'day' ? '☀' : '';
    const qualBadge = qScore != null
      ? `<span class="cp-quality-badge ${qCls}">${lightIcon ? `<span class="cp-light-icon">${lightIcon}</span>` : ''}${_qualityLabel(qScore)}</span>`
      : '';

    const isYT = !!c.youtube_url;
    const ytBadge = isYT ? '<span class="cp-yt-badge">▶ YouTube</span>' : '';

    // YouTube: use thumbnail image (embeds blocked by many channels)
    // ipcam: use lazy-loaded iframe
    const previewInner = isYT
      ? (() => {
          const vid = _ytVideoId(c.youtube_url);
          const thumb = vid ? `https://img.youtube.com/vi/${vid}/hqdefault.jpg` : '';
          return `<img class="cp-yt-thumb" src="${thumb}" alt="${c.name}" loading="lazy">
                  <div class="cp-yt-play-icon">▶</div>`;
        })()
      : `<iframe class="cp-preview-iframe"
           data-alias="${c.ipcam_alias}" data-host="${c.player_host || 'g3'}"
           allow="autoplay" scrolling="no" frameborder="0"></iframe>
         <div class="cp-preview-loader"><span></span></div>`;

    return `
      <div class="cp-cam-card${isAI ? ' cp-cam-ai' : ''}" data-cam-id="${c.id}" tabindex="0" role="button" aria-label="${c.name}">
        <div class="cp-preview-wrap${isYT ? ' cp-preview-loaded' : ''}">
          ${previewInner}
          <div class="cp-click-shield"></div>
        </div>
        <div class="cp-cam-info">
          ${isAI ? '<span class="cp-ai-badge"><span class="cp-ai-dot"></span>AI Live</span>' : ''}
          ${ytBadge}
          <span class="cp-cam-name">${c.name}</span>
          <div class="cp-cam-meta">
            <span class="cp-fps-badge hidden"></span>
            ${qualBadge}
          </div>
        </div>
      </div>`;
  }

  function _buildModal() {
    if (document.getElementById('cam-picker-modal')) return;

    // Group cameras by category
    const groups = {};
    _cameras.forEach(c => {
      const cat = c.category || 'trafficwatcha';
      (groups[cat] = groups[cat] || []).push(c);
    });

    // Render category order: trafficwatcha first, then see_jamaica
    const catOrder = ['trafficwatcha', 'see_jamaica', ...Object.keys(groups).filter(k => k !== 'trafficwatcha' && k !== 'see_jamaica')];

    let bodyHtml = '';
    catOrder.forEach(cat => {
      const cams = groups[cat];
      if (!cams?.length) return;
      const label = _CATEGORY_LABELS[cat] || cat;
      bodyHtml += `<div class="cp-category-section">
        <div class="cp-category-header">${label}</div>
        <div class="cp-category-grid">${cams.map(_buildCamCard).join('')}</div>
      </div>`;
    });

    const total = _cameras.length;
    const modal = document.createElement('div');
    modal.id = 'cam-picker-modal';
    modal.className = 'cam-picker-modal hidden';
    modal.innerHTML = `
      <div class="cam-picker-inner">
        <div class="cam-picker-head">
          <div class="cam-picker-head-left">
            <span class="cam-picker-title">Live Cameras</span>
            <span class="cam-picker-count">${total} feed${total !== 1 ? 's' : ''}</span>
          </div>
          <button class="cam-picker-close" aria-label="Close">✕</button>
        </div>
        <div class="cam-picker-body">${bodyHtml}</div>
      </div>`;

    document.body.appendChild(modal);
    _modal = modal;

    modal.querySelector('.cam-picker-close').addEventListener('click', _closeModal);
    modal.addEventListener('click', e => {
      if (e.target === modal) { _closeModal(); return; }
      const card = e.target.closest('.cp-cam-card');
      if (card) { _switchTo(card.dataset.camId); _closeModal(); }
    });
    modal.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        const card = e.target.closest('.cp-cam-card');
        if (card) { _switchTo(card.dataset.camId); _closeModal(); }
      }
      if (e.key === 'Escape') _closeModal();
    });
  }

  // ── Non-AI overlay ────────────────────────────────────────────
  function _wireNonAiOverlay() {
    const btn = document.getElementById("btn-go-ai-cam");
    if (!btn) return;
    const nameEl = document.getElementById("non-ai-cam-name");
    if (nameEl && _aiCam?.name) nameEl.textContent = _aiCam.name;
    btn.addEventListener("click", () => {
      if (_aiCam?.id) _switchTo(_aiCam.id);
    });
  }

  function _setNonAiOverlay(visible) {
    document.getElementById("non-ai-overlay")?.classList.toggle("hidden", !visible);
  }

  // ── Wire the CAMERAS banner tile (rendered dynamically) ───────
  function _wireCameraTile() {
    document.addEventListener('click', e => {
      if (e.target.closest('#bnr-camera-tile')) _openModal();
    });
  }

  function _openModal() {
    if (!_modal) return;
    _modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';

    // Highlight current selection
    _modal.querySelectorAll('.cp-cam-card').forEach(card => {
      card.classList.toggle('cp-cam-active', card.dataset.camId === _activeId);
    });

    // Stagger-load ipcam iframe previews (YouTube cards already show thumbnails)
    if (!_previewsLoaded) {
      _previewsLoaded = true;
      _modal.querySelectorAll('.cp-preview-iframe').forEach((iframe, i) => {
        setTimeout(() => {
          const host = iframe.dataset.host || 'g3';
          const alias = iframe.dataset.alias;
          if (alias) iframe.src = `https://${host}.ipcamlive.com/player/player.php?alias=${alias}&autoplay=1`;
          iframe.addEventListener('load', () => {
            iframe.closest('.cp-preview-wrap')?.classList.add('cp-preview-loaded');
          }, { once: true });
        }, i * 500);
      });
    }
  }

  function _closeModal() {
    _modal?.classList.add('hidden');
    document.body.style.overflow = '';
  }

  // ── YouTube watch overlay (embedding disabled) ────────────────
  function _showYtWatchOverlay(cam) {
    const wrapper = document.querySelector('.stream-wrapper');
    if (!wrapper) return;
    const vid   = _ytVideoId(cam.youtube_url);
    const thumb = vid ? `https://img.youtube.com/vi/${vid}/maxresdefault.jpg` : '';
    const div   = document.createElement('div');
    div.id = 'yt-watch-overlay';
    div.className = 'yt-watch-overlay';
    div.innerHTML = `
      ${thumb ? `<img class="yt-wo-thumb" src="${thumb}" alt="${cam.name}">` : ''}
      <div class="yt-wo-body">
        <div class="yt-wo-name">${cam.name}</div>
        <div class="yt-wo-note">Live stream — embedding not available</div>
        <a class="yt-wo-btn" href="${cam.youtube_url}" target="_blank" rel="noopener">
          ▶ Watch Live on YouTube
        </a>
      </div>`;
    wrapper.appendChild(div);
  }

  // ── Switch main stream ────────────────────────────────────────
  function _switchTo(camId) {
    if (camId === _activeId) return;
    _activeId = camId;
    const cam = _cameras.find(c => c.id === camId);
    if (!cam) return;

    const iframe = document.getElementById('camera-iframe');
    const isAI = cam.is_active;
    const isYT = !!cam.youtube_url;

    _AI_SHOW.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = isAI ? '' : 'none';
    });

    if (isAI) {
      window.dispatchEvent(new CustomEvent('stream:switching', { detail: { alias: cam.ipcam_alias || '' } }));
      // For YouTube AI cam: alias is '' → Stream fetches /api/stream with no alias,
      // backend serves the yt-dlp HLS URL.
      window.Stream?.setAlias(cam.ipcam_alias || '');
    }

    // Remove any existing YouTube watch overlay
    document.getElementById('yt-watch-overlay')?.remove();

    if (iframe) {
      if (isAI) {
        iframe.src = '';
        iframe.style.display = 'none';
      } else if (isYT) {
        // Embedding disabled — show a watch-on-YouTube overlay instead
        iframe.src = '';
        iframe.style.display = 'none';
        _showYtWatchOverlay(cam);
      } else {
        const host = cam.player_host || 'g3';
        iframe.src = `https://${host}.ipcamlive.com/player/player.php?alias=${cam.ipcam_alias}&autoplay=1`;
        iframe.style.display = 'block';
      }
    }

    if (!isAI) document.getElementById('stream-offline-overlay')?.classList.add('hidden');
    _setNonAiOverlay(!isAI);

    document.getElementById('ml-hud')?.classList.toggle('hidden', !isAI);
    document.getElementById('count-widget')?.classList.toggle('hidden', !isAI);

    const label = document.getElementById('active-cam-label');
    if (label) label.textContent = cam.name;

    const camNameEl = document.getElementById('header-cam-name');
    if (camNameEl) camNameEl.textContent = cam.name || '';

    window.dispatchEvent(new CustomEvent('camera:switched', {
      detail: { alias: cam.ipcam_alias || '', cameraId: cam.id, name: cam.name, isAI }
    }));
  }

  function isOnAiCam() { return _activeId === (_aiCam?.id || null); }

  function switchTo(camId) { _switchTo(camId); }

  return { init, isOnAiCam, switchTo };
})();

window.CameraSwitcher = CameraSwitcher;
