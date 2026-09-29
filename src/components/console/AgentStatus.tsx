import { useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Mono } from "@/components/console/ui";
import { Dot } from "@/components/console/ui";
import {
  ShieldOff,
  Radio,
  TriangleAlert,
  Clock,
  FileWarning,
} from "lucide-react";

/**
 * Agent health for the Fleet view.
 *
 * Three states, and the distinction is the point of this component:
 *
 *   ONLINE    heartbeat fresh AND telemetry flowing
 *   DEGRADED  the host is reachable, but telemetry is stale or errors were
 *             recorded — something between the host and Convex is failing
 *   OFFLINE   no heartbeat inside the threshold
 *
 * A host is never shown as live merely because a database row exists, and a
 * stale figure is never presented as current. When a host is not ONLINE, the
 * metrics are withheld rather than falling back to the operator snapshot,
 * because a stale number that looks live is the failure that matters.
 *
 * Security: this component never receives certificate material. The control
 * plane exposes only the expiry, so the UI can warn without handling a
 * certificate, and errors arrive as a class rather than a message.
 */

export type AgentState = "ONLINE" | "DEGRADED" | "OFFLINE";

interface LiveContainer {
  id: string;
  name: string;
  image: string;
  state: string;
  healthCheckPresent: boolean;
  health: string;
  status: string;
  cpuPercent: number;
  memoryBytes: number;
  restartCount: number;
  ports: string[];
  startedAtMs: number;
}

export interface AgentView {
  serverPublicId: string;
  enrolled: boolean;
  state: AgentState;
  lastHeartbeatAt: number | null;
  lastHeartbeatAgeMs: number | null;
  lastSuccessfulTelemetryAt: number | null;
  telemetryAgeMs: number | null;
  agentErrorCount: number;
  lastErrorClass: string | null;
  gatewayState: string | null;
  certNotAfter: number | null;
  certDaysRemaining: number | null;
  certExpiringSoon: boolean;
  certExpired: boolean;
  inventorySource: string;
  /** Capabilities the AGENT proved its binary supports. */
  agentSupported?: string[];
  /** Capabilities the GATEWAY granted. */
  grantedCeiling?: string[];
  /**
   * Effective docker.logs.read: agent-proven AND granted AND centrally
   * permitted AND the host is ONLINE. A gateway that merely wishes to grant it
   * is not enough.
   */
  logReadAvailable?: boolean;
  agentVersion?: string;
  protocolVersion?: string;
  host?: Record<string, unknown> | null;
  docker?: Record<string, unknown> | null;
  containers: LiveContainer[];
}

export function useAgentViews(): AgentView[] | undefined {
  const status = useQuery(api.agentIngest.listAgentStatus);
  const hostRows = useQuery(api.agentIngest.allLiveHostTelemetry);
  const dockerRows = useQuery(api.agentIngest.allLiveDockerTelemetry);

  return useMemo(() => {
    if (!status) return undefined;
    const hostBy = new Map((hostRows ?? []).map((r) => [r.serverPublicId, r]));
    const dockBy = new Map((dockerRows ?? []).map((r) => [r.serverPublicId, r]));

    return status.map((s) => {
      const hostPayload = (hostBy.get(s.serverPublicId)?.payload ??
        null) as Record<string, unknown> | null;
      const dockPayload = (dockBy.get(s.serverPublicId)?.payload ??
        null) as Record<string, unknown> | null;
      return {
        ...s,
        agentVersion: (hostPayload?.agent_version as string) ?? undefined,
        protocolVersion: (hostPayload?.protocol_version as string) ?? undefined,
        host: hostPayload,
        docker: dockPayload,
        containers: (dockPayload?.containers as LiveContainer[] | undefined) ?? [],
      };
    });
  }, [status, hostRows, dockerRows]);
}

