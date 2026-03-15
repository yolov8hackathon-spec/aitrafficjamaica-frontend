// Supabase connection config — injected by Vercel environment at build time.
// Never store sensitive keys here. ANON key is safe for client-side use.
export const SUPABASE_URL  = import.meta.env.VITE_SUPABASE_URL  ?? '';
export const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY ?? '';
