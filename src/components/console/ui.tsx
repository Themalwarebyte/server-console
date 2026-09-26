import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { motion } from "framer-motion";
import { ShieldCheck, Terminal } from "lucide-react";
import { useState, type ReactNode } from "react";

/* ------------------------------------------------------------------ */
/* wordmark                                                            */
/* ------------------------------------------------------------------ */

export function Wordmark({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <div className="relative flex size-8 shrink-0 items-center justify-center rounded-lg border border-primary/30 bg-primary/10">
        <div className="size-3.5 rounded-[5px] bg-primary/90 shadow-[0_0_14px_oklch(0.82_0.13_178/0.45)]" />
        <div className="absolute inset-0 rounded-lg ring-1 ring-inset ring-white/5" />
      </div>
      <div className="leading-tight">
        <div className="text-[13px] font-semibold tracking-tight">
          Server Management Console
        </div>
        <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          Private control plane
        </div>
      </div>
    </div>
  );
}

export function WordmarkMark({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "relative flex size-10 items-center justify-center rounded-xl border border-primary/30 bg-primary/10",
        className,
      )}
    >
      <div className="size-4 rounded-[6px] bg-primary shadow-[0_0_18px_oklch(0.82_0.13_178/0.5)]" />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* badges + dots                                                       */
/* ------------------------------------------------------------------ */

const LIFECYCLE_STYLES: Record<string, string> = {
  ACTIVE: "border-emerald-400/25 bg-emerald-400/10 text-emerald-300",
  PENDING_ENROLLMENT: "border-amber-400/25 bg-amber-400/10 text-amber-300",
  STALE: "border-amber-400/25 bg-amber-400/10 text-amber-300",
  OFFLINE: "border-zinc-400/25 bg-zinc-400/10 text-zinc-300",
  QUARANTINED: "border-rose-400/25 bg-rose-400/10 text-rose-300",
  RETIRED: "border-zinc-400/20 bg-zinc-400/5 text-zinc-400",
};

export function LifecycleBadge({ state }: { state: string }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "px-2 py-0.5 text-[11px] font-medium tracking-wide",
        LIFECYCLE_STYLES[state] ??
          "border-border bg-muted text-muted-foreground",
      )}
    >
      {state.replace("_", " ").toLowerCase()}
    </Badge>
  );
}

const RISK_STYLES: Record<string, string> = {
  R0: "border-sky-400/25 bg-sky-400/10 text-sky-300",
  R1: "border-emerald-400/25 bg-emerald-400/10 text-emerald-300",
  R2: "border-amber-400/25 bg-amber-400/10 text-amber-300",
  R3: "border-orange-400/25 bg-orange-400/10 text-orange-300",
  R4: "border-rose-400/25 bg-rose-400/10 text-rose-300",
};

export function RiskBadge({ risk }: { risk?: string | null }) {
  if (!risk) return null;
  return (
    <Badge
      variant="outline"
      className={cn(
        "px-1.5 py-0 font-mono text-[10px] font-semibold tracking-wider",
        RISK_STYLES[risk] ?? "border-border bg-muted text-muted-foreground",
      )}
    >
      {risk}
    </Badge>
  );
}

export function Dot({
  tone,
  pulse,
  className,
}: {
  tone: "ok" | "warn" | "bad" | "idle";
  pulse?: boolean;
  className?: string;
}) {
  const tones = {
    ok: "bg-emerald-400 shadow-[0_0_8px_oklch(0.72_0.17_160/0.7)]",
    warn: "bg-amber-400 shadow-[0_0_8px_oklch(0.79_0.15_85/0.6)]",
    bad: "bg-rose-400 shadow-[0_0_8px_oklch(0.68_0.19_25/0.6)]",
    idle: "bg-zinc-500",
  } as const;
  return (
    <span
      className={cn(
        "inline-block size-1.5 shrink-0 rounded-full",
        tones[tone],
        pulse && "animate-pulse",
        className,
      )}
    />
  );
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn("font-mono text-[12px] tracking-tight", className)}>
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* stat tile                                                           */
/* ------------------------------------------------------------------ */

export function StatTile({
  label,
  value,
  sub,
  icon,
  tone = "default",
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  icon?: ReactNode;
  tone?: "default" | "warn" | "bad";
}) {
  const toneRing =
    tone === "warn"
      ? "ring-amber-400/20"
      : tone === "bad"
        ? "ring-rose-400/20"
        : "ring-transparent";
  return (
    <div
      className={cn(
        "rounded-xl border border-border/70 bg-card p-4 card-layer",
        toneRing,
      )}
    >
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          {label}
        </span>
        {icon && <span className="text-muted-foreground">{icon}</span>}
      </div>
      <div className="mt-2 text-2xl font-semibold tracking-tight tabular">
        {value}
      </div>
      {sub && <div className="mt-1 text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

export function Meter({ value, tone }: { value: number; tone?: "warn" | "bad" }) {
  const color =
    tone === "bad"
      ? "bg-rose-400"
      : tone === "warn"
        ? "bg-amber-400"
        : "bg-primary";
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <motion.div
        className={cn("h-full rounded-full", color)}
        initial={{ width: 0 }}
        animate={{ width: `${Math.min(100, Math.max(2, value))}%` }}
        transition={{ duration: 0.6, ease: "easeOut" }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* container log viewer (bounded window)                               */
/* ------------------------------------------------------------------ */

export function LogsDialog({
  containerName,
  serverName,
  logs,
  onClose,
}: {
  containerName: string;
  serverName: string;
  logs: string[];
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const bounded = logs.slice(-40);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl border-border/80 bg-card">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Terminal className="size-4 text-primary" />
            Container logs — {containerName}
          </DialogTitle>
          <DialogDescription>
            Bounded retrieval from {serverName}: last {bounded.length} lines,
            max 8 KiB per request. Logs are rendered as plain text; no secrets
            are collected automatically.
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="h-72 rounded-lg border border-border/70 bg-background/80">
          <pre className="whitespace-pre-wrap p-4 font-mono text-[11.5px] leading-5 text-foreground/85">
            {bounded.length === 0
              ? "No recent output."
              : bounded.join("\n")}
          </pre>
        </ScrollArea>
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <ShieldCheck className="size-3.5 text-emerald-400" />
            Read-only capability · docker.logs v1
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void navigator.clipboard?.writeText(bounded.join("\n"));
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
