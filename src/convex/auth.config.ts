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
 * WHY A STATIC JWKS (JWKS) INSTEAD OF A URL
 * ------------------------------------------
 * Without `jwks`, `getAuthConfigProvider()` tells the backend to fetch
 *   ${CONVEX_SITE_URL}/api/auth/convex/jwks
 * which is served by Caddy on the host's Tailscale address. The Convex
 * container cannot reach that address at all, so the backend logged
 *   auth_update_failed_error: Could not fetch JWKS from URL ...
 * and could not validate any token.
 *
 * Passing the JWKS explicitly makes `getAuthConfigProvider()` emit a `data:`
 * URL instead, so the backend decodes the keys locally and never performs a
 * network fetch.
 *
 * SECURITY: the value of `JWKS` comes from the official
 * `auth:getStaticJwks` internal action, which returns the COMPLETE JWKS
 * document including ENCRYPTED SIGNING MATERIAL. The Better Auth Convex plugin
 * uses this same value to sign tokens, so a public-only JWKS makes
 * `/api/auth/convex/token` fail with HTTP 500.
 *
 * Therefore `JWKS` is SECRET deployment configuration. It must never appear in
 * Git, in a VITE_ variable, in the browser, in logs, or in a report. It is not
 * the same thing as the PUBLIC `/api/auth/convex/jwks` endpoint, which serves
 * verification material only.
 */
export default {
  providers: [
    getAuthConfigProvider({ jwks: process.env.JWKS }),
  ],
} satisfies AuthConfig;
