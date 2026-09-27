import { betterAuth } from "better-auth";
import { createClient, type GenericCtx } from "@convex-dev/better-auth";
import { convex, crossDomain } from "@convex-dev/better-auth/plugins";
import { internalAction } from "./_generated/server";
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

    // `jwks` must be supplied to BOTH the auth config and this plugin, and it
    // must be the COMPLETE document from `auth:getStaticJwks` — including the
    // encrypted signing material. With a public-only JWKS the plugin has no
    // usable signing key and `/api/auth/convex/token` returns HTTP 500. With no
    // `jwks` at all, the plugin falls back to the database.
    plugins: [
      convex({ authConfig, jwks: process.env.JWKS }),
      crossDomain({ siteUrl: SITE_URL }),
    ],
  });

export type Auth = ReturnType<typeof createAuth>;

/**
 * Returns the full static JWKS document for the `JWKS` deployment variable.
 *
 * This is the official @convex-dev/better-auth static-JWKS workflow. The value
 * it returns contains ENCRYPTED SIGNING MATERIAL, so it is secret
 * configuration: it belongs in the Convex deployment environment only, never in
 * Git, never in a VITE_ variable, and never in the browser.
 *
 * This is emphatically NOT the public JWKS served at
 * `/api/auth/convex/jwks`, which is public verification material only.
 *
 * It is an internal action, so it cannot be invoked from the public API — only
 * by an operator with deployment admin credentials, deliberately.
 */
export const getStaticJwks = internalAction({
  args: {},
  handler: async (ctx) => {
    const auth = createAuth(ctx);
    // `/convex/latest-jwks` is declared SERVER_ONLY by the plugin and is
    // therefore unreachable over HTTP; calling the endpoint directly through
    // the Better Auth instance is the supported way to retrieve it.
    return auth.api.getLatestJwks();
  },
});
