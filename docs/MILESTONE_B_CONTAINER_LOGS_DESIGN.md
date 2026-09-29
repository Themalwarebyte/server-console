# Milestone B — Container Logs Design

**Status:** DESIGN PROPOSAL — nothing implemented
**Date:** 2026-09-29
**Builds on:** Milestone A (`agent`, `smc-helper`, `smc-gateway`, live telemetry, read-only ceiling)
**Related:** `docs/AGENT_IMPLEMENTATION_PLAN.md`, `docs/AGENT_PKI.md`, `docs/SERVER02_DEPLOYMENT_DESIGN.md`

> Milestone B adds **read-only container log access**. It does not add container
> lifecycle control, host power control, or any command execution. Those remain
> Milestones C and D and are not designed here.

---

## 1. Scope and non-goals

| In scope (Milestone B) | Explicitly out of scope |
|---|---|
| `docker.logs.read` capability | container start / stop / restart |
| Bounded, redacted log tail | host reboot / shutdown |
| Per-request correlation and expiry | any shell or exec path |
| Full audit of every read | arbitrary Docker API paths |
| Retention-bounded transient storage | log streaming, log search, log export |

**Constraints honoured throughout:** no container mutation, no shell execution,
no arbitrary Docker commands, no Docker socket outside the helper, logs strictly
read-only, testing only against safe workloads.

---

## 2. Architecture flow

The browser must never reach the gateway or an agent, and agents must never
accept inbound connections. The request therefore has to cross the same
certificate-based channel that telemetry already uses, in the opposite
direction, with Convex holding the correlation.

```
Browser (Owner session)
   │  1. POST request — Convex mutation, requireOwner(), checks capability
   ▼
Convex  ── logRequests document created (nonce, expiry, hard caps)
   │  2. request appears in the gateway's work queue
   ▼
smc-gateway  ── 3. dispatches LogRequest over the existing agent stream
   │     (one long-lived mTLS stream per host; gateway never dials)
   ▼
smc-agent (unprivileged)
   │  4. validates nonce, expiry, ceiling, exact container id
   │     helper client → Unix socket
   ▼
smc-helper (root, only holder of the Docker socket)
   │  5. exact container id, bounded tail, redaction, byte cap
   ▼
Docker Engine API — logs only
   │
   ▼  6. result back up the same chain
Convex logRequests → result document (retained briefly, then deleted)
   │
   ▼
Browser renders (reactive subscription, no polling loop)
```

Steps 2 and 6 are the design problem, addressed in §5.

---

## 3. Capability changes

**Add one capability.** The ceiling is the intersection of agent support, the
local ceiling, central policy, Owner authorisation, and protocol version
(§9). Milestone B adds exactly one code.

```
docker.logs.read
```

| Host | Current | Milestone B |
|---|---|---|
| `srv_7f3a91c2e8` (SERVER-01) | `host.telemetry.read`, `docker.telemetry.read` | **+ `docker.logs.read`** |
| `srv_2b6e40af15` (SERVER-02) | `host.telemetry.read`, `docker.telemetry.read` | **+ `docker.logs.read`** |

**Deliberately unchanged:** the helper binary and the agent binary may already
contain the operation, but `docker.container.*`, `host.reboot` and
`host.shutdown` stay absent from every ceiling in Milestone B. The central
policy and the local ceiling both refuse them, so a forged or replayed envelope
for those codes cannot execute.

**A capability check must fail closed.** If the ceiling lookup errors, the
answer is "deny", never "allow". The Milestone A identity work already
established that pattern; it is repeated here rather than relaxed.

---

## 4. Helper changes

The helper remains the **only** component that opens `/var/run/docker.sock`.
Milestone B adds one operation and no other surface.

**New operation: `containerLogs`**

