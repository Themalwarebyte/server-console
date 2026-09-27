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
 * deployment itself, verified against the JWKS the component holds. No
 * external identity provider is involved, and no third-party issuer is trusted.
 */
export default {
  providers: [getAuthConfigProvider()],
} satisfies AuthConfig;
