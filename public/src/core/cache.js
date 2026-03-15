/**
 * cache.js — Global in-memory TTL cache shared across all modules.
 *
 * Cache keys used by this app:
 *   "ws:token"         — /api/token response (4 min TTL)
 *   "round:preferred"  — _fetchPreferredRound() result (30 s TTL)
 *   "lb:<windowSec>"   — leaderboard HTML per window duration (30 s TTL)
 */

const _store = new Map();

function set(key, data, ttlMs) {
  _store.set(key, { v: data, exp: Date.now() + ttlMs });
}

function get(key) {
  const entry = _store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.exp) { _store.delete(key); return null; }
  return entry.v;
}

function invalidate(keyOrPrefix) {
  if (_store.has(keyOrPrefix)) { _store.delete(keyOrPrefix); return; }
  for (const k of _store.keys()) {
    if (k.startsWith(keyOrPrefix)) _store.delete(k);
  }
}

function clear() { _store.clear(); }

export const AppCache = { set, get, invalidate, clear };