/** "12s ago" / "4m ago" from an epoch, or "never". */
export function ago(ms: number | null | undefined): string {
  if (!ms) return "never";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function bytesLabel(b: number): string {
  if (!b || b < 0) return "n/a";
  const u = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0;
  let v = b;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

function duration(seconds: number): string {
  if (!seconds || seconds < 0) return "n/a";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${Math.floor(seconds % 60)}s`;
}

/** Header badge: the three states, or "not enrolled" for a host with no agent. */
export function AgentBadge({ view }: { view: AgentView }) {
  if (!view.enrolled) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <ShieldOff className="size-3" /> not enrolled
      </span>
    );
  }
  if (view.state === "ONLINE") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] text-emerald-400">
        <Radio className="size-3" /> LIVE
      </span>
    );
  }
  if (view.state === "DEGRADED") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] text-amber-400">
        <TriangleAlert className="size-3" /> DEGRADED
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-rose-400">
      <Dot tone="bad" /> OFFLINE
    </span>
  );
}

/**
 * Heartbeat, telemetry and certificate health, shown under the badge.
 *
 * Kept compact on the Fleet card and reused in full on the server detail page.
 */
export function AgentHealthLine({ view }: { view: AgentView }) {
  if (!view.enrolled) {
    return (
      <p className="text-[11px] text-muted-foreground">
        Inventory source: operator snapshot (no agent enrolled). A point-in-time
        observation, not live telemetry.
      </p>
    );
  }

  const line = (label: string, value: React.ReactNode) => (
    <span className="inline-flex items-center gap-1">
      <span className="text-muted-foreground">{label}</span>
      <Mono className="text-foreground/85">{value}</Mono>
    </span>
  );

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px]">
      {line("heartbeat", ago(view.lastHeartbeatAt))}
      {line("telemetry", ago(view.lastSuccessfulTelemetryAt))}
      {view.gatewayState && line("gateway", view.gatewayState)}
      {view.agentErrorCount > 0 && (
        <span className="inline-flex items-center gap-1 text-amber-400">
          <FileWarning className="size-3" />
          <Mono>
            {view.agentErrorCount} error{view.agentErrorCount === 1 ? "" : "s"}
            {view.lastErrorClass ? ` (${view.lastErrorClass})` : ""}
          </Mono>
        </span>
      )}
      {view.certExpired ? (
        <span className="inline-flex items-center gap-1 text-rose-400">
          <Clock className="size-3" /> certificate expired
        </span>
      ) : view.certExpiringSoon ? (
        <span className="inline-flex items-center gap-1 text-amber-400">
          <Clock className="size-3" /> certificate expires in{" "}
          {view.certDaysRemaining}d
        </span>
      ) : null}
    </div>
  );
}

/** Live figures. Withheld unless the agent is actually ONLINE. */
export function LiveMetrics({ view }: { view: AgentView }) {
  if (!view.enrolled) {
    return (
      <p className="text-[11px] text-muted-foreground">
        Inventory source: operator snapshot (no agent enrolled). This is a
        point-in-time observation, not live telemetry.
      </p>
    );
  }
  if (view.state === "OFFLINE") {
    return (
      <p className="text-[11px] text-rose-300/90">
        Agent is offline. Live figures are hidden rather than shown from a stale
        snapshot, so nothing here can be mistaken for current state.
      </p>
    );
  }
  if (view.state === "DEGRADED") {
    return (
      <p className="text-[11px] text-amber-300/90">
        Agent is reachable but telemetry is stale or errors were recorded.
        Figures below are marked stale and must not be treated as current.
      </p>
    );
  }

  const h = view.host ?? {};
  const d = view.docker ?? {};
  const mounts = (h.disk as Record<string, unknown>[] | undefined) ?? [];
  const row = (k: string, v: React.ReactNode) => (
    <div className="flex justify-between gap-3">
      <span className="text-muted-foreground">{k}</span>
      <Mono className="text-foreground/85">{v}</Mono>
    </div>
  );

  return (
    <div className="space-y-1 text-[11px]">
      {row(
        "CPU",
        `${(h.load_1 as number)?.toFixed(2) ?? "n/a"} load · ${h.logical_cpu_count ?? "n/a"} logical`,
      )}
      {row(
        "RAM",
        `${bytesLabel(Number(h.mem_available_bytes ?? 0))} available of ${bytesLabel(Number(h.mem_total_bytes ?? 0))}`,
      )}
      {row("Uptime", duration(Number(h.uptime_seconds ?? 0)))}
      {mounts.length > 0 &&
        row(
          "Disk",
          `${String(mounts[0].mount_point)} ${String(mounts[0].used_percent ?? 0)}% used`,
        )}
      {row(
        "Docker",
        `${d.engine_version ?? "n/a"} · ${d.total ?? 0} total / ${d.running ?? 0} running / ${d.unhealthy ?? 0} unhealthy`,
      )}
      {row("Containers", `${view.containers.length} observed`)}
      <div className="border-t border-border/40 pt-1">
        {row("Agent", `${view.agentVersion ?? "unknown"} · ${view.protocolVersion ?? "unknown"}`)}
      </div>
    </div>
  );
}

/** Container state line, honest about absent health checks. */
export function ContainerHealthLabel({ c }: { c: LiveContainer }) {
  if (!c.healthCheckPresent) {
    return <span className="text-muted-foreground">no health check</span>;
  }
  return (
    <span
      className={
        c.health === "healthy"
          ? "text-emerald-400/80"
          : c.health === "unhealthy"
            ? "text-amber-300/90"
            : "text-muted-foreground"
      }
    >
      {c.health}
    </span>
  );
}
