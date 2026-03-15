/**
 * purge-cf.js — Purge Cloudflare edge cache after a Vercel deployment.
 *
 * Run after every `git push` that triggers a new Vercel deploy:
 *   node scripts/purge-cf.js
 *
 * Why: Vercel serves new deployment files fresh but Cloudflare may have
 * cached a transient 503 from the brief propagation window right after
 * deploy. Purging forces Cloudflare to re-fetch from Vercel cleanly.
 *
 * Env vars (or set at top of file):
 *   CF_EMAIL, CF_API_KEY, CF_ZONE_ID
 */

const CF_EMAIL   = process.env.CF_EMAIL   || 'promptkill@gmail.com';
const CF_API_KEY = process.env.CF_API_KEY || '6de4f697edf4dea79ca2aae523e104ac39f55';
const CF_ZONE_ID = process.env.CF_ZONE_ID || '660a88a62e710f20135d1aeb8541630f';

async function purge() {
  console.log('[CF] Purging entire Cloudflare cache for aitrafficja.com...');
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/purge_cache`,
    {
      method: 'POST',
      headers: {
        'X-Auth-Email': CF_EMAIL,
        'X-Auth-Key':   CF_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ purge_everything: true }),
    }
  );
  const data = await res.json();
  if (data.success) {
    console.log('[CF] Cache purged successfully. Cloudflare will re-fetch from Vercel on next request.');
  } else {
    console.error('[CF] Purge failed:', data.errors);
    process.exit(1);
  }
}

purge().catch(e => { console.error(e); process.exit(1); });
