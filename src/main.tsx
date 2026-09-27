import { Toaster } from "@/components/ui/sonner";
import { RequireAuth } from "@/components/RequireAuth";
import { ConvexBetterAuthProvider } from "@convex-dev/better-auth/react";
import { ConvexReactClient } from "convex/react";
import React, { StrictMode, useEffect, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router";
import { authClient } from "@/lib/auth-client";
import "./index.css";

/**
 * Self-hosted entry point.
 *
 * This file previously contained Freebuff/Vly platform glue:
 *  - `import '@vly-ai/integrations'`      → removed (platform integration client)
 *  - `VlyToolbar` (vly-toolbar-readonly)  → removed (platform-only dev toolbar)
 *  - `RouteSyncer` iframe postMessage     → removed (platform preview navigation sync)
 *  - `ToolbarErrorBoundary`               → removed (existed only to isolate the toolbar)
 *
 * The convex URL is now the single integration point with the backend and can
 * point at either the managed deployment or a self-hosted Convex instance
 * (see docs/DEPLOYMENT.md).
 */
const convexUrl = import.meta.env.VITE_CONVEX_URL as string | undefined;

if (!convexUrl) {
  // Fail loudly and early instead of rendering a console that cannot talk to
  // any backend. Configure VITE_CONVEX_URL in .env.local (see .env.example).
  throw new Error(
    "VITE_CONVEX_URL is not configured. Copy .env.example to .env.local and set the Convex backend URL.",
  );
}

const convex = new ConvexReactClient(convexUrl);

// Lazy load route components for better code splitting
const Landing = lazy(() => import("./pages/Landing.tsx"));
const AuthPage = lazy(() => import("./pages/Auth.tsx"));
const Console = lazy(() => import("./pages/Console.tsx"));
const Servers = lazy(() => import("./pages/Servers.tsx"));
const ServerDetail = lazy(() => import("./pages/ServerDetail.tsx"));
const Communication = lazy(() => import("./pages/Communication.tsx"));
const Tasks = lazy(() => import("./pages/Tasks.tsx"));
const Enrollment = lazy(() => import("./pages/Enrollment.tsx"));
const NotFound = lazy(() => import("./pages/NotFound.tsx"));

// Simple loading fallback for route transitions
function RouteLoading() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="animate-pulse text-muted-foreground">Loading...</div>
    </div>
  );
}

/** Render an observable error state instead of a blank page. */
class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; message: string; stack: string }
> {
  state = { hasError: false, message: "", stack: "" };
  static getDerivedStateFromError(error: Error) {
    return {
      hasError: true,
      message: error.message || "Unknown runtime error",
      stack: error.stack || "",
    };
  }
  componentDidCatch(err: Error) {
    console.error("[App] Uncaught runtime error:", err);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-background text-foreground p-6">
          <div className="max-w-lg text-center">
            <p className="text-sm font-semibold">Application error</p>
            <p className="mt-2 text-xs text-muted-foreground break-words">
              {this.state.message}
            </p>
            {this.state.stack && (
              <pre className="mt-3 text-left text-[10px] leading-4 text-muted-foreground/80 max-h-40 overflow-auto rounded border border-border/60 p-2">
                {this.state.stack}
              </pre>
            )}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RootErrorBoundary>
      <ConvexBetterAuthProvider
        client={convex}
        authClient={
          /*
           * UPSTREAM TYPE COMPATIBILITY WORKAROUND — one boundary, one cast.
           *
           * `ConvexBetterAuthProvider` declares its `authClient` prop as
           *   ReturnType<typeof createAuthClient<BetterAuthClientPlugin & { plugins }>>
           * which requires the base client option to itself be a
           * BetterAuthClientPlugin. A normal `createAuthClient({ baseURL, plugins })`
           * can never satisfy that shape, so the natural client fails to typecheck
           * even though it is exactly the client the official React/Vite guide
           * constructs.
           *
           * Versions: @convex-dev/better-auth 0.12.5, better-auth 1.6.33.
           * Upstream issues: #393, #420.
           *
           * This reconciles a defective type declaration only. It bypasses no
           * authentication or authorization check: all authorization is enforced
           * server-side in `src/convex/authz.ts` via `requireOwner()`.
           *
           * `authClient` keeps its real inferred type everywhere else in the app;
           * this assertion is confined to this single prop and is not repeated
           * anywhere.
           *
           * REMOVE this assertion once the upstream types are fixed.
           */
          authClient as unknown as React.ComponentProps<
            typeof ConvexBetterAuthProvider
          >["authClient"]
        }
      >
        <BrowserRouter>
          <Suspense fallback={<RouteLoading />}>
            <Routes>
              <Route path="/" element={<Landing />} />
              <Route
                path="/auth"
                element={<AuthPage redirectAfterAuth="/console" />}
              />
              <Route
                path="/console"
                element={
                  <RequireAuth>
                    <Console />
                  </RequireAuth>
                }
              />
              <Route
                path="/console/servers"
                element={
                  <RequireAuth>
                    <Servers />
                  </RequireAuth>
                }
              />
              <Route
                path="/console/servers/:publicId"
                element={
                  <RequireAuth>
                    <ServerDetail />
                  </RequireAuth>
                }
              />
              <Route
                path="/console/communication"
                element={
                  <RequireAuth>
                    <Communication />
                  </RequireAuth>
                }
              />
              <Route
                path="/console/tasks"
                element={
                  <RequireAuth>
                    <Tasks />
                  </RequireAuth>
                }
              />
              <Route
                path="/console/enrollment"
                element={
                  <RequireAuth>
                    <Enrollment />
                  </RequireAuth>
                }
              />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </Suspense>
        </BrowserRouter>
        <Toaster />
      </ConvexBetterAuthProvider>
    </RootErrorBoundary>
  </StrictMode>,
);
