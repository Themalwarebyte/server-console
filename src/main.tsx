import { Toaster } from "@/components/ui/sonner";
import { RequireAuth } from "@/components/RequireAuth";
import { ConsoleErrorBoundary } from "@/components/ConsoleErrorBoundary";
import { ConvexProviderWithAuth, ConvexReactClient } from "convex/react";
import React, { StrictMode, useEffect, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router";
import { useAuthFromBetterAuth } from "@/lib/convex-auth-bridge";
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

/**
 * `expectAuth: true` is required, not optional.
 *
 * The Convex client defaults this to `false`, which means query, mutation and
 * action requests are issued as soon as the socket connects, WITHOUT waiting
 * for an auth token. Our token is fetched asynchronously over a different
 * origin (Better Auth on :8444), so the protected queries were winning that
 * race and failing with `Unauthenticated` before the token ever arrived.
 *
 * With `expectAuth: true` the client holds every request back until the first
 * token is available, so protected queries only ever run authenticated.
 */
const convex = new ConvexReactClient(convexUrl, { expectAuth: true });

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
      <ConvexProviderWithAuth client={convex} useAuth={useAuthFromBetterAuth}>
        <BrowserRouter>
          <Suspense fallback={<RouteLoading />}>
            {/* One sanitised boundary for every protected console route, so no
                page can render a raw Convex error into the UI. */}
            <ConsoleErrorBoundary>
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
            </ConsoleErrorBoundary>
          </Suspense>
        </BrowserRouter>
        <Toaster />
      </ConvexProviderWithAuth>
    </RootErrorBoundary>
  </StrictMode>,
);
