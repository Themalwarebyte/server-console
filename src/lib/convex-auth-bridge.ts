import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
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

/* ------------------------------------------------------------------ *
 * Temporary diagnostics (removed before the V0.1 declaration)
 * ------------------------------------------------------------------ */

export interface TokenDiagnostics {
  /** How many times Convex has asked for a token. */
  attempts: number;
  /** Whether a token request was actually issued to Better Auth. */
  requested: boolean;
  /** Whether Better Auth returned an in-band error (not only whether we threw). */
  errorPresent: boolean;
  /** Safe, non-secret fields from `result.error`, when it exposes them. */
  errorStatus: number | null;
  errorCode: string | null;
  /** Whether a non-empty token came back. */
  success: boolean;
  /** Whether the fetch threw. */
  errored: boolean;
  /**
   * Key names of the response object actually observed. Names only, never
   * values — safe, and it settles the response-shape question immediately.
   */
  responseShape: string;
  /** Safe, decoded JWT metadata only. Never the token itself. */
  header: { alg?: string; kid?: string; typ?: string };
  claims: { iss?: string; aud?: unknown; sub?: string; exp?: number };
}

const EMPTY_DIAGNOSTICS: TokenDiagnostics = {
  attempts: 0,
  requested: false,
  errorPresent: false,
  errorStatus: null,
  errorCode: null,
  success: false,
  errored: false,
  responseShape: "",
  header: {},
  claims: {},
};

let diagnostics: TokenDiagnostics = EMPTY_DIAGNOSTICS;
const listeners = new Set<() => void>();

function setDiagnostics(next: Partial<TokenDiagnostics>) {
  diagnostics = { ...diagnostics, ...next };
  listeners.forEach((l) => l());
}

export function useTokenDiagnostics(): TokenDiagnostics {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => diagnostics,
    () => EMPTY_DIAGNOSTICS,
  );
}

/** Decodes header/claims locally, in memory. The token is never stored. */
function decodeJwtMetadata(token: string): Pick<TokenDiagnostics, "header" | "claims"> {
  const empty = { header: {}, claims: {} };
  try {
    const [h, p] = token.split(".");
    if (!h || !p) return empty;
    const header = JSON.parse(atob(h.replace(/-/g, "+").replace(/_/g, "/")));
    const claims = JSON.parse(atob(p.replace(/-/g, "+").replace(/_/g, "/")));
    return {
      header: {
        alg: typeof header.alg === "string" ? header.alg : undefined,
        kid: typeof header.kid === "string" ? header.kid : undefined,
        typ: typeof header.typ === "string" ? header.typ : undefined,
      },
      claims: {
        iss: typeof claims.iss === "string" ? claims.iss : undefined,
        aud: claims.aud,
        sub: typeof claims.sub === "string" ? claims.sub : undefined,
        exp: typeof claims.exp === "number" ? claims.exp : undefined,
      },
    };
  } catch {
    return empty;
  }
}

/* ------------------------------------------------------------------ *
 * The bridge
 * ------------------------------------------------------------------ */

/**
 * `useAuth` prop for `ConvexProviderWithAuth`.
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

      // A. Definitively no Better Auth session -> no token, and do not bother
      //    the server. (We still honour forceRefreshToken by re-checking.)
      if (!session?.session) {
        setDiagnostics({
          attempts: diagnostics.attempts + 1,
          requested: false,
          success: false,
          errorPresent: false,
          errorStatus: null,
          errorCode: null,
          responseShape: "",
        });
        return null;
      }

      setDiagnostics({
        attempts: diagnostics.attempts + 1,
        requested: true,
        success: false,
        errorPresent: false,
        errorStatus: null,
        errorCode: null,
        errored: false,
        responseShape: "",
        header: {},
        claims: {},
      });

      try {
        // The endpoint is declared in @convex-dev/better-auth as
        //   createAuthEndpoint("/convex/token", { method: "GET", requireHeaders: true, use: [sessionMiddleware] })
        // i.e. a GET with no request body, returning { token: string }.
        // Request options are the SECOND parameter of Better Auth's $fetch,
        // so passing an object here would be sent as an endpoint body. The
        // simplest official call shape is therefore no arguments at all.
        const result = await authClient.convex.token();

        // Better Auth's own normalizer (dist/client/session-atom.mjs) treats a
        // result as already-wrapped only when it has BOTH `data` and `error`;
        // otherwise the result IS the payload. The token endpoint's payload is
        // { token }, so it is unwrapped. Mirroring the library's own logic
        // avoids guessing at response shapes.
        const wrapped =
          typeof result === "object" &&
          result !== null &&
          "data" in result &&
          "error" in result;
        const data = wrapped
          ? (result as { data?: { token?: string } }).data
          : (result as { token?: string } | null | undefined);
        const error = wrapped
          ? (result as { error?: unknown }).error
          : null;

        // Key names only, never values.
        const shape =
          typeof result === "object" && result !== null
            ? Object.keys(result as object).join(",")
            : typeof result;

        if (error) {
          const e = error as { status?: unknown; code?: unknown };
          setDiagnostics({
            errorPresent: true,
            errorStatus: typeof e.status === "number" ? e.status : null,
            errorCode: typeof e.code === "string" ? e.code : null,
            responseShape: shape,
          });
          return null;
        }

        const token = data?.token ?? null;

        if (!token) {
          setDiagnostics({ success: false, responseShape: shape });
          return null;
        }

        // D. Safe metadata only. The token itself goes no further than the
        //    return value, straight back to Convex.
        setDiagnostics({
          success: true,
          responseShape: shape,
          ...decodeJwtMetadata(token),
        });
        return token;
      } catch (error) {
        console.error("[convex-auth-bridge] token fetch failed:", error);
        setDiagnostics({ errored: true, success: false, requested: true });
        return null;
      }
    },
    [],
  );

  // `isAuthenticated` describes the EXTERNAL AUTH PROVIDER state, nothing else.
  //
  // This must reflect whether Better Auth currently has an authenticated
  // session. `ConvexProviderWithAuth` uses it to decide whether authentication
  // should be configured and whether `fetchAccessToken` should ever be called.
  // Reporting a hardcoded `false` here therefore deadlocks the handshake:
  //
  //   Better Auth authenticated -> bridge says false -> provider never fetches a
  //   token -> Convex never authenticates -> protected content never mounts.
  //
  // It is deliberately NOT derived from Convex auth state, from the
  // <Authenticated> component, from `requireOwner()`, or from token
  // verification. Server-confirmed Convex auth is a separate downstream
  // concern, surfaced by `useConvexAuth()` / <Authenticated> / <Unauthenticated>.
  const isAuthenticated = data?.user != null;

  return useMemo(
    () => ({
      isLoading: isPending,
      isAuthenticated,
      fetchAccessToken,
    }),
    // `isPending` / `isAuthenticated` must stay reactive; `fetchAccessToken`
    // keeps its stable identity so the provider does not churn.
    [isPending, isAuthenticated, fetchAccessToken],
  );
}
