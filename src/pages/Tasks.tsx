import { RiskBadge, Mono } from "@/components/console/ui";
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
import { cn } from "@/lib/utils";
import { useMutation, useQuery } from "convex/react";
import {
  Activity,
  CircleCheck,
  CircleX,
  Copy,
  History,
  ScrollText,
  ShieldCheck,
  TimerReset,
} from "lucide-react";
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

const STATE_STYLES: Record<string, string> = {
  SUCCEEDED: "text-emerald-300",
  PENDING_APPROVAL: "text-amber-300",
  FAILED: "text-rose-300",
  REJECTED: "text-rose-300",
  CANCELLED: "text-zinc-400",
  EXPIRED: "text-zinc-400",
};

export default function Tasks() {
  const tasks = useQuery(api.console.listTasks);
  const audit = useQuery(api.console.listAudit);

  const replay = useMutation(api.console.simulateReplayAttempt);
  const drill = useMutation(api.console.runRecoveryDrill);

  return (
    <ConsoleLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Tasks & audit</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Every privileged operation is a signed, expiring envelope. The audit
            stream below is append-only and hash-chained.
          </p>
        </div>

        {/* tasks */}
        <Card className="border-border/70 card-layer">
          <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Activity className="size-4 text-primary" /> Task ledger
            </CardTitle>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                replay()
                  .then(() => toast.success("Replay attempted and rejected by the execution ledger"))
                  .catch((e: Error) => toast.error(e.message))
              }
            >
              <Copy className="size-3.5" /> Simulate replay attempt
            </Button>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="text-[11px] uppercase tracking-[0.1em]">Task</TableHead>
                  <TableHead className="text-[11px] uppercase tracking-[0.1em]">Capability</TableHead>
                  <TableHead className="hidden text-[11px] uppercase tracking-[0.1em] md:table-cell">Target</TableHead>
                  <TableHead className="text-[11px] uppercase tracking-[0.1em]">Risk</TableHead>
                  <TableHead className="text-[11px] uppercase tracking-[0.1em]">State</TableHead>
                  <TableHead className="hidden text-right text-[11px] uppercase tracking-[0.1em] md:table-cell">Envelope hash</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(tasks ?? []).map((t) => (
                  <TableRow key={t._id}>
                    <TableCell>
                      <Mono className="text-foreground/85">{t.taskRef}</Mono>
                      <div className="text-[11px] text-muted-foreground">
                        by {t.requestedBy}
                        {t.approver ? ` · approved by ${t.approver}` : ""}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Mono className="text-foreground/85">{t.capability}</Mono>
                      {t.replayAttempted && (
                        <Badge variant="outline" className="ml-2 border-rose-400/25 bg-rose-400/10 text-[10px] text-rose-300">
                          replay seen
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="hidden text-[12px] text-muted-foreground md:table-cell">
                      {t.containerName ?? "—"} · {t.serverPublicId === "srv_7f3a91c2e8" ? "SERVER-01" : t.serverPublicId === "srv_2b6e40af15" ? "SERVER-02" : t.serverPublicId}
                    </TableCell>
                    <TableCell><RiskBadge risk={t.riskClass} /></TableCell>
                    <TableCell>
                      <span className={cn("flex items-center gap-1.5 font-mono text-[11px]", STATE_STYLES[t.state] ?? "")}>
                        {t.state === "SUCCEEDED" ? (
                          <CircleCheck className="size-3.5" />
                        ) : t.state === "FAILED" || t.state === "REJECTED" ? (
                          <CircleX className="size-3.5" />
                        ) : (
                          <History className="size-3.5" />
                        )}
                        {t.state.toLowerCase().replace("_", " ")}
                      </span>
                      {t.resultNote && (
                        <div className="mt-0.5 max-w-60 text-[10px] text-muted-foreground">{t.resultNote}</div>
                      )}
                    </TableCell>
                    <TableCell className="hidden text-right md:table-cell">
                      <Mono className="text-[10.5px] text-muted-foreground">
                        {t.envelopeHash.slice(0, 18)}…
                      </Mono>
                    </TableCell>
                  </TableRow>
                ))}
                {(tasks ?? []).length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="py-8 text-center text-[12px] text-muted-foreground">
                      No tasks yet — run one from a server's container list.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/* recovery drill */}
        <Card className="border-border/70 card-layer">
          <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <TimerReset className="size-4 text-primary" /> Recovery posture
            </CardTitle>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                drill()
                  .then(() => toast.success("Recovery drill recorded in the audit chain"))
                  .catch((e: Error) => toast.error(e.message))
              }
            >
              Record recovery drill
            </Button>
          </CardHeader>
          <CardContent className="grid gap-3 text-[12px] text-muted-foreground sm:grid-cols-3">
            <div className="rounded-lg border border-border/50 bg-background/40 p-3">
              <div className="flex items-center gap-1.5 text-foreground/85">
                <ShieldCheck className="size-3.5 text-emerald-400" /> Console offline
              </div>
              <p className="mt-1.5">Workloads keep running; agents buffer results and reconnect when the plane returns.</p>
            </div>
            <div className="rounded-lg border border-border/50 bg-background/40 p-3">
              <div className="flex items-center gap-1.5 text-foreground/85">
                <ShieldCheck className="size-3.5 text-emerald-400" /> Restored database
              </div>
              <p className="mt-1.5">Executed tasks cannot replay: nonces, expiries, and the recovery epoch stand guard.</p>
            </div>
            <div className="rounded-lg border border-border/50 bg-background/40 p-3">
              <div className="flex items-center gap-1.5 text-foreground/85">
                <ShieldCheck className="size-3.5 text-emerald-400" /> Break-glass
              </div>
              <p className="mt-1.5">Local SSH and console-independent recovery material stay outside this system's blast radius.</p>
            </div>
          </CardContent>
        </Card>

        {/* audit */}
        <Card className="border-border/70 card-layer">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <ScrollText className="size-4 text-primary" /> Audit chain
            </CardTitle>
            <p className="text-[12px] text-muted-foreground">
              Each event commits to its predecessor's hash. Copies also live on
              each server and in an off-host export.
            </p>
          </CardHeader>
          <CardContent className="space-y-2">
            {(audit ?? []).map((e) => (
              <div
                key={e._id}
                className="flex items-start gap-3 rounded-lg border border-border/50 bg-background/40 px-3 py-2.5"
              >
                <Mono className="mt-0.5 w-10 shrink-0 text-[10px] text-muted-foreground">#{String(e.seq).padStart(3, "0")}</Mono>
                <div className="min-w-0 flex-1">
                  <p className="text-[12.5px] leading-5 text-foreground/90">{e.summary}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-muted-foreground">
                    <span className="rounded bg-muted px-1.5 py-0.5">{e.kind}</span>
                    <span>{e.actor}</span>
                    {e.serverPublicId && <span>{e.serverPublicId === "srv_7f3a91c2e8" ? "SERVER-01" : e.serverPublicId === "srv_2b6e40af15" ? "SERVER-02" : e.serverPublicId}</span>}
                    {e.riskClass && <RiskBadge risk={e.riskClass} />}
                    <span>{relative(e.ts)}</span>
                    <span className="hidden sm:inline">hash {e.hash.slice(5, 21)}…</span>
                  </div>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </ConsoleLayout>
  );
}