| Aspect | Requirement |
|---|---|
| Target | **Exact container id only.** No name matching, no prefix, no regex, no glob, no "all containers". |
| `tail` | Bounded, server-clamped to `1..500`. A caller asking for 10,000 receives 500. |
| `since` / `timestamps` | Optional, both boolean. |
| Follow | **Not supported in Milestone B.** No `follow` parameter exists, so no unbounded stream is reachable even by a hostile caller. |
| Line cap | 500 lines. |
| Byte cap | 256 KiB per response, enforced during read, not after. |
| Line length | Truncate any line longer than 4 KiB. |
| Encoding | UTF-8 with invalid sequences replaced; never raw bytes into the UI. |
| Redaction | Applied **inside the helper, before the data leaves the host** (§10). |
| Timeout | 10 s hard ceiling, same as the other operations. |

**Docker API call:** `ContainerLogs(ctx, id, ContainerLogsOptions{ShowStdout, ShowStderr, Timestamps, Tail, Since, Follow:false})`. Version-negotiated, exactly as the telemetry path already does.

**What must not be added:** a `run`, `exec`, `inspect`-with-args, or any endpoint that forwards a caller-supplied method or path to the Docker API. The operation table stays a closed `switch`; an unrecognised op returns `operation not available in this milestone`, as it does today.

**Socket permissions unchanged:** `/run/smc-agent/helper.sock`, `0660 root:smc-agent`. The agent still cannot read the Docker socket directly.

---

## 5. Agent and gateway protocol changes

### 5.1 Proto additions

```protobuf
// Agent → Gateway
message LogRequestResult {
  string request_id = 1;
  string server_public_id = 2;
  bool   ok = 3;
  string error = 4;          // class only, never a Docker error string
  repeated LogLine lines = 5;
  bool   truncated = 6;      // true when a cap was reached
  int64   observed_at_ms = 7;
  int64   duration_ms = 8;
}

message LogLine {
  int64  timestamp_ms = 1;   // 0 when timestamps were not requested
  string text = 2;           // redacted, control characters stripped
}

// Gateway → Agent
message LogRequest {
  string request_id = 1;
  string server_public_id = 2;  // must equal the agent's certificate identity
  string container_id = 3;       // exact id, validated by the helper
  int32  tail = 4;
  bool   timestamps = 5;
  int64  issued_at_ms = 6;
  int64  expires_at_ms = 7;
  string nonce = 8;
  int64  management_epoch = 9;
  string gateway_signature = 10;
}
```

The `Action` / `ActionAck` / `ActionResult` triple already models request and
result. `LogRequest` deliberately mirrors it rather than reusing `Action`, so
that a read can never be confused with a mutation in the ledger or in a
capability check.

### 5.2 Agent behaviour on receiving a `LogRequest`

1. **Identity first** — reject unless `server_public_id` equals the value
   derived from the agent's own certificate. A mismatch is a hard rejection, as
   with `Hello`.
2. **Nonce and expiry** — reject if the nonce was already used, or if
   `expires_at_ms` is in the past. Nonces are retained for 10 minutes.
3. **Management epoch** — reject if the envelope's epoch is older than the epoch
   the agent currently holds. This is the anti-stale control already defined
   for actions.
4. **Ceiling** — require `docker.logs.read` in the ceiling the gateway sent in
   `HelloAck`. Absent means deny.
5. **Signature** — verify the gateway signature with the public key the agent
   already holds from the CA bundle. A forged envelope is refused.
6. **Helper call** — exact container id only.
7. **Reply** — `LogRequestResult` with redacted lines, or `ok=false` with an
   error *class* only.

The agent is still unprivileged and gains no new privilege. It cannot read the
Docker socket; it can only ask the helper.

### 5.3 Gateway behaviour

The gateway is the relay and the enforcement point. It must:

- Reject a `LogRequest` for a server that is not the connected agent
- Reject any `LogRequest` whose capability is not in that host's ceiling
- Attach the gateway signature and the current management epoch
- Bound **per host**: at most 2 concurrent log requests, at most 10 per minute
- Bound **globally**: at most 20 outstanding requests fleet-wide
- Never log line content. Only metadata: request id, server, container id, byte
  count, duration.

### 5.4 How the gateway learns a request exists — 🔴 OWNER DECISION REQUIRED

The gateway has no way to receive a Convex push, and the browser must not call
the gateway. Three workable options:

