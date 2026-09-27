import {
  Dot,
  LifecycleBadge,
  LogsDialog,
  Meter,
  Mono,
  RiskBadge,
  StatTile,
} from "@/components/console/ui";
import { ConsoleLayout } from "@/components/console/ConsoleLayout";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import { useMutation, useQuery } from "convex/react";
import {
  Activity,
  ArrowRight,
  CircleCheck,
  CircleDot,
  Container,
  Cpu,
  Gauge,
  HardDrive,
  ListChecks,
  RefreshCw,
  ScrollText,
  Server as ServerIcon,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import React, { useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";

type ServerRow = Doc<"servers">;
type ContainerRow = Doc<"containers">;
type AuditRow = Doc<"auditEvents">;
type TaskRow = Doc<"tasks">;

function relative(ts: number) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${Math.max(s, 1)}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/**
 * Error state for the console shell.
 *
 * A failed Convex query and a still-loading query both leave the value
 * `undefined`, so without an explicit boundary this page could sit on skeleton
 * loaders with no indication anything was wrong. This boundary turns a thrown
 * query error into a visible, retryable state.
 *
 * The message is intentionally generic: no server names, IDs, stack traces, or
 * backend detail are shown to the user. The real failure is server-side and
 * stays in the deployment logs.
 */
function ConsoleQueryError() {
  return (
    <ConsoleLayout>
      <Card className="mx-auto mt-16 max-w-lg border-border/70 card-layer">
        <CardHeader>
          <CardTitle className="text-base">Cannot reach the control plane</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p>
            The console could not load inventory from the self-hosted Convex
            deployment. This is normally a connectivity or session problem
            rather than an empty control plane.
          </p>
          <p className="text-xs">
            No server details are displayed here. Retry, and if it keeps
            failing sign out and back in so a fresh session is issued.
          </p>
          <Button className="w-full" onClick={() => window.location.reload()}>
            Retry
          </Button>
        </CardContent>
      </Card>
    </ConsoleLayout>
  );
}

/**
 * Minimal local error boundary. `convex/react` in this version does not export
 * one, and adding `@convex-dev/react` just for this would be a new dependency,
 * so the boundary is implemented here directly.
 */
class ConsoleErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    // The detail stays in the browser console for operators; the UI stays
    // deliberately vague.
    console.error("[Console] query failed:", error);
  }

  render() {
    if (this.state.failed) {
      return <ConsoleQueryError />;
    }
    return this.props.children;
  }
}

