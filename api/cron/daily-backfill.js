/**
 * GET /api/cron/daily-backfill
 *
 * Triggers the backend traffic_daily aggregation for yesterday's data.
 * Called nightly at 02:00 UTC by Vercel Cron (Pro/Team plan required).
 * Can also be triggered manually:
 *   curl -H "Authorization: Bearer $CRON_SECRET" https://aitrafficja.com/api/cron/daily-backfill
 *
 * Env vars required:
 *   CRON_SECRET         — shared secret for auth
 *   RAILWAY_BACKEND_URL — backend base URL
 *   ADMIN_SECRET        — optional Bearer token for Railway /admin/* endpoints
 */
export default async function handler(req, res) {
  if (req.method !== "GET")
    return res.status(405).json({ error: "Method not allowed" });

  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`)
    return res.status(401).json({ error: "Unauthorized" });

  const railwayUrl = process.env.RAILWAY_BACKEND_URL;
  if (!railwayUrl)
    return res.status(500).json({ error: "RAILWAY_BACKEND_URL not configured" });

  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret) {
    console.error("[cron/daily-backfill] ADMIN_SECRET not configured — aborting");
    return res.status(500).json({ error: "ADMIN_SECRET not configured" });
  }

  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  try {
    const r = await fetch(`${railwayUrl}/admin/backfill-daily?date=${yesterday}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${adminSecret}` },
    });
    const body = await r.json().catch(() => ({}));
    return res.status(r.ok ? 200 : r.status).json({ triggered_for: yesterday, ...body });
  } catch (err) {
    console.error("[cron/daily-backfill]", err);
    return res.status(502).json({ error: "Upstream request failed", triggered_for: yesterday });
  }
}
