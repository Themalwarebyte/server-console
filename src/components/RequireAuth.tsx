import { Authenticated, AuthLoading, Unauthenticated } from "convex/react";
import { useAuth } from "@/hooks/use-auth";
import { useEffect, type ReactNode } from "react";

/**
 * Gate for every protected console surface.
 *
 * Two independent auth states exist and they are NOT interchangeable:
 *
 *   1. Better Auth session  — "is there a signed-in user?"  (fetched over :8444)
 *   2. Convex auth          — "does the backend accept our request token?"
 *                              (negotiated over the :8443 WebSocket)
 *
 * Only (2) authorises data, and only (2) gates mounting. A component holding a
 * protected `useQuery` must NOT MOUNT until Convex reports authenticated —
 * merely hiding its output afterwards is too late, because the query has
 * already run and already failed server-side.
 *
 * This gate is presentation only. It is never the security boundary: every
 * protected function independently re-validates the session in `requireOwner()`
 * on the server, and that check is unaffected by anything here.
 */

function ConvexAuthFailure() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm space-y-4 rounded-xl border border-border/70 bg-card/80 p-6 text-center card-layer">
        <h1 className="text-base font-semibold">
          Could not authenticate with the control plane
        </h1>
        <p className="text-sm text-muted-foreground">
          Your sign-in is valid, but the console could not establish an
          authenticated session with the Convex deployment. This is usually a
          connectivity problem or an expired token.
        </p>
        <p className="text-xs text-muted-foreground">
          No server details are shown here. Retry, or sign out and back in to
          issue a fresh session token.
        </p>
        <div className="flex flex-col gap-2 pt-1">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          >
            Retry authentication
          </button>
          <button
            type="button"
            onClick={() => {
              window.location.href = "/auth";
            }}
            className="w-full rounded-md border border-border px-4 py-2 text-sm font-medium text-muted-foreground"
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { isLoading: baLoading, isAuthenticated: baAuthenticated } = useAuth();

  // No Better Auth session at all: send the visitor to sign-in rather than
  // showing an authentication failure they cannot act on.
  useEffect(() => {
    if (!baLoading && !baAuthenticated) {
      window.location.href = "/auth";
    }
  }, [baLoading, baAuthenticated]);

  if (baLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground">
        Connecting to the control plane…
      </div>
    );
  }

  if (!baAuthenticated) {
    return null;
  }

  return (
    <>
      {/* Signed in, but the Convex token has not been negotiated yet.
          Nothing that queries Convex may mount in this state. */}
      <AuthLoading>
        <div className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground">
          Connecting to the control plane…
        </div>
      </AuthLoading>

      {/* Signed in, but Convex auth definitively failed. */}
      <Unauthenticated>
        <ConvexAuthFailure />
      </Unauthenticated>

      {/* Only now may protected queries run. */}
      <Authenticated>{children}</Authenticated>
    </>
  );
}
