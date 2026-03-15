/**
 * GET /api/token
 * Issues a short-lived HMAC WebSocket token (v2: ts.nonce.sig) and the WSS URL.
 * Railway backend URL is never sent directly as an HTTP endpoint.
 * The Railway WSS URL is returned here — it's safe because:
 *   - The WS endpoint itself validates the HMAC token
 *   - The token is time-limited to a 5-minute window
 *   - Nonce prevents replay of captured tokens
 *
 * Edge Function: runs at Vercel's global edge for minimal latency on WS connect.
 */
export const config = { runtime: "edge" };

const TOKEN_TTL_SECONDS = 300;

async function generateHmacToken(secret) {
  const ts         = Math.floor(Date.now() / 1000).toString();
  const nonceBytes = new Uint8Array(8);
  crypto.getRandomValues(nonceBytes);
  const nonce      = Array.from(nonceBytes).map(b => b.toString(16).padStart(2, "0")).join("");
  const payload    = `${ts}.${nonce}.`;   // extra="" → trailing dot matches backend

  const encoder = new TextEncoder();
  const key     = await crypto.subtle.importKey(
    "raw", encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false, ["sign"]
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  const sig    = Array.from(new Uint8Array(sigBuf)).map(b => b.toString(16).padStart(2, "0")).join("");
  return `${ts}.${nonce}.${sig}`;
}

export default async function handler(req) {
  if (req.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  const secret     = process.env.WS_AUTH_SECRET;
  // WS_BACKEND_URL points directly to Railway — CF Worker can't proxy WebSockets
  // in service-worker format. Falls back to RAILWAY_BACKEND_URL if not set.
  const wsBase = process.env.WS_BACKEND_URL || process.env.RAILWAY_BACKEND_URL;

  if (!secret || !wsBase) {
    return new Response(JSON.stringify({ error: "Server misconfiguration" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const token  = await generateHmacToken(secret);
  const wssUrl = wsBase.replace(/^https?:\/\//, "wss://") + "/ws/live";

  return new Response(
    JSON.stringify({ token, wss_url: wssUrl, expires_in: TOKEN_TTL_SECONDS }),
    {
      status: 200,
      headers: {
        "Content-Type":  "application/json",
        "Cache-Control": "no-store",
      },
    }
  );
}
