import Hls from 'hls.js';
import { AppCache } from '../core/cache.js';

let hlsInstance = null;
let currentAlias = '';
let currentVideoEl = null;
let retryTimer = null;
let _wssUrl = null;
let _mediaRecoveryAttempts = 0;

function emitStatus(status, detail = {}) {
  window.dispatchEvent(new CustomEvent('stream:status', { detail: { status, alias: currentAlias, ...detail } }));
}

function clearRetry() {
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
}

function buildStreamUrl() {
  const qs = currentAlias ? `?alias=${encodeURIComponent(currentAlias)}` : '';
  return `/api/stream${qs}`;
}

async function init(videoEl, opts = {}) {
  currentVideoEl = videoEl;
  if (opts && Object.prototype.hasOwnProperty.call(opts, 'alias')) {
    currentAlias = String(opts.alias || '').trim();
  }
  clearRetry();
  let tokenData = AppCache.get('ws:token');
  if (!tokenData) {
    const res = await fetch('/api/token');
    if (!res.ok) throw new Error('Failed to get stream token');
    tokenData = await res.json();
    AppCache.set('ws:token', tokenData, 4 * 60 * 1000);
  }
  const { wss_url, token } = tokenData;
  window._wsToken = token;
  _wssUrl = wss_url;
  const streamUrl = buildStreamUrl();

  if (Hls.isSupported()) {
    destroy();
    _mediaRecoveryAttempts = 0;
    hlsInstance = new Hls({
      enableWorker: true,
      lowLatencyMode: true,
      backBufferLength: 2,
      maxBufferLength: 4,
      maxMaxBufferLength: 8,
      liveSyncDurationCount: 1,
      liveMaxLatencyDurationCount: 3,
      fragLoadingMaxRetry: 4,
      levelLoadingMaxRetry: 4,
      manifestLoadingMaxRetry: 3,
    });
    hlsInstance.loadSource(streamUrl);
    hlsInstance.attachMedia(videoEl);
    hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
      _mediaRecoveryAttempts = 0;
      emitStatus('ok', { alias: currentAlias });
      videoEl.play().catch(() => {
        document.getElementById('play-overlay')?.classList.remove('hidden');
      });
    });
    hlsInstance.on(Hls.Events.ERROR, (_, data) => {
      if (!data.fatal) return;
      console.warn('[Stream] Fatal HLS error:', data?.type, data?.details);
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        if (_mediaRecoveryAttempts === 0) {
          _mediaRecoveryAttempts++;
          hlsInstance.recoverMediaError();
          return;
        } else if (_mediaRecoveryAttempts === 1) {
          _mediaRecoveryAttempts++;
          hlsInstance.swapAudioCodec();
          hlsInstance.recoverMediaError();
          return;
        }
      }
      emitStatus('down', { alias: currentAlias, reason: data?.details || 'fatal_error' });
      clearRetry();
      retryTimer = setTimeout(() => init(videoEl, { alias: currentAlias }), 6000);
    });
  } else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
    videoEl.src = streamUrl;
    videoEl.addEventListener('loadedmetadata', () => {
      emitStatus('ok', { alias: currentAlias });
      videoEl.play().catch(() => {});
    });
    videoEl.addEventListener('error', () => {
      emitStatus('down', { alias: currentAlias, reason: 'native_error' });
    });
  } else {
    console.error('[Stream] HLS not supported in this browser');
    emitStatus('down', { alias: currentAlias, reason: 'unsupported_browser' });
  }
}

function setAlias(alias) {
  currentAlias = String(alias || '').trim();
  if (currentVideoEl) init(currentVideoEl, { alias: currentAlias });
}

function destroy() {
  clearRetry();
  _mediaRecoveryAttempts = 0;
  if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
}

function getWssUrl() { return _wssUrl; }

function getVideoLag(videoEl) {
  const vid = videoEl || currentVideoEl;
  if (!vid) return 0;
  try {
    if (!vid.buffered.length) return 0;
    const liveEdge = vid.buffered.end(vid.buffered.length - 1);
    return Math.max(0, (liveEdge - vid.currentTime) * 1000);
  } catch { return 0; }
}

export const Stream = { init, destroy, setAlias, getWssUrl, getVideoLag };
