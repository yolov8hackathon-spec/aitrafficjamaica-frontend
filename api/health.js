/**
 * GET /api/health
 * Proxy backend health to keep Railway URL out of the client.
 *
 * Edge Function: s-maxage=10 lets Vercel CDN cache the response at edge nodes,
 * so most health polls never hit Railway at all.
 */
export const config = { runtime: "edge" };

export default async function handler(req) {
  if (req.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  const railwayUrl = process.env.RAILWAY_BACKEND_URL;
  if (!railwayUrl) {
    return new Response(JSON.stringify({ error: "Server misconfiguration" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const upstream = await fetch(`${railwayUrl}/health`);
    const data     = await upstream.json();
    return new Response(JSON.stringify(data), {
      status: upstream.status,
      headers: {
        "Content-Type":  "application/json",
        "Cache-Control": "public, s-maxage=3, stale-while-revalidate=5",
      },
    });
  } catch {
    return new Response(JSON.stringify({ error: "Upstream request failed" }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }
}
