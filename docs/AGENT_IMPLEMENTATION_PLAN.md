# Real-Time Agent Implementation Plan

**Status:** Milestone A **and A.1 (health monitoring)** implemented and live.
**Date:** 2026-09-27 (A.1 landed 2026-09-29, commit `e83c2bb`)
**Milestone:** V0.1 = real-time, agent-based management of SERVER-01 and SERVER-02
**Companion:** `docs/SERVER02_DEPLOYMENT_DESIGN.md`, `docs/SERVER02_RUNBOOK.md`,
`docs/AGENT_PKI.md`, `docs/MILESTONE_B_CONTAINER_LOGS_DESIGN.md`

> The operator-snapshot model shipped in `d468fcc` is retained as bootstrap and
> fallback data only. It is not the V0.1 operating model. Agents replace it once
> enrolled, and the UI stops showing snapshot values for enrolled hosts.

---

## 0.5 AGENT HEALTH MODEL (Milestone A.1 — implemented)

Health is derived **in the control plane**, never guessed in the browser. Three
states, and the distinction between them is the point:

| State | Condition |
|---|---|
| `ONLINE` | heartbeat within **45 s** AND telemetry within **30 s** AND gateway connected AND zero errors |
| `DEGRADED` | heartbeat fresh, but telemetry stale, gateway disconnected, or errors recorded |
| `OFFLINE` | heartbeat timeout exceeded, or no agent enrolled |

**Why telemetry freshness is separate from the heartbeat.** Host telemetry
arrives every 5 s and Docker telemetry every 10 s. A host can be perfectly
reachable while its helper is failing, the agent cannot reach the socket, or
gateway ingest is rejecting — and all three look identical if you only watch the
heartbeat. Before A.1 that gap rendered as a skeleton that never resolved.

**Thresholds** live in `src/convex/agentIngest.ts` as named constants
(`OFFLINE_AFTER_MS = 45_000`, `TELEMETRY_STALE_MS = 30_000`,
`CERT_WARN_DAYS = 30`).

### Tracked fields

| Field | Meaning |
|---|---|
| `lastHeartbeatAt` | Most recent agent heartbeat |
| `lastSuccessfulTelemetryAt` | Most recent telemetry the gateway actually ingested |
| `agentErrorCount` | Errors **since the last successful telemetry**; reset to 0 on success |
| `lastErrorClass` | Sanitised class only |
| `gatewayState` | `connected` / `disconnected` |
| `certNotAfter` | Leaf certificate expiry |
| `agentHealthEvents` | Append-only connect / disconnect / error trail |

### Certificate expiry is recorded by the control plane

Expiry is a property of the certificate the control plane issued, so the gateway
reports the leaf's `NotAfter` as a **date** on the existing `status` channel and
Convex stores it. This means the expiry warning required **no agent or helper
rebuild** and **no protocol change** — the agent binaries on both hosts are
byte-identical to Milestone A.

### Security posture

- `listAgentStatus` returns **no certificate material**: `certFingerprint` and
  `certSerial` are deliberately omitted. Only the expiry is exposed, which is all
  the UI needs to render a warning.
- Errors are a **class**, not a message. Unrecognised values collapse to
  `unknown` at the ingest boundary, so an upstream message, path, or stack trace
  can never reach the database or the UI.
- The user-facing failure state stays generic: **"Cannot reach the control
  plane"**, with no backend detail.

### UI behaviour

| Situation | What the console shows |
|---|---|
| `ONLINE` | Live badge, heartbeat age, telemetry age, live figures |
| `DEGRADED` | Amber badge, error count and class, figures explicitly marked **stale** |
| `OFFLINE` | Red badge, last-seen time, **live figures withheld** |
| Not enrolled | Snapshot, explicitly labelled a point-in-time observation |

Stale figures are never silently replaced by snapshot data for an enrolled host.

---


## 0. APPROVED OWNER DECISIONS (binding — these supersede §2, §3, §9, §17)

### 0.1 Gateway listener

`100.80.65.109:8446` — **Tailscale address only.** Never `0.0.0.0`, never `[::]`,
never `192.168.1.200`. LAN access to 8446 must be **provably impossible** after
deployment, and that is verified as an acceptance check.

### 0.2 Transport — gRPC + Protobuf + mTLS

The length-prefixed JSON protocol in §2 is **superseded**.

- **gRPC bidirectional streaming** over HTTP/2, with **Protobuf** messages
- **mTLS** on the channel
- **One long-lived, agent-initiated stream.** Agents dial the gateway. The
  gateway never dials an agent.
- Strongly typed messages. Retained from §2: bounded message sizes, reconnect
  backoff with jitter, keepalive, protocol version negotiation, connection timeout.

Agent → Gateway: `Hello`, `Heartbeat`, `HostTelemetry`, `DockerTelemetry`,
`DockerEvent`, `ActionAck`, `ActionResult`
Gateway → Agent: `HelloAck`, `Ping`, `Action`

