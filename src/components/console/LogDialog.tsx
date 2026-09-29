import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { TriangleAlert, Loader2, ScrollText } from "lucide-react";

/**
 * Milestone B — read-only container logs.
 *
 * SECURITY
 *   Every line is rendered as a TEXT NODE. `dangerouslySetInnerHTML` is never
 *   used, so log content can never become markup. The helper has already
 *   stripped ANSI escapes and control characters, and applied best-effort
 *   redaction on the managed host before anything left it.
 *
 *   Redaction is best effort. The operator is told so directly, rather than
 *   being given false assurance.
 *
 * LIFECYCLE
 *   There is NO automatic polling for new log content. The operator requests
 *   once, the result is delivered once, and consuming it deletes the buffer.
 *   "Refresh" issues a NEW request rather than re-reading, because a result can
 *   be consumed only once.
 */

type Phase =
  | { kind: "idle" }
  | { kind: "requesting" }
  | { kind: "waiting"; requestId: string }
  | { kind: "ready"; payload: ResultPayload };

interface ResultPayload {
  status: string;
  requestId: string;
  containerName?: string | null;
  ok?: boolean;
  lines?: { ts: number; text: string }[];
  lineCount?: number;
  byteCount?: number;
  truncated?: boolean;
  errorClass?: string | null;
}

export function LogAccessControl({
  serverPublicId,
  containerId,
  containerName,
  available,
}: {
  serverPublicId: string;
  containerId: string;
  containerName: string;
  available: boolean;
}) {
  const [open, setOpen] = useState(false);

  if (!available) {
    return (
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <ScrollText className="size-3.5" />
        Log access not available on this host
      </div>
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <ScrollText className="mr-1.5 size-3.5" />
          View logs
        </Button>
      </DialogTrigger>
      <LogDialogBody
        serverPublicId={serverPublicId}
        containerId={containerId}
        containerName={containerName}
        onClose={() => setOpen(false)}
      />
    </Dialog>
  );
}

function LogDialogBody({
  serverPublicId,
  containerId,
  containerName,
  onClose,
}: {
  serverPublicId: string;
  containerId: string;
  containerName: string;
  onClose: () => void;
}) {
  const request = useMutation(api.logAccess.requestContainerLogs);
  const status = useMutation(api.logAccess.consumeLogResult);

  const [tail, setTail] = useState(100);
  const [timestamps, setTimestamps] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current) window.clearInterval(timer.current);
    },
    [],
  );

  const submit = useCallback(async () => {
    setError(null);
    setPhase({ kind: "requesting" });
    try {
      const { requestId } = await request({
        serverPublicId,
        containerId,
        tail,
        timestamps,
      });
      setPhase({ kind: "waiting", requestId });

      // Poll the REQUEST STATE only. This never re-reads content: the buffer is
      // consumed exactly once, below.
      let tries = 0;
      timer.current = window.setInterval(async () => {
        tries += 1;
        try {
          const s: any = await status({ requestId });
          if (s.status === "COMPLETE" || s.status === "FAILED" || s.status === "EXPIRED") {
            if (timer.current) window.clearInterval(timer.current);
            const payload: ResultPayload = (await status({
              requestId,
            })) as ResultPayload;
            setPhase({ kind: "ready", payload });
          } else if (tries > 30) {
            if (timer.current) window.clearInterval(timer.current);
            setError("Timed out waiting for the agent.");
            setPhase({ kind: "idle" });
          }
        } catch {
          /* transient; the next tick retries */
        }
      }, 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not request logs.");
      setPhase({ kind: "idle" });
    }
  }, [serverPublicId, containerId, tail, timestamps, request, status]);

  const payload = phase.kind === "ready" ? phase.payload : null;
  const lines = payload?.lines ?? [];

  return (
    <DialogContent className="max-w-3xl">
      <DialogHeader>
        <DialogTitle>Container logs</DialogTitle>
        <DialogDescription>
          {containerName} · read-only, bounded tail
        </DialogDescription>
      </DialogHeader>

      <div className="flex items-start gap-2 rounded-md border border-amber-400/30 bg-amber-400/5 p-2.5 text-[12px] text-amber-200/90">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
        <span>
          Container logs may contain sensitive information. Patterns are
          redacted on the host before the data leaves it, but redaction is best
          effort and is not a guarantee.
        </span>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <div className="w-32">
          <Label htmlFor="log-tail" className="text-[11px]">
            Lines (max 500)
          </Label>
          <input
            id="log-tail"
            type="number"
            min={1}
            max={500}
            value={tail}
            onChange={(e) => setTail(Math.max(1, Math.min(500, Number(e.target.value) || 1)))}
            disabled={phase.kind === "requesting" || phase.kind === "waiting"}
            className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
          />
        </div>
        <div className="flex items-center gap-2 pb-1.5">
          <Switch id="log-ts" checked={timestamps} onCheckedChange={setTimestamps} />
          <Label htmlFor="log-ts" className="text-[11px]">
            Timestamps
          </Label>
        </div>
        <Button
          size="sm"
          onClick={submit}
          disabled={phase.kind === "requesting" || phase.kind === "waiting"}
        >
          {phase.kind === "requesting" || phase.kind === "waiting" ? (
            <>
              <Loader2 className="mr-1.5 size-3.5 animate-spin" />
              {phase.kind === "requesting" ? "Requesting…" : "Waiting for agent…"}
            </>
          ) : (
            "Request logs"
          )}
        </Button>
      </div>

      {error && <p className="text-sm text-rose-400">{error}</p>}

      {payload && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
            <span>
              status: <span className="text-foreground/85">{payload.status}</span>
            </span>
            {payload.lineCount !== undefined && (
              <span>
                lines: <span className="text-foreground/85">{payload.lineCount}</span>
              </span>
            )}
            {payload.byteCount !== undefined && (
              <span>
                bytes: <span className="text-foreground/85">{payload.byteCount}</span>
              </span>
            )}
            {payload.truncated && (
              <span className="text-amber-300/90">truncated</span>
            )}
            {payload.errorClass && (
              <span className="text-rose-300/90">{payload.errorClass}</span>
            )}
          </div>

          {lines.length > 0 && (
            <pre className="max-h-[45vh] overflow-auto rounded-md border border-border/60 bg-background/60 p-2 text-[11px] leading-relaxed">
              {lines.map((l, i) => (
                // TEXT NODE, always. Log content is never markup.
                <div key={i} className="whitespace-pre-wrap break-all">
                  {timestamps && l.ts
                    ? `[${new Date(l.ts).toISOString().slice(11, 19)}] `
                    : null}
                  {l.text}
                </div>
              ))}
            </pre>
          )}

          <p className="text-[10px] text-muted-foreground">
            This result was delivered once and deleted on consumption. Request
            again to fetch a fresh tail.
          </p>
        </div>
      )}

      <DialogFooter>
        <Button variant="outline" size="sm" onClick={onClose}>
          Close
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
