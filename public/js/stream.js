/**
 * stream.js — Load HLS stream using hls.js.
 * Stream URL is never stored in JS — it's fetched from /api/token.
 */

const Stream = (() => {
  let hlsInstance = null;
  let currentAlias = "";
  let currentVideoEl = null;
  let retryTimer = null;
  let _wssUrl = null;   // Railway WS URL — kept in module scope, NOT on window
  let _mediaRecoveryAttempts = 0;

  function emitStatus(status, detail = {}) {
    window.dispatchEvent(new CustomEvent("stream:status", { detail: { status, ...detail } }));
  }

  function clearRetry() {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  function buildStreamUrl() {
    // Always route through the Vercel proxy — never expose the upstream URL.
    const qs = currentAlias ? `?alias=${encodeURIComponent(currentAlias)}` : "";
    return `/api/stream${qs}`;
  }

  async function init(videoEl, opts = {}) {
    currentVideoEl = videoEl;
    if (opts && Object.prototype.hasOwnProperty.call(opts, "alias")) {
      currentAlias = String(opts.alias || "").trim();
    }
    clearRetry();
    // Re-use token if counter.js already fetched it in the same session.
    let tokenData = window.AppCache?.get("ws:token");
    if (!tokenData) {
      const res = await fetch("/api/token");
      if (!res.ok) throw new Error("Failed to get stream token");
      tokenData = await res.json();
      window.AppCache?.set("ws:token", tokenData, 4 * 60 * 1000);
    }
    const { wss_url, token } = tokenData;

    // Share token with other modules (counter.js etc.) via window.
    // wss_url is kept in module scope only — not exposed on window.
    window._wsToken = token;
    _wssUrl = wss_url;

    // Stream proxied through Vercel — avoids ipcamlive CORS restriction
    const streamUrl = buildStreamUrl();

    if (Hls.isSupported()) {
      destroy();
      _mediaRecoveryAttempts = 0;
      hlsInstance = new Hls({
        enableWorker: true,
        lowLatencyMode: true,          // LL-HLS — reduces video lag from ~10s to ~2-4s
        backBufferLength: 2,           // was 10 — minimal back buffer
        maxBufferLength: 4,            // was 15 — stay close to live edge
        maxMaxBufferLength: 8,         // was 30
        liveSyncDurationCount: 1,      // try to stay 1 segment from live edge
        liveMaxLatencyDurationCount: 3,
        fragLoadingMaxRetry: 4,
        levelLoadingMaxRetry: 4,
        manifestLoadingMaxRetry: 3,
      });
      hlsInstance.loadSource(streamUrl);
      hlsInstance.attachMedia(videoEl);
      hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
        _mediaRecoveryAttempts = 0;
        emitStatus("ok", { alias: currentAlias });
        videoEl.play().catch(() => {
          // Autoplay blocked — show play button
          document.getElementById("play-overlay")?.classList.remove("hidden");
        });
      });
      hlsInstance.on(Hls.Events.ERROR, (_, data) => {
        if (!data.fatal) return;
        // Log type/details only — do not log the full data object (may contain URLs).
        console.warn("[Stream] Fatal HLS error:", data?.type, data?.details);

        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          // Media errors (bufferAppendError etc.) — try soft recovery first
          if (_mediaRecoveryAttempts === 0) {
            console.info("[Stream] Attempting media recovery (attempt 1)");
            _mediaRecoveryAttempts++;
            hlsInstance.recoverMediaError();
            return;
          } else if (_mediaRecoveryAttempts === 1) {
            console.info("[Stream] Attempting codec swap + media recovery (attempt 2)");
            _mediaRecoveryAttempts++;
            hlsInstance.swapAudioCodec();
            hlsInstance.recoverMediaError();
            return;
          }
          // Recovery exhausted — fall through to full reinit
        }

        emitStatus("down", { alias: currentAlias, reason: data?.details || "fatal_error" });
        clearRetry();
        retryTimer = setTimeout(() => init(videoEl, { alias: currentAlias }), 6000);
      });
    } else if (videoEl.canPlayType("application/vnd.apple.mpegurl")) {
      // Safari native HLS
      videoEl.src = streamUrl;
      videoEl.addEventListener("loadedmetadata", () => {
        emitStatus("ok", { alias: currentAlias });
        videoEl.play().catch(() => {});
      });
      videoEl.addEventListener("error", () => {
        emitStatus("down", { alias: currentAlias, reason: "native_error" });
      });
    } else {
      console.error("[Stream] HLS not supported in this browser");
      emitStatus("down", { alias: currentAlias, reason: "unsupported_browser" });
    }
  }

  function setAlias(alias) {
    currentAlias = String(alias || "").trim();
    if (currentVideoEl) {
      init(currentVideoEl, { alias: currentAlias });
    }
  }

  function destroy() {
    clearRetry();
    _mediaRecoveryAttempts = 0;
    if (hlsInstance) {
      hlsInstance.destroy();
      hlsInstance = null;
    }
  }

  function getWssUrl() { return _wssUrl; }

  /**
   * Returns how many ms the video element's playback lags behind the live edge.
   * Uses the buffered range end (live edge) minus currentTime.
   * Falls back to 0 when the video hasn't loaded yet.
   */
  function getVideoLag(videoEl) {
    const vid = videoEl || currentVideoEl;
    if (!vid) return 0;
    try {
      if (!vid.buffered.length) return 0;
      const liveEdge = vid.buffered.end(vid.buffered.length - 1);
      return Math.max(0, (liveEdge - vid.currentTime) * 1000);
    } catch { return 0; }
  }

  return { init, destroy, setAlias, getWssUrl, getVideoLag };
})();

window.Stream = Stream;
