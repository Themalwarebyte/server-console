import { defineApp } from "convex/server";
import betterAuth from "@convex-dev/better-auth/convex.config";

/**
 * Component registration.
 *
 * The Better Auth component owns authentication storage (users, sessions,
 * accounts, JWKS) inside the self-hosted Convex deployment. Its schema is
 * merged into this deployment automatically.
 */
const app = defineApp();
app.use(betterAuth);

export default app;
