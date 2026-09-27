import { createAuthClient } from "better-auth/react";
import {
  convexClient,
  crossDomainClient,
} from "@convex-dev/better-auth/client/plugins";

/**
 * Browser auth client.
 *
 * The console is served from `https://gman-02.tail0ab69b.ts.net` while Convex
 * runs on `:8443`, so the cross-domain client plugin moves the session token
 * between those origins. `trustedOrigins` is configured server-side to exactly
 * these origins — no wildcards.
 */
export const authClient = createAuthClient({
  baseURL: import.meta.env.VITE_CONVEX_SITE_URL as string,
  plugins: [convexClient(), crossDomainClient()],
});
