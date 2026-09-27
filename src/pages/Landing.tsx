import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { WordmarkMark } from "@/components/console/ui";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import { motion } from "framer-motion";
import {
  ArrowRight,
  Fingerprint,
  GitBranch,
  KeyRound,
  Lock,
  ScrollText,
  Server,
  ShieldCheck,
  Siren,
} from "lucide-react";
import { Link } from "react-router";

const fade = (delay = 0) => ({
  initial: { opacity: 0, y: 16 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.55, delay, ease: "easeOut" as const },
});

const PRINCIPLES = [
  {
    icon: KeyRound,
    title: "Identity, not hostnames",
    body: "Every machine gets an immutable ID and its own cryptographic identity. Hostnames are metadata, never authority.",
  },
  {
    icon: Lock,
    title: "Privilege, split in two",
    body: "The network-facing agent runs unprivileged. Root work happens only in a local helper that verifies signed actions.",
  },
  {
    icon: ShieldCheck,
    title: "Capabilities, not shells",
    body: "Servers expose typed capabilities with a local ceiling. There is no terminal, no root API, no generic command path.",
  },
  {
    icon: Siren,
    title: "Fail closed, run independent",
    body: "If the console or its database disappears, workloads keep running. Administration stops; operations do not.",
  },
];

const STACK = [
  { label: "Agent", value: "Go · outbound mTLS" },
  { label: "Transport", value: "gRPC over private mesh" },
  { label: "State", value: "PostgreSQL durable tasks" },
  { label: "Audit", value: "Hash-chained · three copies" },
  { label: "Access", value: "Private network only" },
];

function ArchDiagram() {
  return (
    <div className="rounded-2xl border border-border/70 bg-card/60 p-6 card-layer">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          Control plane topology
        </span>
        <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Dot ok /> Live example
        </span>
      </div>
      <pre className="mt-4 overflow-x-auto font-mono text-[11px] leading-6 text-foreground/75">{`  browser
     │  private network · HTTPS
     ▼
┌─────────────────────────────┐
│  control plane              │
│  UI · API · signer · audit  │
└──────────────┬──────────────┘
               │ outbound mTLS
       ┌───────┴────────┐
       ▼                ▼
 ┌───────────┐   ┌───────────┐
 │ SERVER-01 │   │ SERVER-02 │
 │ agent     │   │ agent     │
 │   └ helper│   │   └ helper│
 │ docker·fw │   │ docker·fw │
 └───────────┘   └───────────┘`}</pre>
    </div>
  );
}

function Dot({ ok, pulse }: { ok?: boolean; pulse?: boolean }) {
  return ok ? (
    <span className={cn("inline-block size-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_oklch(0.72_0.17_160/0.7)]", pulse && "animate-pulse")} />
  ) : (
    <span className="inline-block size-1.5 rounded-full bg-zinc-500" />
  );
}

