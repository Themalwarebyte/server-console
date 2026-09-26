import { Mono } from "@/components/console/ui";
import { ConsoleLayout } from "@/components/console/ConsoleLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/convex/_generated/api";
import { cn } from "@/lib/utils";
import { useMutation, useQuery } from "convex/react";
import {
  BadgeCheck,
  CircleCheck,
  CircleX,
  Fingerprint,
  KeyRound,
  Plus,
  Timer,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

const STATUS_STYLES: Record<string, string> = {
  AWAITING_APPROVAL: "border-amber-400/25 bg-amber-400/10 text-amber-300",
  APPROVED: "border-emerald-400/25 bg-emerald-400/10 text-emerald-300",
  REJECTED: "border-rose-400/25 bg-rose-400/10 text-rose-300",
  INVITATION_PENDING: "border-sky-400/25 bg-sky-400/10 text-sky-300",
};

export default function Enrollment() {
  const enrollments = useQuery(api.console.listEnrollments);

  const createInvite = useMutation(api.console.createEnrollmentInvite);
  const approve = useMutation(api.console.approveEnrollment);
  const reject = useMutation(api.console.rejectEnrollment);

  const [hostLabel, setHostLabel] = useState("");
  const [creating, setCreating] = useState(false);

  const create = () => {
    if (!hostLabel.trim()) {
      toast.error("Give the host a label, e.g. SERVER-03.");
      return;
    }
    setCreating(true);
    createInvite({ hostLabel: hostLabel.trim() })
      .then(() => {
        toast.success(
          "Invitation issued. Install the agent on the host, then compare fingerprints before approving.",
        );
        setHostLabel("");
      })
      .catch((e: Error) => toast.error(e.message))
      .finally(() => setCreating(false));
  };

  return (
    <ConsoleLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Enrollment</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            New machines earn trust through a ceremony, not a shared secret.
            The private key is generated on the server and never leaves it.
          </p>
        </div>

        {/* steps */}
        <Card className="border-border/70 card-layer">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <KeyRound className="size-4 text-primary" /> How a server joins
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="grid gap-3 text-[12px] leading-5 text-muted-foreground sm:grid-cols-2 lg:grid-cols-4">
              {[
                "The owner issues a one-time invitation with a short expiry.",
                "The agent installs on the host and generates its key locally, then sends a signing request.",
                "The console and the agent both display the request fingerprint; you compare them yourself.",
                "You approve, a server-specific certificate is issued, and the invitation is consumed for good.",
              ].map((s, i) => (
                <li key={i} className="rounded-lg border border-border/50 bg-background/40 p-3">
                  <div className="font-mono text-[10px] text-primary">step {i + 1}</div>
                  <p className="mt-1">{s}</p>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>

        {/* new invite */}
        <Card className="border-border/70 card-layer">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Plus className="size-4 text-primary" /> Issue an invitation
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap items-end gap-3">
            <div className="min-w-56 flex-1 space-y-1.5">
              <Label className="text-[12px]">Host label</Label>
              <Input
                value={hostLabel}
                onChange={(e) => setHostLabel(e.target.value)}
                placeholder="SERVER-03"
                onKeyDown={(e) => e.key === "Enter" && create()}
              />
            </div>
            <Button onClick={create} disabled={creating}>Create invitation</Button>
          </CardContent>
        </Card>

        {/* pending + history */}
        <div className="space-y-3">
          {(enrollments ?? []).map((e) => {
            const expired = e.expiresAt < Date.now();
            return (
              <Card key={e._id} className={cn("border-border/70 card-layer", (e.status !== "AWAITING_APPROVAL") && "opacity-70")}>
                <CardContent className="pt-6">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2.5">
                        <BadgeCheck className="size-4 text-primary" />
                        <span className="text-[14px] font-semibold tracking-tight">{e.hostLabel}</span>
                        <Badge variant="outline" className={cn("text-[10px]", STATUS_STYLES[e.status])}>
                          {e.status.toLowerCase().replace(/_/g, " ")}
                        </Badge>
                        {expired && e.status === "AWAITING_APPROVAL" && (
                          <Badge variant="outline" className="border-rose-400/25 bg-rose-400/10 text-[10px] text-rose-300">
                            <Timer className="mr-1 size-3" /> expired
                          </Badge>
                        )}
                      </div>
                      <div className="mt-3 space-y-1.5 text-[12px]">
                        <div className="flex flex-wrap items-baseline gap-x-3">
                          <span className="text-muted-foreground">CSRF request fingerprint:</span>
                          <Mono className="text-foreground/85">{e.csrFingerprint}</Mono>
                        </div>
                        <p className="text-muted-foreground">
                          Compare this value against the output printed by the
                          agent on {e.hostLabel} before approving. Agent version{" "}
                          <Mono>{e.agentVersion}</Mono> · hostname <Mono>{e.hostname}</Mono>.
                        </p>
                        <p className="text-[11px] text-muted-foreground/80">{e.note}</p>
                      </div>
                    </div>
                    {e.status === "AWAITING_APPROVAL" && !expired && (
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          onClick={() =>
                            approve({ enrollmentId: e._id })
                              .then(() => toast.success(`${e.hostLabel} enrolled — server-specific certificate issued`))
                              .catch((err: Error) => toast.error(err.message))
                          }
                        >
                          <CircleCheck className="size-3.5" /> Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            reject({ enrollmentId: e._id })
                              .then(() => toast.success("Invitation rejected and consumed"))
                              .catch((err: Error) => toast.error(err.message))
                          }
                        >
                          <CircleX className="size-3.5" /> Reject
                        </Button>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}

          {(enrollments ?? []).length === 0 && (
            <Card className="border-dashed border-border/70">
              <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
                <Fingerprint className="size-5 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  No invitations yet. SERVER-01 and SERVER-02 enrolled before
                  this view existed.
                </p>
              </CardContent>
            </Card>
          )}
        </div>

        <p className="text-[11px] text-muted-foreground">
          A server that stays offline past certificate expiry is never trusted
          automatically again — it re-enrolls through a restricted path that
          requires explicit owner approval. Hostname collisions do not block
          enrollment; duplicate key material does.
        </p>
      </div>
    </ConsoleLayout>
  );
}
