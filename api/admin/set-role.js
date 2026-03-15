/**
 * /api/admin/set-role
 * - GET ?mode=active-users  → proxy to Railway /admin/active-users
 * - GET ?page&per_page      → list users directly from Supabase Auth admin API
 * - POST                    → proxy to Railway /admin/set-role
 *
 * User listing is done directly via Supabase (not Railway) to avoid
 * SDK/serialisation issues in the Python backend.
 */
import { verifyAdminJwt } from "../_lib/admin-auth.js";

export default async function handler(req, res) {
  const method = req.method || "GET";
  if (!["GET", "POST"].includes(method)) {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const supabaseUrl  = process.env.SUPABASE_URL;
  const serviceKey   = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const railwayUrl   = process.env.RAILWAY_BACKEND_URL;

  const authHeader = req.headers["authorization"] || "";
  const authCheck = await verifyAdminJwt(authHeader);
  if (!authCheck.ok) return res.status(authCheck.status).json({ error: authCheck.error });

  try {
    // ── GET: active-users → Railway ──────────────────────────────────────────
    if (method === "GET" && String(req.query?.mode || "").trim() === "active-users") {
      if (!railwayUrl) return res.status(500).json({ error: "Server misconfiguration" });
      const upstream = await fetch(`${railwayUrl}/admin/active-users`, {
        method: "GET", headers: { Authorization: authHeader },
      });
      const raw = await upstream.text();
      let data;
      try { data = raw ? JSON.parse(raw) : {}; } catch { data = { detail: raw }; }
      return res.status(upstream.status).json(data);
    }

    // ── GET: list users directly from Supabase Auth admin API ────────────────
    if (method === "GET") {
      if (!supabaseUrl || !serviceKey) return res.status(500).json({ error: "Server misconfiguration" });
      const page    = Math.max(1, Number(req.query?.page    || 1));
      const perPage = Math.min(200, Math.max(1, Number(req.query?.per_page || 200)));

      const sbRes = await fetch(
        `${supabaseUrl}/auth/v1/admin/users?page=${page}&per_page=${perPage}`,
        { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
      );
      if (!sbRes.ok) return res.status(sbRes.status).json({ error: "Failed to fetch users" });

      const sbData = await sbRes.json();
      const rawUsers = sbData.users || [];

      const users = rawUsers.map(u => {
        const appMeta  = u.app_metadata  || {};
        const userMeta = u.user_metadata || {};
        // Resolve email: direct field → user_metadata → identity
        let email = u.email || userMeta.email || null;
        if (!email && Array.isArray(u.identities)) {
          for (const id of u.identities) {
            const idEmail = (id.identity_data || {}).email;
            if (idEmail) { email = idEmail; break; }
          }
        }
        return {
          id:               u.id,
          email,
          created_at:       u.created_at,
          last_sign_in_at:  u.last_sign_in_at || u.updated_at,
          role:             appMeta.role || "user",
          email_confirmed_at: u.email_confirmed_at,
          username:         userMeta.username || null,
          bet_summary: { bet_count: 0, total_staked: 0, pending_count: 0,
                         won_count: 0, lost_count: 0, last_bet_at: null,
                         last_bet_status: null, last_bet_amount: 0, last_bet_label: null },
        };
      });

      return res.status(200).json({ users, page, per_page: perPage });
    }

    // ── POST: set role → Railway ─────────────────────────────────────────────
    if (!railwayUrl) return res.status(500).json({ error: "Server misconfiguration" });
    const body = typeof req.body === "string" ? req.body : JSON.stringify(req.body || {});
    const upstream = await fetch(`${railwayUrl}/admin/set-role`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authHeader },
      body,
    });
    const raw = await upstream.text();
    let data;
    try { data = raw ? JSON.parse(raw) : {}; } catch { data = { detail: raw }; }
    return res.status(upstream.status).json(data);

  } catch (err) {
    console.error("[/api/admin/set-role] Error:", err);
    return res.status(502).json({ error: "Request failed" });
  }
}
