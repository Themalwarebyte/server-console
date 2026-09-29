import { query, mutation, httpAction } from "./_generated/server";
import { api } from "./_generated/api";
import { v } from "convex/values";
import type { HttpRouter } from "convex/server";
import type { GenericMutationCtx } from "convex/server";
import { requireOwner } from "./authz";
import type { DataModel, Doc } from "./_generated/dataModel";

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
 * Telemetry staleness threshold.
 *
 * Host telemetry is expected every 5 s and Docker telemetry every 10 s, so a
 * successful write older than this while the heartbeat is still fresh means
 * something is broken upstream of Convex — the helper, the agent, or the
 * gateway ingest. That is precisely the DEGRADED case.
 */
export const TELEMETRY_STALE_MS = 30_000;

/** Warn when a certificate has fewer than this many days remaining. */
export const CERT_WARN_DAYS = 30;

/**
 * Error classes the platform will store. Anything unrecognised collapses to
 * `unknown`, so an unexpected upstream message can never reach the database
 * and from there the UI.
 */
const ERROR_CLASSES = new Set([
  "ingest_rejected",
  "helper_unavailable",
  "helper_timeout",
  "unknown_container",
  "identity_mismatch",
  "gateway_unreachable",
  "unknown",
]);

function sanitiseErrorClass(v: unknown): string {
  const s = typeof v === "string" ? v : "";
  return ERROR_CLASSES.has(s) ? s : "unknown";
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

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

const ALLOWED_KINDS: readonly string[] = [
  "host",
  "docker",
  "event",
  // Health signals from the gateway, carried on the same authenticated endpoint
  // so no new channel, credential, or protocol surface is introduced.
  "status",
  "error",
];

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

    // Fail closed on duplicate identities. A managed server is identified by its
    // immutable publicId; if two documents ever claim it, that is corruption and
    // telemetry must be refused rather than attributed to an arbitrary one.
    const rows = await ctx.db
      .query("servers")
      .withIndex("by_public_id", (q) => q.eq("publicId", a.serverPublicId))
      .collect();
    if (rows.length > 1) {
      throw new Error(
        `Identity integrity violation: ${rows.length} server documents share publicId "${a.serverPublicId}". Telemetry refused.`,
      );
    }
    const server = rows[0];
    if (!server) {
      // Identity is established by enrollment, never by telemetry arrival.
      return { stored: false, reason: "unknown server" };
    }

    const now = Date.now();

    // ---- health signals, handled before the telemetry write path ----
    if (a.kind === "status") {
      const connected = a.payload?.state === "connected";
      // The gateway reports the leaf certificate's expiry. It is recorded as a
      // date only, so the UI can warn about expiry without the control plane
      // ever storing or exposing certificate material.
      const na = a.payload?.certNotAfterMs;
      const notAfter =
        typeof na === "number" && Number.isFinite(na) && na > 0 ? na : undefined;
      await ctx.db.patch(server._id, {
        gatewayState: connected ? "connected" : "disconnected",
        ...(notAfter ? { certNotAfter: notAfter } : {}),
      });
      await ctx.db.insert("agentHealthEvents", {
        serverPublicId: a.serverPublicId,
        at: now,
        kind: connected ? "connect" : "disconnect",
        agentVersion: str(a.payload?.agentVersion),
        protocolVersion: str(a.payload?.protocolVersion),
      });
      return { stored: true, kind: "status" };
    }

    if (a.kind === "error") {
      // Only a sanitised class is accepted. A raw message, path, or stack trace
      // is discarded at the boundary rather than trusted and trimmed.
      const cls = sanitiseErrorClass(a.payload?.errorClass);
      await ctx.db.patch(server._id, {
        agentErrorCount: (server.agentErrorCount ?? 0) + 1,
        lastErrorClass: cls,
      });
      await ctx.db.insert("agentHealthEvents", {
        serverPublicId: a.serverPublicId,
        at: now,
        kind: "error",
        errorClass: cls,
        agentVersion: str(a.payload?.agentVersion),
        protocolVersion: str(a.payload?.protocolVersion),
      });
      return { stored: true, kind: "error" };
    }

    // ---- telemetry: a successful write clears the current error streak ----
    // Liveness. A host is never presented as active merely because a row exists.
    await ctx.db.patch(server._id, {
      inventorySource: "agent",
      agentStatus: "enrolled",
      lastHeartbeatAt: now,
      lastObservedAt: a.observedAtMs || now,
      lastSuccessfulTelemetryAt: now,
      agentErrorCount: 0,
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

/**
 * Fleet view with derived agent health.
 *
 * Three states, and the distinction between them is the whole point:
 *
 *   OFFLINE   — no heartbeat inside the offline threshold. The host is not
 *               talking to the gateway at all.
 *   DEGRADED  — the heartbeat is fresh, so the host IS talking, but telemetry
 *               is stale or errors have been recorded. Something between the
 *               host and Convex is failing: the helper, the agent, or ingest.
 *   ONLINE    — heartbeat fresh AND telemetry flowing.
 *
 * A host is never reported healthy merely because a row exists.
 *
 * Security: this view deliberately omits the certificate fingerprint and
 * serial. Only the expiry is exposed, so the UI can warn without ever
 * receiving certificate material. Error detail is limited to a class.
 */
export const listAgentStatus = query({
  args: {},
  handler: async (ctx) => {
    await requireOwner(ctx);
    const servers = await ctx.db.query("servers").collect();
    const now = Date.now();

    return servers.map((s) => {
      const enrolled = s.agentStatus === "enrolled";
      const hb = s.lastHeartbeatAt ?? 0;
      const hbAge = hb > 0 ? now - hb : null;
      const tel = s.lastSuccessfulTelemetryAt ?? 0;
      const telAge = tel > 0 ? now - tel : null;
      const gatewayState = s.gatewayState ?? null;
      const errCount = s.agentErrorCount ?? 0;

      let state: "ONLINE" | "DEGRADED" | "OFFLINE";
      if (!enrolled) {
        state = "OFFLINE";
      } else if (hbAge === null || hbAge > OFFLINE_AFTER_MS) {
        state = "OFFLINE";
      } else if (
        gatewayState === "disconnected" ||
        telAge === null ||
        telAge > TELEMETRY_STALE_MS ||
        errCount > 0
      ) {
        state = "DEGRADED";
      } else {
        state = "ONLINE";
      }

      const certNotAfter = s.certNotAfter ?? null;
      const certDays = certNotAfter
        ? Math.floor((certNotAfter - now) / 86_400_000)
        : null;
      const certExpired = certNotAfter !== null && certNotAfter <= now;

      return {
        serverPublicId: s.publicId,
        displayName: s.displayName,
        hostname: s.hostname,
        enrolled,
        state,
        lastHeartbeatAt: hb || null,
        lastHeartbeatAgeMs: hbAge,
        lastSuccessfulTelemetryAt: tel || null,
        telemetryAgeMs: telAge,
        agentErrorCount: errCount,
        lastErrorClass: s.lastErrorClass ?? null,
        gatewayState,
        certNotAfter,
        certDaysRemaining: certDays,
        certExpiringSoon:
          certDays !== null && !certExpired && certDays <= CERT_WARN_DAYS,
        certExpired,
        // Live figures are only meaningful while the agent is actually
        // reporting. For an OFFLINE or DEGRADED host the caller must label any
        // figure as stale rather than current.
        inventorySource: s.inventorySource ?? "demo",
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
 * Records the expiry of an agent certificate.
 *
 * Expiry is a property of the certificate the control plane issued, so it is
 * recorded here rather than reported by the agent. That keeps the warning
 * feature free of any change to the agent, the helper, or the gateway protocol.
 *
 * Requires the Owner. Only an epoch is accepted; no certificate material is
 * stored, and none is ever returned to the UI.
 */
export const recordCertificateExpiry = mutation({
  args: {
    serverPublicId: v.string(),
    notAfterMs: v.number(),
  },
  handler: async (ctx, a) => {
    await requireOwner(ctx);
    if (!Number.isFinite(a.notAfterMs) || a.notAfterMs <= 0) {
      throw new Error("notAfterMs must be a positive epoch in milliseconds");
    }
    const server = await ctx.db
      .query("servers")
      .withIndex("by_public_id", (q) => q.eq("publicId", a.serverPublicId))
      .first();
    if (!server) throw new Error("unknown server");
    await ctx.db.patch(server._id, { certNotAfter: a.notAfterMs });
    await ctx.db.insert("agentHealthEvents", {
      serverPublicId: a.serverPublicId,
      at: Date.now(),
      kind: "cert_recorded",
    });
    return { recorded: true, serverPublicId: a.serverPublicId };
  },
});

/**
 * Recent agent health events, for the server detail page.
 *
 * Sanitised by construction: only a class, never a message. Requires the Owner.
 */
export const listHealthEvents = query({
  args: { serverPublicId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, a) => {
    await requireOwner(ctx);
    const n = Math.min(a.limit ?? 20, 50);
    return ctx.db
      .query("agentHealthEvents")
      .withIndex("by_server", (q) => q.eq("serverPublicId", a.serverPublicId))
      .order("desc")
      .take(n);
  },
});

/**
 * Latest host telemetry for every managed host, for the Fleet view.
 *
 * One row per server, chosen as the most recent observation of that kind. A
 * host with no agent simply has no row, which is how the UI tells "not
 * enrolled" apart from "enrolled but silent".
 */
export const allLiveHostTelemetry = query({
  args: {},
  handler: async (ctx) => {
    await requireOwner(ctx);
    // by_server_kind is [serverPublicId, kind], so kind cannot be a leading
    // filter. The most recent row per kind is taken in memory instead.
    const rows = (await ctx.db
      .query("agentTelemetry")
      .collect())
      .filter((r) => r.kind === "host")
      .sort((a, b) => b.observedAtMs - a.observedAtMs);

    const seen = new Set<string>();
    const out: Doc<"agentTelemetry">[] = [];
    for (const r of rows) {
      if (seen.has(r.serverPublicId)) continue;
      seen.add(r.serverPublicId);
      out.push(r);
    }
    return out;
  },
});

/** Latest Docker telemetry for every managed host, same shape as above. */
export const allLiveDockerTelemetry = query({
  args: {},
  handler: async (ctx) => {
    await requireOwner(ctx);
    // by_server_kind is [serverPublicId, kind], so kind cannot be a leading
    // filter. The most recent row per kind is taken in memory instead.
    const rows = (await ctx.db
      .query("agentTelemetry")
      .collect())
      .filter((r) => r.kind === "docker")
      .sort((a, b) => b.observedAtMs - a.observedAtMs);

    const seen = new Set<string>();
    const out: Doc<"agentTelemetry">[] = [];
    for (const r of rows) {
      if (seen.has(r.serverPublicId)) continue;
      seen.add(r.serverPublicId);
      out.push(r);
    }
    return out;
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
    const serverRows = await ctx.db
      .query("servers")
      .withIndex("by_public_id", (q) => q.eq("publicId", a.serverPublicId))
      .collect();
    if (serverRows.length > 1) {
      throw new Error(
        `Identity integrity violation: ${serverRows.length} server documents share publicId "${a.serverPublicId}".`,
      );
    }
    const server = serverRows[0];
    if (!server) throw new Error("unknown server");
    await ctx.db.patch(server._id, {
      agentStatus: "revoked",
      certRevokedAt: Date.now(),
    });
    return { revoked: true, serverPublicId: a.serverPublicId };
  },
});
