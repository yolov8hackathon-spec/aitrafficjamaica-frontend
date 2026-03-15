/**
 * /api/admin/rounds
 * Proxy admin round/session operations to Railway backend.
 */
import { verifyAdminJwt } from "../_lib/admin-auth.js";

export default async function handler(req, res) {
  const method = req.method || "GET";
  if (!["GET", "POST", "PATCH"].includes(method)) {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const railwayUrl = process.env.RAILWAY_BACKEND_URL;
  if (!railwayUrl) return res.status(500).json({ error: "Server misconfiguration" });

  const authHeader = req.headers["authorization"] || "";
  const authCheck = await verifyAdminJwt(authHeader);
  if (!authCheck.ok) return res.status(authCheck.status).json({ error: authCheck.error });

  try {
    const mode = String(req.query?.mode || "");
    let url = `${railwayUrl}/admin/rounds`;
    let body;

    // Backward compatibility for older frontend query modes.
    if (mode === "sessions") {
      if (method === "GET") {
        const limit = Number(req.query?.limit || 20);
        url = `${railwayUrl}/admin/round-sessions?limit=${encodeURIComponent(limit)}`;
      } else if (method === "POST") {
        url = `${railwayUrl}/admin/round-sessions`;
      }
    } else if (mode === "session-stop" && method === "PATCH") {
      const sessionId = String(req.query?.id || "").trim();
      if (!sessionId) {
        return res.status(400).json({ error: "Missing session id" });
      }
      url = `${railwayUrl}/admin/round-sessions/${encodeURIComponent(sessionId)}/stop`;
    } else {
      // Only forward known-safe parameters to Railway to prevent parameter injection.
      const ALLOWED_PARAMS = new Set(["status", "limit", "offset", "round_id", "camera_id"]);
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(req.query || {})) {
        if (!ALLOWED_PARAMS.has(k)) continue;
        const safeV = Array.isArray(v) ? v[0] : v;
        params.set(k, String(safeV).slice(0, 128));
      }
      const query = params.toString();
      url = `${railwayUrl}/admin/rounds${query ? `?${query}` : ""}`;
    }

    if (!["GET"].includes(method)) {
      body = typeof req.body === "string" ? req.body : JSON.stringify(req.body || {});
    }

    const upstream = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
      },
      body,
    });
    const raw = await upstream.text();
    let data;
    try { data = raw ? JSON.parse(raw) : {}; } catch { data = { detail: raw || "Upstream returned non-JSON" }; }
    return res.status(upstream.status).json(data);
  } catch (err) {
    console.error("[/api/admin/rounds] Upstream error:", err);
    return res.status(502).json({ error: "Upstream request failed" });
  }
}
