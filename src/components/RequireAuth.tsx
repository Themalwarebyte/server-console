import { useAuth } from "@/hooks/use-auth";
import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import { useEffect } from "react";

/**
 * Client-side route guard.
 *
 * Presentation only. This decides what to render; it is NOT the security
 * boundary. Every protected query and mutation independently re-validates the
 * session server-side via `requireOwner()`, so bypassing this component grants
 * nothing but an empty screen.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { isLoading, isAuthenticated } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      navigate("/auth", { replace: true });
    }
  }, [isLoading, isAuthenticated, navigate]);

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-muted-foreground">
        Checking session…
      </div>
    );
  }

  if (!isAuthenticated) {
    return null;
  }

  return <>{children}</>;
}
