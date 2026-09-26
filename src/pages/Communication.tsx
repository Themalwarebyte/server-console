import { Mono } from "@/components/console/ui";
import { ConsoleLayout } from "@/components/console/ConsoleLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/convex/_generated/api";
import { cn } from "@/lib/utils";
import { useMutation, useQuery } from "convex/react";
import {
  ArrowDown,
  CircleCheck,
  CircleX,
  Clock,
  Network,
  Plus,
  ShieldAlert,
  Undo2,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

const LAYER_STYLES: Record<string, string> = {
  ACTIVE: "border-emerald-400/25 bg-emerald-400/10 text-emerald-300",
  PENDING_APPROVAL: "border-amber-400/25 bg-amber-400/10 text-amber-300",
  REVOKED: "border-zinc-400/25 bg-zinc-400/5 text-zinc-400",
  VERIFIED: "border-emerald-400/25 bg-emerald-400/10 text-emerald-300",
  PENDING: "border-amber-400/25 bg-amber-400/10 text-amber-300",
  FAILED: "border-rose-400/25 bg-rose-400/10 text-rose-300",
};

function nameFor(id: string) {
  if (id === "srv_7f3a91c2e8") return "SERVER-01";
  if (id === "srv_2b6e40af15") return "SERVER-02";
  return id;
}

export default function Communication() {
  const rules = useQuery(api.console.listCommRules);
  const servers = useQuery(api.console.listServers);

  const requestRule = useMutation(api.console.requestCommRule);
  const approveRule = useMutation(api.console.approveCommRule);
  const revokeRule = useMutation(api.console.revokeCommRule);

  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [sourceServer, setSourceServer] = useState("");
  const [sourceProject, setSourceProject] = useState("");
  const [destServer, setDestServer] = useState("");
  const [destService, setDestService] = useState("");
  const [port, setPort] = useState("443");
  const [proto, setProto] = useState("tcp");
  const [path, setPath] = useState("tailscale0");
  const [permanence, setPermanence] = useState("TEMPORARY");
  const [note, setNote] = useState("");

  const pending = (rules ?? []).filter((r) => r.status === "PENDING_APPROVAL");

  const submit = () => {
    if (!name.trim() || !sourceServer || !destServer || !destService.trim()) {
      toast.error("Fill in the rule name, both servers, and the destination service.");
      return;
    }
    requestRule({
      name: name.trim(),
      sourceServer,
      sourceProject: sourceProject.trim() || "unspecified",
      destServer,
      destService: destService.trim(),
      proto,
      port: Number(port) || 443,
      path,
      permanence,
      note: note.trim() || "No reason recorded.",
    })
      .then(() => {
        toast.success("Rule drafted — impact preview and approval required before enforcement");
        setShowForm(false);
        setName("");
        setNote("");
      })
      .catch((e: Error) => toast.error(e.message));
  };

  return (
    <ConsoleLayout>
      <div className="space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Communication</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Server-to-server traffic is denied by default. Each allow rule is
              a reviewed exception with a reason, an owner, and an expiry.
            </p>
          </div>
          <Button size="sm" onClick={() => setShowForm((v) => !v)}>
            <Plus className="size-3.5" /> Draft rule
          </Button>
        </div>

        {showForm && (
          <Card className="border-border/70 card-layer">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Network className="size-4 text-primary" /> New communication rule
              </CardTitle>
              <p className="text-[12px] text-muted-foreground">
                R3 security-sensitive action. On approval the rule is compiled
                into the agent-owned firewall chain on the destination host and
                verified with positive and negative connectivity tests.
              </p>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5 sm:col-span-2">
                <Label className="text-[12px]">Rule name</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Webapp API consumes platform gateway" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-[12px]">Source server</Label>
                <Select value={sourceServer} onValueChange={setSourceServer}>
                  <SelectTrigger><SelectValue placeholder="Select server" /></SelectTrigger>
                  <SelectContent>
                    {(servers ?? []).map((s) => (
                      <SelectItem key={s.publicId} value={s.publicId}>{s.displayName}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-[12px]">Source project</Label>
                <Input value={sourceProject} onChange={(e) => setSourceProject(e.target.value)} placeholder="webapp" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-[12px]">Destination server</Label>
                <Select value={destServer} onValueChange={setDestServer}>
                  <SelectTrigger><SelectValue placeholder="Select server" /></SelectTrigger>
                  <SelectContent>
                    {(servers ?? []).map((s) => (
                      <SelectItem key={s.publicId} value={s.publicId}>{s.displayName}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-[12px]">Destination service</Label>
                <Input value={destService} onChange={(e) => setDestService(e.target.value)} placeholder="api-gateway" />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-[12px]">Protocol</Label>
                  <Select value={proto} onValueChange={setProto}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="tcp">tcp</SelectItem>
                      <SelectItem value="udp">udp</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-[12px]">Port</Label>
                  <Input type="number" value={port} onChange={(e) => setPort(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-[12px]">Path</Label>
                  <Select value={path} onValueChange={setPath}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="tailscale0">tailscale0</SelectItem>
                      <SelectItem value="lan">lan</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-[12px]">Duration</Label>
                <Select value={permanence} onValueChange={setPermanence}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="TEMPORARY">Temporary — expires on the host in 6h</SelectItem>
                    <SelectItem value="PERMANENT">Permanent</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label className="text-[12px]">Reason</Label>
                <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why this connection must exist" />
              </div>
              <div className="flex items-center gap-2 sm:col-span-2">
                <Button size="sm" onClick={submit}>Create draft</Button>
                <Button size="sm" variant="ghost" onClick={() => setShowForm(false)}>Cancel</Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* pending approvals */}
        {pending.length > 0 && (
          <Card className="border-amber-400/25 bg-amber-400/[0.03] card-layer">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Clock className="size-4 text-amber-300" /> Awaiting your approval
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {pending.map((r) => (
                <div key={r._id} className="rounded-lg border border-amber-400/20 bg-background/40 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="text-[13px] font-medium">{r.name}</div>
                      <div className="mt-2 flex items-center gap-2 font-mono text-[11.5px] text-muted-foreground">
                        <span className="text-foreground/85">{nameFor(r.sourceServer)} / {r.sourceProject}</span>
                        <ArrowDown className="size-3.5 rotate-[-90deg] text-primary" />
                        <span className="text-foreground/85">{nameFor(r.destServer)} / {r.destService}</span>
                        <Badge variant="outline" className="border-border/60 font-mono text-[10px]">
                          {r.proto}/{r.port} · {r.path}
                        </Badge>
                      </div>
                      <p className="mt-2 max-w-xl text-[12px] text-muted-foreground">{r.note}</p>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        onClick={() =>
                          approveRule({ ruleId: r._id })
                            .then(() => toast.success("Rule approved, applied, and verified"))
                            .catch((e: Error) => toast.error(e.message))
                        }
                      >
                        Approve & apply
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          revokeRule({ ruleId: r._id })
                            .then(() => toast.success("Draft rejected"))
                            .catch((e: Error) => toast.error(e.message))
                        }
                      >
                        Reject
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        {/* rule list */}
        <div className="grid gap-4 lg:grid-cols-2">
          {(rules ?? []).map((r) => (
            <Card key={r._id} className={cn("border-border/70 card-layer", r.status === "REVOKED" && "opacity-60")}>
              <CardHeader className="pb-3">
                <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-[15px]">
                  {r.name}
                  <span className="flex items-center gap-2">
                    <Badge variant="outline" className={cn("text-[10px]", LAYER_STYLES[r.status])}>
                      {r.status.toLowerCase().replace("_", " ")}
                    </Badge>
                    <Badge variant="outline" className={cn("text-[10px]", LAYER_STYLES[r.verification])}>
                      {r.verification.toLowerCase()}
                    </Badge>
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {/* mini graph */}
                <div className="flex items-center gap-3 rounded-lg border border-border/50 bg-background/40 px-4 py-3">
                  <div className="text-center">
                    <Mono className="text-foreground/90">{nameFor(r.sourceServer)}</Mono>
                    <div className="text-[10px] text-muted-foreground">{r.sourceProject}</div>
                  </div>
                  <div className="flex-1 border-t border-dashed border-primary/40" />
                  <div className="text-center">
                    <Mono className="text-primary">{r.proto}/{r.port}</Mono>
                    <div className="text-[10px] text-muted-foreground">{r.path}</div>
                  </div>
                  <div className="flex-1 border-t border-dashed border-primary/40" />
                  <div className="text-center">
                    <Mono className="text-foreground/90">{nameFor(r.destServer)}</Mono>
                    <div className="text-[10px] text-muted-foreground">{r.destService}</div>
                  </div>
                </div>
                <p className="text-[12px] text-muted-foreground">{r.note}</p>
                <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
                  <span>
                    {r.permanence === "TEMPORARY"
                      ? `temporary · expires on the host ${r.expiresAt ? new Date(r.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}`
                      : "permanent"} · by {r.createdBy}{r.approvedBy ? ` · approved by ${r.approvedBy}` : ""}
                  </span>
                  {r.status === "ACTIVE" && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        revokeRule({ ruleId: r._id })
                          .then(() => toast.success("Rule revoked and removed from the host"))
                          .catch((e: Error) => toast.error(e.message))
                      }
                    >
                      <Undo2 className="size-3.5" /> Revoke
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* enforcement layers */}
        <Card className="border-border/70 card-layer">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Enforcement layers</CardTitle>
            <p className="text-[12px] text-muted-foreground">
              A rule is only as strong as the layer that finally blocks the packet.
            </p>
          </CardHeader>
          <CardContent className="grid gap-3 text-[12px] sm:grid-cols-2 lg:grid-cols-4">
            {[
              { t: "1 · Service auth", d: "Applications still authenticate their own requests; network reachability is not authorization." },
              { t: "2 · Overlay policy", d: "Mesh policy restricts traffic that crosses the private network, read-only in this build." },
              { t: "3 · Host firewall", d: "The decisive layer. Agent-owned chains, atomic apply, automatic rollback on failure." },
              { t: "4 · Runtime networks", d: "Compose-scoped networks and bind scopes keep projects isolated by default." },
            ].map((l) => (
              <div key={l.t} className="rounded-lg border border-border/50 bg-background/40 p-3">
                <div className="text-foreground/85">{l.t}</div>
                <p className="mt-1.5 leading-5 text-muted-foreground">{l.d}</p>
              </div>
            ))}
          </CardContent>
        </Card>

        <div className="flex items-start gap-2.5 rounded-lg border border-border/50 bg-card/60 px-4 py-3 text-[12px] text-muted-foreground">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-300" />
          <p>
            The console never runs <Mono>iptables -F</Mono> or touches rules
            outside its own chains. Temporary rules expire on the target host,
            so a console outage can never turn a one-hour allow into a
            permanent one.
          </p>
        </div>
      </div>
    </ConsoleLayout>
  );
}