**Milestone A uses only the read-only messages** (`Hello`, `Heartbeat`,
`HostTelemetry`, `DockerTelemetry`, `DockerEvent` and their replies). `Action`,
`ActionAck` and `ActionResult` are defined in the schema but no Milestone A
ceiling permits them.

### 0.3 Build — containerised, pinned, never on a managed server

**Go is NOT installed on the Owner workstation and NOT installed on either
managed server.** Builds run in a pinned container.

- Pin the Go toolchain version, the build image **digest**, and module versions
- `CGO_ENABLED=0 GOOS=linux GOARCH=amd64` for static binaries
- Produce `smc-agent`, `smc-helper`, and the gateway binary
- **Record SHA-256 for every installed binary**
- No production binary is ever built directly on a managed server

### 0.4 PKI — keys are generated on the host that owns them

**Correction to §3: managed-server private keys are NOT generated on the
workstation.**

- Each host generates **its own** ECDSA P-256 keypair **locally**
- `srv_7f3a91c2e8` (SERVER-01) private key **never leaves SERVER-01**
- `srv_2b6e40af15` (SERVER-02) private key **never leaves SERVER-02**
- Stored under `/var/lib/smc-agent/`, private key mode `0600`
- The agent generates a **CSR locally**
- Certificate identity is the immutable **`serverPublicId` in a URI SAN**
  (`spiffe://smc/srv_7f3a91c2e8`). **CN and hostname are never trusted.**
- The gateway verifies: trusted CA, certificate validity, `clientAuth` EKU,
  the `serverPublicId` identity, and revocation state
- For this explicitly approved bootstrap of these two known servers, signing and
  enrollment complete without a further approval dialog

**The CA private key is never exposed to** the browser, the agent, the frontend,
Convex, or Git. The gateway holds only trust material (CA bundle) plus its own
server keypair.

**Revocation:** the console records a revoked state per certificate fingerprint;
the gateway reloads its trust set and refuses the connection on the next dial.
Because the agent re-dials rather than holding a session open, revocation takes
effect within one keepalive interval.

### 0.5 Gateway → Convex — narrow authenticated ingest

**The gateway must NOT receive `CONVEX_SELF_HOSTED_ADMIN_KEY`, and must NOT
receive the Owner's Better Auth credentials.**

- Narrow server-side telemetry/event ingestion endpoints, and nothing else
- Protected by a **dedicated gateway service credential**, generated strong
- Stored **only** in the gateway's protected secret configuration and the Convex
  deployment environment. **Never** in Git, the browser bundle, logs, or reports
- Verified with **constant-time comparison**
- Every write identifies: gateway service identity, agent `serverPublicId`, agent
  certificate fingerprint and serial, and `observedAt`
- **Telemetry attribution is derived from the authenticated mTLS connection, not
  from a `serverPublicId` supplied inside a payload.** The gateway sets it from
  the verified certificate; the Convex endpoint rejects a body that disagrees.

### 0.6 Milestone A capability ceiling — read-only

Both servers receive **only**:

```
host.telemetry.read
docker.telemetry.read
```

No Milestone A permission for `docker.logs.read`, `docker.container.start`,
`docker.container.stop`, `docker.container.restart`, `host.reboot`, or
`host.shutdown`. The binaries may *contain* future typed operations, but the local
ceiling and central policy **deny** them.

| Milestone | Capabilities added |
|---|---|
| A (now) | `host.telemetry.read`, `docker.telemetry.read` |
| B | `docker.logs.read` |
| C | `docker.container.start`, `docker.container.stop`, `docker.container.restart` |
| D | `host.reboot`, `host.shutdown` — only after explicit Owner approval |

### 0.7 Agent user

`smc-agent`: system account, `nologin`, its own primary group, **no supplementary
privileged groups**, **not** in `docker`, **not** in `sudo`. It must **not** be
able to read `/var/run/docker.sock`. Hardened systemd unit retaining
`NoNewPrivileges=true` and `ProtectSystem=strict`; the minimum additional
filesystem/device/network access is granted, and sandboxing is **not** weakened
to make telemetry work without first identifying the exact requirement.

### 0.8 Helper

Unix socket `/run/smc-agent/helper.sock` only. No TCP listener, no shell, no
`exec`, no arbitrary command vector, no generic Docker command endpoint.

Milestone A exposes only the fixed read-only operations `hostTelemetry` and
`dockerTelemetry`. `dockerTelemetry` **is** permitted to enumerate the local
Docker estate read-only. Future mutations must take an **exact** container ID or
name and must reject wildcards, regex selectors, arbitrary selectors, and
arbitrary Docker API paths. Uses the Docker Go SDK with API version negotiation.

### 0.9 Telemetry frequency

| Stream | Interval |
|---|---|
| Heartbeat | **5 s** |
| Host telemetry | **5 s** |
| Per-container resource telemetry | **10 s** |
| Docker lifecycle events | **event-driven, immediate** |
| Full Docker reconcile | **30 s** |

No expensive full container inspection on the 5 s path where the event/reconcile
model already provides the freshness.

### 0.10 Telemetry model

