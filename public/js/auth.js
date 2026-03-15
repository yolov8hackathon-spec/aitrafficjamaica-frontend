/**
 * auth.js — Login, register, logout via Supabase JS SDK.
 * Exposes: Auth.login(), Auth.register(), Auth.logout(), Auth.getSession()
 */

const Auth = (() => {
  async function login(email, password) {
    const { data, error } = await window.sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data;
  }

  async function register(email, password) {
    const { data, error } = await window.sb.auth.signUp({ email, password });
    if (error) throw error;
    return data;
  }

  async function logout() {
    const { error } = await window.sb.auth.signOut();
    if (error) throw error;
    window.AppCache?.clear(); // wipe all cached data before redirect
    window.location.href = "/";
  }

  // Dedup concurrent getSession() calls — all callers within the same async
  // tick share one promise, preventing simultaneous localStorage lock contention.
  let _sessionPending = null;
  async function getSession() {
    if (_sessionPending) return _sessionPending;
    _sessionPending = window.sb.auth.getSession()
      .then(({ data }) => data?.session ?? null)
      .finally(() => { _sessionPending = null; });
    return _sessionPending;
  }

  async function getJwt() {
    const session = await getSession();
    return session?.access_token ?? null;
  }

  async function requireAuth(redirectTo = "/login") {
    const session = await getSession();
    if (!session) {
      window.location.href = redirectTo;
      return null;
    }
    return session;
  }

  async function requireAdmin(redirectTo = "/") {
    const session = await requireAuth();
    if (!session) return null;
    const role = session.user?.app_metadata?.role;
    if (role !== "admin") {
      window.location.href = redirectTo;
      return null;
    }
    return session;
  }

  // Listen for auth state changes
  window.sb.auth.onAuthStateChange((event, session) => {
    if (event === "SIGNED_OUT") {
      // Clear any cached data
      window.dispatchEvent(new CustomEvent("auth:signed_out"));
    }
    if (event === "SIGNED_IN") {
      window.dispatchEvent(new CustomEvent("auth:signed_in", { detail: session }));
    }
  });

  async function signInAnon() {
    const { data, error } = await window.sb.auth.signInAnonymously();
    if (error) throw error;
    if (!data?.session) throw new Error("Guest session could not be created. Please try again.");
    return data.session.access_token;
  }

  async function signInWithGoogle(redirectTo = window.location.origin + "/") {
    const { error } = await window.sb.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo },
    });
    if (error) throw error;
  }

  function isAnonymous(session) {
    return !!session?.user?.is_anonymous;
  }

  return { login, register, logout, getSession, getJwt, requireAuth, requireAdmin, signInAnon, signInWithGoogle, isAnonymous };
})();

window.Auth = Auth;
