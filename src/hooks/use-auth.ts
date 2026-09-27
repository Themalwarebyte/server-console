import { authClient } from "@/lib/auth-client";

/**
 * Better Auth session state for the console.
 *
 * Presentation only. This hook decides what to render; it is never a security
 * boundary. Every protected query and mutation re-validates the session
 * server-side through `requireOwner()` in `convex/authz.ts`.
 */
export function useAuth() {
  const { data, isPending } = authClient.useSession();

  return {
    isLoading: isPending,
    isAuthenticated: data != null,
    user: data?.user ?? null,
    session: data ?? null,
    signOut: () => authClient.signOut(),
    authClient,
  };
}