Host: `serverPublicId`, observed hostname, OS, kernel, boot ID, uptime, load, CPU
usage, memory total/available/used, mounts and disk usage, Tailscale IP, LAN IPs,
agent version, protocol version, `observedAt`.

Docker: engine version, daemon reachability, container ID, name, image, state,
`healthCheckPresent`, health when available, CPU, memory, restart count, published
ports.

**Health is never synthesised.** No HEALTHCHECK means `healthCheckPresent=false`,
and health must not be rendered as Healthy.

### 0.11 Offline display

When the heartbeat exceeds the offline threshold the Fleet card shows:

```
OFFLINE
Last seen <timestamp>
```

Stale CPU/RAM/load/container values are **not** displayed as current. The server
detail page may show a last-known state clearly marked **STALE** with its
observation time. **There is never a silent fallback from agent telemetry to
operator snapshot for an enrolled server.**

### 0.12 Real-time path

```
Agent -> gRPC/mTLS gateway -> authenticated narrow Convex ingest -> Convex state
     -> existing reactive browser subscriptions
```

The browser never connects to an agent and never receives agent certificates, the
gateway secret, the Docker socket, or SSH credentials. Once a host is enrolled and
producing telemetry, `inventorySource` becomes `agent` and snapshot values leave
the live Fleet calculation for that host.

### 0.13 SERVER-02 self-management

Identical binary, certificate model, capability model, protocol and telemetry path
as SERVER-01. `isLocalhost`, `isControlPlaneHost` and `skipAuthorization` are
prohibited and are searched for explicitly. No console-to-local-Docker shortcut.
SERVER-02's agent connects to the gateway through the same approved Tailscale
gateway identity. **If that produces a host-routing problem, work stops and is
reported — no localhost bypass is introduced automatically.**

### 0.14 SERVER-02 virtualization — VERIFIED READ-ONLY

| Probe | Result |
|---|---|
| `systemd-detect-virt` | `none` |
| CPU `hypervisor` flag | **absent** |
| `lscpu` hypervisor line | **absent** (shows only `Virtualization: VT-x`) |
| `vmx`/`svm` flag | present |
| `/sys/hypervisor` | **present** |
| `kvm` modules loaded | **2** |
| DMI `sys_vendor`, `product_name`, `product_version`, `board_vendor`, `board_name` | **all empty** |
| DMI `bios_vendor` / `bios_version` | `American Megatrends Inc.` / `5.6.5` |
| `chassis_type` | 3 (Desktop) |
| NIC drivers | `eno1` → **e1000e**, `enp1s0` → **igb**, `wlx…` → **rtl8xxxu** |

**Conclusion: SERVER-02 is a guest virtual machine.** `e1000e`, `igb` and
`rtl8xxxu` are all QEMU/KVM emulated device models rather than typical bare-metal
Intel NICs, and the DMI identity is entirely synthetic. `systemd-detect-virt`
returning `none` and the missing CPU `hypervisor` flag are false negatives caused
by the virtualised CPU exposing no hypervisor bit, not evidence of bare metal.

**Carried forward to Milestone D:** a magic packet to `00:03:2d:44:b3:68` cannot
power on physical hardware, because that NIC is emulated and exists only once the
hypervisor starts the guest. SERVER-02 power-on is a **hypervisor** action, outside
the agent channel. Intel AMT is unavailable on an emulated NIC. No power-management
setting was changed.

---


## 1. Component structure

```
                    OWNER BROWSER
                         │  https (tailnet only)
                         ▼
        ┌────────────────────────────────────────┐
        │  SERVER-02 — control plane             │
        │                                        │
        │  Caddy  :443 / :8443 / :8444 / :8445  │
        │     └── static SPA                    │
        │                                        │
        │  convex-backend  (127.0.0.1:3210)     │
        │     ├── requireOwner()  ← unchanged    │
        │     ├── action ledger  ← unchanged    │
        │     └── agent projection queries      │  ← NEW
        │                                        │
        │  smc-gateway  (NEW)                   │
        │     ├── :8446  mTLS, tailnet-bound    │  ← NEW
        │     ├── agent session registry        │
        │     └── writes telemetry into Convex  │
        │         via internal (admin) calls    │
        │                                        │
        │  smc-agent  ── outbound mTLS ──┐       │
        │  (manages itself like any host)│       │
        │  smc-helper (root, unix socket)│       │
        └────────────────────────────────┼───────┘
                                         │  (each agent dials OUT)
              ┌──────────────────────────┴──────────┐
              ▼                                     ▼
    ┌───────────────────┐                 ┌───────────────────┐
    │ SERVER-01 (gman)  │                 │ SERVER-02 (gman-02)│
    │ HP EliteBook 840G1│                 │ VM on 6.12 host   │
    │ smc-agent  (NEW)  │                 │ smc-agent  (NEW)  │
    │ smc-helper (NEW)  │                 │ smc-helper (NEW)  │
    │ docker (47 cont.) │                 │ docker (8 cont.)  │
    └───────────────────┘                 └───────────────────┘
```

**No generic inbound management listener is opened on either managed host.** The
only new listener anywhere is the gateway on SERVER-02's Tailscale address.