| Option | Mechanism | New grant to the gateway | Complexity |
|---|---|---|---|
| **A (recommended)** | Gateway holds a Convex **live-query subscription** over pending `logRequests`, using the same service credential | none beyond the existing credential — same auth, new endpoint | low |
| B | Gateway **long-polls** Convex every 1 s for pending requests | same credential, read-only endpoint | low, but constant polling |
| C | Convex **HTTP action** calls the gateway directly, synchronously | gateway would need an inbound listener, and Convex actions have a 1-minute ceiling that a slow log read could exceed | high |

**Recommendation: A.** It is push-based, adds no inbound listener, reuses the
existing service credential, and cannot exceed a Convex action timeout because
the result comes back over the agent stream and lands in a document that the
browser already subscribes to.

Option C deserves a specific warning: it would make the gateway reachable
inbound from the internet, which is exactly what the tailnet-only bind was
designed to prevent.

---

## 6. Convex schema and control-plane changes

**New table `logRequests`** — correlation only, never a log store.

```
serverPublicId     string
requestId          string     (nonce, indexed)
containerId        string
containerName      string     // snapshot at request time, for display
requestedBy        string     // session-derived actor
capability         string     // always "docker.logs.read"
status             string     // PENDING | RUNNING | COMPLETE | FAILED | EXPIRED
issuedAt           number
expiresAt          number     // <= issuedAt + 60s
completedAt        number?
lineCount          number?
byteCount          number?
truncated          boolean?
errorClass         string?    // enum-like string, never a raw error
```

Index: `by_request` on `requestId`. Rows are deleted on completion plus a short
retention (§8).

**No log content is ever written to Convex in the primary design.** Logs are
large, sensitive, and short-lived; persisting them would turn the control plane
into an unencrypted log archive. See §7 for the bounded alternative.

**`docker.logs.read` must be added to the central capability policy** alongside
the two existing codes, and to the per-host ceiling stored for each server. The
`revokeCertificate` and `importVerifiedSnapshot` paths are unaffected.

**Authorisation is unchanged and mandatory:** the requesting mutation calls
`requireOwner()` first. There is no public log path, ever.

---

## 7. Log storage strategy

**Primary: no storage.** A log request is fulfilled and the result is held in
the `logRequests` document only long enough for the browser to render it, then
deleted. Nothing accumulates.

**Why not store logs in Convex:**
- Convex documents are not a log store; they are a transactional document DB
- Log lines frequently contain credentials, connection strings, and tokens
- Storage cost grows without bound and there is no natural TTL
- A log archive in the control plane would become the single most valuable
  exfiltration target on the platform

**Bounded alternative if a short history proves necessary** (not Milestone B):
a fixed per-server ring of the last 200 lines from the **most recent** request
only, retained 15 minutes, clearly labelled as a snapshot rather than a stream.
Even then, redaction happens on the host before the data crosses the network.

**Never proposed, at any milestone:** shipping raw Docker logs to Convex or
storing them on the gateway disk. The gateway would become a log repository
with no access control story.

---

## 8. Retention limits

| Limit | Value | Enforced by |
|---|---|---|
| Lines per request | 500 | helper, clamped regardless of request |
| Bytes per request | 256 KiB | helper, during read |
| Line length | 4 KiB, truncated | helper |
| Concurrency per host | 2 | gateway |
| Rate per host | 10 / minute | gateway |
| Rate fleet-wide | 20 outstanding | gateway |
| Request expiry | 60 s from issue | Convex + agent + helper |
| Nonce reuse window | 10 minutes | agent |
| Completed `logRequests` row | deleted after render, hard cap 5 minutes | Convex |
| Maximum log text retained anywhere | 0 bytes beyond the live render | design invariant |

Container CPU/memory stats are already sampled at 10 s and are **not** part of
this milestone.

---

## 9. Security risks and mitigations

