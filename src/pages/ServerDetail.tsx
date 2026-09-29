import {
  Dot,
  LifecycleBadge,
  LogsDialog,
  Meter,
  Mono,
  RiskBadge,
} from "@/components/console/ui";
import { ago, useAgentViews } from "@/components/console/AgentStatus";
import { LogAccessControl } from "@/components/console/LogDialog";
import { ConsoleLayout } from "@/components/console/ConsoleLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import { useMutation, useQuery } from "convex/react";
import {
  ArrowLeft,
  CircleCheck,
  Cpu,
  Fingerprint,
  Gauge,
  HardDrive,
  MemoryStick,
  ScrollText,
  Server as ServerIcon,
  ShieldAlert,
  ShieldCheck,
  Terminal,
} from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { toast } from "sonner";

function relative(ts: number) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${Math.max(s, 1)}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

const CAP_LABELS: Record<string, { label: string; desc: string }> = {
  "system.inventory": { label: "System inventory", desc: "Read-only host facts: OS, kernel, CPU, memory, disks." },
  "system.health": { label: "Health checks", desc: "Run the agent's local health probe on demand." },
  "docker.inventory": { label: "Docker inventory", desc: "Observe containers, images, networks, and project labels." },
  "docker.logs": { label: "Container logs", desc: "Bounded, on-demand log windows rendered as plain text." },
  "docker.container.restart": { label: "Restart container", desc: "Typed restart of a single observed container." },
  "firewall.communication-policy": { label: "Communication policy", desc: "Apply or revoke agent-owned firewall rules from approved policies." },
  "package.install": { label: "Package install", desc: "Install system packages. Disabled by local policy." },
  "ssh.modify": { label: "SSH modification", desc: "Change SSH server configuration. Disabled by local policy." },
  "volume.delete": { label: "Volume deletion", desc: "Destructive storage operation. Not supported by this agent." },
};