---

## 2. Gateway protocol

| Aspect | Decision |
|---|---|
| Transport | TLS over TCP, `100.80.65.109:8446`, bound to the Tailscale address only |
| Auth | Mutual TLS. The agent presents a client certificate; the gateway requires one. |
| Server identity | Agent sends `serverPublicId` in a signed hello frame. The certificate CN/SAN must match. **Hostname is never the identity.** |
| Framing | Length-prefixed JSON frames, `uint32` big-endian length + payload, max 1 MiB |
| Messages (agent→gateway) | `hello`, `heartbeat`, `telemetry`, `event`, `action_result`, `action_ack` |
| Messages (gateway→agent) | `hello_ack`, `ping`, `action` |
| Keepalive | Agent pings every 15 s; session dropped after 45 s of silence |
| Backoff | Exponential 1→60 s with jitter on reconnect; the gateway never dials the agent |
| Capability ceiling | Enforced **at three** points: agent config, helper allowlist, and centrally. See §12. |
| Protocol version | `smc-agent/1`. Handshake refuses a version mismatch rather than degrading silently. |

The gateway holds **no** Docker socket and executes **no** commands. It validates,
routes, and records. All host interaction happens on the managed host.

---

## 3. Certificate and enrollment mechanism

**Bootstrap (one-time, manual, per host)**

1. Operator runs an enrollment CLI on the **workstation**:
   `smc-enroll --server srv_xxxx --gateway 100.80.65.109:8446 --out ./enroll.json`
2. It generates an ECDSA P-256 keypair locally. The private key **never leaves the
   workstation** at this stage.
3. `enroll.json` contains a CSR plus a fingerprint, which the Owner imports into
   the console (Enrollment page) while authenticated.
4. Console creates an `enrollments` row and an `ENROLLMENT` audit event with the
   session-derived actor, and issues a short-lived one-time **enrollment token**
   (single use, 15-minute expiry, bound to the server id).
5. The agent, on first start, presents the token **plus** its CSR. The gateway
   validates the token with the control plane, then issues a signed agent
   certificate valid for 1 year, stored only on the host.

**Steady state**

- Agent identity is a client certificate, not a shared secret. Revoking the
  certificate in the console immediately disconnects the host.
- Renewal at 30 days remaining, over the same channel, using the existing
  certificate to authenticate the request.
- Each host has its own keypair, its own certificate, and its own ceiling.

**Alternative considered and rejected:** long-lived API tokens. They are
copyable, replayable, and cannot be bound to a specific process. Certificates
are not.

---

## 4. Agent system user

| Property | Value |
|---|---|
| User | `smc-agent` (system, no login) |
| Shell | `/usr/sbin/nologin` |
| Groups | **none** — explicitly **not** in `docker`, **not** in `sudo` |
| Home | `/var/lib/smc-agent` (`0700`, owned by `smc-agent`) |
| Config | `/etc/smc-agent/agent.toml` (`0644` root-owned, agent-readable) |
| Identity | `/var/lib/smc-agent/agent.key`, `agent.crt` (`0600`, agent-owned) |
| Runtime | `/usr/local/bin/smc-agent` (`0755` root-owned) |
| Service | `smc-agent.service`, `systemd`, `Restart=always`, `NoNewPrivileges=yes`, `ProtectSystem=strict`, `ProtectHome=yes`, `PrivateTmp=yes`, `ReadWritePaths=/var/lib/smc-agent` |

**Privilege separation:** the agent cannot read the Docker socket and is not in
the `docker` group, so it cannot reach Docker even if compromised. It has **no**
sudo rule at all. Every privileged operation goes to the helper over a Unix
socket, and the helper re-validates the capability.

> **Note on SERVER-01:** the `ooadmin` account is in group `docker` (982). The
> `smc-agent` user is created separately and is **not** added to it. I will not
> modify `ooadmin`'s group membership.

---

## 5. Helper IPC design

| Aspect | Decision |
|---|---|
| Binary | `/usr/local/bin/smc-helper`, root-owned `0755` |
| Runs as | `root`, but **only** `smc-agent` may connect |
| Socket | `/run/smc-agent/helper.sock`, mode `0660`, owner `root`, group `smc-agent` |
| Socket dir | `/run/smc-agent` mode `0750` root-owned (tmpfs, cleared on reboot) |
| Protocol | Newline-delimited JSON, request/response, 10 s hard timeout |
| Authorisation | The helper holds its own allowlist and **re-validates every parameter** |
| Shell | **Never.** No `exec`, no `sh -c`, no free-form argument vector |
| Docker access | Talks to `/var/run/docker.sock` itself as root. The socket is never exposed to the agent, Convex, the browser, or the network. |

**Typed operations — the complete v1 surface**

