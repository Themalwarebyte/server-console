import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// default user roles. can add / remove based on the project as needed
export const ROLES = {
  ADMIN: "admin",
  USER: "user",
  MEMBER: "member",
} as const;

export const roleValidator = v.union(
  v.literal(ROLES.ADMIN),
  v.literal(ROLES.USER),
  v.literal(ROLES.MEMBER),
);

const capability = v.object({
  code: v.string(),
  version: v.string(),
  riskClass: v.string(),
  supported: v.boolean(),
  locallyEnabled: v.boolean(),
});

const schema = defineSchema(
  {
    // Authentication storage (users, sessions, accounts, JWKS) lives inside the
    // @convex-dev/better-auth component and is merged in by convex.config.ts.
    // The old @convex-dev/auth `authTables` are no longer used.

    /**
     * Servers: stable managed machines. Immutable `publicId` is the identity,
     * hostname is metadata only. A server never disappears from history —
     * retired machines keep their record and their audit trail.
     */
    servers: defineTable({
      publicId: v.string(),
      displayName: v.string(),
      hostname: v.string(),
      lifecycleState: v.string(), // ACTIVE | PENDING_ENROLLMENT | STALE | OFFLINE | QUARANTINED | RETIRED
      environment: v.string(),
      region: v.string(),
      tailscaleName: v.string(),

      // How this row's telemetry was obtained. The UI keys off this so a
      // snapshot is never presented as live telemetry.
      // "demo" | "operator_snapshot" | "agent"
      inventorySource: v.optional(v.string()),
      // Epoch ms of the observation. Absent means "not observed".
      lastObservedAt: v.optional(v.number()),
      // Epoch ms of the most recent agent heartbeat. Liveness is derived from
      // this, never from the mere existence of a row.
      lastHeartbeatAt: v.optional(v.number()),
      // Epoch ms of the last telemetry record the gateway actually ingested.
      // Deliberately distinct from the heartbeat: a host can be reachable while
      // its helper is failing, and that gap is what marks the host DEGRADED.
      lastSuccessfulTelemetryAt: v.optional(v.number()),
      // Errors observed since the last successful telemetry; reset on success.
      agentErrorCount: v.optional(v.number()),
      // Sanitised error CLASS only (helper_timeout, ingest_rejected). Never a
      // raw message, path, or stack trace.
      lastErrorClass: v.optional(v.string()),
      // Gateway-side view of the agent stream: connected | disconnected.
      gatewayState: v.optional(v.string()),
      // Certificate expiry, recorded by the control plane at enrollment rather
      // than reported by the agent, so surfacing it needs no protocol change.
      certNotAfter: v.optional(v.number()),
      // not_enrolled | enrolled | revoked
      agentStatus: v.optional(v.string()),
      // Identity of the agent certificate this host last presented.
      certFingerprint: v.optional(v.string()),
      certSerial: v.optional(v.string()),
      certRevokedAt: v.optional(v.number()),
      // Host uptime in seconds at the time of the snapshot.
      observedUptimeSeconds: v.optional(v.number()),
      os: v.object({ name: v.string(), kernel: v.string(), arch: v.string() }),
      hardware: v.object({
        cores: v.number(),
        memoryGb: v.number(),
        diskGb: v.number(),
        diskUsedGb: v.number(),
      }),
      cpuLoad: v.number(),
      memUsedPct: v.number(),
      docker: v.object({
        version: v.string(),
        running: v.number(),
        total: v.number(),
        healthy: v.boolean(),
        // Docker-reported counts. Absent means unknown, never assumed.
        stopped: v.optional(v.number()),
        unhealthy: v.optional(v.number()),
        composeVersion: v.optional(v.string()),
        daemonActive: v.optional(v.boolean()),
        rootDir: v.optional(v.string()),
        images: v.optional(v.number()),
      }),

      /**
       * Agent runtime facts. Optional because no agent is enrolled in V0.1 —
       * these MUST be absent rather than fabricated, and the UI renders
       * "Not enrolled" when they are.
       */
      agent: v.optional(
        v.object({
          version: v.string(),
          protocolVersion: v.string(),
          connected: v.boolean(),
          lastSeenAt: v.number(),
          bootId: v.string(),
        }),
      ),

      /**
       * mTLS identity issued to the agent. Optional for the same reason as
       * `agent`: absent means no certificate has been issued.
       */
      identity: v.optional(
        v.object({
          fingerprint: v.string(),
          certSerial: v.string(),
          issuedAt: v.number(),
          certExpiresAt: v.number(),
        }),
      ),
      capabilities: v.array(capability),
      enrolledAt: v.number(),
      note: v.optional(v.string()),
    }).index("by_public_id", ["publicId"]),

    /** Observed container inventory. Read-only mirror of runtime state. */
    containers: defineTable({
      serverPublicId: v.string(),
      dockerId: v.string(),
      name: v.string(),
      image: v.string(),
      project: v.string(),
      state: v.string(), // running | exited | paused | restarting | created | dead
      // Only meaningful when healthcheckPresent is true. A container with no
      // HEALTHCHECK must be shown as such, never as "healthy".
      health: v.optional(v.string()), // healthy | unhealthy | starting
      // Whether Docker reports a HEALTHCHECK for this container.
      healthcheckPresent: v.optional(v.boolean()),
      // Raw Docker status string, e.g. "Up 4 days (healthy)".
      dockerStatus: v.optional(v.string()),
      // Epoch ms of the observation this row came from.
      observedAt: v.optional(v.number()),
      cpuPct: v.optional(v.number()),
      memPct: v.optional(v.number()),
      restarts: v.optional(v.number()),
      ports: v.optional(v.array(v.string())),
      startedAt: v.optional(v.number()),
      logs: v.optional(v.array(v.string())),
    }).index("by_server", ["serverPublicId"]),

    /**
     * Tasks: requested operations. Every task carries the signed action
     * envelope fields the agent and helper verify before execution.
     */
    tasks: defineTable({
      taskRef: v.string(),
      serverPublicId: v.string(),
      capability: v.string(),
      containerName: v.optional(v.string()),
      riskClass: v.string(), // R1 | R2 | R3
      state: v.string(), // PENDING_APPROVAL | SUCCEEDED | FAILED | REJECTED | CANCELLED | EXPIRED
      reason: v.string(),
      requestedBy: v.string(),
      approver: v.optional(v.string()),
      nonce: v.string(),
      envelopeHash: v.string(),
      signedBy: v.string(),
      controlEpoch: v.number(),
      expiresAt: v.number(),
      resultNote: v.optional(v.string()),
      replayAttempted: v.optional(v.boolean()),
    }).index("by_task_ref", ["taskRef"]),

    /**
     * Audit events: append-only, hash-chained evidence. Each event commits to
     * the previous event's hash, so rewriting history is detectable.
     */
    auditEvents: defineTable({
      seq: v.number(),
      ts: v.number(),
      correlationId: v.string(),
      taskRef: v.optional(v.string()),
      actor: v.string(),
      serverPublicId: v.optional(v.string()),
      capability: v.optional(v.string()),
      kind: v.string(), // REQUEST | AUTHORIZATION | APPROVAL | DISPATCH | RECEIPT | EXECUTION | VERIFICATION | COMPLETION | REJECTION | ENROLLMENT | SYSTEM
      summary: v.string(),
      riskClass: v.optional(v.string()),
      prevHash: v.string(),
      hash: v.string(),
    }).index("by_seq", ["seq"]),

    /** Communication rules: human-meaningful intent, compiled to agent-owned firewall rules. */
    commRules: defineTable({
      ruleRef: v.string(),
      name: v.string(),
      sourceServer: v.string(),
      sourceProject: v.string(),
      destServer: v.string(),
      destService: v.string(),
      proto: v.string(), // tcp | udp
      port: v.number(),
      path: v.string(), // tailscale0 | lan
      status: v.string(), // PENDING_APPROVAL | ACTIVE | REVOKED
      permanence: v.string(), // PERMANENT | TEMPORARY
      expiresAt: v.optional(v.number()),
      verification: v.string(), // VERIFIED | PENDING | FAILED
      lastVerifiedAt: v.optional(v.number()),
      createdBy: v.string(),
      approvedBy: v.optional(v.string()),
      note: v.string(),
    }).index("by_rule_ref", ["ruleRef"]),

    /** Enrollment invitations: short-lived, one-time, fingerprint-verified. */
    enrollments: defineTable({
      inviteRef: v.string(),
      hostLabel: v.string(),
      hostname: v.string(),
      status: v.string(), // INVITATION_PENDING | AWAITING_APPROVAL | APPROVED | REJECTED
      csrFingerprint: v.string(),
      agentVersion: v.string(),
      createdAt: v.number(),
      expiresAt: v.number(),
      note: v.string(),
    }).index("by_invite_ref", ["inviteRef"]),

      /** Internal markers (seed state, control epoch). */
      meta: defineTable({
        key: v.string(),
        value: v.any(),
      }).index("by_key", ["key"]),

      /**
       * Agent telemetry, written only by the authenticated gateway ingest.
       *
       * Every row carries the certificate fingerprint and serial that produced
       * it, so any figure shown in the console can be traced to a specific
       * agent certificate. There is no other write path.
       */
      agentTelemetry: defineTable({
        serverPublicId: v.string(),
        kind: v.string(), // host | docker | event
        observedAtMs: v.number(),
        receivedAtMs: v.number(),
        certFingerprint: v.string(),
        certSerial: v.string(),
        gatewayServiceId: v.string(),
        payload: v.any(),
      })
        .index("by_server_kind", ["serverPublicId", "kind"])
        .index("by_server", ["serverPublicId"]),

      /** Lifecycle events observed by an agent, kept separate from samples. */
      agentEvents: defineTable({
        serverPublicId: v.string(),
        observedAtMs: v.number(),
        kind: v.string(),
        containerId: v.optional(v.string()),
        containerName: v.optional(v.string()),
        fromState: v.optional(v.string()),
        toState: v.optional(v.string()),
        fromHealth: v.optional(v.string()),
        toHealth: v.optional(v.string()),
      }).index("by_server", ["serverPublicId"]),

      /**
       * Agent health events: gateway connect/disconnect and sanitised error
       * classes. This is an operator audit trail, never a log sink — it holds
       * metadata only, with no message bodies, paths, or stack traces.
       */
      agentHealthEvents: defineTable({
        serverPublicId: v.string(),
        at: v.number(),
        // connect | disconnect | error
        kind: v.string(),
        // Sanitised class, e.g. ingest_rejected, helper_timeout, unknown_container
        errorClass: v.optional(v.string()),
        agentVersion: v.optional(v.string()),
        protocolVersion: v.optional(v.string()),
      }).index("by_server", ["serverPublicId"]),
    },
  {
    schemaValidation: false,
  },
);

export default schema;