| # | Risk | Mitigation |
|---|---|---|
| 1 | **Logs contain secrets** — tokens, connection strings, passwords, env dumps | Redact on the host (§10) **before** the data crosses the network. The gateway and Convex never see raw text. |
| 2 | **Log injection** — ANSI escapes, control characters, crafted text | Strip all control characters except tab; drop ANSI sequences; neutralise carriage returns. The UI renders as text, never as HTML. |
| 3 | **Exfiltration via log reads** — a compromised agent reading arbitrary containers | Capability ceiling plus exact-container-id only, and the central policy can revoke per host. No name or wildcard selection exists. |
| 4 | **Denial of service by volume** — one request pulling megabytes | 500-line and 256 KiB caps, rate limits, hard timeouts at every hop. |
| 5 | **Replay of a log request** | Single-use nonce, 10-minute window, expiry checked at the agent and the helper. |
| 6 | **Stale authorisation** — a request approved under an old policy | `management_epoch` checked at the agent; an older epoch is refused. |
| 7 | **Docker socket exposure** | Unchanged. The helper is the only holder; the agent is not in the `docker` group and has no sudo. |
| 8 | **Log text reaching the audit chain** | Audit records store metadata only — request id, server, container, counts. Never line content. |
| 9 | **Cross-server confusion** — a log request for SERVER-01's container answered by SERVER-02 | The gateway rejects any request not matching the connected agent's certificate identity, and the agent re-derives its identity from its own certificate. |
| 10 | **Unauthorised log access** | `requireOwner()` on the request mutation; no public read path exists. |

---

## 10. Redaction — must happen on the host

Redaction belongs in the helper, before the payload leaves SERVER-01 or
SERVER-02. Anything redacted centrally has already crossed the network.

Patterns to mask, applied per line, with a `[REDACTED]` placeholder:
- `password`, `passwd`, `secret`, `token`, `api_key`, `apikey`, `access_key`
  followed by `=`, `:`, or whitespace and a value
- `Authorization: Bearer …`, `Basic …`, `Cookie:` headers
- Connection strings containing a credential segment
- AWS access key id pattern `AKIA[0-9A-Z]{16}`
- JWT-shaped tokens: three base64url segments
- Private key PEM headers
- Any value matching the platform's own `BETTER_AUTH_SECRET`

Redaction is a **defence in depth**, not a guarantee. It cannot catch a secret in
an unusual format. The design must not pretend otherwise: the console should
state that log content is untrusted and may contain sensitive data, and
Milestone B should ship with redaction implemented and documented as best-effort.

---

## 11. Audit requirements

Every request produces audit events, in the existing append-only chain with the
session-derived actor. The five states map onto the existing `REQUESTED →
DISPATCHED → STARTED → SUCCEEDED | FAILED` model.

| Event | When | Fields |
|---|---|---|
| `LOG_REQUESTED` | Owner issues | server, container id, requested tail, actor, correlationId |
| `LOG_DISPATCHED` | gateway sends to agent | agent identity, request id, nonce |
| `LOG_STARTED` | agent begins the helper call | request id |
| `LOG_SUCCEEDED` | result returned | line count, byte count, truncated flag, duration |
| `LOG_FAILED` | any failure | error class only, never raw error text |
| `LOG_EXPIRED` | no result within the window | request id |

Hard rules:
- **No line content in any audit record.**
- The gateway's own log carries metadata only.
- Failures record an error *class* (`not_authorized`, `container_not_found`,
  `timeout`, `too_large`, `helper_unavailable`) — never a Docker error string,
  which routinely contains paths and identifiers.
- A read is an access event and is audited exactly as an action would be.

---

## 12. UI changes

**Containers page / server detail**
- A "View logs" control per container, enabled only when the host's ceiling
  includes `docker.logs.read`
- Shows the container name and id at request time
- Renders up to 500 lines as **text nodes only**, never `dangerouslySetInnerHTML`
- A visible "truncated" marker when a cap was hit
- No auto-refresh by default; a manual "Refresh" re-issues a fresh request
  (no polling loop, to keep the read path auditable)
- An explicit warning that log content may contain sensitive data

**Request lifecycle**
`Requesting…` → `Rendering` or `Could not read logs` with a Retry and the error
*class* only. The user must never see a raw backend or Docker error.

**No streaming in Milestone B.** A tail-only read is honest about what it is. A
streaming design should be its own milestone once the pull path is proven.

