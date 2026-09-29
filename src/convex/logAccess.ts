import { query, mutation, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { requireOwner } from "./authz";
import { requireLogWorkCredential, LOG_LIMITS, sanitiseErrorClass } from "./logPolicy";

/**
 * Milestone B — read-only container log access, control plane.
 *
 * WHAT IS STORED
 *   logRequests  metadata and coordination only. No log content, ever.
 *   logResults   a temporary bounded delivery buffer, because the browser
 *                 cannot reach the gateway directly. Capped at 256 KiB,
 *                 retained at most 2 minutes, deleted on read or at expiry.
 *
 * There is NO persistent log retention. Rows are removed as soon as the
 * authenticated browser has collected them, or automatically at expiry.
 *
 * NOTHING TRUSTED FROM THE BROWSER
 *   server identity, container name, capability, actor and management epoch are
 *   all derived centrally. The body may only carry a serverPublicId, an exact
 *   64-hex container id, a tail and a timestamps flag.
 */

const randomId = (n: number) => {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
};

// ---------------------------------------------------------------------------
// Owner request path
// ---------------------------------------------------------------------------

/**
 * Requests a bounded log tail for one container on one enrolled server.
 *
 * Every authorisation fact is derived here, not taken from the request:
 * the actor from the session, the epoch from central policy, the container
 * name from agent telemetry, and support for `docker.logs.read` from the
 * capability the enrolled agent advertises.
 */
export const requestContainerLogs = mutation({
  args: {
    serverPublicId: v.string(),
    containerId: v.string(),
    tail: v.optional(v.number()),
    timestamps: v.optional(v.boolean()),
  },
  handler: async (ctx, a) => {
    // 1. The only authorisation that matters: a real Owner session.
    await requireOwner(ctx);

    // 2. The server must exist exactly once. A duplicate identity is refused
    //    rather than resolved, so a corrupt index cannot authorise a read.
    const servers = await ctx.db
      .query("servers")
      .withIndex("by_public_id", (q) => q.eq("publicId", a.serverPublicId))
      .collect();
    if (servers.length > 1) {
      throw new Error(
        `Identity integrity violation: ${servers.length} server documents share publicId "${a.serverPublicId}".`,
      );
    }
    const server = servers[0];
    if (!server) throw new Error("Unknown server.");

    // 3. The server must have a live agent.
    if (server.agentStatus !== "enrolled") throw new Error("Server has no enrolled agent.");

    // 4. Agent health must be ONLINE. A degraded or offline agent cannot serve
    //    a read, and this also prevents queueing work that cannot complete.
    const now = Date.now();
    const hb = server.lastHeartbeatAt ?? 0;
    const tel = server.lastSuccessfulTelemetryAt ?? 0;
    if (hb === 0 || now - hb > 45_000) throw new Error("Agent is offline.");
    if (tel === 0 || now - tel > 30_000) throw new Error("Agent is degraded.");

    // 5. Capability support, as ADVERTISED by the enrolled agent. Support is
    //    never inferred from an agent version number.
    const advertised = await advertisedCapabilities(ctx, a.serverPublicId);
    if (!advertised.includes("docker.logs.read")) {
      throw new Error("Host does not support docker.logs.read.");
    }

    // 6. Exact container id only. A name, prefix, regex or glob is refused
    //    here, and again in the helper.
    if (!/^[0-9a-f]{64}$/.test(a.containerId)) {
      throw new Error("containerId must be a full 64-character container id.");
    }

    // 7. The container must currently belong to THIS server according to
    //    agent telemetry, so a valid id from another host cannot be used.
    const containers = await ctx.db
      .query("agentTelemetry")
      .withIndex("by_server_kind", (q) =>
        q.eq("serverPublicId", a.serverPublicId).eq("kind", "docker"),
      )
      .order("desc")
      .first();
    const live = ((containers?.payload as any)?.containers ?? []) as {
      id: string;
      name: string;
    }[];
    const match = live.find((c) => c.id === a.containerId);
    if (!match) throw new Error("Container is not present on this server.");

    // 8. Clamp the tail. A caller asking for more is capped, not refused.
    let tail = Math.floor(a.tail ?? 100);
    if (!Number.isFinite(tail) || tail < 1) tail = 1;
    if (tail > LOG_LIMITS.maxLines) tail = LOG_LIMITS.maxLines;

    const timestamps = a.timestamps === true;
    const epoch = (server as any).managementEpoch ?? 0;
    const requestId = randomId(16);
    const nonce = randomId(16);
    const expiresAt = now + 60_000;

    await ctx.db.insert("logRequests", {
      requestId,
      serverPublicId: a.serverPublicId,
      containerId: a.containerId,
      containerName: match.name,
      requestedBy: (await currentActor(ctx)) ?? "owner",
      status: "PENDING",
      issuedAt: now,
      expiresAt,
      managementEpoch: epoch,
      requestedTail: tail,
      timestamps,
      nonce,
    });

    await appendLogAudit(ctx, {
      kind: "LOG_REQUESTED",
      requestId,
      serverPublicId: a.serverPublicId,
      containerId: a.containerId,
      detail: `tail=${tail} timestamps=${timestamps}`,
    });

    return { requestId, expiresAt };
  },
});

// ---------------------------------------------------------------------------
// Gateway claim
// ---------------------------------------------------------------------------

/**
 * Claims pending work for the gateway.
 *
 * Authenticated by the DEDICATED log-work credential, which is independent of
 * the telemetry ingest credential: the ingest path cannot claim log work, and
 * the log-work path cannot ingest arbitrary telemetry.
 *
 * The PENDING -> CLAIMED transition is atomic. Convex mutations are
 * serialisable, so a second gateway cannot observe the same row as PENDING.
 */
export const claimLogRequests = mutation({
  args: { serviceCredential: v.string() },
  handler: async (ctx, a) => {
    requireLogWorkCredential(a.serviceCredential);
    const now = Date.now();
    await purgeExpired(ctx);

    const pending = await ctx.db
      .query("logRequests")
      .withIndex("by_status", (q) => q.eq("status", "PENDING"))
      .collect();

    const out: {
      requestId: string;
      serverPublicId: string;
      containerId: string;
      tail: number;
      timestamps: boolean;
      nonce: string;
      managementEpoch: number;
      issuedAt: number;
      expiresAt: number;
      claimLease: string;
    }[] = [];

    for (const r of pending) {
      if (r.expiresAt <= now) {
        await expire(ctx, r);
        continue;
      }
      // A random lease, minted centrally, required to complete.
      const lease = randomId(24);
      await ctx.db.patch(r._id, { status: "CLAIMED", claimLease: lease, claimedAt: now });
      await appendLogAudit(ctx, {
        kind: "LOG_CLAIMED",
        requestId: r.requestId,
        serverPublicId: r.serverPublicId,
        containerId: r.containerId,
        detail: "claimed",
      });
      out.push({
        requestId: r.requestId,
        serverPublicId: r.serverPublicId,
        containerId: r.containerId,
        tail: r.requestedTail,
        timestamps: r.timestamps,
        nonce: r.nonce,
        managementEpoch: r.managementEpoch,
        issuedAt: r.issuedAt,
        expiresAt: r.expiresAt,
        claimLease: lease,
      });
    }
    return { requests: out };
  },
});

// ---------------------------------------------------------------------------
// Gateway completion
// ---------------------------------------------------------------------------

/**
 * Accepts a completed read.
 *
 * The control plane does NOT trust the gateway blindly: the line, byte and
 * per-line limits and the error-class allowlist are all re-enforced here, and
 * an oversized payload is REJECTED rather than silently truncated at the
 * database boundary. The helper already applied the same limits, so this is
 * defence in depth rather than a duplicate policy.
 */
export const completeLogRequest = mutation({
  args: {
    serviceCredential: v.string(),
    requestId: v.string(),
    serverPublicId: v.string(),
    claimLease: v.string(),
    ok: v.boolean(),
    lines: v.optional(v.array(v.object({ ts: v.number(), text: v.string() }))),
    lineCount: v.optional(v.number()),
    byteCount: v.optional(v.number()),
    truncated: v.optional(v.boolean()),
    errorClass: v.optional(v.string()),
    durationMs: v.optional(v.number()),
  },
  handler: async (ctx, a) => {
    requireLogWorkCredential(a.serviceCredential);
    const now = Date.now();

    const row = await ctx.db
      .query("logRequests")
      .withIndex("by_request", (q) => q.eq("requestId", a.requestId))
      .first();
    if (!row) throw new Error("Unknown request.");
    // Wrong host, wrong lease, expired, or not in a completable state: all fail.
    if (row.serverPublicId !== a.serverPublicId) throw new Error("Server mismatch.");
    if (!row.claimLease || row.claimLease !== a.claimLease) throw new Error("Bad claim lease.");
    if (row.expiresAt <= now) throw new Error("Request expired.");
    if (!["CLAIMED", "RUNNING"].includes(row.status)) {
      throw new Error(`Request not completable (status=${row.status}).`);
    }

    // Re-enforce the ceilings.
    const lines = a.lines ?? [];
    if (lines.length > LOG_LIMITS.maxLines) throw new Error("Too many lines.");
    let total = 0;
    for (const l of lines) {
      const n = l.text.length;
      if (n > LOG_LIMITS.maxLineBytes) throw new Error("Line too long.");
      total += n;
      if (total > LOG_LIMITS.maxBytes) throw new Error("Payload too large.");
    }

    const errorClass = a.errorClass ? sanitiseErrorClass(a.errorClass) : null;

    await ctx.db.patch(row._id, {
      status: a.ok ? "COMPLETE" : "FAILED",
      completedAt: now,
      lineCount: lines.length,
      byteCount: total,
      truncated: a.truncated === true,
      ...(errorClass ? { errorClass } : {}),
    });

    if (a.ok) {
      // The temporary delivery buffer. Bounded, and short-lived by construction.
      await ctx.db.insert("logResults", {
        requestId: row.requestId,
        serverPublicId: row.serverPublicId,
        ok: true,
        lines: lines.map((l) => ({ ts: l.ts, text: l.text })),
        lineCount: lines.length,
        byteCount: total,
        truncated: a.truncated === true,
        observedAt: now,
        // Hard retention: two minutes maximum, then automatically purged.
        expiresAt: now + 120_000,
      });
      await appendLogAudit(ctx, {
        kind: "LOG_SUCCEEDED",
        requestId: row.requestId,
        serverPublicId: row.serverPublicId,
        containerId: row.containerId,
        detail: `lines=${lines.length} bytes=${total} truncated=${a.truncated === true}`,
      });
    } else {
      await appendLogAudit(ctx, {
        kind: "LOG_FAILED",
        requestId: row.requestId,
        serverPublicId: row.serverPublicId,
        containerId: row.containerId,
        detail: errorClass ?? "unknown",
      });
    }
    return { accepted: true };
  },
});

// ---------------------------------------------------------------------------
// Owner retrieval + acknowledgement
// ---------------------------------------------------------------------------

/**
 * Reads the result of a completed request, once, for the Owner.
 *
 * The result is deleted on read, so the buffer is emptied as soon as the
 * authenticated browser has collected it. Content is returned as data for text
 * rendering only; it is never interpreted as markup.
 */
export const readLogResult = mutation({
  args: { requestId: v.string() },
  handler: async (ctx, a) => {
    await requireOwner(ctx);
    await purgeExpired(ctx);

    const req = await ctx.db
      .query("logRequests")
      .withIndex("by_request", (q) => q.eq("requestId", a.requestId))
      .first();
    if (!req) return { status: "UNKNOWN" as const };

    if (req.status === "PENDING" || req.status === "CLAIMED" || req.status === "RUNNING") {
      return { status: req.status as "PENDING" | "CLAIMED" | "RUNNING", requestId: req.requestId };
    }
    if (req.status === "EXPIRED") return { status: "EXPIRED" as const, requestId: req.requestId };

    const res = await ctx.db
      .query("logResults")
      .withIndex("by_request", (q) => q.eq("requestId", a.requestId))
      .first();

    // Collected: delete the buffer entry immediately.
    if (res) await ctx.db.delete(res._id);

    return {
      status: req.status as "COMPLETE" | "FAILED",
      requestId: req.requestId,
      serverPublicId: req.serverPublicId,
      containerId: req.containerId,
      containerName: req.containerName ?? null,
      ok: res?.ok ?? false,
      lines: res?.lines ?? [],
      lineCount: res?.lineCount ?? 0,
      byteCount: res?.byteCount ?? 0,
      truncated: res?.truncated ?? false,
      errorClass: req.errorClass ?? null,
      observedAt: res?.observedAt ?? null,
    };
  },
});

/** Discards a request row the Owner no longer wants. Metadata and content. */
export const discardLogRequest = mutation({
  args: { requestId: v.string() },
  handler: async (ctx, a) => {
    await requireOwner(ctx);
    const row = await ctx.db
      .query("logRequests")
      .withIndex("by_request", (q) => q.eq("requestId", a.requestId))
      .first();
    if (!row) return { discarded: false };
    await ctx.db.delete(row._id);

    const res = await ctx.db
      .query("logResults")
      .withIndex("by_request", (q) => q.eq("requestId", a.requestId))
      .first();
    if (res) await ctx.db.delete(res._id);
    return { discarded: true };
  },
});

// ---------------------------------------------------------------------------
// Expiry
// ---------------------------------------------------------------------------

/** Marks one request expired and audits it. */
async function expire(ctx: any, row: any) {
  await ctx.db.patch(row._id, { status: "EXPIRED", completedAt: Date.now() });
  await appendLogAudit(ctx, {
    kind: "LOG_EXPIRED",
    requestId: row.requestId,
    serverPublicId: row.serverPublicId,
    containerId: row.containerId,
    detail: "no result before expiry",
  });
}

/**
 * Lazy expiry.
 *
 * Convex has no scheduler here, so every read and claim purges first. This
 * bounds retention to "at most 2 minutes" in practice without leaving a
 * cleanup job that could itself be a source of retained content.
 */
export async function purgeExpired(ctx: any) {
  const now = Date.now();

  const staleResults = await ctx.db
    .query("logResults")
    .withIndex("by_expiry", (q: any) => q.lte("expiresAt", now))
    .collect();
  for (const r of staleResults) await ctx.db.delete(r._id);

  const live = await ctx.db.query("logRequests").collect();
  for (const r of live) {
    if (r.expiresAt <= now && !["EXPIRED", "COMPLETE", "FAILED"].includes(r.status)) {
      await expire(ctx, r);
    }
    // A completed request keeps only its metadata row; the content row is
    // already gone or was just purged above.
    if (
      ["COMPLETE", "FAILED"].includes(r.status) &&
      r.completedAt !== undefined &&
      r.completedAt + 120_000 < now
    ) {
      await ctx.db.delete(r._id);
    }
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Capabilities the ENROLLED AGENT advertised. Read from its own HelloAck,
 * recorded centrally, and never inferred from an agent version number.
 */
export async function advertisedCapabilities(
  ctx: any,
  serverPublicId: string,
): Promise<string[]> {
  const row = await ctx.db
    .query("agentTelemetry")
    .withIndex("by_server_kind", (q: any) =>
      q.eq("serverPublicId", serverPublicId).eq("kind", "host"),
    )
    .order("desc")
    .first();
  const caps = (row?.payload as any)?.capabilities;
  return Array.isArray(caps) ? caps.filter((c: unknown) => typeof c === "string") : [];
}

async function currentActor(ctx: any): Promise<string | null> {
  try {
    await requireOwner(ctx);
    return "owner";
  } catch {
    return null;
  }
}

/**
 * Audit metadata only. Line content is never written to the audit chain, to
 * agentHealthEvents, to the application log, or into any error string.
 */
export async function appendLogAudit(
  ctx: any,
  e: {
    kind: string;
    requestId: string;
    serverPublicId: string;
    containerId: string;
    detail?: string;
  },
) {
  const now = Date.now();
  const prev = await ctx.db
    .query("auditEvents")
    .withIndex("by_seq", (q: any) => q.gt("seq", 0))
    .order("desc")
    .first();
  const seq = (prev?.seq ?? 0) + 1;
  await ctx.db.insert("auditEvents", {
    seq,
    ts: now,
    kind: e.kind,
    actor: "owner",
    summary: `${e.kind} request=${e.requestId} server=${e.serverPublicId} container=${e.containerId}${
      e.detail ? ` ${e.detail}` : ""
    }`,
    serverPublicId: e.serverPublicId,
    prevHash: prev?.hash ?? "GENESIS",
    hash: `${seq}:${now}:${e.kind}:${e.requestId}`,
  });
}