| Capability | Helper operation | Validation performed by the helper |
|---|---|---|
| `docker.container.start` | `containerStart` | name resolves to exactly one container; state is `exited`; no `--privileged`, no volume, no network, no env overrides |
| `docker.container.stop` | `containerStop` | exactly one container; grace period fixed at 10 s, not caller-controlled |
| `docker.container.restart` | `containerRestart` | exactly one container |
| `docker.logs.read` | `containerLogs` | exactly one container; `tail ≤ 500`; line length ≤ 4 KiB; total ≤ 256 KiB; ANSI escapes stripped; secrets-pattern redaction |
| `host.reboot` | `hostReboot` | ceiling flag required; logs a line to syslog before issuing |
| `host.shutdown` | `hostShutdown` | ceiling flag required; distinct HIGH-RISK confirmation token |
| `telemetry.host` | `hostTelemetry` | unprivileged, read-only |
| `telemetry.docker` | `dockerTelemetry` | read-only; reads the socket directly |

Anything not in this table **does not exist** in the helper. There is no generic
`run`, `exec`, or `docker` passthrough, so a compromised agent or a forged
envelope cannot reach anything outside it.

**Envelope verification inside the helper.** The gateway signs each action
envelope with a key only the gateway holds. The helper verifies that signature,
the nonce, and the expiry **before** acting. A replayed or forged envelope is
rejected locally, so a compromised agent cannot invent its own action.

---

## 6. Telemetry schema

Pushed on the 5 s heartbeat and on Docker events.

```jsonc
{
  "schemaVersion": 1,
  "serverPublicId": "srv_7f3a91c2e8",
  "observedAt": 1790530000000,
  "seq": 18422,                       // monotonic; gaps are detectable
  "host": {
    "hostname": "gman",
    "os": "Debian GNU/Linux 13 (trixie)",
    "kernel": "7.1.8+deb13-amd64",
    "arch": "amd64",
    "uptimeSeconds": 375865,
    "bootId": "…",                     // from /proc/sys/kernel/random/boot_id
    "load1": 3.14, "load5": 2.50, "load15": 2.58,
    "cpuPercent": 27.4,                // delta over the heartbeat interval
    "cpuCores": 4,
    "memory": { "totalBytes": 12434159782, "availableBytes": 5807394048, "usedBytes": 6626765734 },
    "disk": [
      { "mount": "/", "fstype": "ext4", "totalBytes": 238326726656,
        "usedBytes": 67065208832, "availBytes": 159080632320 }
    ],
    "network": { "tailscaleIps": ["100.94.91.17"], "lanIps": ["192.168.1.190"] }
  },
  "docker": {
    "engineVersion": "29.8.0",
    "composeVersion": "5.5.1",
    "daemonReachable": true,
    "counts": { "total": 47, "running": 42, "exited": 4, "restarting": 1, "unhealthy": 3 },
    "containers": [
      { "id": "abc123…", "name": "church-platform-api-1", "image": "church-platform-app:def3a24a",
        "state": "running", "healthCheckPresent": true, "health": "healthy",
        "cpuPercent": 1.8, "memoryBytes": 214958080,
        "ports": ["443/tcp"], "restarts": 0, "startedAt": 1789920000000 }
    ]
  },
  "events": [ { "kind": "container.state", "containerId": "…", "from": "running", "to": "exited", "at": 1790529999000 } ]
}
```

`healthCheckPresent` is separate from `health` precisely so a container with no
HEALTHCHECK is never rendered as healthy — the defect that made the seed data
unacceptable.

---

## 7. Heartbeat and event model

| Layer | Mechanism |
|---|---|
| Host metrics | 5 s timer, CPU computed as a delta against the previous sample |
| Docker list + stats | Baseline on connect and on any event; container stats stream continuously |
| Docker state change | **Event-driven** from the Docker Engine API `/events`, filtered to `container` events, then reconciled with a full list pass every 30 s to self-heal a missed event |
| Transport | 5 s heartbeat carrying host metrics and deltas; bulk container lists only when changed |
| Offline detection | No frame for 45 s ⇒ `OFFLINE`, with the last-seen timestamp retained. **A host is never `ACTIVE` merely because a row exists.** |
| Local ceiling | The agent also marks a host `DEGRADED` when a helper operation is refused locally, so drift is visible before the Owner acts |

---

## 8. Docker read/write split

| Concern | Path |
|---|---|
| Read telemetry | Agent → helper `telemetry.docker` (root) → `/var/run/docker.sock` |
| Read logs | Agent → helper `containerLogs` (root) → socket, output bounded and redacted |
| Write actions | Gateway → agent → helper `containerStart/Stop/Restart` (root) → socket |
| Docker socket holders | **The helper only.** Not the agent, not Convex, not the browser, not the frontend, not the network, not any unprivileged process. |
| Host power actions | Helper directly, via `systemctl`, only behind a signed, expiring, ceiling-checked envelope |

Read and write share one narrow typed surface. Adding a capability later means
adding a helper operation, a capability code, and a central policy entry — never
widening an existing one.

---

## 9. Action envelope