---

## 13. Rollback plan

Fully reversible; the read-only telemetry path is untouched by any of it.

| Step | Action |
|---|---|
| Disable the capability | Remove `docker.logs.read` from the central policy and both host ceilings. Takes effect on the next `HelloAck`; the helper operation becomes unreachable within one heartbeat. |
| Disable the UI | Revert the frontend commit and redeploy the bundle. |
| Disable the helper operation | Remove `containerLogs` from the helper switch; the agent's call returns `operation not available`. |
| Full revert | Redeploy the previous agent/helper binaries, restore the previous units, `git revert` the commits. |

No stored log data to clean up, because nothing is retained. `logRequests` rows
are deleted on completion, so a rollback leaves nothing behind.

---

## 14. Testing plan

**All Milestone B testing is read-only.** No test may stop, start, or restart
any container, and no test may target a production workload.

**Safe targets** — containers with no secrets and no customer data. SERVER-02's
`smc-caddy` and SERVER-01's `filebrowser` are both candidates; confirm before use.

| # | Test | Pass condition |
|---|---|---|
| 1 | Helper rejects an unknown operation | `operation not available in this milestone` |
| 2 | Helper rejects a container name, prefix, or regex | exact-id requirement rejected, no data returned |
| 3 | Helper clamps `tail` above 500 | at most 500 lines returned |
| 4 | Helper enforces the 256 KiB cap | response truncated, `truncated=true` |
| 5 | Helper truncates a line over 4 KiB | line shortened, no crash |
| 6 | Helper strips ANSI and control characters | output contains none |
| 7 | Redaction applied on the host | a synthetic secret never appears in the response |
| 8 | Agent rejects a mismatched `server_public_id` | no result returned |
| 9 | Agent rejects a replayed nonce | second attempt refused |
| 10 | Agent rejects an expired request | refused |
| 11 | Agent rejects an envelope with an old `management_epoch` | refused |
| 12 | Agent refuses a forged gateway signature | refused |
| 13 | Gateway refuses a request for a host it is not connected to | never dispatched |
| 14 | Rate limit | 11th request in a minute refused |
| 15 | Capability absent → denied | with `docker.logs.read` removed, request refused |
| 16 | Unauthenticated request | rejected by `requireOwner()` |
| 17 | Non-Owner request | rejected |
| 18 | Container that does not exist | `container_not_found`, no data |
| 19 | Two concurrent requests for one container | both succeed |
| 20 | Expired request with no result | `LOG_EXPIRED` audited, row deleted |
| 21 | Audit records contain no line content | verified by inspection |
| 22 | Full round trip | real lines rendered in the UI |
| 23 | **Revocation drill** — remove the capability | the next log attempt is denied, telemetry unaffected |
| 24 | **Socket denial** re-check | `smc-agent` still cannot read `/var/run/docker.sock` |
| 25 | **Offline drill** — stop only the agent | log requests fail cleanly; telemetry unaffected |

Tests 23–25 are the important ones: they prove a capability revocation and an
agent outage degrade cleanly rather than breaking the platform.

---

## 15. Decisions required before implementation

1. **Gateway work-source — option A, B, or C (§5.4).** Recommended **A**
   (Convex live-query subscription). Option C introduces an inbound listener and
   should be rejected.
2. **Does the gateway's service credential gain a second, read-only purpose?**
   Under option A it reuses the same credential for a different endpoint. I would
   prefer a **separate** credential for log work so a compromised ingest path
   cannot fetch pending requests. That means two secrets, not one.
3. **Redaction patterns** — the list in §10 is a proposal and needs Owner
   approval before it hard-codes anything.
4. **Retain a short last-request ring buffer, or store nothing?** Proposed:
   store nothing.
5. **Tail cap** — 500 lines and 256 KiB proposed; confirm, or set lower.
6. **Which safe containers are approved as test targets**, given this is a
   production host pair.

---

*Design only. No code, schema, helper, agent, gateway, or UI change has been
made. Milestone B is not started, and container lifecycle control and host power
control remain unstarted and undesigned.*
