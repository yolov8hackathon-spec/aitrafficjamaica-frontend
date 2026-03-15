/**
 * /api/admin/ml
 * Consolidated ML admin proxy. Handles all five former ml-* endpoints.
 * Vercel rewrites route /api/admin/ml-:slug → /api/admin/ml?_route=:slug
 * so existing frontend calls are unchanged.
 *
 * Routes:
 *   _route=capture-status  → former /api/admin/ml-capture-status
 *   _route=jobs            → former /api/admin/ml-jobs
 *   _route=models          → former /api/admin/ml-models
 *   _route=retrain         → former /api/admin/ml-retrain
 *   _route=runtime-profile → former /api/admin/ml-runtime-profile
 */
export const config = {
  maxDuration: 300, // retrain can be slow; others finish in <5 s
};

// ── helpers ─────────────────────────────────────────────────────────────────

function proxyError(route, err, res) {
  console.error(`[/api/admin/ml?_route=${route}] Upstream error:`, err);
  return res.status(502).json({ error: "Upstream request failed" });
}

async function proxyResponse(upstream, res) {
  const raw = await upstream.text();
  let data;
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { detail: raw || "Upstream returned non-JSON" }; }
  return res.status(upstream.status).json(data);
}

// ── sub-handlers ─────────────────────────────────────────────────────────────

async function handleCaptureStatus(req, res, railwayUrl, auth) {
  if (!["GET", "PATCH"].includes(req.method)) return res.status(405).json({ error: "Method not allowed" });
  const limit  = Number(req.query?.limit || 30);
  const isPatch = req.method === "PATCH";
  const url = isPatch
    ? `${railwayUrl}/admin/ml/capture-status`
    : `${railwayUrl}/admin/ml/capture-status?limit=${encodeURIComponent(limit)}`;
  const upstream = await fetch(url, {
    method: req.method,
    headers: { Authorization: auth, ...(isPatch ? { "Content-Type": "application/json" } : {}) },
    ...(isPatch ? { body: JSON.stringify(req.body || {}) } : {}),
  });
  return proxyResponse(upstream, res);
}

async function handleJobs(req, res, railwayUrl, auth) {
  if (!["GET", "POST"].includes(req.method)) return res.status(405).json({ error: "Method not allowed" });
  const action = String(req.query?.action || "").trim().toLowerCase();
  let upstream;
  if (req.method === "GET") {
    const path = action === "diagnostics"
      ? `${railwayUrl}/admin/ml/diagnostics`
      : `${railwayUrl}/admin/ml/jobs?limit=${encodeURIComponent(Number(req.query?.limit || 50))}`;
    upstream = await fetch(path, { method: "GET", headers: { Authorization: auth } });
  } else {
    const body   = typeof req.body === "string" ? req.body : JSON.stringify(req.body || {});
    const target = action === "one-click"       ? "/admin/ml/one-click"
                 : action === "train-captures"  ? "/admin/ml/train-captures-async"
                 : "/admin/ml/retrain-async";
    upstream = await fetch(`${railwayUrl}${target}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body,
    });
  }
  return proxyResponse(upstream, res);
}

async function handleModels(req, res, railwayUrl, auth) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  const upstream = await fetch(
    `${railwayUrl}/admin/ml/models?limit=${encodeURIComponent(Number(req.query?.limit || 50))}`,
    { method: "GET", headers: { Authorization: auth } },
  );
  return proxyResponse(upstream, res);
}

async function handleRetrain(req, res, railwayUrl, auth) {
  if (!["GET", "POST"].includes(req.method)) return res.status(405).json({ error: "Method not allowed" });
  const action = String(req.query?.action || "").trim().toLowerCase();
  let upstream;
  if (req.method === "GET") {
    if (action !== "diagnostics") return res.status(400).json({ error: "Unsupported GET action" });
    upstream = await fetch(`${railwayUrl}/admin/ml/diagnostics`, { method: "GET", headers: { Authorization: auth } });
  } else {
    const body   = typeof req.body === "string" ? req.body : JSON.stringify(req.body || {});
    const target = action === "one-click" ? "/admin/ml/one-click" : "/admin/ml/retrain-async";
    upstream = await fetch(`${railwayUrl}${target}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body,
    });
  }
  return proxyResponse(upstream, res);
}

async function handleRuntimeProfile(req, res, railwayUrl, auth) {
  if (!["GET", "PATCH"].includes(req.method)) {
    res.setHeader("Allow", "GET, PATCH");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const scope    = String(req.query?.scope || "").toLowerCase();
  const cameraId = req.query?.camera_id ? String(req.query.camera_id) : "";
  const qs       = cameraId ? `?camera_id=${encodeURIComponent(cameraId)}` : "";
  const path     = scope === "night" ? "/admin/ml/night-profile" : `/admin/ml/runtime-profile${qs}`;
  const upstream = await fetch(`${railwayUrl}${path}`, {
    method: req.method,
    headers: { "Content-Type": "application/json", Authorization: auth },
    body: req.method === "PATCH" ? JSON.stringify(req.body || {}) : undefined,
  });
  const payload = await upstream.json().catch(() => ({}));
  return res.status(upstream.status).json(payload);
}

// ── main handler ─────────────────────────────────────────────────────────────

import { verifyAdminJwt } from "../_lib/admin-auth.js";

export default async function handler(req, res) {
  const route = String(req.query._route || "").toLowerCase();

  const railwayUrl = process.env.RAILWAY_BACKEND_URL;
  if (!railwayUrl) return res.status(500).json({ error: "Server misconfiguration" });

  const auth = req.headers["authorization"] || "";
  const authCheck = await verifyAdminJwt(auth);
  if (!authCheck.ok) return res.status(authCheck.status).json({ error: authCheck.error });

  try {
    switch (route) {
      case "capture-status":   return await handleCaptureStatus(req, res, railwayUrl, auth);
      case "jobs":             return await handleJobs(req, res, railwayUrl, auth);
      case "models":           return await handleModels(req, res, railwayUrl, auth);
      case "retrain":          return await handleRetrain(req, res, railwayUrl, auth);
      case "runtime-profile":  return await handleRuntimeProfile(req, res, railwayUrl, auth);
      default:
        return res.status(404).json({ error: `Unknown ML route: ${route || "(none)"}` });
    }
  } catch (err) {
    return proxyError(route, err, res);
  }
}
