import { betterAuth } from "better-auth";
import { createClient, type GenericCtx } from "@convex-dev/better-auth";
import { convex, crossDomain } from "@convex-dev/better-auth/plugins";
import { components } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import authConfig from "./auth.config";

/**
 * Better Auth, running entirely inside this self-hosted Convex deployment.
 *
 * Single-owner, email + password. No OAuth, no external IdP, no email OTP, no
 * magic links, no anonymous provider. The previous Freebuff-issued `customJwt`
 * trust anchor and the OTP provider are both gone.
 */

export const authComponent = createClient<DataModel>(components.betterAuth);

/** The single approved console origin. Never a wildcard, never the LAN IP. */
const SITE_ORIGIN = "https://gman-02.tail0ab69b.ts.net";
/** Console origin as the browser sees it. */
const SITE_URL = SITE_ORIGIN;
/** Convex HTTP-actions origin — the Better Auth base URL. */
const CONVEX_SITE_URL = "https://gman-02.tail0ab69b.ts.net:8444";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`${name} must be set on the Convex deployment environment.`);
  }
  return value;
}

/** The single permitted Owner login. */
function permittedOwner(): string {
  return requiredEnv("OWNER_LOGIN_ID").trim().toLowerCase();
}

export const createAuth = (ctx: GenericCtx<DataModel>) =>
  betterAuth({
    baseURL: CONVEX_SITE_URL,
    secret: requiredEnv("BETTER_AUTH_SECRET"),
    database: authComponent.adapter(ctx),

    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
      // V0.1 strong policy. Better Auth's own hashing is used unchanged.
      minPasswordLength: 16,
      maxPasswordLength: 256,
    },

    trustedOrigins: [SITE_ORIGIN, CONVEX_SITE_URL],

    databaseHooks: {
      user: {
        create: {
          /**
           * Server-side, pre-creation restriction.
           *
           * `/sign-up/email` may create an account ONLY for the configured
           * Owner login. Every other identifier is refused before the account
           * row is written, and before any password hash is stored.
           *
           * This is the boundary. It is enforced inside the deployment, so no
           * frontend behaviour, request shape, or browser-side state can
           * bypass it.
           */
          before: async (user: { email?: string }) => {
            const requested = (user.email ?? "").trim().toLowerCase();
            if (requested.length === 0) {
              throw new Error("Email is required.");
            }
            if (requested !== permittedOwner()) {
              throw new Error(
                "Sign-up is restricted to the configured Owner account.",
              );
            }
            return { data: { ...user, email: requested } };
          },
        },
      },
    },

    // `jwks` must be supplied to BOTH the auth config and this plugin. When a
    // static JWKS is present in the auth config but absent here, the deployment
    // throws at runtime:
    //   "Static JWKS detected in auth config, but missing from Convex plugin"
    // Supplying it here also stops the plugin reading the JWKS from the
    // database on every token request.
    plugins: [
      convex({ authConfig, jwks: process.env.BETTER_AUTH_JWKS }),
      crossDomain({ siteUrl: SITE_URL }),
    ],
  });

export type Auth = ReturnType<typeof createAuth>;
