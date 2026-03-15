import { sb } from '../core/supabase.js';
import { AppCache } from '../core/cache.js';

async function login(email, password) {
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

async function register(email, password) {
  const { data, error } = await sb.auth.signUp({ email, password });
  if (error) throw error;
  return data;
}

async function logout() {
  const { error } = await sb.auth.signOut();
  if (error) throw error;
  AppCache.clear();
  window.location.href = '/';
}

async function getSession() {
  const { data } = await sb.auth.getSession();
  return data?.session ?? null;
}

async function getJwt() {
  const session = await getSession();
  return session?.access_token ?? null;
}

async function requireAuth(redirectTo = '/?login=1') {
  const session = await getSession();
  if (!session) { window.location.href = redirectTo; return null; }
  return session;
}

async function requireAdmin(redirectTo = '/') {
  // Pass intended destination so login modal can redirect back after auth
  const returnTo = encodeURIComponent(window.location.pathname);
  const session = await requireAuth(`/?login=1&return=${returnTo}`);
  if (!session) return null;
  const role = session.user?.app_metadata?.role;
  if (role !== 'admin') { window.location.href = redirectTo; return null; }
  return session;
}

async function signInAnon() {
  const { data, error } = await sb.auth.signInAnonymously();
  if (error) throw error;
  if (!data?.session) throw new Error('Guest session could not be created. Please try again.');
  return data.session.access_token;
}

async function signInWithGoogle(redirectTo = window.location.origin + '/') {
  // Build the Google OAuth URL directly so Google shows "aitrafficja.com" on
  // the consent screen instead of the Supabase project URL.
  // The code is exchanged server-side in /api/auth/google/callback.
  const params = new URLSearchParams({
    client_id:    '247854268363-bmitffj15pbmkvok5735ndikn1kcm3ov.apps.googleusercontent.com',
    redirect_uri: 'https://aitrafficja.com/api/auth/google/callback',
    response_type: 'code',
    scope:        'openid email profile',
    access_type:  'offline',
    prompt:       'select_account',
    state:        encodeURIComponent(redirectTo),
  });
  window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

function isAnonymous(session) { return !!session?.user?.is_anonymous; }

sb.auth.onAuthStateChange((event, session) => {
  if (event === 'SIGNED_OUT') window.dispatchEvent(new CustomEvent('auth:signed_out'));
  if (event === 'SIGNED_IN')  window.dispatchEvent(new CustomEvent('auth:signed_in', { detail: session }));
});

export const Auth = { login, register, logout, getSession, getJwt, requireAuth, requireAdmin, signInAnon, signInWithGoogle, isAnonymous };
