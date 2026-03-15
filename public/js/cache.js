/**
 * cache.js — Global in-memory TTL cache shared across all modules.
 *
 * Exposed as window.AppCache — available to every module after this script loads.
 *
 * Usage:
 *   AppCache.set("key", data, 30_000);    // store for 30 s
 *   AppCache.get("key");                  // returns data, or null if expired/missing
 *   AppCache.invalidate("key");           // exact-key delete
 *   AppCache.invalidate("round:");        // prefix delete (all keys starting with "round:")
 *   AppCache.clear();                     // wipe everything (e.g. on sign-out)
 *
 * Cache keys used by this app:
 *   "ws:token"         — /api/token response (4 min TTL); shared by counter.js + stream.js
 *   "round:preferred"  — _fetchPreferredRound() result (30 s TTL, invalidated by heartbeat)
 *   "lb:<windowSec>"   — leaderboard HTML per window duration (30 s TTL)
 *   "health:latest"    — /api/health JSON (60 s TTL); shared by counter.js, markets.js, index-init.js
 *   "camera:active"    — resolveActiveCamera() result (5 min TTL); index-init.js
 *   "analytics:<url>"  — /api/analytics/traffic response (2 min TTL); invalidated on date range change
 *   "crossings:<id>"   — vehicle_crossings last 20 rows (10 s TTL); gov overlay table
 *
 * Design notes:
 *   - Pure in-memory Map; no sessionStorage (avoids stale data across page reloads).
 *   - Entries are wrapped in { v, exp } so null/false/0 are valid cached values.
 *   - No async locking needed — JS is single-threaded; concurrent callers get same ref.
 */

window.AppCache = (() => {
  /** @type {Map<string, {v: *, exp: number}>} */
  const _store = new Map();

  /**
   * Store a value under key with a TTL.
   * @param {string} key
   * @param {*}      data  Any serialisable value (including null, false, 0).
   * @param {number} ttlMs Milliseconds until the entry expires.
   */
  function set(key, data, ttlMs) {
    _store.set(key, { v: data, exp: Date.now() + ttlMs });
  }

  /**
   * Retrieve a cached value. Returns null on miss or expiry.
   * To distinguish a cached null from a miss, callers check has() first if needed
   * — but in practice callers use sentinel objects { v: null } for nullable data.
   * @param {string} key
   * @returns {*|null}
   */
  function get(key) {
    const entry = _store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.exp) {
      _store.delete(key);
      return null;
    }
    return entry.v;
  }

  /**
   * Remove one or more entries.
   * - Exact match: invalidate("ws:token")
   * - Prefix match: invalidate("lb:") removes all "lb:*" keys
   * @param {string} keyOrPrefix
   */
  function invalidate(keyOrPrefix) {
    if (_store.has(keyOrPrefix)) {
      _store.delete(keyOrPrefix);
      return;
    }
    for (const k of _store.keys()) {
      if (k.startsWith(keyOrPrefix)) _store.delete(k);
    }
  }

  /** Remove all entries (call on sign-out to avoid stale user data). */
  function clear() {
    _store.clear();
  }

  return { set, get, invalidate, clear };
})();