```jsonc
{
  "v": 1,
  "taskId": "tsk_a1b2c3",
  "serverPublicId": "srv_7f3a91c2e8",
  "capability": "docker.container.restart",
  "target": { "containerId": "abc123", "containerName": "smoke-test" },
  "args": {},                          // typed per capability; no free-form strings
  "requestedBy": "owner@server-console.invalid (sub=k17…)",
  "issuedAt": 1790530000000,
  "expiresAt": 1790530120000,          // 120 s default
  "nonce": "b3f1…",                    // single use, replay-rejected centrally
  "managementEpoch": 7,                // bumps on policy change; invalidates in-flight actions
  "riskClass": "NORMAL",               // NORMAL | HIGH | CRITICAL
  "confirmationToken": "…",            // required for HIGH/CRITICAL
  "gatewaySignature": "…"              // verified by the helper
}
```

`managementEpoch` is the anti-stale control: a policy change bumps the epoch
centrally, and any envelope minted under an older epoch is refused. A restart
therefore cannot execute an action authorised under rules that have since changed.

**Authorisation is the intersection of five checks**, all of which must pass:

```
capability supported by the agent
  AND within the local server ceiling
  AND permitted by central policy
  AND requested by an authenticated Owner
  AND protocol version compatible
```

Failing any one denies the action, and the denial is audited with the reason.

---

## 10. SERVER-01 installation plan

Read-only assessment first, then install with the Owner's interactive sudo.

```
1. Transfer:  scp smc-agent smc-helper ooadmin@SERVER-01:/tmp/
2. sudo useradd --system --no-create-home --shell /usr/sbin/nologin smc-agent
3. sudo install -d -m 0750 -o root -g smc-agent /etc/smc-agent
4. sudo install -m 0755 -o root -g root /tmp/smc-agent /tmp/smc-helper /usr/local/bin/
5. sudo install -d -m 0700 -o smc-agent -g smc-agent /var/lib/smc-agent
6. sudo install -d -m 0750 -o root -g root /etc/smc-helper   (helper policy, root-only)
7. Create a smc-agent group; DO NOT add it to `docker` or `sudo`
8. Write /etc/smc-agent/agent.toml (gateway URL, serverPublicId, ceiling)
9. Write the systemd units for smc-helper (root, before the agent) and smc-agent
10. sudo systemctl daemon-reload && sudo systemctl enable --now smc-helper
11. Enrol: Owner imports the CSR in the console, then the agent starts and registers
12. Verify: agent ONLINE, heartbeat advancing, telemetry matching `docker ps`
```

**Explicitly not done:** `ooadmin` is already in group `docker` and that is left
alone. `smc-agent` gets no group memberships.

---

## 11. SERVER-02 installation plan

Identical, with two differences:

1. `ghub` has NOPASSWD sudo, so no interactive step is needed.
2. **SERVER-02 runs its own agent, exactly like SERVER-01.** The console gains no
   direct path to its Docker daemon. `isLocalhost`, `isControlPlaneHost` and
   `skipAuthorization` do not exist anywhere in the codebase, and the agent
   ceiling for SERVER-02 is stored centrally like any other host.

Note that SERVER-02's Docker root is `/opt/schoolcore/docker`, shared with the
SchoolCore project. The helper therefore addresses containers by **id or exact
name** and never enumerates or mutates anything it was not asked about.

---

## 12. Security requirements and how each is met

| Requirement | How |
|---|---|
| Agent non-root | System user, `nologin`, no groups |
| Agent not in `docker` | User created with no supplementary groups; verified after install |
| Agent no arbitrary sudo | No sudoers entry at all |
| Agent no shell execution | The agent binary has no exec path; the helper has none either |
| Helper root-owned | `root:root 0755`; policy file `root:root 0640` |
| Helper Unix socket only | `/run/smc-agent/helper.sock`, `0660 root:smc-agent`; no TCP listener anywhere |
| Helper allowlisted typed ops | The §5 table is the whole surface; parameters re-validated inside the helper |
| Gateway no Docker socket | The gateway container never mounts it |
| Gateway no arbitrary root execution | The gateway has no privileged container and no host helper |
| Capability intersection | Enforced at agent, helper, and control plane |
| No privileged exception for SERVER-02 | SERVER-02 is an ordinary managed node; no code path treats it specially |

---

## 13. Wake-on-LAN and power-on assessment

Assessed read-only. **Nothing was changed, and no BIOS or NIC setting was touched.**

### SERVER-01 POWER-ON OPTIONS — `gman`

| Item | Finding |
|---|---|
| Hardware | **HP EliteBook 840 G1** — 2015 business laptop; BIOS `L71 Ver. 01.10`, board `198F` |
| Wired NIC | `enp0s25`, MAC `28:80:23:01:c9:ea` — **state DOWN** |
| Wireless | `wlo1`, MAC `ac:7b:a1:c6:bb:4b` — **UP, and it is the default route** (`via 192.168.1.1 dev wlo1`) |
| WoL NIC support | **UNKNOWN** — `ethtool` is not installed and the `wakeon` sysfs attribute is not readable unprivileged |
| Current WoL setting | **UNKNOWN**, same reason |
| Out-of-band management | Intel MEI present: `/dev/mei0`, `mei_me` loaded. **Intel AMT may be available** on this platform; not verified. |
| `wakeup_count` | 1 (one resume since boot) |
| RAM / disk | 11.58 GiB, sda 238.5G SSD + sdb 1.8T HDD |

