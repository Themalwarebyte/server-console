import { query, mutation, httpAction } from "./_generated/server";
import { v } from "convex/values";
import type { HttpRouter } from "convex/server";
import { requireOwner } from "./authz";

/**
 * Agent telemetry ingestion.
 *
 * This module is the narrow door between the agent gateway and the control
 * plane. It is deliberately the ONLY write path for agent data, and it accepts
 * nothing else.
 *
 * AUTHENTICATION
 * The gateway holds a dedicated service credential, not the Convex admin key and
 * not the Owner's Better Auth credentials. It is compared in constant time so a
 * mismatch reveals nothing through timing.
 *
 * ATTRIBUTION
 * `serverPublicId`, the certificate fingerprint and the certificate serial all
 * arrive inside the authenticated envelope, which the gateway populates from the
 * verified mTLS session. The agent cannot choose its own identity: the gateway
 * overwrites `serverPublicId` from the certificate before forwarding, and this
 * endpoint records the fingerprint and serial so an operator can trace any row
 * back to a specific certificate.
 */

/** Offline threshold. Beyond this, a host is OFFLINE. */
export const OFFLINE_AFTER_MS = 45_000;

/** constantTimeEqual is the only comparison used for the service credential. */
/**
 * constantTimeEqual compares two credentials without leaking their contents
 * through timing. Implemented over UTF-8 bytes directly rather than via Buffer
 * so the behaviour does not depend on which Buffer type the runtime exposes.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  const n = Math.max(x.byteLength, y.byteLength);
  let diff = x.byteLength ^ y.byteLength;
  for (let i = 0; i < n; i++) {
    // Missing bytes are treated as zero, so a length mismatch still costs the
    // same work as a matching length.
    const xi = i < x.byteLength ? x[i] : 0;
    const yi = i < y.byteLength ? y[i] : 0;
    diff |= xi ^ yi;
  }
  return diff === 0;
}

type IngestEnvelope = {
  kind: "host" | "docker" | "event";
  serverPublicId: string;
  certFingerprint: string;
  certSerial: string;
  gatewayServiceId: string;
  observedAtMs: number;
  receivedAtMs: number;
  payload: Record<string, unknown>;
};

/** Registers the narrow ingest endpoint on the shared HTTP router. */
export function registerAgentRoutes(http: HttpRouter): void {
  http.route({
    path: "/api/smc/ingest",
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      const expected = process.env.SMC_GATEWAY_SECRET;
      if (!expected || expected.length < 32) {
        return new Response(
          JSON.stringify({ error: "ingest credential is not configured" }),
          { status: 503, headers: { "Content-Type": "application/json" } },
        );
      }

      const presented = request.headers.get("X-SMC-Service-Credential") ?? "";
      if (!constantTimeEqual(presented, expected)) {
        // Status only. No detail about which part was wrong.
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
      const svc = request.headers.get("X-SMC-Gateway") ?? "";
      if (svc !== "smc-gateway") {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }

      let env: IngestEnvelope;
      try {
        env = (await request.json()) as IngestEnvelope;
      } catch {
        return new Response(JSON.stringify({ error: "malformed" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (!env || typeof env.serverPublicId !== "string" || env.serverPublicId.length === 0) {
        return new Response(JSON.stringify({ error: "missing server identity" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      // A payload may only carry the approved kinds.
      const kind = String(env.kind);
      const allowed: readonly string[] = ["host", "docker", "event"];
      if (!allowed.includes(kind)) {
        return new Response(JSON.stringify({ error: "unknown kind" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      await storeTelemetry(ctx as unknown as Ctx, env);

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  });
}

type Ctx = {
  db: {
    query: (t: string) => {
      withIndex: (n: string, f: (q: any) => any) => {
        unique: () => Promise<any>;
        first: () => Promise<any>;
        order: (d: "asc" | "desc") => { take: (n: number) => Promise<any[]> };
        take: (n: number) => Promise<any[]>;
      };
    };
    patch: (id: any, v: any) => Promise<any>;
    insert: (t: string, v: any) => Promise<any>;
  };
};

/**
 * storeTelemetry persists one record and refreshes the host's agent state.
 *
 * It runs inside the authenticated httpAction rather than behind a second
 * internal mutation, so there is exactly ONE gate into agent data. There is no
 * other write path, public or otherwise.
 */
async function storeTelemetry(ctx: Ctx, a: IngestEnvelope) {
  const server = await ctx.db
    .query("servers")
    .withIndex("by_public_id", (q: any) => q.eq("publicId", a.serverPublicId))
    .unique();
  if (!server) {
    // Telemetry for an unknown host is dropped. Identity is established by
    // enrollment, never by telemetry arrival.
    return { stored: false, reason: "unknown server" };
  }

  const now = Date.now();

  // Liveness. A host is never presented as active merely because a row exists.
  await ctx.db.patch(server._id, {
    inventorySource: "agent",
    agentStatus: "enrolled",
    lastHeartbeatAt: now,
    lastObservedAt: a.observedAtMs || now,
    certFingerprint: a.certFingerprint,
    certSerial: a.certSerial,
  });

  // Liveness is refreshed above by every arrival. The gateway treats a bare
  // heartbeat as session state and does not forward it as a sample, so every
  // record that reaches here is an observation worth storing.

  await ctx.db.insert("agentTelemetry", {
    serverPublicId: a.serverPublicId,
    kind: a.kind,
    observedAtMs: a.observedAtMs || now,
    receivedAtMs: a.receivedAtMs || now,
    certFingerprint: a.certFingerprint,
    certSerial: a.certSerial,
    gatewayServiceId: a.gatewayServiceId,
    payload: a.payload,
  });
  return { stored: true };
}

/** Fleet view. Requires the Owner, like every other sensitive read. */
export const listAgentStatus = query({
  args: {},
  handler: async (ctx) => {
    await requireOwner(ctx);
    const servers = await ctx.db.query("servers").collect();
    const now = Date.now();

    return servers.map((s) => {
      const last = s.lastHeartbeatAt ?? 0;
      const online = last > 0 && now - last <= OFFLINE_AFTER_MS;
      return {
        serverPublicId: s.publicId,
        displayName: s.displayName,
        hostname: s.hostname,
        enrolled: s.agentStatus === "enrolled",
        online,
        lastHeartbeatAt: last || null,
        lastObservedAt: s.lastObservedAt ?? null,
        // Live figures are only meaningful while the agent is online. For an
        // offline host the caller must label any figure as stale.
        inventorySource: s.inventorySource ?? "demo",
        certFingerprint: s.certFingerprint ?? null,
      };
    });
  },
});

/** Latest telemetry of a kind for a host. Requires the Owner. */
export const latestTelemetry = query({
  args: { serverPublicId: v.string(), kind: v.string() },
  handler: async (ctx, a) => {
    await requireOwner(ctx);
    const row = await ctx.db
      .query("agentTelemetry")
      .withIndex("by_server_kind", (q) =>
        q.eq("serverPublicId", a.serverPublicId).eq("kind", a.kind),
      )
      .order("desc")
      .first();
    if (!row) return null;
    return {
      observedAtMs: row.observedAtMs,
      receivedAtMs: row.receivedAtMs,
      payload: row.payload,
      certFingerprint: row.certFingerprint,
    };
  },
});

/** Recent lifecycle events for a host, for the UI. Requires the Owner. */
export const listAgentEvents = query({
  args: { serverPublicId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, a) => {
    await requireOwner(ctx);
    const n = Math.min(a.limit ?? 20, 100);
    return ctx.db
      .query("agentEvents")
      .withIndex("by_server", (q) => q.eq("serverPublicId", a.serverPublicId))
      .order("desc")
      .take(n);
  },
});

/** Marks a certificate revoked. Requires the Owner. The gateway refuses it on
 *  the next dial, because agents re-dial rather than holding a session open. */
export const revokeCertificate = mutation({
  args: { serverPublicId: v.string() },
  handler: async (ctx, a) => {
    await requireOwner(ctx);
    const server = await ctx.db
      .query("servers")
      .withIndex("by_public_id", (q) => q.eq("publicId", a.serverPublicId))
      .unique();
    if (!server) throw new Error("unknown server");
    await ctx.db.patch(server._id, {
      agentStatus: "revoked",
      certRevokedAt: Date.now(),
    });
    return { revoked: true, serverPublicId: a.serverPublicId };
  },
});
