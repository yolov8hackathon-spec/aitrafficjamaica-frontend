/**
 * GET /api/agency/data
 *
 * Authenticated agency data API — programmatic access for registered agencies.
 * Authentication: x-api-key header with a pre-issued agency API key.
 *
 * Query params:
 *   from        — ISO date string (required)
 *   to          — ISO date string (required)
 *   camera_id   — optional camera UUID filter
 *   format      — "json" (default) | "csv"
 *
 * Rate limiting: per-key daily quota enforced via agency_api_usage table.
 *
 * Key management: keys are inserted directly into agency_api_keys via Supabase
 * SQL editor by admin. The raw key is never stored — only a SHA-256 hash.
 *
 * Example key creation (run in Supabase SQL editor):
 *   INSERT INTO agency_api_keys (agency, key_prefix, key_hash, plan, rate_limit_day)
 *   SELECT 'nwa',
 *          left(k, 8),
 *          encode(sha256(k::bytea), 'hex'),
 *          'pro', 500
 *   FROM (SELECT 'wlzk_nwa_' || replace(gen_random_uuid()::text, '-', '') AS k) t;
 *
 * Then send the raw key (the full `k` value) to the agency.
 */

import { createHash } from "crypto";

export default async function handler(req, res) {
  if (req.method !== "GET")
    return res.status(405).json({ error: "Method not allowed" });

  // ── Auth ─────────────────────────────────────────────────────────────────────
  const rawKey = req.headers["x-api-key"] || "";
  if (!rawKey)
    return res.status(401).json({ error: "x-api-key header required" });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY)
    return res.status(500).json({ error: "Server misconfiguration" });

  const sbH = {
    apikey:        SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    "Content-Type": "application/json",
  };

  const keyHash = createHash("sha256").update(rawKey).digest("hex");

  // Look up key
  const keyRes = await fetch(
    `${SUPABASE_URL}/rest/v1/agency_api_keys?key_hash=eq.${encodeURIComponent(keyHash)}&active=eq.true&select=id,agency,plan,rate_limit_day`,
    { headers: sbH }
  );
  if (!keyRes.ok) return res.status(502).json({ error: "Key lookup failed" });
  const keys = await keyRes.json();
  if (!keys.length) return res.status(401).json({ error: "Invalid or inactive API key" });

  const keyRow = keys[0];
  const today  = new Date().toISOString().slice(0, 10);

  // ── Rate limit: atomic increment via RPC ────────────────────────────────────
  let currentHits = 1;
  try {
    const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/increment_agency_usage`, {
      method: "POST",
      headers: sbH,
      body: JSON.stringify({ p_key_id: keyRow.id, p_agency: keyRow.agency, p_date: today }),
    });
    if (rpcRes.ok) currentHits = (await rpcRes.json()) ?? 1;
  } catch {
    // Non-fatal — continue without rate limit enforcement on error.
  }

  if (currentHits > keyRow.rate_limit_day)
    return res.status(429).json({
      error: `Daily rate limit reached (${keyRow.rate_limit_day} requests/day). Resets at midnight UTC.`,
      resets_at: today + "T00:00:00Z",
    });

  // Update last_used_at (fire-and-forget)
  fetch(`${SUPABASE_URL}/rest/v1/agency_api_keys?id=eq.${encodeURIComponent(keyRow.id)}`, {
    method: "PATCH", headers: sbH,
    body: JSON.stringify({ last_used_at: new Date().toISOString() }),
  }).catch(() => {});

  // ── Validate query params ────────────────────────────────────────────────────
  const { from, to, camera_id, format = "json" } = req.query;
  if (!from || !to)
    return res.status(400).json({ error: "from and to query params required (YYYY-MM-DD)" });

  const fromDate = new Date(from);
  const toDate   = new Date(to);
  if (isNaN(fromDate) || isNaN(toDate))
    return res.status(400).json({ error: "Invalid date format. Use YYYY-MM-DD." });

  const diffDays = (toDate - fromDate) / 86400000;
  if (diffDays < 0)
    return res.status(400).json({ error: "from must be before to" });
  if (diffDays > 90)
    return res.status(400).json({ error: "Date range exceeds 90-day limit." });

  const fromISO = fromDate.toISOString();
  const toISO   = new Date(to + "T23:59:59Z").toISOString();

  // ── Query vehicle_crossings ──────────────────────────────────────────────────
  try {
    let url = `${SUPABASE_URL}/rest/v1/vehicle_crossings`
      + `?select=captured_at,track_id,vehicle_class,direction,confidence,scene_lighting,scene_weather,dwell_frames`
      + `&vehicle_class=in.(car,truck,bus,motorcycle)`
      + `&captured_at=gte.${encodeURIComponent(fromISO)}`
      + `&captured_at=lte.${encodeURIComponent(toISO)}`
      + `&order=captured_at.asc&limit=50000`;
    if (camera_id) url += `&camera_id=eq.${encodeURIComponent(camera_id)}`;

    const dataRes = await fetch(url, { headers: sbH });
    if (!dataRes.ok) return res.status(502).json({ error: "Data query failed" });
    const rows = await dataRes.json();

    // Deduplicate by track_id
    const seen = new Set();
    const deduped = rows.filter(r => {
      if (!r.track_id) return true;
      if (seen.has(r.track_id)) return false;
      seen.add(r.track_id); return true;
    });

    // ── CSV format ─────────────────────────────────────────────────────────────
    if (format === "csv") {
      const _csvSanitize = (v) => {
        const s = String(v == null ? "" : v);
        return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
      };
      const lines = ["timestamp,vehicle_class,direction,confidence,scene_lighting,scene_weather,dwell_frames,track_id"];
      for (const r of deduped) {
        lines.push([
          _csvSanitize(r.captured_at),
          _csvSanitize(r.vehicle_class),
          _csvSanitize(r.direction),
          r.confidence != null ? r.confidence : "",
          _csvSanitize(r.scene_lighting),
          _csvSanitize(r.scene_weather),
          r.dwell_frames != null ? r.dwell_frames : "",
          _csvSanitize(r.track_id),
        ].join(","));
      }
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="whitelinez-${keyRow.agency}-${from}.csv"`);
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).send(lines.join("\n"));
    }

    // ── JSON format (default) ──────────────────────────────────────────────────
    const classTotals = { car: 0, truck: 0, bus: 0, motorcycle: 0 };
    for (const r of deduped) {
      if (r.vehicle_class in classTotals) classTotals[r.vehicle_class]++;
    }

    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-RateLimit-Limit",     String(keyRow.rate_limit_day));
    res.setHeader("X-RateLimit-Remaining", String(Math.max(0, keyRow.rate_limit_day - currentHits)));
    return res.status(200).json({
      agency:      keyRow.agency,
      plan:        keyRow.plan,
      from:        fromISO,
      to:          toISO,
      camera_id:   camera_id || null,
      total:       deduped.length,
      class_totals: classTotals,
      rows:        deduped,
    });
  } catch (err) {
    console.error("[/api/agency/data]", err);
    return res.status(502).json({ error: "Data query failed" });
  }
}
