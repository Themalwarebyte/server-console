import React from "react";
import { signOutAndReload } from "@/lib/sign-out";
import { toast } from "sonner";
import { ConsoleLayout } from "@/components/console/ConsoleLayout";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/**
 * Sanitised error boundary for the protected console surface.
 *
 * The Owner-facing requirement is that no backend detail ever reaches the page.
 * Convex query failures otherwise render their raw error into the component
 * tree, which exposed query names, source paths, line numbers and request IDs.
 *
 * The operator-facing requirement is that the detail is not lost, so the full
 * error goes to the browser console and the deployment logs, while the page
 * shows only a generic message with a retry and a way back to sign-in.
 *
 * This is presentation only. It grants nothing: the server-side
 * `requireOwner()` check in `convex/authz.ts` is the security boundary and is
 * unaffected by anything here.
 *
 * It is mounted once, at the route level in `main.tsx`, so every protected
 * page receives identical sanitised handling.
 */

interface State {
  error: unknown;
  failed: boolean;
}

export class ConsoleErrorBoundary extends React.Component<
  { children: React.ReactNode },
  State
> {
  state: State = { error: undefined, failed: false };

  static getDerivedStateFromError(error: unknown): State {
    return { error, failed: true };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    // Full detail stays with operators; the page stays deliberately vague.
    console.error("[Console] render failed:", error, info.componentStack);
  }

  private looksLikeAuthFailure(): boolean {
    const message =
      this.state.error instanceof Error
        ? this.state.error.message
        : String(this.state.error ?? "");
    return /unauthenticated|not authorized|unauthori[sz]ed/i.test(message);
  }

  private handleRetry = () => {
    this.setState({ error: undefined, failed: false });
    window.location.reload();
  };

  private handleSignOut = async () => {
    const { ok } = await signOutAndReload();
    if (!ok) {
      toast.error("Sign out failed. Please try again.");
    }
  };

  render() {
    if (!this.state.failed) {
      return this.props.children;
    }

    const authFailure = this.looksLikeAuthFailure();

    return (
      <ConsoleLayout>
        <Card className="mx-auto mt-16 max-w-lg border-border/70 card-layer">
          <CardHeader>
            <CardTitle className="text-base">Cannot reach the control plane</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <p>
              {authFailure
                ? "The console could not authenticate with the Convex deployment. Your sign-in may have expired, or the deployment may be unreachable."
                : "The console could not load data from the Convex deployment. This is usually a connectivity or session problem rather than an empty control plane."}
            </p>
            <p className="text-xs">
              No server names, identifiers, or backend diagnostics are shown
              here. The details are recorded in the browser console and the
              deployment logs.
            </p>
            <div className="flex flex-col gap-2 pt-1">
              <button
                type="button"
                onClick={this.handleRetry}
                className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
              >
                Retry
              </button>
              <button
                type="button"
                onClick={this.handleSignOut}
                className="w-full rounded-md border border-border px-4 py-2 text-sm font-medium text-muted-foreground"
              >
                Sign out
              </button>
            </div>
          </CardContent>
        </Card>
      </ConsoleLayout>
    );
  }
}
