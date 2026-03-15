/**
 * GET /api/stream           — HLS manifest proxy
 * GET /api/stream?p=<enc>   — HLS segment proxy (keeps CDN URL hidden from browser)
 *
 * Edge Function: runs at Vercel's global edge nodes for lower latency.
 * Dual-mode keeps us within Vercel Hobby's 12-function limit.
 */
export const config = { runtime: "edge" };

async function generateHmacToken(secret) {
  const ts          = Math.floor(Date.now() / 1000).toString();
  const nonceBytes  = new Uint8Array(8);
  crypto.getRandomValues(nonceBytes);
  const nonce       = Array.from(nonceBytes).map(b => b.toString(16).padStart(2, "0")).join("");
  const payload     = `${ts}.${nonce}.`;

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

  const railwayUrl = process.env.RAILWAY_BACKEND_URL;
  if (!railwayUrl) {
    return new Response(JSON.stringify({ error: "Stream not configured" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const backendBase = railwayUrl.replace(/\/+$/, "");
  const url         = new URL(req.url);
  const p           = url.searchParams.get("p");

  // ── Segment proxy mode ──────────────────────────────────────────────────
  if (p) {
    if (p.length > 4096) return new Response("", { status: 400 });
    try {
      const upstream = await fetch(
        `${backendBase}/stream/ts?p=${encodeURIComponent(p)}`,
        { headers: { "User-Agent": "Vercel-SegmentProxy/1.0" } }
      );
      if (!upstream.ok) return new Response("", { status: 502 });
      const contentType = upstream.headers.get("content-type") || "video/MP2T";
      const buffer      = await upstream.arrayBuffer();
      return new Response(buffer, {
        status: 200,
        headers: {
          "Content-Type":  contentType,
          "Cache-Control": "public, max-age=10",
        },
      });
    } catch {
      return new Response("", { status: 502 });
    }
  }

  // ── Manifest proxy mode ─────────────────────────────────────────────────
  const secret = process.env.WS_AUTH_SECRET;
  if (!secret) {
    return new Response(JSON.stringify({ error: "Stream not configured" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const token    = await generateHmacToken(secret);
  const aliasRaw = (url.searchParams.get("alias") || "").trim();
  // Allow ipcam aliases (alphanumeric/_/-) and YouTube cam refs (yt:<uuid>)
  const alias    = /^[A-Za-z0-9_:-]+$/.test(aliasRaw) ? aliasRaw : "";
  const manifestUrl =
    `${backendBase}/stream/live.m3u8?token=${encodeURIComponent(token)}`
    + (alias ? `&alias=${encodeURIComponent(alias)}` : "");

  try {
    const upstream = await fetch(manifestUrl);
    if (!upstream.ok) {
      const body = await upstream.text().catch(() => "");
      console.error("[/api/stream] backend status:", upstream.status, body.slice(0, 200));
      return new Response(
        JSON.stringify({ error: "Stream unavailable", upstream_status: upstream.status }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }

    // Decode base64 p= params and replace proxy URLs with direct CDN URLs.
    // Segments go Browser → ipcamlive CDN directly — zero proxy hops, lowest latency.
    // Local dev falls back to /api/stream?p= via Vite proxy (no base64 decode needed there).
    const isLocal = req.url.includes("localhost") || req.url.includes("127.0.0.1");
    let text = await upstream.text();
    if (!isLocal) {
      text = text.replace(
        /https?:\/\/[^/\s"']+\/(?:api\/stream|stream\/ts)\?p=([A-Za-z0-9+/=_-]+)/g,
        (match, p) => {
          try {
            const decoded = atob(p.replace(/-/g, "+").replace(/_/g, "/"));
            // Only serve direct for ipcamlive — CORS: * confirmed.
            // YouTube (googlevideo.com) must stay proxied: no CORS + signed URLs.
            return decoded.includes(".ipcamlive.com") ? decoded : match;
          } catch { return match; }
        }
      );
    } else {
      text = text.replace(/https?:\/\/[^/\s"']+\/(?:api\/stream|stream\/ts)\?p=/g, "/api/stream?p=");
    }

    return new Response(text, {
      status: 200,
      headers: {
        "Content-Type":  "application/vnd.apple.mpegurl",
        "Cache-Control": "no-cache, no-store",
      },
    });
  } catch (err) {
    console.error("[/api/stream] manifest fetch error:", err);
    return new Response(JSON.stringify({ error: "Stream unavailable" }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }
}
