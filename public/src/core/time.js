/**
 * time.js — Shared time utilities.
 */

function formatCountdown(ms) {
  if (ms <= 0) return "0:00";
  const totalSec = Math.ceil(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatDuration(sec) {
  if (!sec) return "—";
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}

function isoToLocal(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

export const TimeUtil = { formatCountdown, formatDuration, isoToLocal };