**Constraints that materially affect power-on:**

1. **The wired NIC is down and the default route is WiFi.** A magic packet must be
   sent to `28:80:23:01:c9:ea` on the wired interface. Both hosts sit on
   `192.168.1.0/24`, so L2 delivery from SERVER-02 is possible — but SERVER-01's
   wired link being administratively down is a separate concern from WoL support.
2. **This is a laptop.** WoL requires the NIC to retain standby power with the
   machine off, which on a laptop depends on BIOS "Wake on LAN" and often on
   closing the lid rather than powering down. Not verifiable from software.
3. WoL over `wlo1` would need WoWLAN, which is markedly less reliable and often
   unsupported on consumer laptop NICs.

**Options, best first:**
- **A. Intel AMT (if licensed and enabled)** — the only option that works with the
  machine fully off, independent of BIOS NIC settings. Needs verification and
  likely a licence.
- **B. Wired WoL after `ethtool -s enp0s25 wol g` and a BIOS check** — viable only
  if the BIOS offers it and the laptop is shut down rather than suspended.
- **C. BIOS scheduled power-on / RTC wake** — reliable, but time-based, not
  on-demand.
- **D. Manual power button** — the fallback, and what should be assumed until
  A/B/C are ruled in or out.

### SERVER-02 POWER-ON OPTIONS — `gman-02`

| Item | Finding |
|---|---|
| Hardware | **A virtual machine.** DMI `product_name`, `sys_vendor` and `board_name` are all **empty**; `kvm_intel` is loaded |
| Primary NIC | `eno1`, MAC `00:03:2d:44:b3:68`, UP at 1000 Mbps, driver `e1000e`, bus `0000:00:19.0` |
| WoL support | ✅ `Supports Wake-on: pumbg` — magic packet, broadcast, unicast |
| Current WoL setting | ✅ **`Wake-on: g` — magic packet already enabled** |
| Second NIC | `enp1s0` `00:03:2d:44:b3:69`, DOWN. Wireless `wlx94ba064bc7f6` DOWN |
| Out-of-band | Intel MEI present. **AMT on a `e1000e` virtual NIC is not a thing** — AMT needs specific hardware. Effectively unavailable. |
| Default route | `via 192.168.1.1 dev eno1`, wired |

**This is the single most important finding for power-on.**

SERVER-02 is a guest. Sending a magic packet to `00:03:2d:44:b3:68` cannot power
on the physical machine — that NIC is emulated, and the card is created when the
hypervisor starts the guest. There is nothing to wake.

**Consequence:** "power on SERVER-02" is a **hypervisor action**, not an agent
action. It cannot be delivered over the management channel at all.

