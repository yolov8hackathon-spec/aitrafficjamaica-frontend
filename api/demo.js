/**
 * /api/demo
 *
 * GET  /api/demo          → proxy manifest from Railway
 * POST /api/demo?action=start-detect → start live YOLO on demo video
 * POST /api/demo?action=stop-detect  → stop demo YOLO, resume live AI
 */
export const config = { runtime: "edge" };

export default async function handler(req) {
  const backendBase = (process.env.RAILWAY_BACKEND_URL || "").replace(/\/+$/, "");
  const demoSecret  = process.env.DEMO_SECRET || "";

  // ── GET manifest ──────────────────────────────────────────────────────────
  if (req.method === "GET") {
    if (!backendBase) {
      return new Response(JSON.stringify({ available: false }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }
    try {
      const upstream = await fetch(`${backendBase}/demo/manifest`, {
        headers: { "User-Agent": "Vercel-DemoProxy/1.0" },
      });
      const body = await upstream.text();
      return new Response(body, {
        status: upstream.ok ? 200 : 502,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "*",
        },
      });
    } catch {
      return new Response(JSON.stringify({ available: false }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }
  }

  // ── POST control actions ──────────────────────────────────────────────────
  if (req.method === "POST") {
    const url    = new URL(req.url);
    const action = url.searchParams.get("action");

    if (action !== "start-detect" && action !== "stop-detect") {
      return new Response(JSON.stringify({ error: "Unknown action" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (!backendBase || !demoSecret) {
      return new Response(JSON.stringify({ error: "Demo detection not configured" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }

    const endpoint = action === "start-detect" ? "/demo/start-detect" : "/demo/stop-detect";
    try {
      const upstream = await fetch(`${backendBase}${endpoint}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Demo-Secret": demoSecret,
        },
      });
      const body = await upstream.text();
      return new Response(body, {
        status: upstream.ok ? 200 : upstream.status,
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: String(err) }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  return new Response(JSON.stringify({ error: "Method not allowed" }), {
    status: 405,
    headers: { "Content-Type": "application/json" },
  });
}
