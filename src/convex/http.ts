import { httpRouter } from "convex/server";
import { authComponent, createAuth } from "./auth";
import { registerAgentRoutes } from "./agentIngest";

/**
 * HTTP surface.
 *
 * Better Auth is mounted lazily under /api/auth by the component. The agent
 * gateway's narrow ingest endpoint is mounted at /api/smc/ingest and is
 * protected by a dedicated service credential compared in constant time.
 */
const http = httpRouter();

registerAgentRoutes(http);

authComponent.registerRoutesLazy(http, createAuth, {
  cors: {
    allowedOrigins: ["https://gman-02.tail0ab69b.ts.net"],
    allowedHeaders: ["Content-Type", "Authorization", "Origin", "Accept"],
    exposedHeaders: ["Set-Cookie"],
  },
});

export default http;
