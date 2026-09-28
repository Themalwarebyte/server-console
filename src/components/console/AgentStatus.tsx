import { useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Mono } from "@/components/console/ui";
import { Dot } from "@/components/console/ui";
import { ShieldCheck, ShieldOff, Radio } from "lucide-react";

/**
 * Live agent state for the Fleet view.
 *
 * Milestone A gives SERVER-02 a real agent. What the console shows depends
 * entirely on whether an agent is actually reporting:
 *
 *   enrolled + heartbeat within the threshold -> LIVE, figures from telemetry
 *   enrolled + heartbeat older               -> OFFLINE, no live figures shown
 *   not enrolled                             -> the operator snapshot is shown,
 *                                               clearly labelled, never as live
 *
 * There is no path where snapshot numbers are presented as current telemetry for
 * an enrolled host. If an agent is enrolled but silent, the figures disappear
 * rather than falling back to a snapshot, because a stale snapshot that looks
 * live is the failure mode that matters.
 */

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

function bytesLabel(b: number): string {
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

function ago(ms: number): string {
  if (!ms) return "never";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export interface AgentView {
  serverPublicId: string;
  enrolled: boolean;
  online: boolean;
  lastHeartbeatAt: number | null;
  lastObservedAt: number | null;
  inventorySource: string;
  certFingerprint: string | null;
  certSerial: string | null;
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
    const byId = new Map(status.map((s) => [s.serverPublicId, s]));
    const hostBy = new Map((hostRows ?? []).map((r) => [r.serverPublicId, r]));
    const dockBy = new Map((dockerRows ?? []).map((r) => [r.serverPublicId, r]));

    return status.map((s) => {
      const h = hostBy.get(s.serverPublicId);
      const d = dockBy.get(s.serverPublicId);
      const hostPayload = (h?.payload ?? null) as Record<string, unknown> | null;
      const dockPayload = (d?.payload ?? null) as Record<string, unknown> | null;
      return {
        serverPublicId: s.serverPublicId,
        enrolled: s.enrolled,
        online: s.online,
        lastHeartbeatAt: s.lastHeartbeatAt,
        lastObservedAt: s.lastObservedAt,
        inventorySource: s.inventorySource,
        certFingerprint: s.certFingerprint,
        certSerial: s.certSerial,
        agentVersion: (hostPayload?.agent_version as string) ?? undefined,
        protocolVersion: (hostPayload?.protocol_version as string) ?? undefined,
        host: hostPayload,
        docker: dockPayload,
        containers: (dockPayload?.containers as LiveContainer[] | undefined) ?? [],
      };
    });
  }, [status, hostRows, dockerRows]);
}

/** Header badge: LIVE / OFFLINE / NOT ENROLLED. Never guesses. */
export function AgentBadge({ view }: { view: AgentView }) {
  if (!view.enrolled) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <ShieldOff className="size-3" /> not enrolled
      </span>
    );
  }
  if (view.online) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] text-emerald-400">
        <Radio className="size-3" /> LIVE
        <span className="text-muted-foreground">
          · heartbeat {ago(view.lastHeartbeatAt ?? 0)}
        </span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-amber-400">
      <Dot tone="warn" pulse /> OFFLINE
      <span className="text-muted-foreground">· last seen {ago(view.lastHeartbeatAt ?? 0)}</span>
    </span>
  );
}

/** Live figures. Returns null when there is nothing live to show. */
export function LiveMetrics({ view }: { view: AgentView }) {
  if (!view.enrolled) {
    return (
      <p className="text-[11px] text-muted-foreground">
        Inventory source: operator snapshot (no agent enrolled). This is a
        point-in-time observation, not live telemetry.
      </p>
    );
  }
  if (!view.online) {
    return (
      <p className="text-[11px] text-amber-300/90">
        Agent is offline. Live figures are hidden rather than shown from a stale
        snapshot, so nothing here can be mistaken for current state.
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
      {row("CPU", `${(h.load_1 as number)?.toFixed(2) ?? "n/a"} load · ${h.logical_cpu_count ?? "n/a"} logical`)}
      {row("RAM", `${bytesLabel(Number(h.mem_available_bytes ?? 0))} available of ${bytesLabel(Number(h.mem_total_bytes ?? 0))}`)}
      {row("Uptime", duration(Number(h.uptime_seconds ?? 0)))}
      {mounts.length > 0 &&
        row("Disk", `${String(mounts[0].mountPoint)} ${String(mounts[0].used_percent ?? 0)}% used`)}
      {row("Docker", `${d.engine_version ?? "n/a"} · ${d.total ?? 0} total / ${d.running ?? 0} running / ${d.unhealthy ?? 0} unhealthy`)}
      {row("Containers", `${view.containers.length} observed`)}
      <div className="border-t border-border/40 pt-1">
        {row("Agent", `${view.agentVersion ?? "unknown"} · ${view.protocolVersion ?? "unknown"}`)}
        {row("Certificate", view.certFingerprint ? `${view.certFingerprint.slice(0, 16)}…` : "not issued")}
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
    <span className={c.health === "healthy" ? "text-emerald-400/80" : c.health === "unhealthy" ? "text-amber-300/90" : "text-muted-foreground"}>
      {c.health}
    </span>
  );
}

export { bytesLabel, duration, ago };
