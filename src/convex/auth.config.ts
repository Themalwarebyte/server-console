import { getAuthConfigProvider } from "@convex-dev/better-auth/auth-config";
import type { AuthConfig } from "convex/server";

/**
 * Convex JWT provider configuration.
 *
 * The resulting provider is `type: "customJwt"` (RS256) — the JWT
 * authentication model the self-hosted backend accepts. There is deliberately
 * no `credentials` provider here: the self-hosted backend rejects that type.
 *
 * The trust boundary is entirely internal: the issuer is this Convex
 * deployment itself, and the signing key is the component's own key. No
 * external identity provider is involved and no third-party issuer is trusted.
 *
 * WHY A STATIC JWKS (BETTER_AUTH_JWKS) INSTEAD OF A URL
 * ---------------------------------------------------
 * Without `jwks`, `getAuthConfigProvider()` tells the backend to fetch
 *   ${CONVEX_SITE_URL}/api/auth/convex/jwks
 * which is served by Caddy on the host's Tailscale address. The Convex
 * container cannot reach that address at all (a Docker bridge container has no
 * route to a host IP bound to a non-default interface), so the backend logged
 *   auth_update_failed_error: Could not fetch JWKS from URL ...
 * on every attempt, could not validate any token, and every protected query
 * failed — which surfaced as a page stuck on skeleton loaders forever.
 *
 * Passing the component's public JWKS explicitly makes `getAuthConfigProvider()`
 * emit a `data:` URL instead, so the backend decodes the keys locally and never
 * performs a network fetch. The payload contains PUBLIC key material only; the
 * private key stays inside the Better Auth component's table and is never
 * exposed here, in the environment, or in the browser.
 */
export default {
  providers: [
    getAuthConfigProvider({ jwks: process.env.BETTER_AUTH_JWKS }),
  ],
} satisfies AuthConfig;
