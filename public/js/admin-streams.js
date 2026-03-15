/**
 * admin-streams.js — Camera / stream source management for admin panel.
 * Supports ipcam alias strings AND direct HLS URLs stored in ipcam_alias.
 * Human-readable name is stored in feed_appearance.label (existing JSONB col).
 */
const AdminStreams = (() => {
  let _cameras = [];
  let _editId = null;
  const _hlsMap = {}; // camId → Hls instance

  // ── Helpers ───────────────────────────────────────────────────
  function esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function _camLabel(cam) {
    return cam?.feed_appearance?.label || cam?.ipcam_alias || "(unnamed)";
  }

  function _isUrl(alias) {
    return /^https?:\/\//i.test(String(alias || ""));
  }

  function _msg(text, isErr = false) {
    const el = document.getElementById("streams-msg");
    if (!el) return;
    el.textContent = text;
    el.className = "streams-msg " + (isErr ? "streams-msg-err" : "streams-msg-ok");
    setTimeout(() => { if (el.textContent === text) el.textContent = ""; }, 4500);
  }

  // ── Load ──────────────────────────────────────────────────────
  async function _load() {
    const listEl = document.getElementById("streams-list");
    if (listEl) listEl.innerHTML = '<p class="loading">Loading streams...</p>';

    const { data, error } = await window.sb
      .from("cameras")
      .select("id, ipcam_alias, created_at, is_active, feed_appearance, player_host, area, quality_snapshot")
      .order("created_at", { ascending: false });

    if (error) { _msg("Load failed: " + error.message, true); return; }
    _cameras = Array.isArray(data) ? data : [];

    // Fetch FPS per camera from ml_detection_events (last 5 min)
    const since = new Date(Date.now() - 5 * 60_000).toISOString();
    const [fpsResp, healthResp] = await Promise.all([
      window.sb
        .from("ml_detection_events")
        .select("camera_id, captured_at")
        .gte("captured_at", since)
        .order("captured_at", { ascending: true }),
      fetch("/api/health").then(r => r.json()).catch(() => null),
    ]);

    const fpsRows = fpsResp?.data || [];
    const groups = {};
    fpsRows.forEach(r => {
      (groups[r.camera_id] = groups[r.camera_id] || []).push(r.captured_at);
    });
    _fpsMap = {};
    const aiFps = healthResp?.ai_fps_estimate ?? null;
    _cameras.forEach(cam => {
      if (cam.is_active && aiFps != null) {
        _fpsMap[cam.id] = aiFps;
        return;
      }
      const ts = groups[cam.id];
      if (!ts || ts.length < 2) return;
      const elapsed = (new Date(ts.at(-1)) - new Date(ts[0])) / 1000;
      if (elapsed > 0) _fpsMap[cam.id] = ts.length / elapsed;
    });

    _render();
  }

  let _fpsMap = {};

  // ── Determine which camera the public page loads by default ──
  function _getDefaultCamId() {
    const rank = (cam) => {
      const a = String(cam?.ipcam_alias || "").trim();
      if (!a || a.toLowerCase() === "your-alias") return 0;
      return 1;
    };
    const active = _cameras.filter(c => c.is_active && rank(c) > 0);
    if (!active.length) return null;
    active.sort((a, b) => {
      const at = Date.parse(a?.created_at || 0) || 0;
      const bt = Date.parse(b?.created_at || 0) || 0;
      if (at !== bt) return bt - at;
      return String(b?.id || "").localeCompare(String(a?.id || ""));
    });
    return active[0]?.id ?? null;
  }

  // ── Quality helpers ───────────────────────────────────────────
  function _qualityBadge(q) {
    if (!q || q.quality_score == null) return "";
    const score = Math.round(q.quality_score);
    const cls = score >= 70 ? "stream-quality-good" : score >= 40 ? "stream-quality-mid" : "stream-quality-bad";
    const light = q.lighting ? `<span class="stream-lighting-tag stream-lighting-${q.lighting}">${q.lighting}</span>` : "";
    return `<span class="stream-quality-badge ${cls}" title="Brightness: ${q.brightness}  Sharpness: ${q.sharpness}  Contrast: ${q.contrast}">${light}Q:${score}</span>`;
  }

  function _autoPick() {
    const scored = _cameras.filter(c => c.quality_snapshot?.quality_score != null);
    if (!scored.length) { _msg("No quality data yet — wait for probe cycle.", true); return; }
    scored.sort((a, b) => b.quality_snapshot.quality_score - a.quality_snapshot.quality_score);
    const best = scored[0];
    if (confirm(`Set "${best.feed_appearance?.label || best.ipcam_alias}" as AI camera? (score: ${Math.round(best.quality_snapshot.quality_score)})`)) {
      _setAiCamera(String(best.id));
    }
  }

  // ── Render list ───────────────────────────────────────────────
  function _render() {
    const el = document.getElementById("streams-list");
    if (!el) return;

    if (!_cameras.length) {
      el.innerHTML = '<p class="muted" style="padding:12px 0;">No streams configured. Add one below.</p>';
      return;
    }

    const defaultId = _getDefaultCamId();

    // Render "Auto-pick Best" button above list
    const hasQuality = _cameras.some(c => c.quality_snapshot?.quality_score != null);
    const autoPickEl = document.getElementById("streams-autopick-btn");
    if (autoPickEl) {
      autoPickEl.style.display = hasQuality ? "" : "none";
    }

    el.innerHTML = _cameras.map(cam => {
      const label     = cam?.feed_appearance?.label || "";
      const alias     = cam.ipcam_alias || "";
      const isIpcam   = !_isUrl(alias);
      const typeTag   = isIpcam ? "ipcamlive" : "Direct URL";
      const host      = cam.player_host || "g3";
      const area      = cam.area ? `<span class="stream-area-tag">${esc(cam.area)}</span>` : "";
      const fpsVal      = _fpsMap[cam.id];
      const fpsBadge    = fpsVal != null
        ? `<span class="stream-fps-badge">${Number(fpsVal).toFixed(1)} fps</span>`
        : "";
      const qualBadge   = _qualityBadge(cam.quality_snapshot);
      const isDefault = cam.is_active && String(cam.id) === String(defaultId);
      const activeCls  = cam.is_active ? "stream-badge-active" : "stream-badge-inactive";
      const activeText = cam.is_active ? "AI Active" : "Inactive";
      const liveBadge  = isDefault
        ? '<span class="stream-live-badge"><span class="stream-live-dot"></span>LIVE ON PUBLIC</span>'
        : "";

      const aiIcon  = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5M2 12l10 5 10-5"/></svg>';
      const offIcon = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>';

      // ipcam: inline iframe preview (auto-loaded staggered after render)
      // direct URL: click-to-play HLS video
      const previewBlock = isIpcam
        ? `<div class="stream-row-iframe-wrap" id="sprv-${cam.id}">
             <div class="stream-row-iframe-loader"><span class="sprv-spinner"></span></div>
             <iframe class="stream-row-iframe" id="sprv-iframe-${cam.id}"
               data-alias="${esc(alias)}" data-host="${esc(host)}"
               allowfullscreen allow="autoplay" frameborder="0"></iframe>
           </div>`
        : `<div class="stream-row-preview-wrap hidden" id="sprv-${cam.id}">
             <video class="stream-row-video" data-cam-id="${cam.id}" muted playsinline></video>
             <button class="stream-prv-close" data-id="${cam.id}">&#x2715;</button>
           </div>`;

      const previewBtn = isIpcam ? "" : `
            <button class="btn-sm stream-btn-preview" data-action="preview" data-id="${cam.id}" data-alias="${esc(alias)}">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="2" y="7" width="14" height="10" rx="1.5"/><path d="M16 10l5-3v10l-5-3"/></svg>
              Preview
            </button>`;

      const hasZones = !!(cam.count_line || cam.detect_zone);
      const zonesIcon = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polygon points="3 11 3 20 21 20 21 11 12 3 3 11"/><line x1="3" y1="20" x2="21" y2="20"/></svg>';

      return `
        <div class="stream-row ${isDefault ? "stream-row-live" : ""}" data-id="${cam.id}">
          <div class="stream-row-info">
            ${label ? `<span class="stream-row-label">${esc(label)}</span>` : ""}
            <span class="stream-row-alias">${esc(alias)}</span>
            ${liveBadge}
            ${area}
            ${fpsBadge}
            ${qualBadge}
            <span class="stream-badge ${activeCls}">${activeText}</span>
            <span class="stream-type-tag">${typeTag}</span>
            ${hasZones ? '<span class="stream-zones-badge">zones set</span>' : ""}
          </div>
          ${previewBlock}
          <div class="stream-row-actions">
            ${previewBtn}
            <button class="btn-sm stream-btn-edit" data-action="edit" data-id="${cam.id}">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              Edit
            </button>
            <button class="btn-sm stream-btn-zones ${hasZones ? "stream-btn-zones-set" : ""}" data-action="zones" data-id="${cam.id}" data-alias="${esc(alias)}">
              ${zonesIcon} Zones
            </button>
            ${cam.is_active
              ? `<button class="btn-sm stream-btn-deactivate" data-action="deactivate-ai" data-id="${cam.id}">${offIcon} Remove AI</button>`
              : `<button class="btn-sm stream-btn-set-ai" data-action="set-ai" data-id="${cam.id}">${aiIcon} Set as AI Cam</button>`
            }
            <button class="btn-sm stream-btn-delete" data-action="delete" data-id="${cam.id}">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
              Delete
            </button>
          </div>
        </div>`;
    }).join("");

    // Wire action buttons
    el.querySelectorAll("[data-action]").forEach(btn => {
      btn.addEventListener("click", _handleRowAction);
    });
    el.querySelectorAll(".stream-prv-close").forEach(btn => {
      btn.addEventListener("click", () => _stopPreview(btn.dataset.id));
    });

    // Lazy-load ipcam iframes — only load when scrolled into view
    const _iframeObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        const iframe = entry.target;
        if (iframe.src) return; // already loaded
        const alias = iframe.dataset.alias;
        const host  = iframe.dataset.host || "g3";
        iframe.src = `https://${host}.ipcamlive.com/player/player.php?alias=${encodeURIComponent(alias)}&autoplay=1`;
        iframe.addEventListener("load", () => {
          iframe.closest(".stream-row-iframe-wrap")?.classList.add("sprv-loaded");
        }, { once: true });
        _iframeObserver.unobserve(iframe);
      });
    }, { rootMargin: "100px" });

    el.querySelectorAll(".stream-row-iframe").forEach(iframe => {
      _iframeObserver.observe(iframe);
    });
  }

  function _handleRowAction(e) {
    const btn = e.currentTarget;
    const id = btn.dataset.id;
    switch (btn.dataset.action) {
      case "preview":       _togglePreview(id, btn.dataset.alias); break;
      case "edit":          _startEdit(id); break;
      case "zones":         _openZoneEditor(id, btn.dataset.alias); break;
      case "set-ai":        _setAiCamera(id); break;
      case "deactivate-ai": _deactivateAi(id); break;
      case "delete":        _deleteCamera(id); break;
    }
  }

  // ── Zone Editor ───────────────────────────────────────────────
  // Scrolls to existing admin zone editor section and loads the chosen camera
  function _openZoneEditor(camId, alias) {
    const cam = _cameras.find(c => String(c.id) === String(camId));
    const label = cam?.feed_appearance?.label || alias || camId;

    // Update the "currently editing" label in the zone editor header
    const editingLabel = document.getElementById("zone-editor-cam-label");
    if (editingLabel) editingLabel.textContent = label;

    // Switch admin stream + AdminLine to this camera
    if (window.AdminLine) {
      const videoEl = document.getElementById("admin-video");
      const canvasEl = document.getElementById("line-canvas");
      if (videoEl && canvasEl) {
        // Switch HLS stream to this camera's alias
        const streamUrl = _isUrl(alias) ? alias : `/api/stream?alias=${encodeURIComponent(alias)}`;
        if (window.Hls && Hls.isSupported()) {
          if (_adminVideoHls) { _adminVideoHls.destroy(); }
          _adminVideoHls = new Hls({ enableWorker: false, maxBufferLength: 8, maxMaxBufferLength: 16 });
          _adminVideoHls.loadSource(streamUrl);
          _adminVideoHls.attachMedia(videoEl);
          _adminVideoHls.on(Hls.Events.MANIFEST_PARSED, () => { videoEl.play().catch(() => {}); });
        } else if (videoEl.canPlayType?.("application/vnd.apple.mpegurl")) {
          videoEl.src = streamUrl;
          videoEl.play().catch(() => {});
        }
        // Switch AdminLine to this camera (re-init updates cameraId + reloads zones)
        AdminLine.init(videoEl, canvasEl, camId);
        AdminLine.loadZones?.();
        // Switch landmarks editor to this camera
        const lmCanvas = document.getElementById('landmark-canvas');
        if (lmCanvas && window.AdminLandmarks) {
          AdminLandmarks.reinit(videoEl, lmCanvas, camId);
        }
      }
    }

    // Navigate to AI Engine → Zones tab
    document.querySelector('.admin-nav-btn[data-panel="detection"]')?.click();
    setTimeout(() => {
      document.querySelector('.det-subnav-btn[data-det-tab="zones"]')?.click();
    }, 60);
  }

  let _adminVideoHls = null;

  // ── Preview ───────────────────────────────────────────────────
  function _togglePreview(camId, alias) {
    const wrap = document.getElementById(`sprv-${camId}`);
    if (!wrap) return;
    if (!wrap.classList.contains("hidden")) {
      _stopPreview(camId); return;
    }
    wrap.classList.remove("hidden");

    const videoEl = wrap.querySelector("video");
    if (!videoEl) return;

    const url = _isUrl(alias) ? alias : `/api/stream?alias=${encodeURIComponent(alias)}`;

    if (Hls.isSupported()) {
      if (_hlsMap[camId]) { _hlsMap[camId].destroy(); }
      const h = new Hls({ enableWorker: false, maxBufferLength: 8, maxMaxBufferLength: 16 });
      h.loadSource(url);
      h.attachMedia(videoEl);
      h.on(Hls.Events.MANIFEST_PARSED, () => { videoEl.play().catch(() => {}); });
      _hlsMap[camId] = h;
    } else if (videoEl.canPlayType("application/vnd.apple.mpegurl")) {
      videoEl.src = url;
      videoEl.play().catch(() => {});
    }
  }

  function _stopPreview(camId) {
    const wrap = document.getElementById(`sprv-${camId}`);
    if (wrap) wrap.classList.add("hidden");
    if (_hlsMap[camId]) { _hlsMap[camId].destroy(); delete _hlsMap[camId]; }
    const vid = wrap?.querySelector("video");
    if (vid) { vid.pause(); vid.src = ""; }
  }

  // ── Edit ──────────────────────────────────────────────────────
  function _startEdit(id) {
    const cam = _cameras.find(c => String(c.id) === String(id));
    if (!cam) return;
    _editId = id;

    const heading = document.getElementById("streams-form-heading");
    const nameEl  = document.getElementById("streams-form-name");
    const aliasEl = document.getElementById("streams-form-alias");
    const activeEl = document.getElementById("streams-form-active");
    const submitBtn = document.getElementById("streams-form-submit");

    if (heading)   heading.textContent = "Edit Stream";
    if (nameEl)    nameEl.value  = cam.feed_appearance?.label || "";
    if (aliasEl)   aliasEl.value = cam.ipcam_alias || "";
    if (activeEl)  activeEl.checked = !!cam.is_active;
    if (submitBtn) submitBtn.textContent = "Update Stream";

    document.getElementById("streams-form-card")?.scrollIntoView({ behavior: "smooth" });
  }

  // ── AI camera selection (exclusive — one atomic backend call) ────────────────
  async function _setAiCamera(id) {
    const btn = document.querySelector(`[data-action="set-ai"][data-id="${id}"]`);
    if (btn) { btn.disabled = true; btn.textContent = "Switching…"; }

    try {
      const session = await window.Auth?.getSession?.();
      const jwt = session?.access_token || null;

      const res = await fetch("/api/admin/camera-switch", {
        method: "POST",
        headers: {
          "Authorization": jwt ? `Bearer ${jwt}` : "",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ camera_id: id }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        _msg("Switch failed: " + (data.detail || data.error || res.status), true);
        return;
      }

      _msg("Camera switched. AI reset, tracker cleared, scene lock lifted.");

      // Clear stale detection boxes from previous camera immediately
      window.DetectionOverlay?.clearDetections?.();

      // If zone editor is open, reload zones for new camera
      const cam = _cameras.find(c => String(c.id) === String(id));
      if (cam) {
        window.ZoneOverlay?.reloadZones?.(cam.ipcam_alias);
        window.Stream?.setAlias?.(cam.ipcam_alias);
      }

      await _load();
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "Set as AI Cam"; }
    }
  }

  async function _deactivateAi(id) {
    const { error } = await window.sb
      .from("cameras")
      .update({ is_active: false })
      .eq("id", id);
    if (error) { _msg("Error: " + error.message, true); return; }
    _msg("AI deactivated for this camera.");
    await _load();
  }

  // ── Delete ────────────────────────────────────────────────────
  async function _deleteCamera(id) {
    if (!confirm("Delete this stream? This cannot be undone.")) return;
    _stopPreview(id);
    const { error } = await window.sb.from("cameras").delete().eq("id", id);
    if (error) { _msg("Delete failed: " + error.message, true); return; }
    _msg("Stream deleted.");
    await _load();
  }

  // ── Form ──────────────────────────────────────────────────────
  function _wireForm() {
    const form = document.getElementById("streams-form");
    const cancelBtn = document.getElementById("streams-form-cancel");
    if (!form) return;

    cancelBtn?.addEventListener("click", _resetForm);

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const name   = document.getElementById("streams-form-name")?.value.trim() || "";
      const alias  = document.getElementById("streams-form-alias")?.value.trim() || "";
      const active = document.getElementById("streams-form-active")?.checked ?? true;

      if (!alias) { _msg("Stream alias or URL is required.", true); return; }

      const submitBtn = document.getElementById("streams-form-submit");
      if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = "Saving..."; }

      // Store label in feed_appearance.label (merges with existing config)
      const existingAppearance = _editId
        ? (_cameras.find(c => String(c.id) === String(_editId))?.feed_appearance || {})
        : {};
      const appearance = { ...existingAppearance, label: name || alias };

      let error;
      if (_editId) {
        ({ error } = await window.sb.from("cameras")
          .update({ ipcam_alias: alias, is_active: active, feed_appearance: appearance })
          .eq("id", _editId));
      } else {
        ({ error } = await window.sb.from("cameras")
          .insert({ ipcam_alias: alias, is_active: active, feed_appearance: appearance }));
      }

      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = _editId ? "Update Stream" : "Add Stream";
      }
      if (error) { _msg("Error: " + error.message, true); return; }
      _msg(_editId ? "Stream updated." : "Stream added.");
      _resetForm();
      await _load();
    });
  }

  function _resetForm() {
    _editId = null;
    const form = document.getElementById("streams-form");
    if (form) form.reset();
    const heading = document.getElementById("streams-form-heading");
    if (heading) heading.textContent = "Add Stream";
    const submitBtn = document.getElementById("streams-form-submit");
    if (submitBtn) submitBtn.textContent = "Add Stream";
  }

  // ── Init ──────────────────────────────────────────────────────
  function init() {
    _load();
    _wireForm();
    document.getElementById("streams-autopick-btn")
      ?.addEventListener("click", _autoPick);
  }

  return { init, reload: _load };
})();

window.AdminStreams = AdminStreams;
