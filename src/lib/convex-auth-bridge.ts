import { useCallback, useMemo, useRef } from "react";
import { authClient } from "@/lib/auth-client";

/**
 * Local bridge from Better Auth to the Convex client.
 *
 * This replaces `ConvexBetterAuthProvider` from `@convex-dev/better-auth/react`
 * with the supported Convex primitive `ConvexProviderWithAuth`, driven by the
 * `useAuth` hook exported here.
 *
 * Nothing about the authentication system changes: Better Auth still owns the
 * session and still issues the Convex JWT through
 * `authClient.convex.token()`. This is only the React-to-Convex wiring.
 *
 * IDENTITY STABILITY — THE WHOLE POINT OF THIS FILE
 * -------------------------------------------------
 * Convex documents that if the `useAuth` prop function or the
 * `fetchAccessToken` it returns changes identity, auth state transitions back
 * to loading and the token is fetched again. Keying either on the session id
 * therefore causes an endless re-auth loop as the session resolves.
 *
 * So:
 *   - `useAuthFromBetterAuth` is a module-level function: same identity for the
 *     life of the module, never recreated by a render.
 *   - `fetchAccessToken` is a single `useCallback` with a stable identity. It
 *     reads current state through refs, so its behaviour can change without
 *     its identity churning.
 *
 * Tokens are never cached across calls, never persisted, and never logged.
 */

/**
 * `useAuth` prop for `ConvexProviderWithAuth`.
 *
 * `isAuthenticated` describes the EXTERNAL AUTH PROVIDER state and nothing
 * else. `ConvexProviderWithAuth` uses it to decide whether to configure auth
 * and whether to call `fetchAccessToken` at all, so it must reflect whether
 * Better Auth currently has an authenticated user.
 *
 * It is deliberately NOT derived from Convex auth state, from the
 * <Authenticated> component, from `requireOwner()`, or from token verification.
 * Server-confirmed Convex auth is a separate downstream concern, surfaced by
 * `useConvexAuth()` / <Authenticated> / <Unauthenticated>.
 *
 * Exported as a stable module-level function on purpose — see the identity
 * stability note above.
 */
export function useAuthFromBetterAuth(): {
  isLoading: boolean;
  isAuthenticated: boolean;
  fetchAccessToken: (args: { forceRefreshToken: boolean }) => Promise<string | null>;
} {
  const { data, isPending } = authClient.useSession();

  const sessionRef = useRef(data);
  sessionRef.current = data;

  // Stable identity for the life of the component. Reads live state from refs.
  const fetchAccessToken = useCallback(
    async ({ forceRefreshToken }: { forceRefreshToken: boolean }) => {
      const session = sessionRef.current;

      // Definitively no Better Auth session: no token, and no point asking the
      // server. Each call still performs a real request when a session exists,
      // so `forceRefreshToken` naturally yields a fresh token — nothing is
      // cached between calls.
      if (!session?.session) {
        return null;
      }

      try {
        // The endpoint is declared in @convex-dev/better-auth as
        //   createAuthEndpoint("/convex/token", { method: "GET", requireHeaders: true, use: [sessionMiddleware] })
        // i.e. a GET with no request body returning { token: string }. Better
        // Auth's $fetch takes request options as the SECOND argument, so this is
        // called with no arguments.
        const result = await authClient.convex.token();

        // Better Auth's own normalizer treats a result as already-wrapped only
        // when it has BOTH `data` and `error`; otherwise the result IS the
        // payload. The payload here is { token }, so it is unwrapped. Mirroring
        // the library's rule avoids guessing at response shapes.
        const wrapped =
          typeof result === "object" &&
          result !== null &&
          "data" in result &&
          "error" in result;
        const data = wrapped
          ? (result as { data?: { token?: string } }).data
          : (result as { token?: string } | null | undefined);
        const error = wrapped ? (result as { error?: unknown }).error : null;

        if (error) {
          // Detail to operators only. The user-facing surface is the sanitised
          // error boundary, which never renders backend specifics.
          console.error("[convex-auth-bridge] token request returned an error:", error);
          return null;
        }

        return data?.token ?? null;
      } catch (error) {
        console.error("[convex-auth-bridge] token fetch failed:", error);
        return null;
      }
    },
    [],
  );

  const isAuthenticated = data?.user != null;

  return useMemo(
    () => ({
      isLoading: isPending,
      isAuthenticated,
      fetchAccessToken,
    }),
    // `isPending` / `isAuthenticated` stay reactive; `fetchAccessToken` keeps
    // its stable identity so the provider does not churn.
    [isPending, isAuthenticated, fetchAccessToken],
  );
}