**Options:**
- **A. Hypervisor out-of-band control** (Proxmox/libvirt/cluster API, or the
  physical host's own management plane). The console would need a distinct,
  separately-credentialed integration — a different trust domain from the agent
  channel, and it must be designed as such.
- **B. Physical host auto-start** — configure the VM to start when the host boots.
  Removes the need to power on anything, at the cost of no independent recovery.
- **C. Physical host itself managed as a node** — then its own power-on problem
  must be solved, which circles back to SERVER-01's options.

**Recommendation:** accept that SERVER-02 power-on is out of scope for the agent
channel, and record the hypervisor integration as a separate milestone with its
own credential boundary. Do not model it as an agent capability.

### Assessment commands for a re-run

```bash
# Identity and OOB
cat /sys/class/dmi/id/product_name /sys/class/dmi/id/sys_vendor /sys/class/dmi/id/bios_version
lsmod | grep -E 'mei_me|kvm_intel' ; ls /dev/mei*

# NIC identity and WoL (needs root for the full picture)
for n in /sys/class/net/*; do
  i=$(basename $n); case $i in lo|tailscale0|docker0|br-*|veth*) continue;; esac
  echo "$i mac=$(cat $n/address) state=$(cat $n/operstate) wakeon=$(cat $n/wakeon 2>/dev/null)"
done
ethtool <nic> | grep -E 'Supports Wake-on|Wake-on:'
ethtool -i <nic> | grep -E 'driver|firmware|bus-info'

# Confirm the link a magic packet must take
ip route show default
```

`ethtool` is **not installed** on SERVER-01. I have not installed it. On SERVER-02
it is present and was used read-only.

---

## 14. Estimated changes to the console

| Area | Change | Size |
|---|---|---|
| Schema | `servers`: add `agentStatus`, `lastHeartbeatAt`, `agentVersion`, `agentProtocolVersion`, `capabilityCeiling`, `bootId`. `containers`: add `cpuPct`, `memBytes`, `restarts`, `startedAt`, `stateChangedAt`. `telemetry` and `agentSessions` tables. | moderate |
| New Convex module | `agent.ts` — internal writes from the gateway, authenticated queries for the UI, heartbeat/offline evaluation | moderate |
| Gateway integration | Internal mutations the gateway calls; a server↔agent session view | small |
| Fleet UI | `LIVE` / `OFFLINE` badge, "last heartbeat Xs ago", agent version; **fall back to snapshot values only when `inventorySource` is `operator_snapshot` and no agent is enrolled** | moderate |
| Container tables | Real cpu/mem/state/health from telemetry; event-driven refresh | moderate |
| Server detail | Agent card, capability ceiling, boot id, container controls | moderate |
| Action UI | Restart/start/stop with confirmation; reboot and shutdown behind a HIGH-RISK dialog that **names SERVER-02's control-plane role** | moderate |
| Audit | `REQUESTED → DISPATCHED → STARTED → SUCCEEDED/FAILED` states with agent execution evidence | small |
| Docs | `docs/AGENT.md`, updated `DEPLOYMENT.md`, `SECURITY.md` | small |

**Explicitly unchanged:** self-hosted Convex, Better Auth, `requireOwner()`,
Caddy, Tailscale-only exposure, the backup system, SERVER-01/SERVER-02
identities, the audit chain, the snapshot data.

---

## 15. Test approach

**Disposable container only.** On each host, create a dedicated throwaway
container for the start/stop/restart proof:

```
SERVER-01:  docker run -d --name smc-selftest --restart=no alpine:3 sleep infinity
SERVER-02:  same
```

Never SchoolCore, never `church-platform-*`, `ooflowdesk-*`, `zongfitness-*`,
`neolife-*`, `ghub-production-*`, `convex-*`, or `smc-caddy`. The test container
is removed after validation.

**Host reboot and shutdown are not tested.** They require explicit Owner approval
of the first destructive host test, and SERVER-01 reboot would take 47 production
containers down. SERVER-02 reboot would take the control plane down and end the
session.

**Telemetry is verified against ground truth**: agent-reported counts must equal
`docker ps` output on each host at the same moment. A mismatch is a bug, not a
rounding difference.

---

## 16. Rollback

| Component | Rollback |
|---|---|
| Agent | `systemctl disable --now smc-agent && systemctl disable --now smc-helper`; remove `/usr/local/bin/smc-*`, `/etc/smc-agent`, `/etc/smc-helper`, `/var/lib/smc-agent`; `userdel smc-agent`. No host state is altered by an agent. |
| Gateway | Stop and remove the container; delete `/srv/platform/agent-gateway`. Convex and Caddy are untouched. |
| Convex changes | Schema additions are additive; the snapshot data and `requireOwner()` are unchanged. The UI falls back to snapshot values when no agent is enrolled, so the console keeps working. |
| Certificates | Revoke in the console; the host is disconnected immediately. |
| Console | Revert the commit; the pre-agent console continues to serve. |

**Milestone A is fully reversible with no data loss**, because agents only read
host state until a control action is explicitly invoked.

---

## 17. OWNER DECISIONS REQUIRED

| # | Decision | Blocks | Note |
|---|---|---|---|
| 1 | **Gateway listen address** — bind `100.80.65.109:8446` (tailnet only) as proposed? | Milestone A | Needs a new port in the Caddy/Tailscale model |
| 2 | **Agent build host** — Go is not installed on the workstation. Build in a container, install Go on the workstation, or use WSL? | Milestone A | I will not install Go without approval |
| 3 | **SERVER-01 sudo** — installing the agent needs your interactive password, as with the backup directory | Milestone A | No workaround |
| 4 | **Ceiling per host** — which capabilities may SERVER-01 and SERVER-02 hold? Proposal: both get all six in v1, ceiling enforced locally and centrally | Milestone A/C | SERVER-02 self-management is symmetric by design |
| 5 | **Heartbeat interval** — 5 s proposed. Accept, or prefer 10 s to reduce load on a 4-core host? | Milestone A | Both hosts run 2-core-class CPUs |
| 6 | **Agent→gateway transport** — HTTPS/JSON over mTLS on 8446, or a lighter framed protocol? | Milestone A | JSON is simplest to debug and audit |
| 7 | **Power-on scope** — accept that SERVER-02 power-on is a hypervisor task outside the agent channel? | Milestone D | See §13; it cannot be an agent capability |
| 8 | **SERVER-01 WoL** — authorise installing `ethtool` to read the NIC's WoL capability, and a BIOS check for Wake-on-LAN? | Milestone D | Read-only; no setting will be changed without approval |
| 9 | **First destructive host test** — SERVER-01 reboot would interrupt 47 production containers. When, and is it acceptable? | Milestone D | Deferred until you say so |
| 10 | **Gateway→Convex auth** — the gateway writes telemetry as an internal admin path. Acceptable, or should it act as a per-server identity with its own credentials? | Milestone A | Affects audit attribution |
| 11 | **Snapshot fallback** — keep showing operator-snapshot values for a host whose agent is offline, or show `OFFLINE` with no figures? | Milestone A | I recommend OFFLINE-only, to avoid stale data looking live |
| 12 | **Log streaming** — tail-only for v1, or prepare a streaming path now? | Milestone B | Streaming is materially more complex |

---

*Nothing installed, started, or modified on either host. No agent binary built.
The only change to this repository is this document.*
