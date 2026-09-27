import {
  Dot,
  LifecycleBadge,
  Meter,
  Mono,
} from "@/components/console/ui";
import { ConsoleLayout } from "@/components/console/ConsoleLayout";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/convex/_generated/api";
import { useQuery } from "convex/react";
import { ArrowRight, ShieldCheck } from "lucide-react";
import { Link } from "react-router";

export default function Servers() {
  const servers = useQuery(api.console.listServers);

  if (servers === undefined) {
    return (
      <ConsoleLayout>
        <div className="space-y-4">
          <Skeleton className="h-8 w-48" />
          <div className="grid gap-4 lg:grid-cols-2">
            <Skeleton className="h-44 rounded-xl" />
            <Skeleton className="h-44 rounded-xl" />
          </div>
        </div>
      </ConsoleLayout>
    );
  }

  return (
    <ConsoleLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Servers</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Each machine carries an immutable identity and its own credentials.
            Hostnames shown here are metadata, never proof of identity.
          </p>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          {servers.map((s) => {
            const diskPct = (s.hardware.diskUsedGb / s.hardware.diskGb) * 100;
            return (
              <Link key={s.publicId} to={`/console/servers/${s.publicId}`} className="group">
                <Card className="h-full border-border/70 transition-colors group-hover:border-primary/40 card-layer">
                  <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
                    <CardTitle className="flex items-center gap-2.5 text-base">
                      <Dot tone={s.lifecycleState === "ACTIVE" ? "ok" : "warn"} pulse />
                      {s.displayName}
                      <LifecycleBadge state={s.lifecycleState} />
                    </CardTitle>
                    <ArrowRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-[12px] text-muted-foreground">
                      <div className="flex justify-between sm:col-span-1">
                        <span>Hostname</span>
                        <Mono className="text-foreground/80">{s.hostname}</Mono>
                      </div>
                      <div className="flex justify-between">
                        <span>Server ID</span>
                        <Mono className="text-foreground/80">{s.publicId}</Mono>
                      </div>
                      <div className="flex justify-between">
                        <span>Environment</span>
                        <Mono className="text-foreground/80">{s.environment}</Mono>
                      </div>
                      <div className="flex justify-between">
                        <span>Agent</span>
                        {/* No agent is enrolled in V0.1. */}
                        <Mono className="text-foreground/80">
                          {s.agent ? `${s.agent.version} · ${s.agent.protocolVersion}` : "Not enrolled"}
                        </Mono>
                      </div>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div>
                        <div className="mb-1.5 flex justify-between text-[11px] text-muted-foreground">
                          <span>Memory</span>
                          <span className="tabular">{s.memUsedPct.toFixed(0)}%</span>
                        </div>
                        <Meter value={s.memUsedPct} tone={s.memUsedPct > 60 ? "warn" : undefined} />
                      </div>
                      <div>
                        <div className="mb-1.5 flex justify-between text-[11px] text-muted-foreground">
                          <span>Disk</span>
                          <span className="tabular">{diskPct.toFixed(0)}%</span>
                        </div>
                        <Meter value={diskPct} tone={diskPct > 80 ? "warn" : undefined} />
                      </div>
                    </div>
                    <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                      <ShieldCheck className="size-3.5 text-emerald-400" />
                      {s.capabilities.filter((c) => c.locallyEnabled && c.supported).length} capabilities enabled locally
                      {/* No agent is enrolled, so no capability ceiling and no
                          identity have been negotiated. */}
                      {" · capability ceiling: not negotiated · "}
                      {s.identity
                        ? `identity fingerprint ${s.identity.fingerprint.slice(0, 13)}…`
                        : "identity: not issued"}
                    </div>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>

        {servers.length === 0 && (
          <Card className="border-dashed border-border/70">
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              No servers registered yet. Start from the enrollment page.
            </CardContent>
          </Card>
        )}

        <p className="text-[11px] text-muted-foreground">
          Retired and replaced servers never leave this history; their audit
          trail stays queryable. Registration never implies failover —{" "}
          <Badge variant="outline" className="border-border/60 text-[10px] text-muted-foreground">
            SERVER-02 is not a backup for SERVER-01
          </Badge>
        </p>
      </div>
    </ConsoleLayout>
  );
}