function ConsoleInner() {
  useAuth();
  const servers = useQuery(api.console.listServers);
  const audit = useQuery(api.console.listAudit);
  const tasks = useQuery(api.console.listTasks);
  const seeded = useQuery(api.console.isSeeded);

  const seed = useMutation(api.console.seed);
  const refresh = useMutation(api.console.refreshInventory);

  const [logs, setLogs] = useState<ContainerRow | null>(null);
  const containersS1 = useQuery(api.console.listContainers, {
    serverPublicId: "srv_7f3a91c2e8",
  });

  const loading =
    servers === undefined || audit === undefined || tasks === undefined;

  if (loading) {
    return (
      <ConsoleLayout>
        <div className="space-y-4">
          <Skeleton className="h-8 w-64" />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-24 rounded-xl" />
            ))}
          </div>
          <Skeleton className="h-64 rounded-xl" />
        </div>
      </ConsoleLayout>
    );
  }

  if (!seeded) {
    return (
      <ConsoleLayout>
        <Card className="mx-auto mt-16 max-w-lg border-border/70 card-layer">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldCheck className="size-4 text-primary" />
              Initialize the control plane
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm text-muted-foreground">
            <p>
              The console has no servers registered yet. Create the demo estate
              to explore inventory, tasks, communication policy, and the audit
              chain.
            </p>
            <Button
              className="w-full"
              onClick={() =>
                seed()
                  .then(() => toast.success("Demo estate provisioned"))
                  .catch((e: Error) => toast.error(e.message))
              }
            >
              Provision demo estate
            </Button>
            <p className="text-xs">
              Nothing touches real infrastructure — this only creates records in
              the console's own database.
            </p>
          </CardContent>
        </Card>
      </ConsoleLayout>
    );
  }

  const totalContainers = servers!.reduce((n, s) => n + s.docker.total, 0);
  const runningContainers = servers!.reduce((n, s) => n + s.docker.running, 0);
  const pendingTasks = tasks!.filter((t) => t.state === "PENDING_APPROVAL").length;
  const avgMem =
    servers!.reduce((n, s) => n + s.memUsedPct, 0) / Math.max(servers!.length, 1);

  return (
    <ConsoleLayout>
      <div className="space-y-6">
        {/* heading */}
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Fleet overview</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {servers!.length} servers under management · observed state, refreshed by agent heartbeats
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              refresh()
                .then(() => toast.success("Inventory refreshed"))
                .catch((e: Error) => toast.error(e.message))
            }
          >
            <RefreshCw className="size-3.5" /> Refresh inventory
          </Button>
        </div>

        {/* stats */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label="Servers"
            value={servers!.length}
            sub="all identities valid"
            icon={<ServerIcon className="size-4" />}
          />
          <StatTile
            label="Containers"
            value={`${runningContainers}/${totalContainers}`}
            sub="running / observed"
            icon={<Container className="size-4" />}
          />
          <StatTile
            label="Pending approvals"
            value={pendingTasks}
            sub={pendingTasks > 0 ? "action required" : "queue clear"}
            icon={<ListChecks className="size-4" />}
            tone={pendingTasks > 0 ? "warn" : "default"}
          />
          <StatTile
            label="Avg memory"
            value={`${avgMem.toFixed(0)}%`}
            sub="across the estate"
            icon={<Gauge className="size-4" />}
            tone={avgMem > 60 ? "warn" : "default"}
          />
        </div>

        {/* server cards */}
        <div className="grid gap-4 lg:grid-cols-2">
          {servers!.map((s) => {
            const diskPct = (s.hardware.diskUsedGb / s.hardware.diskGb) * 100;
            const expDays = Math.round(
              (s.identity.certExpiresAt - Date.now()) / 86_400_000,
            );
            return (
              <Card key={s.publicId} className="border-border/70 card-layer">
                <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
                  <CardTitle className="flex items-center gap-2.5 text-base">
                    <Dot tone={s.lifecycleState === "ACTIVE" ? "ok" : "warn"} pulse />
                    {s.displayName}
                    <LifecycleBadge state={s.lifecycleState} />
                  </CardTitle>
                  <Link
                    to={`/console/servers/${s.publicId}`}
                    className="text-xs text-primary hover:underline"
                  >
                    details <ArrowRight className="inline size-3" />
                  </Link>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-[12px] text-muted-foreground sm:grid-cols-4">
                    <div>
                      <div className="text-[10px] uppercase tracking-[0.12em]">Agent</div>
                      <Mono className="text-foreground/85">{s.agent.version}</Mono>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-[0.12em]">Docker</div>
                      <Mono className="text-foreground/85">
                        {s.docker.version.split("-")[0]}
                      </Mono>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-[0.12em]">Cert</div>
                      <Mono className={cn(expDays < 15 ? "text-amber-300" : "text-foreground/85")}>
                        {expDays}d
                      </Mono>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-[0.12em]">Load</div>
                      <Mono className="text-foreground/85">{s.cpuLoad.toFixed(2)}</Mono>
                    </div>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <div className="mb-1.5 flex justify-between text-[11px] text-muted-foreground">
                        <span>Memory</span>
                        <span className="tabular">{s.memUsedPct.toFixed(0)}% of {s.hardware.memoryGb} GiB</span>
                      </div>
                      <Meter value={s.memUsedPct} tone={s.memUsedPct > 60 ? "warn" : undefined} />
                    </div>
                    <div>
                      <div className="mb-1.5 flex justify-between text-[11px] text-muted-foreground">
                        <span>Disk</span>
                        <span className="tabular">{diskPct.toFixed(0)}% of {s.hardware.diskGb} GiB</span>
                      </div>
                      <Meter value={diskPct} tone={diskPct > 80 ? "warn" : undefined} />
                    </div>
                  </div>
                  {s.docker.healthy === false && (
                    <div className="flex items-center gap-2 rounded-lg border border-amber-400/20 bg-amber-400/5 px-3 py-2 text-[12px] text-amber-200/90">
                      <ShieldAlert className="size-3.5" />
                      One container is unhealthy on this host — worker-queue keeps restarting.
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>

        {/* container snapshot S1 */}
        {containersS1 && containersS1.length > 0 && (
          <Card className="border-border/70 card-layer">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Container className="size-4 text-primary" />
                Containers — SERVER-01
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {containersS1.slice(0, 6).map((c) => (
                  <button
                    key={c._id}
                    onClick={() => setLogs(c)}
                    className="group rounded-lg border border-border/60 bg-background/40 p-3 text-left transition-colors hover:border-primary/40"
                  >
                    <div className="flex items-center justify-between">
                      <Mono className="text-foreground/90">{c.name}</Mono>
                      <Dot tone={c.state === "running" ? (c.health === "healthy" ? "ok" : "warn") : "idle"} />
                    </div>
                    <div className="mt-1 truncate text-[11px] text-muted-foreground">{c.image}</div>
                    <div className="mt-2 flex items-center gap-3 text-[11px] text-muted-foreground">
                      <span className="tabular flex items-center gap-1">
                        <Cpu className="size-3" /> {c.cpuPct.toFixed(1)}%
                      </span>
                      <span className="tabular flex items-center gap-1">
                        <HardDrive className="size-3" /> {c.memPct.toFixed(1)}%
                      </span>
                      {c.restarts > 0 && (
                        <span className="text-amber-300/90">{c.restarts} restarts</span>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* tasks + audit */}
        <div className="grid gap-4 lg:grid-cols-2">
          <Card className="border-border/70 card-layer">
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Activity className="size-4 text-primary" /> Recent tasks
              </CardTitle>
              <Link to="/console/tasks" className="text-xs text-primary hover:underline">
                all tasks
              </Link>
            </CardHeader>
            <CardContent className="space-y-2">
              {tasks!.slice(0, 5).map((t: TaskRow) => (
                <div
                  key={t._id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border/50 bg-background/40 px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Mono className="truncate text-foreground/90">{t.capability}</Mono>
                      <RiskBadge risk={t.riskClass} />
                    </div>
                    <div className="truncate text-[11px] text-muted-foreground">
                      {t.containerName ?? t.serverPublicId} · {t.requestedBy}
                    </div>
                  </div>
                  <span
                    className={cn(
                      "shrink-0 font-mono text-[10px] uppercase tracking-wider",
                      t.state === "SUCCEEDED" && "text-emerald-300",
                      t.state === "PENDING_APPROVAL" && "text-amber-300",
                      t.state === "FAILED" && "text-rose-300",
                      t.state === "REJECTED" && "text-rose-300",
                    )}
                  >
                    {t.state === "SUCCEEDED" ? (
                      <span className="flex items-center gap-1"><CircleCheck className="size-3" /> done</span>
                    ) : (
                      t.state.toLowerCase()
                    )}
                  </span>
                </div>
              ))}
              {tasks!.length === 0 && (
                <div className="flex items-center gap-2 rounded-lg border border-dashed border-border/60 px-3 py-6 text-[12px] text-muted-foreground">
                  <CircleDot className="size-3.5" /> No tasks yet. Actions you take will appear here.
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="border-border/70 card-layer">
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <ScrollText className="size-4 text-primary" /> Audit stream
              </CardTitle>
              <Link to="/console/tasks" className="text-xs text-primary hover:underline">
                full history
              </Link>
            </CardHeader>
            <CardContent className="space-y-2">
              {audit!.slice(0, 5).map((e: AuditRow) => (
                <div key={e._id} className="flex items-start gap-2.5 rounded-lg border border-border/50 bg-background/40 px-3 py-2">
                  <Mono className="mt-0.5 shrink-0 text-[10px] text-muted-foreground">
                    #{e.seq}
                  </Mono>
                  <div className="min-w-0">
                    <p className="text-[12px] leading-5 text-foreground/85">{e.summary}</p>
                    <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                      {e.kind} · {e.actor} · {relative(e.ts)}
                    </p>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>

      {logs && (
        <LogsDialog
          containerName={logs.name}
          serverName={logs.serverPublicId === "srv_7f3a91c2e8" ? "SERVER-01" : "SERVER-02"}
          logs={logs.logs}
          onClose={() => setLogs(null)}
        />
      )}
    </ConsoleLayout>
  );
}
/**
 * Wraps the console in a Convex ErrorBoundary so a failed query renders a
 * visible, retryable error state instead of an indefinite skeleton.
 */
export default function Console() {
  return (
    <ConsoleErrorBoundary>
      <ConsoleInner />
    </ConsoleErrorBoundary>
  );
}