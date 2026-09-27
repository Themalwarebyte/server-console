import { authClient } from "@/lib/auth-client";

/**
 * The one sign-out path for the whole console.
 *
 * Sign-out must do two things, in this order:
 *
 *   1. `await authClient.signOut()` — invalidate the Better Auth session
 *      server-side so the session cookie stops being accepted.
 *   2. Force a FULL-DOCUMENT navigation with `window.location.replace()`.
 *
 * Step 2 is not optional. The Convex client is constructed once at module scope
 * with `{ expectAuth: true }`, and it caches an authenticated state. An SPA
 * `navigate()` re-renders the tree but leaves that client instance alive, so
 * protected queries can continue to be attempted with stale auth. A real
 * document navigation destroys the client and rebuilds it from scratch, which
 * is what the official guidance requires when `expectAuth` is enabled.
 *
 * Using `location.replace` rather than `assign` also keeps the failed
 * protected route out of session history, so Back cannot return the user to a
 * page that would immediately re-trigger it.
 *
 * On failure we deliberately do NOT navigate and do NOT pretend the user is
 * signed out: the session may still be valid. The caller is told so it can
 * surface a sanitized message; technical detail goes to the console only.
 */
export async function signOutAndReload(): Promise<{ ok: boolean }> {
  try {
    const result = await authClient.signOut();

    // Better Auth reports failures in-band rather than by throwing.
    if (result && typeof result === "object" && "error" in result && result.error) {
      console.error("[auth] sign out reported an error:", result.error);
      return { ok: false };
    }

    // Full-document transition. Destroys the ConvexReactClient instance and
    // rebuilds the app on /auth with no cached auth state.
    window.location.replace("/auth");
    return { ok: true };
  } catch (error) {
    // Never surface a backend stack trace to the operator.
    console.error("[auth] sign out threw:", error);
    return { ok: false };
  }
}