export default function Landing() {
  const { isAuthenticated, isLoading } = useAuth();
  const consoleHref = isAuthenticated ? "/console" : "/auth?returnTo=%2Fconsole";

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* nav */}
      <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <div className="flex items-center gap-2.5">
            <WordmarkMark className="size-8 rounded-lg" />
            <div className="leading-tight">
              <div className="text-[13px] font-semibold tracking-tight">
                Server Management Console
                <span className="ml-2 font-mono text-[10px] font-normal text-muted-foreground">
                  v0.1
                </span>
              </div>
              <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                Private control plane
              </div>
            </div>
            {/*
              Truthful status only. The control plane is genuinely online; no
              agent or mTLS channel exists yet, so none is claimed.
            */}
            <span className="ml-4 hidden items-center gap-1.5 text-[11px] text-muted-foreground md:flex">
              <Dot ok pulse /> control plane online · agents not enrolled
            </span>
          </div>
          <nav className="flex items-center gap-2">
            {!isLoading && isAuthenticated ? (
              <Button asChild size="sm">
                <Link to="/console">
                  Open console <ArrowRight className="size-3.5" />
                </Link>
              </Button>
            ) : (
              <Button asChild size="sm">
                <Link to="/auth?returnTo=%2Fconsole">
                  Sign in <ArrowRight className="size-3.5" />
                </Link>
              </Button>
            )}
          </nav>
          <span className="sr-only">{consoleHref}</span>
        </div>
      </header>

      {/* hero */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 bg-grid [mask-image:radial-gradient(70%_60%_at_50%_0%,black,transparent)]" />
        <div className="absolute inset-0 glow-top" />
        <div className="relative mx-auto max-w-6xl px-6 pb-20 pt-24 md:pt-32">
          <motion.div {...fade(0)} className="flex items-center gap-3">
            <Badge
              variant="outline"
              className="border-border bg-card px-3 py-1 text-[11px] text-muted-foreground"
            >
              <Fingerprint className="mr-1.5 size-3.5 text-primary" />
              Two-server estate · zero-trust access
            </Badge>
          </motion.div>
          <motion.h1
            {...fade(0.08)}
            className="mt-6 max-w-3xl text-4xl font-semibold leading-[1.08] tracking-tight md:text-6xl"
          >
            Administration for independent servers,
            <span className="text-primary"> without handing anyone root</span>.
          </motion.h1>
          <motion.p
            {...fade(0.16)}
            className="mt-5 max-w-2xl text-base leading-7 text-muted-foreground md:text-lg"
          >
            A private management plane for SERVER-01 and SERVER-02: live
            inventory, typed actions, communication policy, and tamper-evident
            audit — while every workload keeps running even when this console
            is offline.
          </motion.p>
          <motion.div {...fade(0.24)} className="mt-8 flex flex-wrap items-center gap-3">
            <Button asChild size="lg" className="shadow-[0_0_24px_oklch(0.82_0.13_178/0.25)]">
              <Link to="/auth?returnTo=%2Fconsole">
                Enter the console <ArrowRight className="size-4" />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link to="/auth?returnTo=%2Fconsole">
                Request access
              </Link>
            </Button>
          </motion.div>
          <motion.div {...fade(0.32)} className="mt-12 grid grid-cols-2 gap-x-8 gap-y-6 sm:grid-cols-5">
            {STACK.map((s) => (
              <div key={s.label}>
                <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                  {s.label}
                </div>
                <div className="mt-1 font-mono text-[12px] text-foreground/85">{s.value}</div>
              </div>
          ))}
          </motion.div>
        </div>
      </section>

      {/* principles */}
      <section className="border-t border-border/60 py-20">
        <div className="mx-auto max-w-6xl px-6">
          <div className="flex items-end justify-between">
            <div>
              <h2 className="text-2xl font-semibold tracking-tight md:text-3xl">
                Connected does not mean coupled
              </h2>
              <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
                Four principles shape every capability in the console. They are
                enforced server-side, not promised in a UI.
              </p>
            </div>
          </div>
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {PRINCIPLES.map((p, i) => (
              <motion.div
                key={p.title}
                {...fade(0.08 * i)}
                className="rounded-xl border border-border/70 bg-card p-5 card-layer"
              >
                <div className="flex size-9 items-center justify-center rounded-lg border border-primary/20 bg-primary/10">
                  <p.icon className="size-4 text-primary" />
                </div>
                <h3 className="mt-4 text-[15px] font-semibold tracking-tight">{p.title}</h3>
                <p className="mt-2 text-[13px] leading-6 text-muted-foreground">{p.body}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* architecture */}
      <section className="border-t border-border/60 bg-card/30 py-20">
        <div className="mx-auto grid max-w-6xl gap-10 px-6 lg:grid-cols-2 lg:items-center">
          <motion.div {...fade(0)}>
            <Badge variant="outline" className="border-border bg-background px-3 py-1 text-[11px] text-muted-foreground">
              <GitBranch className="mr-1.5 size-3.5 text-primary" />
              Architecture
            </Badge>
            <h2 className="mt-5 text-2xl font-semibold tracking-tight md:text-3xl">
              One path to privilege, and it starts with a signature
            </h2>
            <p className="mt-4 text-sm leading-7 text-muted-foreground">
              The browser never reaches an agent. Requests pass through
              authentication, resource-scoped authorization, and a signer that
              issues expiring, replay-resistant action envelopes. On each
              server, an unprivileged agent hands the envelope to a root-owned
              helper that independently verifies it before touching Docker,
              systemd, or the firewall.
            </p>
            <ul className="mt-6 space-y-3">
              {[
                "Agents connect outward; managed servers expose no control port.",
                "Every action carries a nonce, an expiry, and a server-specific identity.",
                "A local capability ceiling overrides the console on every host.",
                "Audit evidence lives in three places, chained and exportable.",
              ].map((line) => (
                <li key={line} className="flex items-start gap-2.5 text-[13px] leading-6 text-muted-foreground">
                  <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" />
                  {line}
                </li>
              ))}
            </ul>
          </motion.div>
          <motion.div {...fade(0.12)}>
            <ArchDiagram />
          </motion.div>
        </div>
      </section>

      {/* audit preview */}
      <section className="border-t border-border/60 py-20">
        <div className="mx-auto max-w-6xl px-6">
          <div className="grid gap-10 lg:grid-cols-3">
            {[
              {
                icon: ScrollText,
                title: "Evidence, not logs",
                body: "Each action produces a chained record — request, authorization, approval, dispatch, receipt, verification — so history cannot be quietly rewritten.",
              },
              {
                icon: Server,
                title: "Inventory that tells the truth",
                body: "Observed state is shown next to desired state. When a server drifts, the console says so instead of papering over it.",
              },
              {
                icon: Fingerprint,
                title: "Enrollment is a ceremony",
                body: "New machines join through a one-time invitation, a fingerprint comparison you perform yourself, and explicit approval.",
              },
            ].map((c, i) => (
              <motion.div key={c.title} {...fade(0.08 * i)}>
                <div className="flex size-9 items-center justify-center rounded-lg border border-primary/20 bg-primary/10">
                  <c.icon className="size-4 text-primary" />
                </div>
                <h3 className="mt-4 text-[15px] font-semibold tracking-tight">{c.title}</h3>
                <p className="mt-2 text-[13px] leading-6 text-muted-foreground">{c.body}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="border-t border-border/60 py-24">
        <div className="mx-auto max-w-6xl px-6">
          <div className="relative overflow-hidden rounded-2xl border border-primary/20 bg-card p-10 text-center card-layer">
            <div className="absolute inset-0 glow-top" />
            <div className="relative">
              <h2 className="text-2xl font-semibold tracking-tight md:text-3xl">
                The console is waiting on you
              </h2>
              <p className="mx-auto mt-3 max-w-lg text-sm leading-6 text-muted-foreground">
                Sign in to review fleet health, approve the pending
                communication rule, or walk through a recovery drill. Access is
                restricted to the private network and every visit is recorded.
              </p>
              <div className="mt-7 flex justify-center gap-3">
                <Button asChild size="lg">
                  <Link to="/auth?returnTo=%2Fconsole">
                    Sign in <ArrowRight className="size-4" />
                  </Link>
                </Button>
              </div>
            </div>
          </div>
        </div>
      </section>

      <footer className="border-t border-border/60 py-8">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-6 text-[11px] text-muted-foreground sm:flex-row">
          <span>Server Management Console · private deployment</span>
          <span className="font-mono">
            v0.1 · self-hosted Convex · agents not yet enrolled
          </span>
        </div>
      </footer>
    </div>
  );
}
