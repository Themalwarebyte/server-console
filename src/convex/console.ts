import { query, mutation, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function hash(input: string): string {
  // Deterministic 64-bit-ish rolling digest rendered as hex. Enough to make
  // casual tampering visible in this demo; a real control plane would use
  // SHA-256 over the canonical envelope.
  let h1 = 0xdeadbeef ^ input.length;
  let h2 = 0x41c6ce57 ^ input.length;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  const hex = (
    (h1 >>> 0).toString(16).padStart(8, "0") +
    (h2 >>> 0).toString(16).padStart(8, "0") +
    (h1 ^ h2 >>> 0).toString(16).padStart(8, "0") +
    ((h1 + h2) >>> 0).toString(16).padStart(8, "0")
  );
  return `sha3:${hex}`;
}

function ref(prefix: string): string {
  const rand = crypto.getRandomValues(new Uint8Array(8));
  const tail = Array.from(rand)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${prefix}_${tail.slice(0, 12)}`;
}

function hexTag(seed: string, len: number): string {
  const digest = hash(seed).replace("sha3:", "");
  return digest.slice(0, len);
}

const GENESIS = "sha3:genesis";

async function appendAudit(
  ctx: MutationCtx,
  event: {
    correlationId: string;
    taskRef?: string;
    actor: string;
    serverPublicId?: string;
    capability?: string;
    kind: string;
    summary: string;
    riskClass?: string;
  },
) {
  const last = await ctx.db.query("auditEvents").order("desc").first();
  let prevHash = GENESIS;
  let prevSeq = 0;
  if (last) {
    prevHash = last.hash;
    prevSeq = last.seq;
  }

  const ts = Date.now();
  const hashInput = `${prevSeq + 1}|${ts}|${event.kind}|${event.actor}|${
    event.serverPublicId ?? ""
  }|${event.capability ?? ""}|${event.summary}|${prevHash}`;
  const eventHash = hash(hashInput);

  await ctx.db.insert("auditEvents", {
    seq: prevSeq + 1,
    ts,
    correlationId: event.correlationId,
    taskRef: event.taskRef,
    actor: event.actor,
    serverPublicId: event.serverPublicId,
    capability: event.capability,
    kind: event.kind,
    summary: event.summary,
    riskClass: event.riskClass,
    prevHash,
    hash: eventHash,
  });
}

async function requireUser(ctx: MutationCtx) {
  const userId = await getAuthUserId(ctx);
  if (userId === null) throw new Error("Unauthenticated");
  return userId;
}

/* ------------------------------------------------------------------ */
/* seed                                                                */
/* ------------------------------------------------------------------ */

const CAPS_S1 = [
  { code: "system.inventory", version: "v1", riskClass: "R0", supported: true, locallyEnabled: true },
  { code: "system.health", version: "v1", riskClass: "R0", supported: true, locallyEnabled: true },
  { code: "docker.inventory", version: "v1", riskClass: "R0", supported: true, locallyEnabled: true },
  { code: "docker.logs", version: "v1", riskClass: "R0", supported: true, locallyEnabled: true },
  { code: "docker.container.restart", version: "v1", riskClass: "R1", supported: true, locallyEnabled: true },
  { code: "firewall.communication-policy", version: "v1", riskClass: "R3", supported: true, locallyEnabled: true },
  { code: "package.install", version: "v1", riskClass: "R3", supported: true, locallyEnabled: false },
  { code: "volume.delete", version: "v1", riskClass: "R4", supported: false, locallyEnabled: false },
];

const CAPS_S2 = [
  { code: "system.inventory", version: "v1", riskClass: "R0", supported: true, locallyEnabled: true },
  { code: "system.health", version: "v1", riskClass: "R0", supported: true, locallyEnabled: true },
  { code: "docker.inventory", version: "v1", riskClass: "R0", supported: true, locallyEnabled: true },
  { code: "docker.logs", version: "v1", riskClass: "R0", supported: true, locallyEnabled: true },
  { code: "docker.container.restart", version: "v1", riskClass: "R1", supported: true, locallyEnabled: true },
  { code: "firewall.communication-policy", version: "v1", riskClass: "R3", supported: true, locallyEnabled: true },
  { code: "ssh.modify", version: "v1", riskClass: "R3", supported: true, locallyEnabled: false },
];

const CONTAINERS_S1 = [
  { name: "api-gateway", image: "ghcr.io/example/api-gateway:1.42.0", project: "platform", state: "running", health: "healthy", cpu: 12.4, mem: 31.2, restarts: 0, ports: ["443/tcp", "80/tcp"], logs: ["[api] listening on :8080", "[api] upstream pool ready (2 backends)", "[api] GET /healthz 200 2ms", "[api] TLS handshake ok (tls1.3)"] },
  { name: "postgres-primary", image: "postgres:17.2-alpine", project: "platform", state: "running", health: "healthy", cpu: 8.1, mem: 52.7, restarts: 1, ports: ["5432/tcp"], logs: ["database system is ready to accept connections", "checkpoint starting: time", "autovacuum launcher started"] },
  { name: "redis-cache", image: "redis:7.4-alpine", project: "platform", state: "running", health: "healthy", cpu: 2.2, mem: 9.4, restarts: 0, ports: ["6379/tcp"], logs: ["Ready to accept connections tcp", "Background saving started by pid 42"] },
  { name: "media-organizer", image: "ghcr.io/example/media:0.9.3", project: "media", state: "running", health: "starting", cpu: 21.7, mem: 44.9, restarts: 2, ports: ["9090/tcp"], logs: ["scanning library (24,812 items)", "metadata refresh queued", "transcode worker: idle"] },
  { name: "metrics-agent", image: "ghcr.io/example/otel-collector:0.112", project: "observability", state: "running", health: "healthy", cpu: 3.5, mem: 12.1, restarts: 0, ports: ["4317/tcp", "8888/tcp"], logs: ["collector started, pipeline: metrics|logs", "exporter: remote-write ok"] },
  { name: "legacy-cron", image: "ghcr.io/example/cron:2.1", project: "utilities", state: "exited", health: "unknown", cpu: 0, mem: 0, restarts: 0, ports: [], logs: ["job completed, sleeping", "container stopped by schedule"] },
];

const CONTAINERS_S2 = [
  { name: "edge-proxy", image: "ghcr.io/example/caddy:2.8", project: "edge", state: "running", health: "healthy", cpu: 6.8, mem: 18.2, restarts: 0, ports: ["443/tcp", "80/tcp"], logs: ["serving initial configuration", "certificate obtained: edge.internal"] },
  { name: "app-frontend", image: "ghcr.io/example/web:3.7.1", project: "webapp", state: "running", health: "healthy", cpu: 4.1, mem: 22.6, restarts: 0, ports: ["3000/tcp"], logs: ["vite build served from /dist", "GET / 200 12ms"] },
  { name: "app-api", image: "ghcr.io/example/web-api:3.7.1", project: "webapp", state: "running", health: "healthy", cpu: 9.6, mem: 37.3, restarts: 0, ports: ["4000/tcp"], logs: ["server started", "db pool: 4/10 in use"] },
  { name: "worker-queue", image: "ghcr.io/example/worker:1.15.0", project: "webapp", state: "restarting", health: "unhealthy", cpu: 0.4, mem: 5.2, restarts: 6, ports: [], logs: ["worker crashed: OOM (killed)", "restart scheduled with backoff"] },
  { name: "backup-runner", image: "ghcr.io/example/restic:0.17", project: "backup", state: "running", health: "healthy", cpu: 1.9, mem: 8.8, restarts: 0, ports: [], logs: ["snapshot 4f2a saved (18.2 GiB)", "prune: ok"] },
];

export const seed = mutation({
  args: {},
  handler: async (ctx) => {
    await requireUser(ctx);
    const existing = await ctx.db.query("servers").first();
    if (existing) return;

    const now = Date.now();
    const H = 60 * 60 * 1000;
    const D = 24 * H;

    await ctx.db.insert("servers", {
      publicId: "srv_7f3a91c2e8",
      displayName: "SERVER-01",
      hostname: "server-01.lan",
      lifecycleState: "ACTIVE",
      environment: "production",
      region: "rack-a / 10.0.20.11",
      tailscaleName: "server-01.tailnet.ts.net.",
      os: { name: "Debian 12 (bookworm)", kernel: "6.1.0-31-amd64", arch: "x86_64" },
      hardware: { cores: 8, memoryGb: 32, diskGb: 1024, diskUsedGb: 412 },
      cpuLoad: 0.42,
      memUsedPct: 47.8,
      docker: { version: "28.3.2", running: 5, total: 6, healthy: true },
      agent: {
        version: "0.9.4",
        protocolVersion: "v1",
        connected: true,
        lastSeenAt: now - 14_000,
        bootId: "b7e1f0a2",
      },
      identity: {
        fingerprint: "SHA256:9c1f:44ab:d02e:7b31:5f8c:e6a9:120d:8b74",
        certSerial: "2a:4f:19:c8",
        issuedAt: now - 32 * D,
        certExpiresAt: now + 12 * D,
      },
      capabilities: CAPS_S1,
      enrolledAt: now - 32 * D,
      note: "Primary workloads. Not a failover target.",
    });

    await ctx.db.insert("servers", {
      publicId: "srv_2b6e40af15",
      displayName: "SERVER-02",
      hostname: "server-02.lan",
      lifecycleState: "ACTIVE",
      environment: "production",
      region: "rack-b / 10.0.20.12",
      tailscaleName: "server-02.tailnet.ts.net.",
      os: { name: "Ubuntu 24.04 LTS", kernel: "6.8.0-49-generic", arch: "x86_64" },
      hardware: { cores: 4, memoryGb: 16, diskGb: 512, diskUsedGb: 188 },
      cpuLoad: 0.31,
      memUsedPct: 62.4,
      docker: { version: "27.5.1", running: 4, total: 5, healthy: false },
      agent: {
        version: "0.9.4",
        protocolVersion: "v1",
        connected: true,
        lastSeenAt: now - 9_000,
        bootId: "c3d9821e",
      },
      identity: {
        fingerprint: "SHA256:3d7e:b104:6c9f:82a3:ee51:07bc:d446:91f2",
        certSerial: "2a:4f:19:c9",
        issuedAt: now - 30 * D,
        certExpiresAt: now + 14 * D,
      },
      capabilities: CAPS_S2,
      enrolledAt: now - 30 * D,
      note: "Independent infrastructure. Own recovery path.",
    });

    for (const c of CONTAINERS_S1) {
      await ctx.db.insert("containers", {
        serverPublicId: "srv_7f3a91c2e8",
        dockerId: `a1${hexTag(c.name, 10)}`,
        name: c.name,
        image: c.image,
        project: c.project,
        state: c.state,
        health: c.health,
        cpuPct: c.cpu,
        memPct: c.mem,
        restarts: c.restarts,
        ports: c.ports,
        startedAt: now - 6 * D,
        logs: c.logs,
      });
    }
    for (const c of CONTAINERS_S2) {
      await ctx.db.insert("containers", {
        serverPublicId: "srv_2b6e40af15",
        dockerId: `b2${hexTag(c.name, 10)}`,
        name: c.name,
        image: c.image,
        project: c.project,
        state: c.state,
        health: c.health,
        cpuPct: c.cpu,
        memPct: c.mem,
        restarts: c.restarts,
        ports: c.ports,
        startedAt: now - 4 * D,
        logs: c.logs,
      });
    }

    // Communication rules: one verified active edge, one pending approval.
    await ctx.db.insert("commRules", {
      ruleRef: "rule_c81e4d20",
      name: "Webapp API consumes platform gateway",
      sourceServer: "srv_2b6e40af15",
      sourceProject: "webapp",
      destServer: "srv_7f3a91c2e8",
      destService: "api-gateway",
      proto: "tcp",
      port: 443,
      path: "tailscale0",
      status: "ACTIVE",
      permanence: "PERMANENT",
      verification: "VERIFIED",
      lastVerifiedAt: now - 2 * H,
      createdBy: "Owner",
      approvedBy: "Owner",
      note: "webapp app-api calls platform api-gateway over HTTPS.",
    });
    await ctx.db.insert("commRules", {
      ruleRef: "rule_9d72ba53",
      name: "Metrics scrape path (temporary)",
      sourceServer: "srv_7f3a91c2e8",
      sourceProject: "observability",
      destServer: "srv_2b6e40af15",
      destService: "app-api",
      proto: "tcp",
      port: 9100,
      path: "tailscale0",
      status: "PENDING_APPROVAL",
      permanence: "TEMPORARY",
      expiresAt: now + 6 * H,
      verification: "PENDING",
      createdBy: "Owner",
      note: "Time-boxed scrape during migration; expires on the host.",
    });

    // Historical audit trail, chained.
    const events: Array<[string, string, string, string | undefined, string | undefined]> = [
      ["ENROLLMENT", "Owner", "SERVER-01 identity issued; fingerprint verified out-of-band.", "srv_7f3a91c2e8", undefined],
      ["ENROLLMENT", "Owner", "SERVER-02 identity issued; invitation consumed, server is ACTIVE.", "srv_2b6e40af15", undefined],
      ["APPROVAL", "Owner", "Approved restart of media-organizer after library scan hang.", "srv_7f3a91c2e8", "docker.container.restart"],
      ["COMPLETION", "mgmt-agent/SERVER-01", "Container media-organizer restarted; verification passed.", "srv_7f3a91c2e8", "docker.container.restart"],
      ["APPROVAL", "Owner", "Approved communication rule rule_c81e4d20 after impact preview.", undefined, "firewall.communication-policy"],
      ["VERIFICATION", "mgmt-agent/SERVER-01", "Positive and negative connectivity tests passed for rule_c81e4d20.", "srv_7f3a91c2e8", "firewall.communication-policy"],
      ["REJECTION", "mgmt-helper/SERVER-02", "Replayed task rejected: nonce already present in execution ledger.", "srv_2b6e40af15", "docker.container.restart"],
    ];
    let prevHash = GENESIS;
    for (let i = 0; i < events.length; i++) {
      const [kind, actor, summary, server, capability] = events[i];
      const ts = now - (events.length - i) * 37 * 60 * 1000;
      const hashInput = `${i + 1}|${ts}|${kind}|${actor}|${server ?? ""}|${capability ?? ""}|${summary}|${prevHash}`;
      const eventHash = hash(hashInput);
      await ctx.db.insert("auditEvents", {
        seq: i + 1,
        ts,
        correlationId: ref("corr"),
        actor,
        serverPublicId: server,
        capability,
        kind,
        summary,
        prevHash,
        hash: eventHash,
      });
      prevHash = eventHash;
    }
  },
});

/* ------------------------------------------------------------------ */
/* queries                                                             */
/* ------------------------------------------------------------------ */

export const listServers = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("servers").order("asc").collect();
    return rows.sort((a, b) => a.displayName.localeCompare(b.displayName));
  },
});

export const getServer = query({
  args: { publicId: v.string() },
  handler: async (ctx, { publicId }) => {
    const all = await ctx.db
      .query("servers")
      .withIndex("by_public_id", (q) => q.eq("publicId", publicId))
      .collect();
    return all[0] ?? null;
  },
});

export const listContainers = query({
  args: { serverPublicId: v.string() },
  handler: async (ctx, { serverPublicId }) => {
    const rows = await ctx.db
      .query("containers")
      .withIndex("by_server", (q) => q.eq("serverPublicId", serverPublicId))
      .collect();
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  },
});

export const listTasks = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("tasks").order("desc").collect();
    return rows.slice(0, 100);
  },
});

export const listAudit = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("auditEvents").order("desc").collect();
    return rows.slice(0, 200);
  },
});

export const listCommRules = query({
  args: {},
  handler: async (ctx) => ctx.db.query("commRules").order("desc").collect(),
});

export const listEnrollments = query({
  args: {},
  handler: async (ctx) => ctx.db.query("enrollments").order("desc").collect(),
});

export const isSeeded = query({
  args: {},
  handler: async (ctx) => (await ctx.db.query("servers").first()) !== null,
});

/* ------------------------------------------------------------------ */
/* actions (mutations)                                                 */
/* ------------------------------------------------------------------ */

export const restartContainer = mutation({
  args: { containerId: v.id("containers") },
  handler: async (ctx, { containerId }) => {
    await requireUser(ctx);
    const container = await ctx.db.get(containerId);
    if (!container) throw new Error("Container not found");
    const serverRows = await ctx.db
      .query("servers")
      .withIndex("by_public_id", (q) => q.eq("publicId", container.serverPublicId))
      .collect();
    const server = serverRows[0];
    if (!server) throw new Error("Server not found");

    const cap = server.capabilities.find(
      (c) => c.code === "docker.container.restart",
    );
    if (!cap || !cap.supported || !cap.locallyEnabled) {
      throw new Error(
        "Capability docker.container.restart is not enabled on this server's local policy.",
      );
    }

    const taskRef = ref("task");
    const nonce = ref("nonce");
    const correlationId = ref("corr");
    const envelope = `${taskRef}|${server.publicId}|docker.container.restart|${container.name}|${nonce}`;
    const envelopeHash = hash(envelope);
    const now = Date.now();

    await ctx.db.insert("tasks", {
      taskRef,
      serverPublicId: server.publicId,
      capability: "docker.container.restart",
      containerName: container.name,
      riskClass: "R1",
      state: "SUCCEEDED",
      reason: "Operator-initiated restart from console",
      requestedBy: "Owner",
      approver: "Owner",
      nonce,
      envelopeHash,
      signedBy: "signer@control-plane",
      controlEpoch: 1,
      expiresAt: now + 5 * 60 * 1000,
      resultNote: "Executed by helper; container healthy after restart.",
    });

    await ctx.db.patch(containerId, {
      state: "running",
      health: "healthy",
      restarts: container.restarts + 1,
    });

    await appendAudit(ctx, {
      correlationId,
      taskRef,
      actor: "Owner",
      serverPublicId: server.publicId,
      capability: "docker.container.restart",
      kind: "COMPLETION",
      summary: `Restarted container ${container.name} on ${server.displayName}; envelope signed and verified.`,
      riskClass: "R1",
    });

    return { taskRef, envelopeHash };
  },
});

export const requestCommRule = mutation({
  args: {
    name: v.string(),
    sourceServer: v.string(),
    sourceProject: v.string(),
    destServer: v.string(),
    destService: v.string(),
    proto: v.string(),
    port: v.number(),
    path: v.string(),
    permanence: v.string(),
    note: v.string(),
  },
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const ruleRef = ref("rule");
    await ctx.db.insert("commRules", {
      ruleRef,
      name: args.name,
      sourceServer: args.sourceServer,
      sourceProject: args.sourceProject,
      destServer: args.destServer,
      destService: args.destService,
      proto: args.proto,
      port: args.port,
      path: args.path,
      status: "PENDING_APPROVAL",
      permanence: args.permanence,
      expiresAt:
        args.permanence === "TEMPORARY" ? Date.now() + 6 * 60 * 60 * 1000 : undefined,
      verification: "PENDING",
      createdBy: "Owner",
      note: args.note,
    });
    await appendAudit(ctx, {
      correlationId: ref("corr"),
      taskRef: ruleRef,
      actor: "Owner",
      serverPublicId: args.destServer,
      capability: "firewall.communication-policy",
      kind: "REQUEST",
      summary: `Requested communication rule "${args.name}" (${args.proto}/${args.port}, ${args.path}); awaiting Owner approval.`,
      riskClass: "R3",
    });
    return { ruleRef };
  },
});

export const approveCommRule = mutation({
  args: { ruleId: v.id("commRules") },
  handler: async (ctx, { ruleId }) => {
    await requireUser(ctx);
    const rule = await ctx.db.get(ruleId);
    if (!rule) throw new Error("Rule not found");
    if (rule.status !== "PENDING_APPROVAL") {
      throw new Error("Only pending rules can be approved.");
    }
    await ctx.db.patch(ruleId, {
      status: "ACTIVE",
      approvedBy: "Owner",
      verification: "VERIFIED",
      lastVerifiedAt: Date.now(),
    });
    await appendAudit(ctx, {
      correlationId: ref("corr"),
      taskRef: rule.ruleRef,
      actor: "Owner",
      serverPublicId: rule.destServer,
      capability: "firewall.communication-policy",
      kind: "APPROVAL",
      summary: `Approved and applied rule "${rule.name}"; positive and negative connectivity tests passed.`,
      riskClass: "R3",
    });
  },
});

export const revokeCommRule = mutation({
  args: { ruleId: v.id("commRules") },
  handler: async (ctx, { ruleId }) => {
    await requireUser(ctx);
    const rule = await ctx.db.get(ruleId);
    if (!rule) throw new Error("Rule not found");
    await ctx.db.patch(ruleId, { status: "REVOKED", verification: "VERIFIED", lastVerifiedAt: Date.now() });
    await appendAudit(ctx, {
      correlationId: ref("corr"),
      taskRef: rule.ruleRef,
      actor: "Owner",
      serverPublicId: rule.destServer,
      capability: "firewall.communication-policy",
      kind: "COMPLETION",
      summary: `Revoked rule "${rule.name}"; host firewall artifacts removed and verified.`,
      riskClass: "R3",
    });
  },
});

export const createEnrollmentInvite = mutation({
  args: { hostLabel: v.string() },
  handler: async (ctx, { hostLabel }) => {
    await requireUser(ctx);
    const inviteRef = ref("inv");
    const csrFingerprint = `SHA256:${Array.from(crypto.getRandomValues(new Uint8Array(8)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(":")}`;
    await ctx.db.insert("enrollments", {
      inviteRef,
      hostLabel,
      hostname: `${hostLabel.toLowerCase().replace(/\s+/g, "-")}.lan`,
      status: "AWAITING_APPROVAL",
      csrFingerprint,
      agentVersion: "0.9.4",
      createdAt: Date.now(),
      expiresAt: Date.now() + 60 * 60 * 1000,
      note: "Fingerprint must be compared against the local agent output before approval.",
    });
    await appendAudit(ctx, {
      correlationId: ref("corr"),
      actor: "Owner",
      kind: "ENROLLMENT",
      summary: `Enrollment invitation issued for "${hostLabel}"; awaiting fingerprint verification.`,
    });
    return { inviteRef, csrFingerprint };
  },
});

export const approveEnrollment = mutation({
  args: { enrollmentId: v.id("enrollments") },
  handler: async (ctx, { enrollmentId }) => {
    await requireUser(ctx);
    const enrollment = await ctx.db.get(enrollmentId);
    if (!enrollment) throw new Error("Enrollment not found");
    if (enrollment.status !== "AWAITING_APPROVAL") {
      throw new Error("This invitation is no longer pending.");
    }
    await ctx.db.patch(enrollmentId, { status: "APPROVED", note: "Certificate issued; invitation consumed." });
    await appendAudit(ctx, {
      correlationId: ref("corr"),
      actor: "Owner",
      kind: "ENROLLMENT",
      summary: `Enrollment approved for "${enrollment.hostLabel}"; server-specific certificate issued.`,
    });
  },
});

export const rejectEnrollment = mutation({
  args: { enrollmentId: v.id("enrollments") },
  handler: async (ctx, { enrollmentId }) => {
    await requireUser(ctx);
    const enrollment = await ctx.db.get(enrollmentId);
    if (!enrollment) throw new Error("Enrollment not found");
    await ctx.db.patch(enrollmentId, { status: "REJECTED", note: "Invitation rejected and consumed." });
    await appendAudit(ctx, {
      correlationId: ref("corr"),
      actor: "Owner",
      kind: "ENROLLMENT",
      summary: `Enrollment rejected for "${enrollment.hostLabel}"; invitation consumed.`,
    });
  },
});

export const simulateReplayAttempt = mutation({
  args: {},
  handler: async (ctx) => {
    await requireUser(ctx);
    const all = await ctx.db.query("tasks").order("desc").collect();
    const target = all[0];
    if (!target) throw new Error("No tasks to replay.");
    await ctx.db.patch(target._id, { replayAttempted: true });
    await appendAudit(ctx, {
      correlationId: ref("corr"),
      taskRef: target.taskRef,
      actor: "mgmt-helper/SERVER-02",
      serverPublicId: target.serverPublicId,
      capability: target.capability,
      kind: "REJECTION",
      summary: `Replayed task ${target.taskRef} rejected: nonce already present in the execution ledger.`,
    });
  },
});

export const runRecoveryDrill = mutation({
  args: {},
  handler: async (ctx) => {
    await requireUser(ctx);
    await appendAudit(ctx, {
      correlationId: ref("corr"),
      actor: "Owner",
      kind: "SYSTEM",
      summary:
        "Recovery drill recorded: control plane offline, workloads verified independent, epoch advanced to 2; pre-restoration tasks cancelled.",
    });
  },
});

export const listAuditForServer = query({
  args: { serverPublicId: v.string() },
  handler: async (ctx, { serverPublicId }) => {
    const rows = await ctx.db.query("auditEvents").order("desc").collect();
    return rows.filter((e) => e.serverPublicId === serverPublicId).slice(0, 20);
  },
});

export const refreshInventory = mutation({
  args: {},
  handler: async (ctx) => {
    await requireUser(ctx);
    const servers = await ctx.db.query("servers").collect();
    const now = Date.now();
    for (const s of servers) {
      await ctx.db.patch(s._id, {
        cpuLoad: Math.max(0.05, Math.min(0.95, s.cpuLoad + (Math.random() - 0.5) * 0.08)),
        memUsedPct: Math.max(15, Math.min(90, s.memUsedPct + (Math.random() - 0.5) * 3)),
        agent: { ...s.agent, lastSeenAt: now },
      });
      const containers = await ctx.db
        .query("containers")
        .withIndex("by_server", (q) => q.eq("serverPublicId", s.publicId))
        .collect();
      for (const c of containers) {
        if (c.state === "running" || c.state === "restarting") {
          await ctx.db.patch(c._id, {
            cpuPct: Math.max(0.1, Math.min(95, c.cpuPct + (Math.random() - 0.5) * 4)),
            memPct: Math.max(2, Math.min(90, c.memPct + (Math.random() - 0.5) * 2)),
          });
        }
      }
    }
    await appendAudit(ctx, {
      correlationId: ref("corr"),
      actor: "Owner",
      kind: "REQUEST",
      summary: "Requested fresh inventory from all agents; heartbeats and metrics updated.",
    });
  },
});
