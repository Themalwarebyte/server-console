import { httpRouter } from "convex/server";
import { authComponent, createAuth } from "./auth";

/**
 * Better Auth HTTP routes.
 *
 * `registerRoutesLazy` mounts the Better Auth handler under the component's
 * own path on the HTTP-actions port. CORS is restricted to the single approved
 * console origin — no wildcards, and never the LAN address.
 */
const http = httpRouter();

authComponent.registerRoutesLazy(http, createAuth, {
  cors: {
    allowedOrigins: ["https://gman-02.tail0ab69b.ts.net"],
    allowedHeaders: ["Content-Type", "Authorization", "Origin", "Accept"],
    exposedHeaders: ["Set-Cookie"],
  },
});

export default http;
