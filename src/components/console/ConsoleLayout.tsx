import { Button } from "@/components/ui/button";
import { Wordmark, Dot, Mono } from "@/components/console/ui";
import { useAuth } from "@/hooks/use-auth";
import { signOutAndReload } from "@/lib/sign-out";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  Activity,
  ArrowUpRight,
  BadgeCheck,
  Network,
  ScrollText,
  Server,
  TerminalSquare,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link, NavLink, useNavigate } from "react-router";

const NAV = [
  { to: "/console", label: "Fleet", icon: Activity, end: true },
  { to: "/console/servers", label: "Servers", icon: Server },
  { to: "/console/communication", label: "Communication", icon: Network },
  { to: "/console/tasks", label: "Tasks & audit", icon: ScrollText },
  { to: "/console/enrollment", label: "Enrollment", icon: BadgeCheck },
] as const;

export function ConsoleLayout({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  // Centralised sign-out: invalidates the session, then forces a full-document
  // navigation so the cached Convex client is destroyed. See lib/sign-out.ts.
  const handleSignOut = async () => {
    const { ok } = await signOutAndReload();
    if (!ok) {
      toast.error("Sign out failed. Please try again.");
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* top bar */}
      <header className="sticky top-0 z-40 border-b border-border/60 bg-background/85 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="icon"
              className="lg:hidden"
              onClick={() => setOpen((v) => !v)}
              aria-label="Toggle navigation"
            >
              <TerminalSquare className="size-4" />
            </Button>
            <Wordmark className="hidden sm:flex" />
            <div className="sm:hidden text-[13px] font-semibold tracking-tight">SMC</div>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden items-center gap-1.5 text-[11px] text-muted-foreground md:flex">
              <Dot tone="ok" pulse /> gateway · mTLS up
            </span>
            <span className="hidden font-mono text-[11px] text-muted-foreground lg:block">
              epoch 1 · protocol v1
            </span>
            <span className="text-right text-[11px] leading-tight text-muted-foreground">
              {user?.email ?? "operator"}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void handleSignOut();
              }}
            >
              Sign out
            </Button>
          </div>
        </div>
      </header>

      <div className="mx-auto flex max-w-7xl gap-8 px-4 sm:px-6">
        {/* sidebar */}
        <aside
          className={cn(
            "fixed inset-x-4 top-16 z-30 rounded-xl border border-border/70 bg-card p-2 shadow-xl lg:static lg:z-auto lg:block lg:w-56 lg:shrink-0 lg:rounded-none lg:border-0 lg:bg-transparent lg:p-0 lg:shadow-none",
            open ? "block" : "hidden",
          )}
        >
          <nav className="space-y-0.5 lg:sticky lg:top-20 lg:pt-6">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={"end" in item ? item.end : false}
                onClick={() => setOpen(false)}
                className={({ isActive }) =>
                  cn(
                    "flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors",
                    isActive
                      ? "bg-primary/12 text-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )
                }
              >
                <item.icon className="size-4" />
                {item.label}
              </NavLink>
            ))}
            <div className="my-3 border-t border-border/60" />
            <a
              href="/"
              className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <ArrowUpRight className="size-4" />
              About this console
            </a>
            <div className="px-3 pb-4 pt-2">
              <Mono className="text-[10px] text-muted-foreground">
                deny-by-default · audit on
              </Mono>
            </div>
          </nav>
        </aside>

        {/* content */}
        <main className="min-w-0 flex-1 py-8">{children}</main>
      </div>
    </div>
  );
}
