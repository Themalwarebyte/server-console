import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { WordmarkMark } from "@/components/console/ui";

import { authClient } from "@/lib/auth-client";
import { ArrowRight, KeyRound, Loader2, ShieldCheck, UserPlus } from "lucide-react";
import { Suspense, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";

interface AuthProps {
  redirectAfterAuth?: string;
}

function resolveRedirectAfterAuth(
  returnTo: string | null,
  fallback = "/console",
) {
  if (returnTo?.startsWith("/") && !returnTo.startsWith("//")) {
    return returnTo;
  }
  return fallback;
}

/**
 * Single-owner password sign-in.
 *
 * There is no public registration and no guest/anonymous path. Ordinary
 * sign-in is the default; first-owner setup sits behind an explicit control so
 * the screen never has to ask "does an account already exist" — a question
 * whose answer would disclose whether an arbitrary address is provisioned.
 *
 * The single-owner restriction itself is enforced inside the deployment, in the
 * Better Auth `databaseHooks` in `convex/auth.ts`. Nothing here is trusted.
 */
function Auth({ redirectAfterAuth }: AuthProps = {}) {
  const [searchParams] = useSearchParams();
  const redirect = resolveRedirectAfterAuth(
    searchParams.get("returnTo"),
    redirectAfterAuth,
  );

  const { data, isPending } = authClient.useSession();

  const [isFirstRun, setIsFirstRun] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isPending && data) {
      window.location.replace(redirect);
    }
  }, [isPending, data, redirect]);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsLoading(true);
    setError(null);
    try {
      const formData = new FormData(event.currentTarget);
      const email = String(formData.get("email") ?? "").trim();
      const password = String(formData.get("password") ?? "");
      if (password.length === 0) {
        throw new Error("Enter your password.");
      }

      if (isFirstRun) {
        const result = await authClient.signUp.email({
          email,
          password,
          name: "Owner",
        });
        if (result.error) {
          throw new Error(result.error.message ?? "Could not create the Owner account.");
        }
      } else {
        const result = await authClient.signIn.email({ email, password });
        if (result.error) {
          throw new Error("Sign-in failed. Check the Owner credentials.");
        }
      }

      window.location.replace(redirect);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Authentication failed. Try again.",
      );
      setIsLoading(false);
    }
  };

  const title = isFirstRun ? "Create Owner account" : "Owner sign-in";
  const description = isFirstRun
    ? "First run. Choose the Owner password for this control plane."
    : "Enter the Owner credentials for this control plane.";

  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden bg-background">
      <div className="absolute inset-0 bg-grid [mask-image:radial-gradient(60%_50%_at_50%_0%,black,transparent)]" />
      <div className="absolute inset-0 glow-top" />

      <div className="relative flex flex-1 items-center justify-center px-4 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex flex-col items-center gap-3 text-center">
            <WordmarkMark />
            <div>
              <h1 className="text-lg font-semibold tracking-tight">
                Server Management Console
              </h1>
              <p className="mt-1 text-xs text-muted-foreground">
                Private control plane · single-owner access · every session is audited
              </p>
            </div>
          </div>

          <Card className="border-border/70 bg-card/90 backdrop-blur card-layer">
            <CardHeader className="text-center">
              <CardTitle className="text-base">{title}</CardTitle>
              <CardDescription>{description}</CardDescription>
            </CardHeader>

            <form onSubmit={handleSubmit}>
              <CardContent className="space-y-3">
                <div className="relative">
                  <KeyRound className="absolute left-3 top-3 size-4 text-muted-foreground" />
                  <Input
                    name="email"
                    placeholder="owner@server-console.invalid"
                    type="email"
                    autoComplete="username"
                    className="pl-9"
                    disabled={isLoading}
                    required
                  />
                </div>

                <Input
                  name="password"
                  type="password"
                  autoComplete={isFirstRun ? "new-password" : "current-password"}
                  placeholder={isFirstRun ? "Choose a strong password" : "Password"}
                  disabled={isLoading}
                  required
                />

                {isFirstRun && (
                  <p className="text-[11px] leading-4 text-muted-foreground">
                    At least 16 characters, with upper and lower case letters, a
                    digit and a symbol. Only the configured Owner address may
                    create an account.
                  </p>
                )}

                {error && (
                  <p className="text-sm text-rose-400" role="alert">
                    {error}
                  </p>
                )}
              </CardContent>

              <CardFooter className="flex-col gap-2">
                <Button type="submit" className="w-full" disabled={isLoading || isPending}>
                  {isLoading ? (
                    <>
                      <Loader2 className="mr-2 size-4 animate-spin" />
                      {isFirstRun ? "Creating…" : "Signing in…"}
                    </>
                  ) : isFirstRun ? (
                    <>
                      <UserPlus className="mr-2 size-4" />
                      Create Owner account
                    </>
                  ) : (
                    <>
                      Sign in
                      <ArrowRight className="ml-2 size-4" />
                    </>
                  )}
                </Button>

                {!isFirstRun && (
                  <button
                    type="button"
                    onClick={() => {
                      setIsFirstRun(true);
                      setError(null);
                    }}
                    className="text-[11px] text-muted-foreground underline-offset-4 hover:underline"
                  >
                    First run? Create the Owner account
                  </button>
                )}

                {isFirstRun && (
                  <button
                    type="button"
                    onClick={() => {
                      setIsFirstRun(false);
                      setError(null);
                    }}
                    className="text-[11px] text-muted-foreground underline-offset-4 hover:underline"
                  >
                    Back to sign in
                  </button>
                )}
              </CardFooter>
            </form>

            <div className="flex items-center justify-center gap-1.5 rounded-b-lg border-t border-border/60 bg-background/60 px-6 py-3 text-center text-[11px] text-muted-foreground">
              <ShieldCheck className="size-3" />
              Single-owner access · no guest sign-in
            </div>
          </Card>

          <p className="mt-6 text-center text-[11px] text-muted-foreground">
            <Link to="/" className="underline-offset-4 hover:underline">
              Back to overview
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}

export default function AuthPage(props: AuthProps) {
  return (
    <Suspense>
      <Auth {...props} />
    </Suspense>
  );
}