export default function ServerDetail() {
  const { publicId } = useParams<{ publicId: string }>();
  const server = useQuery(api.console.getServer, { publicId: publicId ?? "" });
  // Agent health is a separate control-plane read: the server document does not
  // carry derived state, and the health view deliberately omits certificate
  // material, exposing only the expiry the UI needs for a warning.
  const agentViews = useAgentViews();
  // Effective docker.logs.read: agent-proven AND centrally permitted AND ONLINE.
  const logReadAvailable = agentViews?.find(
    (a) => a.serverPublicId === publicId,
  )?.logReadAvailable;
  const agentView = agentViews?.find(
    (a) => a.serverPublicId === publicId,
  );
  const containers = useQuery(api.console.listContainers, {
    serverPublicId: publicId ?? "",
  });
  const audit = useQuery(api.console.listAuditForServer, {
    serverPublicId: publicId ?? "",
  });

  const restart = useMutation(api.console.restartContainer);
  const [logs, setLogs] = useState<Doc<"containers"> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  if (server === undefined) {
    return (
      <ConsoleLayout>
        <div className="space-y-4">
          <Skeleton className="h-8 w-72" />
          <Skeleton className="h-64 rounded-xl" />
        </div>
      </ConsoleLayout>
    );
  }

  if (!server) {
    return (
      <ConsoleLayout>
        <Card className="mx-auto mt-16 max-w-md border-border/70">
          <CardHeader>
            <CardTitle className="text-base">Unknown server</CardTitle>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline" size="sm">
              <Link to="/console/servers">
                <ArrowLeft className="size-3.5" /> Back to servers
              </Link>
            </Button>
          </CardContent>
        </Card>
      </ConsoleLayout>
    );
  }

  const diskPct = (server.hardware.diskUsedGb / server.hardware.diskGb) * 100;

  const doRestart = (c: Doc<"containers">) => {
    setBusy(c._id);
    restart({ containerId: c._id })
      .then(() => toast.success(`Restart envelope signed and executed for ${c.name}`))
      .catch((e: Error) => toast.error(e.message))
      .finally(() => setBusy(null));
  };

  // Live containers come from agent telemetry, which carries the real Docker
  // ids a log request needs. The legacy table below shows the seeded view.
  const liveContainers = useQuery(api.agentIngest.liveContainers, {
    serverPublicId: server?.publicId ?? "",
  });

  return (
    <ConsoleLayout>
      <div className="space-y-6">
        {/* header */}
        <div>
          <Link
            to="/console/servers"
            className="mb-3 inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" /> All servers
          </Link>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">{server.displayName}</h1>
            <LifecycleBadge state={server.lifecycleState} />
            <Badge
              variant="outline"
              className="border-border bg-card text-[11px] text-muted-foreground"
            >
              {/* Agent state is derived in the control plane from the heartbeat,
                  telemetry freshness and error count. It is never inferred
                  from the presence of a database row. */}
              <Dot
                tone={
                  agentView?.state === "ONLINE"
                    ? "ok"
                    : agentView?.state === "DEGRADED"
                      ? "warn"
                      : "bad"
                }
                pulse={agentView?.state === "ONLINE"}
              />
              <span className="ml-1.5">
                agent {agentView ? agentView.state.toLowerCase() : "not enrolled"}
              </span>
            </Badge>
            <Badge variant="outline" className="border-border bg-card text-[11px] text-muted-foreground">
              source: {server.inventorySource === "operator_snapshot" ? "operator snapshot" : (server.inventorySource ?? "demo")}
            </Badge>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            {server.note} · enrolled {relative(server.enrolledAt)}
          </p>
        </div>

        {/* hardware */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Card className="border-border/70 card-layer">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-[13px] font-medium text-muted-foreground">
                <ScrollText className="size-4" /> Container logs
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <p className="text-[11px] text-muted-foreground">
                Read-only bounded tail. Availability follows the EFFECTIVE
                capability: the agent must prove it supports the read and
                central policy must permit it.
              </p>
              {logReadAvailable === true ? (
                <div className="max-h-64 space-y-1 overflow-auto">
                  {(liveContainers ?? []).map((c) => (
                    <div
                      key={c.id}
                      className="flex items-center justify-between gap-3 rounded border border-border/50 px-2 py-1.5"
                    >
                      <div className="min-w-0">
                        <Mono className="block truncate text-foreground/85">
                          {c.name}
                        </Mono>
                        <span className="text-[10px] text-muted-foreground">
                          {c.state} ·{" "}
                          {c.healthCheckPresent
                            ? `health: ${c.health ?? "unknown"}`
                            : "No health check"}
                        </span>
                      </div>
                      <LogAccessControl
                        serverPublicId={server.publicId}
                        containerId={c.id}
                        containerName={c.name}
                        available
                      />
                    </div>
                  ))}
                  {(liveContainers ?? []).length === 0 && (
                    <p className="text-[11px] text-muted-foreground">
                      No container inventory reported yet.
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-[11px] text-muted-foreground">
                  Log access not available on this host
                </p>
              )}
            </CardContent>
          </Card>
          <Card className="border-border/70 card-layer">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-[13px] font-medium text-muted-foreground">
                <MemoryStick className="size-4" /> Memory
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-xl font-semibold tabular">{server.memUsedPct.toFixed(0)}%</div>
              <div className="mt-2">
                <Meter value={server.memUsedPct} tone={server.memUsedPct > 60 ? "warn" : undefined} />
              </div>
              <div className="mt-1.5 text-[11px] text-muted-foreground">of {server.hardware.memoryGb} GiB</div>
            </CardContent>
          </Card>
          <Card className="border-border/70 card-layer">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-[13px] font-medium text-muted-foreground">
                <HardDrive className="size-4" /> Disk
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-xl font-semibold tabular">{diskPct.toFixed(0)}%</div>
              <div className="mt-2"><Meter value={diskPct} tone={diskPct > 80 ? "warn" : undefined} /></div>
              <div className="mt-1.5 text-[11px] text-muted-foreground">
                {server.hardware.diskUsedGb} / {server.hardware.diskGb} GiB used
              </div>
            </CardContent>
          </Card>
          <Card className="border-border/70 card-layer">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-[13px] font-medium text-muted-foreground">
                <Cpu className="size-4" /> CPU
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-xl font-semibold tabular">{server.cpuLoad.toFixed(2)}</div>
              <div className="mt-1.5 text-[11px] text-muted-foreground">
                load average · {server.hardware.cores} cores {server.os.arch}
              </div>
            </CardContent>
          </Card>
          <Card className="border-border/70 card-layer">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-[13px] font-medium text-muted-foreground">
                <Gauge className="size-4" /> Docker
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-xl font-semibold tabular">
                {server.docker.running}/{server.docker.total}
              </div>
              <div className="mt-1.5 text-[11px] text-muted-foreground">
                Engine {server.docker.version}
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          {/* identity */}
          <Card className="border-border/70 card-layer">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Fingerprint className="size-4 text-primary" /> Identity
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2.5 text-[12px]">
              {[
                ["Server ID", server.publicId],
                ["Hostname", server.hostname],
                [
                  "Last observed",
                  server.lastObservedAt
                    ? `${new Date(server.lastObservedAt).toISOString().replace("T", " ").slice(0, 19)} UTC`
                    : "Not observed",
                ],
                ["Source", server.inventorySource === "operator_snapshot" ? "Operator snapshot" : (server.inventorySource ?? "demo")],
              // Certificate and mTLS facts come from the agent health view, which
              // exposes only the expiry. No fingerprint or serial is rendered
              // here: the UI has no need for certificate material and must not
              // be given it.
              [
                "Certificate",
                agentView?.certExpired
                  ? "EXPIRED"
                  : agentView?.certNotAfter
                    ? agentView.certExpiringSoon
                      ? `Expires in ${agentView.certDaysRemaining}d`
                      : "Valid"
                    : "Not recorded",
              ],
              [
                "mTLS",
                agentView?.gatewayState === "connected"
                  ? "Connected"
                  : agentView?.gatewayState
                    ? "Configured, not connected"
                    : "Not connected",
              ],
              ["Last heartbeat", ago(agentView?.lastHeartbeatAt)],
              ["Last successful telemetry", ago(agentView?.lastSuccessfulTelemetryAt)],
              [
                "Last errors",
                agentView && agentView.agentErrorCount > 0
                  ? `${agentView.agentErrorCount} since last success${
                      agentView.lastErrorClass ? ` (${agentView.lastErrorClass})` : ""
                    }`
                  : "None since last success",
              ],
                ["Tailscale", server.tailscaleName],
              ].map(([k, v]) => (
                <div key={k} className="flex items-baseline justify-between gap-4 border-b border-border/40 pb-2 last:border-0">
                  <span className="shrink-0 text-muted-foreground">{k}</span>
                  <Mono className="truncate text-right">{v}</Mono>
                </div>
              ))}
            </CardContent>
          </Card>

          {/* system */}
          <Card className="border-border/70 card-layer">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <ServerIcon className="size-4 text-primary" /> System
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2.5 text-[12px]">
              {[
                ["Operating system", server.os.name],
                ["Kernel", server.os.kernel],
                ["Architecture", server.os.arch],
                ["Cores", `${server.hardware.cores}`],
                [
                  "Uptime at observation",
                  server.observedUptimeSeconds
                    ? relative(Date.now() - server.observedUptimeSeconds)
                    : "Not observed",
                ],
                ["CPU load", server.cpuLoad.toFixed(2)],
                // Agent-dependent fields. No agent is enrolled in V0.1, so these
                // report the absence rather than a placeholder.
                ["Agent", server.agent ? server.agent.version : "Not enrolled"],
                ["Protocol", server.agent?.protocolVersion ?? "Not negotiated"],
                [
                  "Last heartbeat",
                  server.agent?.lastSeenAt
                    ? relative(server.agent.lastSeenAt)
                    : "Not available until agent enrollment",
                ],
                ["Boot ID", server.agent?.bootId ?? "Not enrolled"],
                ["Capability ceiling", "Not negotiated"],
              ].map(([k, v]) => (
                <div key={k} className="flex items-baseline justify-between gap-4 border-b border-border/40 pb-2 last:border-0">
                  <span className="shrink-0 text-muted-foreground">{k}</span>
                  <Mono className="truncate text-right">{v}</Mono>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>

        {/* capabilities */}
        <Card className="border-border/70 card-layer">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldCheck className="size-4 text-primary" /> Capability ceiling
            </CardTitle>
            <p className="text-[12px] text-muted-foreground">
              The console may request only capabilities this server has enabled
              locally. Disabled rows cannot be turned on from here — that is the point.
            </p>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="text-[11px] uppercase tracking-[0.1em]">Capability</TableHead>
                  <TableHead className="hidden text-[11px] uppercase tracking-[0.1em] md:table-cell">Purpose</TableHead>
                  <TableHead className="text-[11px] uppercase tracking-[0.1em]">Risk</TableHead>
                  <TableHead className="text-right text-[11px] uppercase tracking-[0.1em]">Local policy</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {server.capabilities.map((cap) => {
                  const meta = CAP_LABELS[cap.code] ?? { label: cap.code, desc: "" };
                  const disabled = !cap.supported || !cap.locallyEnabled;
                  return (
                    <TableRow key={cap.code}>
                      <TableCell>
                        <div className="font-mono text-[12px]">{cap.code}</div>
                        <div className="text-[11px] text-muted-foreground md:hidden">{meta.label}</div>
                      </TableCell>
                      <TableCell className="hidden max-w-96 text-[12px] text-muted-foreground md:table-cell">
                        {meta.desc}
                      </TableCell>
                      <TableCell><RiskBadge risk={cap.riskClass} /></TableCell>
                      <TableCell className="text-right">
                        {disabled ? (
                          <Badge variant="outline" className="border-zinc-400/25 bg-zinc-400/5 text-[11px] text-zinc-400">
                            {cap.supported ? "locally disabled" : "unsupported"}
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="border-emerald-400/25 bg-emerald-400/10 text-[11px] text-emerald-300">
                            enabled
                          </Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/* containers */}
        <Card className="border-border/70 card-layer">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Terminal className="size-4 text-primary" /> Containers
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="text-[11px] uppercase tracking-[0.1em]">Container</TableHead>
                  <TableHead className="hidden text-[11px] uppercase tracking-[0.1em] md:table-cell">Image</TableHead>
                  <TableHead className="text-[11px] uppercase tracking-[0.1em]">State</TableHead>
                  <TableHead className="text-right text-[11px] uppercase tracking-[0.1em]">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(containers ?? []).map((c) => (
                  <TableRow key={c._id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {/* No HEALTHCHECK is never shown as healthy. */}
                        <Dot
                          tone={
                            c.state !== "running"
                              ? "idle"
                              : !c.healthcheckPresent
                                ? "warn"
                                : c.health === "healthy"
                                  ? "ok"
                                  : c.health === "unhealthy"
                                    ? "bad"
                                    : "warn"
                          }
                        />
                        <Mono className="text-foreground/90">{c.name}</Mono>
                      </div>
                      <div className="mt-0.5 text-[11px] text-muted-foreground">
                        {c.project} · {c.state} ·{" "}
                        {c.healthcheckPresent
                          ? `health: ${c.health ?? "unknown"}`
                          : "No health check"}
                      </div>
                      {c.dockerStatus && (
                        <div className="mt-0.5 truncate text-[10px] text-muted-foreground/70">
                          {c.dockerStatus}
                        </div>
                      )}
                    </TableCell>

                    <TableCell className="hidden max-w-72">
                      <Mono className="block truncate text-muted-foreground">{c.image}</Mono>
                    </TableCell>
                    <TableCell>
                      <span className={cn("font-mono text-[11px]", c.state === "running" ? "text-emerald-300" : c.state === "exited" ? "text-zinc-400" : "text-amber-300")}>
                        {c.state}
                      </span>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-2">
                        <Button variant="outline" size="sm" onClick={() => setLogs(c)}>
                          Logs
                        </Button>
                        <Button
                          size="sm"
                          disabled={busy === c._id}
                          onClick={() => doRestart(c)}
                        >
                          Restart
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/* server audit */}
        <Card className="border-border/70 card-layer">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <ScrollText className="size-4 text-primary" /> Recent activity on this server
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {(audit ?? []).map((e) => (
              <div key={e._id} className="flex items-start gap-3 rounded-lg border border-border/50 bg-background/40 px-3 py-2">
                <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-primary/70" />
                <div className="min-w-0">
                  <p className="text-[12px] leading-5 text-foreground/85">{e.summary}</p>
                  <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                    {e.kind} · {e.actor} · {relative(e.ts)}
                  </p>
                </div>
              </div>
            ))}
            {(audit ?? []).length === 0 && (
              <p className="px-1 py-4 text-[12px] text-muted-foreground">
                No audit events recorded for this server yet.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {logs && (
        <LogsDialog
          containerName={logs.name}
          serverName={server.displayName}
          logs={logs.logs ?? []}
          onClose={() => setLogs(null)}
        />
      )}
    </ConsoleLayout>
  );
}
