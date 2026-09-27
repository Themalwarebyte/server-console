import { authComponent } from "./auth";
import type { GenericCtx } from "@convex-dev/better-auth";
import type { DataModel } from "./_generated/dataModel";

/**
 * Central server-side authorization for the Server Management Console.
 *
 * Every sensitive query and every mutation routes through `requireOwner`.
 * Frontend route guards are presentation only and are never a security
 * boundary — a caller can invoke any exported Convex function directly, so
 * enforcement lives here.
 *
 * There is deliberately no `isLocalhost`, no root bypass, and no special case
 * for the host the control plane runs on. SERVER-02 is both the control-plane
 * host and an ordinary managed node, and it authorizes exactly like any other.
 *
 * Authorization never depends on hostname, IP address, Tailscale identity, or
 * any value supplied by the browser.
 */

export type AuthzCtx = GenericCtx<DataModel>;

export interface OwnerIdentity {
  /** Stable Better Auth user id, taken from the validated session. */
  userId: string;
  /** The authenticated login identifier. */
  email: string;
  /**
   * Attribution string for audit records: the authenticated login plus the
   * stable Better Auth user id. Derived from the validated session only, never
   * from caller input.
   */
  actor: string;
}

/** Reads the single permitted Owner login from the deployment environment. */
export function ownerLoginId(): string {
  const configured = process.env.OWNER_LOGIN_ID;
  if (!configured || configured.trim().length === 0) {
    throw new Error(
      "OWNER_LOGIN_ID is not configured on this deployment. Authorization cannot be evaluated.",
    );
  }
  return configured.trim().toLowerCase();
}

/**
 * Require a valid Better Auth session belonging to the permitted Owner account.
 *
 * `authComponent.getAuthUser(ctx)` resolves the session server-side from the
 * authenticated request and throws when there is no valid session. Nothing is
 * read from the browser beyond the authenticated session itself.
 */
export async function requireOwner(ctx: AuthzCtx): Promise<OwnerIdentity> {
  const user = await authComponent.getAuthUser(ctx);

  const email =
    typeof user.email === "string" ? user.email.trim().toLowerCase() : "";
  if (email.length === 0) {
    throw new Error("Unauthenticated");
  }

  if (email !== ownerLoginId()) {
    throw new Error("Not authorized");
  }

  const userId = String(user._id);
  return { userId, email, actor: `${email} (sub=${userId})` };
}

/**
 * There is intentionally no `hasOwnerAccount` query.
 *
 * A public "does an account exist" query would reveal whether an arbitrary
 * address is provisioned. First-run setup is therefore driven from the
 * sign-in screen as an explicit Owner action, and the single-owner restriction
 * is enforced server-side by the Better Auth `databaseHooks` in `auth.ts` —
 * not by any frontend state.
 */
