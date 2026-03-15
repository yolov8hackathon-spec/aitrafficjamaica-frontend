/**
 * GET /api/auth/google/callback
 *
 * Handles the Google OAuth authorization code exchange so that
 * the Google consent screen says "aitrafficja.com" rather than
 * the Supabase project URL.
 *
 * Flow:
 *   1. Google redirects here with ?code=... after user consent
 *   2. We exchange the code with Google for an id_token (server-side,
 *      using the client_secret stored in env — never exposed to browser)
 *   3. We exchange the Google id_token with Supabase for a session
 *   4. We redirect back to the frontend with ?_sb_at / ?_sb_rt
 *   5. Frontend calls sb.auth.setSession() and cleans the URL
 */
export const config = { runtime: "edge" };

const SITE_URL = "https://aitrafficja.com";
const REDIRECT_URI = `${SITE_URL}/api/auth/google/callback`;

export default async function handler(req) {
  const url = new URL(req.url);
  const code  = url.searchParams.get("code");
  const state = url.searchParams.get("state");   // encodeURIComponent(redirectTo)
  const error = url.searchParams.get("error");

  // Google returned an error (user denied, etc.)
  if (error) {
    const msg = url.searchParams.get("error_description") || error;
    return Response.redirect(`${SITE_URL}/?error=${encodeURIComponent(msg)}`, 302);
  }

  if (!code) {
    return Response.redirect(`${SITE_URL}/?error=no_code`, 302);
  }

  // ── 1. Exchange authorization code with Google ───────────────────────────
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code,
      client_id:     process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri:  REDIRECT_URI,
      grant_type:    "authorization_code",
    }),
  });

  const googleData = await tokenRes.json();

  if (!googleData.id_token) {
    const msg = googleData.error_description || googleData.error || "google_token_failed";
    return Response.redirect(`${SITE_URL}/?error=${encodeURIComponent(msg)}`, 302);
  }

  // ── 2. Exchange Google id_token for Supabase session ────────────────────
  const sbRes = await fetch(
    `${process.env.SUPABASE_URL}/auth/v1/token?grant_type=id_token`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": process.env.SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({
        provider:     "google",
        id_token:     googleData.id_token,
        access_token: googleData.access_token,   // optional but recommended
        nonce:        "",
      }),
    }
  );

  const sbData = await sbRes.json();

  if (!sbData.access_token) {
    const msg = sbData.error_description || sbData.message || "supabase_auth_failed";
    return Response.redirect(`${SITE_URL}/?error=${encodeURIComponent(msg)}`, 302);
  }

  // ── 3. Redirect back to frontend with session tokens ────────────────────
  // Tokens go in the URL fragment (#) so they are never sent to servers,
  // never appear in Vercel/Referrer logs, and are not accessible to third-party scripts.
  // Frontend reads _sb_at / _sb_rt from location.hash, calls sb.auth.setSession(), clears hash.

  // Validate state: only allow redirects to aitrafficja.com to prevent open-redirect.
  let redirectTo = SITE_URL;
  try {
    if (state) {
      const candidate = decodeURIComponent(state);
      const candidateUrl = new URL(candidate);
      if (candidateUrl.origin === SITE_URL) {
        redirectTo = candidate;
      }
      // Silently fall back to SITE_URL for any external origin.
    }
  } catch {}

  const params = new URLSearchParams({
    _sb_at: sbData.access_token,
    _sb_rt: sbData.refresh_token || "",
  });

  // Use fragment (#) to keep tokens out of server logs and Referrer headers.
  return Response.redirect(`${redirectTo}#${params}`, 302);
}
