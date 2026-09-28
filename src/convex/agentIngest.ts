import { query, mutation, httpAction } from "./_generated/server";
import { api } from "./_generated/api";
import { v } from "convex/values";
import type { HttpRouter } from "convex/server";
import type { GenericMutationCtx } from "convex/server";
import { requireOwner } from "./authz";
import type { DataModel } from "./_generated/dataModel";

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
 * originate from the authenticated mTLS session. The gateway overwrites
 * `serverPublicId` from the verified certificate before forwarding, so an agent
 * cannot claim another host's identity.
 *
 * STRUCTURE
 * An `httpAction` has no `db`, so the HTTP layer authenticates and the write
 * runs through a mutation. Both layers check the credential, so a routing
 * mistake alone cannot admit a write.
 */

/** Offline threshold. Beyond this, a host is OFFLINE. */
export const OFFLINE_AFTER_MS = 45_000;

/**
 * constantTimeEqual compares two credentials without leaking their contents
 * through timing. Implemented over UTF-8 bytes directly rather than via Buffer
 * so behaviour does not depend on which Buffer type the runtime exposes.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  const n = Math.max(x.byteLength, y.byteLength);
  let diff = x.byteLength ^ y.byteLength;
  for (let i = 0; i < n; i++) {
    const xi = i < x.byteLength ? x[i] : 0;
    const yi = i < y.byteLength ? y[i] : 0;
    diff |= xi ^ yi;
  }
  return diff === 0;
}

type Ctx = GenericMutationCtx<DataModel>;

interface IngestEnvelope {
  kind: string;
  serverPublicId: string;
  certFingerprint: string;
  certSerial: string;
  gatewayServiceId: string;
  observedAtMs: number;
  receivedAtMs: number;
  payload: Record<string, unknown>;
}

const ALLOWED_KINDS: readonly string[] = ["host", "docker", "event"];

/** Registers the narrow ingest endpoint on the shared HTTP router. */
export function registerAgentRoutes(http: HttpRouter): void {
  http.route({
    path: "/api/smc/ingest",
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      const json = (body: unknown, status: number) =>
        new Response(JSON.stringify({ error: body }), {
          status,
          headers: { "Content-Type": "application/json" },
        });

      const expected = process.env.SMC_GATEWAY_SECRET;
      if (!expected || expected.length < 32) {
        return json("ingest credential is not configured", 503);
      }

      const presented = request.headers.get("X-SMC-Service-Credential") ?? "";
      if (!constantTimeEqual(presented, expected)) {
        return json("unauthorized", 401);
      }
      if ((request.headers.get("X-SMC-Gateway") ?? "") !== "smc-gateway") {
        return json("unauthorized", 401);
      }

      let env: IngestEnvelope;
      try {
        env = (await request.json()) as IngestEnvelope;
      } catch {
        return json("malformed", 400);
      }
      if (!env || typeof env.serverPublicId !== "string" || env.serverPublicId === "") {
        return json("missing server identity", 400);
      }
      if (!ALLOWED_KINDS.includes(String(env.kind))) {
        return json("unknown kind", 400);
      }

      // httpAction has no db, so the write is delegated to the mutation below,
      // which re-validates the credential itself.
      await ctx.runMutation(api.agentIngest.ingestAgentTelemetry, {
        serviceCredential: presented,
        kind: String(env.kind),
        serverPublicId: env.serverPublicId,
        certFingerprint: String(env.certFingerprint ?? ""),
        certSerial: String(env.certSerial ?? ""),
        observedAtMs: Number(env.observedAtMs) || 0,
        receivedAtMs: Number(env.receivedAtMs) || 0,
        payload: env.payload ?? {},
      });

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  });
}

/**
 * The write half of ingest, reached only through the authenticated HTTP action.
 *
 * `.first()` rather than `.unique()`: `unique()` throws when an index holds more
 * than one document, so a pre-existing duplicate would turn every telemetry
 * arrival into a 500. A duplicate now degrades to "first match" instead of
 * breaking the whole ingest path.
 */
export const ingestAgentTelemetry = mutation({
  args: {
    serviceCredential: v.string(),
    kind: v.string(),
    serverPublicId: v.string(),
    certFingerprint: v.string(),
    certSerial: v.string(),
    observedAtMs: v.number(),
    receivedAtMs: v.number(),
    payload: v.any(),
  },
  handler: async (ctx, a) => {
    const expected = process.env.SMC_GATEWAY_SECRET;
    if (!expected || expected.length < 32) {
      throw new Error("ingest credential is not configured");
    }
    if (!constantTimeEqual(a.serviceCredential, expected)) {
      throw new Error("unauthorized");
    }
    if (!ALLOWED_KINDS.includes(a.kind)) {
      throw new Error("unknown kind");
    }

    const server = await ctx.db
      .query("servers")
      .withIndex("by_public_id", (q) => q.eq("publicId", a.serverPublicId))
      .first();
    if (!server) {
      // Identity is established by enrollment, never by telemetry arrival.
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

    await ctx.db.insert("agentTelemetry", {
      serverPublicId: a.serverPublicId,
      kind: a.kind,
      observedAtMs: a.observedAtMs || now,
      receivedAtMs: a.receivedAtMs || now,
      certFingerprint: a.certFingerprint,
      certSerial: a.certSerial,
      gatewayServiceId: "smc-gateway",
      payload: a.payload,
    });

    return { stored: true };
  },
});

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
        certSerial: s.certSerial ?? null,
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

/** Recent lifecycle events for a host. Requires the Owner. */
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

/**
 * Marks a certificate revoked. The gateway refuses the certificate on the next
 * dial, because agents re-dial rather than holding a session open.
 */
export const revokeCertificate = mutation({
  args: { serverPublicId: v.string() },
  handler: async (ctx, a) => {
    await requireOwner(ctx);
    const server = await ctx.db
      .query("servers")
      .withIndex("by_public_id", (q) => q.eq("publicId", a.serverPublicId))
      .first();
    if (!server) throw new Error("unknown server");
    await ctx.db.patch(server._id, {
      agentStatus: "revoked",
      certRevokedAt: Date.now(),
    });
    return { revoked: true, serverPublicId: a.serverPublicId };
  },
});
