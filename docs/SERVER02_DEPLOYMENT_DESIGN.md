# SERVER-02 Deployment Design

**Status:** PROPOSAL — nothing executed, nothing installed
**Date:** 2026-09-26
**Basis:** read-only baseline assessment of `gman-02` via `ssh gman-remote`, 2026-09-26 22:52 BST
**Scope:** SERVER-02 as both managed infrastructure node and control-plane host

> **This document is a design proposal.** No step in it has been performed. Every
> item marked **OWNER DECISION** must be settled by the Owner before the phase
> that depends on it begins.

---

## 0. Measured baseline this design responds to

Everything below is derived from the live assessment, not assumptions.

| Fact | Value | Design consequence |
|---|---|---|
| OS | Debian 13 "trixie" 13.5, kernel 6.12.107, amd64 | nftables is native; no `ufw`/`iptables` binaries present |
| CPU | i5-4300U, 2 cores / 4 threads @ 1.9 GHz | Resource **caps are mandatory**, not optional |
| RAM | 15 GiB total, 14 GiB available | Ample for Convex + proxy + agents |
| Disk | `/dev/sda2` 3.6 TiB ext4, 3.4 TiB free, 1% used | Ample. **Single disk, no RAID** |
| Container runtime | **NONE** — no docker/podman/nerdctl, no `/var/lib/docker` | Phase 1 is a hard prerequisite |
| Firewall | **NONE** — `ufw`, `nft`, `iptables` all absent | Phase 2 is a hard prerequisite |
| Port 80 | **OCCUPIED** by `nginx.service` → OMV web UI | Ingress design must not assume 80 |
| Port 443 | free | Console ingress |
| Ports 3210/3211/6791/5173 | free | Convex + Vite |
| Host role | OpenMediaVault engine + nginx + php8.4-fpm | Host is an appliance, not bare metal |
| Management channels | SaltStack (`/srv/salt`, `/srv/pillar`), monit, collectd | **Overlaps the future agent model** |
| Backups | **NONE** — no `omv-backup`, no cron, no timers | Must exist before any data lands |
| SSH | key-only, `PasswordAuthentication no`, `AllowGroups root _ssh` | 🟢 Strong — no change needed |
| Tailscale | active, `100.80.65.109`, MagicDNS `gman-02.tail0ab69b.ts.net` | Management + agent transport |
| SERVER-01 | reachable, SSH/22, ~5.8 ms RTT | Agent path viable |
| Auto-updates | `unattended-upgrades` active | Can disrupt a deployment mid-cycle |

---

## 1. Recommended architecture

### 1.1 Layer model

```
                    OWNER DEVICE
                    trusts private CA
                          │ 443 (tailnet only)
                          ▼
        ┌───────────────────────────────────────────┐
        │  SERVER-02  (gman-02)                     │
        │                                           │
        │  EDGE ─────────────────────────────────   │
        │   Caddy (container) :443                  │
        │     ├── /            → static console     │
        │     └── /convex/*    → convex backend     │
        │                        (127.0.0.1:3210)    │
        │                                           │
        │  CONTROL PLANE ─────────────────────────   │
        │   convex-backend   127.0.0.1:3210/3211    │
        │   convex-dashboard 127.0.0.1:6791         │
        │   convex-db        (SQLite volume)        │
        │   console agent  ── outbound mTLS ──┐     │
        │                                        │     │
        │  SELF-MANAGEMENT ─────────────────────┼──   │
        │   gman-02 agent ── outbound mTLS ────┤     │
        │   local-helper (privileged, narrow)   │     │
        │                                        │     │
        │  MANAGED NODE ROLE ───────────────────┘     │
        │   Docker Engine (own daemon)               │
        │   /srv/docker  (project data)              │
        │   /srv/console (compose + config)          │
        │                                           │
        │  SUBSTRATE (unchanged) ─────────────────   │
        │   OpenMediaVault engine + nginx:80         │
        │   SaltStack · Syncthing · monit/collectd   │
        └───────────────────────────────────────────┘
                          │  outbound mTLS only
                          ▼
                    ┌──────────────┐
                    │  SERVER-01   │  same agent model
                    │  agent ──────┤
                    └──────────────┘
```

### 1.2 Role separation — the central design rule

SERVER-02 wears three hats, and they must not blur:

| Layer | Runs | Managed by | Privilege |
|---|---|---|---|
| **Control plane** | Convex, console, Caddy | Owner directly, out-of-band | Infrastructure — not agent-managed |
| **Managed node** | gman-02's own services | **Its own agent**, same model as SERVER-01 | Constrained by capability ceiling |
| **Substrate** | OMV, SaltStack, Syncthing, monitoring | OMV/SaltStack as today | Root-equivalent — **not agent-managed** |

**Rule:** the agent manages the *node*; the Owner manages the *control plane*; the substrate is neither. This keeps the audit model coherent — agent actions are all attributable, and control-plane operations stay out-of-band by design.

> **Known tension, stated plainly:** the control plane lives on the same host it governs. Convex's database and the audit chain have no independent failure domain. This is accepted for now and is a documented risk (§9, R-9), not a solved problem.

---

## 2. Docker deployment model

### 2.1 Installation approach

**Recommendation: native Docker Engine + Compose v2 from Docker's official Debian repository. Not the OMV plugin.**

| Option | Verdict | Reason |
|---|---|---|
| Native Engine (recommended) | ✅ | Full control, upstream-supported, no OMV coupling |
| OMV `docker-ce` plugin | ❌ | Couples container lifecycle to the appliance; OMV upgrades become container-upgrade events |
| Rootless Docker | 🟨 alternative | Avoids mutating host `iptables` — attractive *because no firewall exists* — but adds systemd/UID-mapping complexity against an OMV host. **Worth revisiting if the firewall decision goes badly.** |

**Ordering constraint:** Docker rewrites host `iptables`/`nftables` rulesets on install and on every network attach. Installing it before a firewall exists means Docker silently becomes the de facto firewall. **Phase 1 (Docker) must therefore either follow Phase 2 (firewall), or ship with an explicit DOCKER-USER policy from the first start.**

### 2.2 Storage paths

| Path | Purpose | Rationale |
|---|---|---|
| `/srv/docker` | Docker root (`data-root`) | On the 3.4 TiB volume; separate from OMV-managed shares |
| `/srv/docker/volumes` | Named volumes (Convex DB) | Named volumes, never bind-mount the DB |
| `/srv/console/compose` | Compose files (git-managed) | Config as code, reviewable |
| `/srv/console/config` | Caddyfile, proxy config | Read-only bind mounts into containers |
| `/srv/console/secrets` | Secret material, mode `0700` | **Never in git, never in a compose file** |
| `/srv/backups` | Local backup staging | Staging only — off-host copy mandatory |

**OMV interaction:** OMV's share engine owns `/srv`. Creating Docker-owned subdirectories inside it risks OMV's share scanner reacting. **Verify the OMV share/exclusion model before populating these paths** — otherwise OMV may index or claim Convex's database volume.

### 2.3 Volume strategy

- **Convex database → named volume**, never a host bind mount. Snapshot and backup semantics depend on it.
- **Config → read-only bind mounts** (`ro`), so a compromised container cannot rewrite its own configuration.
- **Secrets → never mounted into containers.** Convex secrets are set via `convex env set` into the deployment environment, or injected as read-only files with `0400`.
- **No `.:/app` style mounts** for application code. The console is served as a **static build** (Caddy `file_server`), not a running Node process.

### 2.4 Isolation

Mandatory for every container, given 2 physical cores shared with OMV:

```yaml
# Applied to every service
security_opt:
  - no-new-privileges:true
cap_drop: [ALL]
read_only: true            # where the image permits
tmpfs: [/tmp]              # where writes are required
deploy:
  resources:
    limits: { cpus: "1.0", memory: 1g }
    reservations: { memory: 256m }
```

| Measure | Reason |
|---|---|
| `cap_drop: ALL` on every container | Nothing in this stack needs a Linux capability |
| `no-new-privileges` | Blocks setuid escalation |
| Explicit CPU/memory limits | Prevents Convex starving OMV — the host has **2 real cores** |
| `pids-limit` | Bounds fork bombs |
| No `privileged`, no `docker.sock` mount | The Docker socket is root-equivalent; mounting it defeats the entire capability model |
| Dedicated networks | See below |

**Network layout:**

| Network | Members | Exposure |
|---|---|---|
| `proxy` | caddy, convex-backend | internal; Caddy is the only egress path |
| `data` | convex-backend, convex-db | `internal: true` — no route off-host |
| `agents` | agent, gateway | egress for mTLS only |

Convex ports published as `127.0.0.1:3210:3210` etc. — **loopback bindings only.** Never `0.0.0.0`.

---

## 3. Firewall design

### 3.1 Required ports

| Port | Bind | Purpose | Exposure |
|---|---|---|---|
| 22 | `0.0.0.0` (current) | SSH | Tailnet preferred; LAN only if justified |
| 443 | host | Console + Convex ingress via Caddy | **Tailnet only** |
| 80 | **OMV nginx — occupied** | OMV web UI | Leave as-is; Caddy does not need it |
| 3210 | `127.0.0.1` | Convex sync/API | Loopback only |
| 3211 | `127.0.0.1` | Convex HTTP actions | Loopback only |
| 6791 | `127.0.0.1` | Convex dashboard | Loopback only |
| 8384 | `127.0.0.1` | Syncthing GUI | 🟢 Already correct |
| 22000 | `100.80.65.109` | Syncthing | 🟢 Already correct |

### 3.2 Deny-by-default model

```
default input   DROP
default forward DROP
default output  ACCEPT
```

| Rule | Source | Destination | Rationale |
|---|---|---|---|
| Allow SSH | `100.64.0.0/10` (tailnet) | 22 | Management over Tailscale only |
| Allow HTTPS | `100.64.0.0/10` | 443 | Console reachable only on the private path |
| Allow OMV | `192.168.1.0/24` | 80 | **Pre-existing exposure — decision required** |
| Drop RPC/mDNS | anywhere | 111, 5353, 5355 | Currently `0.0.0.0`-exposed with no filtering |

**Nothing is published on `0.0.0.0` except what is listed above.** Agent traffic is **outbound-initiated only** — no inbound agent port is ever opened, on either host.

### 3.3 Tailscale integration

- Tailscale remains the **only** management path. No new ingress.
- `tailscale serve` is currently `No serve config` — **do not** use it for the console. Keep the console's TLS termination inside Caddy on :443 so there is one ingress component, not two.
- Agent transport rides the existing tailnet or public egress with mTLS; either way the gateway **listens locally and agents dial out**.

### 3.4 Docker interaction — the critical detail

Docker inserts rules into `FORWARD` and the `DOCKER-USER` chain that **bypass UFW**. A UFW-default-deny host with Docker installed is not actually deny-by-default for container traffic.

Required mitigations:

1. **All published ports bind `127.0.0.1`** — then Docker's DNAT rules are unreachable from outside regardless of chain state. This is the primary control.
2. **Explicit `DOCKER-USER` policy** — default-drop forwarded traffic, then re-allow only what is required.
3. **Prefer `nftables` over `ufw`** as the host firewall — Debian 13 native, and Docker's interaction is easier to reason about when the rulesets are unified.
4. **Audit after every container start** — Docker re-writes chains on each attach.

---

## 4. Reverse proxy options

| Criterion | Reuse OMV nginx | Separate nginx (container) | **Caddy (container)** |
|---|---|---|---|
| **TLS** | Manual cert + reload; OMV UI coupled | Manual cert + reload | 🟢 **Automatic issuance**; `tls internal` for a private CA |
| **Config ownership** | 🔴 OMV rewrites `sites-enabled`; hand edits get clobbered | Own file, own lifecycle | Own file, own lifecycle |
| **Blast radius** | 🔴 OMV breakage takes the console down | 🟢 Isolated | 🟢 Isolated |
| **Maintenance** | 🟡 Familiar, but contested surface | 🟢 Standard | 🟢 Smallest config surface |
| **Recovery** | 🔴 Coupled to OMV engine health | 🟢 Independent restart | 🟢 Single static binary, no state |
| **Resource cost** | 0 (already running) | ~50 MB | ~40 MB |
| **Port 80 conflict** | Shares OMV's listener | Needs its own | **Avoided — 443 only** |

### Recommendation: **Caddy in a container, `tls internal`**

Reasons specific to this host:

1. **Port 80 is occupied by OMV.** Caddy needs only 443, sidestepping the conflict entirely.
2. **TLS is mandatory and PKI is undecided.** `tls internal` issues and rotates certificates for the tailnet hostname with no external CA and no `certbot` renewal cron. This directly answers OD-04 for a private-network deployment.
3. **Isolation from OMV** — the appliance cannot take the console down.
4. **Path routing `/convex/*` → backend** is three lines of config, and the same Caddy process becomes the natural termination point for future agent traffic.

**Trade-off to accept:** every Owner device must trust the Caddy root CA. One installation step per device, once.

**Alternative if minimising new components matters more:** separate nginx container + certs from the existing OMV PKI. Loses automatic renewal; gains familiarity.

**Explicitly not recommended:** reusing OMV's nginx. Contested config ownership plus a shared failure domain is the wrong trade for a control plane.

---

## 5. Backup architecture

**Current state: nothing is backed up.** This must change before any data lands.

| Data | Method | Frequency | Destination |
|---|---|---|---|
| Convex database | `docker exec` → dump, or volume snapshot | Daily minimum | Local staging + off-host |
| Audit chain | Append-only export (OD-07) | Daily | **Independent, write-restricted** |
| Compose + config | `git` in `/srv/console` | On change | Repository (private) |
| Firewall rules | `nft list ruleset` snapshot | On change | Repository + local |
| **Secrets** | Convex admin key, `JWT_PRIVATE_KEY`, `JWKS`, `OTP_API_KEY` | On rotation | **Encrypted secret store only — never git, never a compose file** |

### Principles

1. **Local staging is not a backup.** `/srv/backups` is a staging area; every backup must reach an off-host destination.
2. **Audit copy C is independent** (OD-07) — a different failure domain from Convex itself.
3. **Backups precede data.** Phase 0, not a follow-up task.
4. **Test restores.** A backup that has never been restored is a hypothesis.

### Recovery procedure

1. Identify scope: host loss, volume loss, or data corruption.
2. Restore host from the OMV/debian baseline; reinstall Docker; re-apply firewall config from the repository.
3. Recreate volumes; restore the Convex database dump.
4. Re-push Convex functions; re-apply deployment environment from the secret store.
5. Restore audit export and **verify the hash chain** (`docs/SECURITY.md` F-5 notes no verification path exists yet — this must be built before it matters).
6. Redeploy the console static build.
7. Re-enroll agents.

> ⚠️ **Constraint from `docs/RECOVERY.md`:** restores must not replay executed tasks once the agent layer exists. The task ledger's replay semantics must be settled **before** Phase 7, not during an incident.

---

## 6. Self-management model

**Requirement: SERVER-02 is managed by the same agent architecture as SERVER-01. No privileged exception.**

### 6.1 How SERVER-02 manages itself

SERVER-02 appears in the console as **an ordinary server**, with its own agent identity, its own certificates, and the same capability ceiling as SERVER-01. There is no `isLocalhost` bypass, no implicit trust, no "it's the same box" shortcut.

```
Console UI → mutation (normal path)
  → Convex authorization: role + capability ceiling   ← same code for both hosts
  → audit event (session-derived actor)              ← same schema
  → gateway → mTLS → gman-02 agent
  → local-helper: narrow, allowlisted, non-root
  → operation
```

Every step is identical to the SERVER-01 path. The only difference is which agent certificate the gateway selects.

### 6.2 The local helper

The privileged boundary on each host:

| Property | Requirement |
|---|---|
| Identity | Dedicated non-root user, e.g. `smc-helper` |
| Privilege | `sudoers` drop-in limited to specific binaries — **not** `NOPASSWD: ALL` |
| Scope | Explicit allowlist: `docker restart <named-container>`, `systemctl reload nginx`, nothing else |
| Identity | Own certificate; actions bound to agent identity in the audit chain |
| Boundary | Cannot escalate outside the allowlist; `no-new-privileges` |

**The helper is the only privileged path.** If an operation cannot be expressed through it, the operation is out of scope — not a reason to widen the helper.

### 6.3 Reconciling existing management channels

🔴 **This is the sharpest unresolved conflict on the host.**

| Channel | Status | Required action |
|---|---|---|
| **SaltStack** (`/srv/salt`, `/srv/pillar`, `/opt/saltstack`) | Present, 1.6 MB | 🔴 **Must be reconciled.** A second privileged management path bypasses the agent's capability ceiling entirely. Either (a) restrict Salt's master/minion reach so it cannot act on the console-managed domain, or (b) formally designate the local-helper as a Salt module so its actions land in the audit chain. **Silently layering the agent on top leaves two unaccountable control paths.** |
| **OMV engine** | Running | Out of agent scope by design (substrate). OMV root-equivalent operations stay out-of-band and must be documented as such. |
| **monit / collectd** | Running | Read-only monitoring. No conflict. |
| **Syncthing** | Running | Document transport. No conflict. |

### 6.4 Self-management boundary

The agent manages **the node** — containers, services, host state within its ceiling. It does **not** manage the control plane: Convex's own lifecycle, the proxy, and the audit database are Owner-operated, out-of-band. A control plane cannot self-provide its own failover; pretending otherwise is how single-host control planes silently lose their audit trail.

---

## 7. Deployment phases

Each phase has an entry gate. **Do not begin a phase until its gate is met.**

### Phase 0 — Preparation
- [ ] Settle all **OWNER DECISION** items in §8
- [ ] Establish **backup destination** and run one successful test restore
- [ ] Choose console hostname; confirm DNS
- [ ] Decide PKI / CA distribution to Owner devices
- [ ] Verify OMV share-exclusion model for `/srv/docker` and `/srv/console`
- [ ] Snapshot the pristine host config for rollback
- **Gate:** backups working and verified; decisions recorded in `docs/STATUS.md`
- **Rationale for going first:** everything after this creates state worth protecting.

### Phase 1 — Docker installation
- [ ] Install Docker Engine + Compose v2 (native, upstream repo)
- [ ] `data-root` → `/srv/docker`
- [ ] Apply default resource limits and security options
- [ ] Verify OMV and Syncthing unaffected; watch `monit` for regressions
- [ ] Confirm `iptables`/`nftables` post-install state before starting anything
- **Gate:** `docker run hello-world` succeeds; OMV healthy; **no container published beyond loopback**
- ⚠️ `unattended-upgrades` may auto-patch mid-phase — pin or pause during the window

### Phase 2 — Firewall setup
- [ ] Install nftables; establish default-deny
- [ ] Allow SSH (tailnet) and 443 (tailnet)
- [ ] Add explicit `DOCKER-USER` policy (default-drop forwarded traffic)
- [ ] Decide fate of LAN-exposed 80 / 111 / 5353 / 5355
- [ ] Verify from a LAN host that management ports are refused
- **Gate:** tailnet access works; LAN access to 22/443/111 refused; Convex ports unreachable externally
- ⚠️ **Lockout risk** — keep an active session open and verify tailnet SSH **before** committing rules

### Phase 3 — Convex deployment
- [ ] Write compose file to `/srv/console/compose`; pull images
- [ ] Start `convex-backend`, `convex-db`, `convex-dashboard` on `data` network
- [ ] Publish **3210/3211/6791 to `127.0.0.1` only**
- [ ] Generate admin key; store in the secret store
- [ ] Create `.env.local` in the repo (gitignored) with `VITE_CONVEX_URL`, `CONVEX_SELF_HOSTED_URL`, `CONVEX_SELF_HOSTED_ADMIN_KEY`
- [ ] `bun run convex:push` → generates `src/convex/_generated/`
- [ ] **`bun run typecheck`** — first genuine verdict; 74 errors are expected until codegen runs
- [ ] Set deployment env: `SITE_URL`, `CONVEX_SITE_URL`, `JWT_PRIVATE_KEY`, `JWKS`, `OTP_ENDPOINT_URL`, `OTP_API_KEY`
- [ ] Confirm backup job captures the database
- **Gate:** dashboard reachable on loopback, schema pushed, typecheck resolved, backup verified

### Phase 4 — Console deployment
- [ ] `bun run build` → static `dist/`
- [ ] Start Caddy on :443; `tls internal`; route `/` → static, `/convex/*` → backend
- [ ] Distribute the Caddy root CA to Owner devices
- [ ] Verify from a tailnet device: console loads, WebSocket to Convex opens
- [ ] Run the `docs/LOCAL_VALIDATION_GUIDE.md` §5 checklist (11 checks)
- [ ] **Before real data:** remove or restrict anonymous access (SECURITY.md F-2); rotate the OTP key (F-1)
- **Gate:** full checklist passes; security gates closed; audit events visible in the dashboard

### Phase 5 — SERVER-02 agent enrollment
- [ ] Build the **local-helper** (dedicated user, narrow sudoers allowlist)
- [ ] Issue gman-02's agent identity + mTLS certificate
- [ ] Start the agent; confirm **outbound-only** connection to the gateway
- [ ] **Reconcile SaltStack** per §6.3 — decide before enrolling
- [ ] Verify SERVER-02 appears in the console as an ordinary server
- [ ] **Prove no privileged exception:** attempt a privileged action through the console and confirm the capability ceiling refuses it; confirm the refusal is audited
- [ ] Run a recovery drill and record it
- **Gate:** self-management works through the identical path as any other host, with refusals enforced and audited

### Phase 6 — SERVER-01 agent enrollment
- [ ] Confirm SERVER-01 prerequisites (Docker present, tailnet reachable — SSH/22 confirmed working, ~5.8 ms)
- [ ] Install + enrol the agent with the same image and configuration as SERVER-02
- [ ] Verify parity: identical capability ceiling, identical audit schema
- [ ] Cross-host test: action on SERVER-01 appears correctly in the console
- **Gate:** both hosts managed identically; no host-specific code path

### Phase 7 — Post-deployment hardening
- [ ] CSP headers at the reverse proxy (SECURITY.md F-7)
- [ ] Audit chain verification path (F-5) — currently absent
- [ ] Session-derived audit actors (F-6) — actors still hardcoded `"Owner"`
- [ ] Role-based authorization (F-3)
- [ ] Document the recovery-runbook constraint on task replay

---

## 8. OWNER DECISION REQUIRED

Blocking items are marked 🔴 — the phase that needs them cannot start without a decision.

| # | Decision | Blocks | Why it is yours |
|---|---|---|---|
| 1 | 🔴 **Install Docker on an OpenMediaVault host?** | Phase 1 | Changes host rulesets, failure domain, and appliance lifecycle |
| 2 | 🔴 **Firewall ownership** — nftables host firewall vs Docker's own ruleset vs proxy-only? | Phase 2 | Docker and UFW conflict; the wrong choice silently breaks deny-by-default |
| 3 | 🔴 **Backup destination + RPO/RTO** (OD-07, OD-08) | Phase 0 | Requires infrastructure/asset decisions outside this repo |
| 4 | 🔴 **Reverse proxy: Caddy vs separate nginx** | Phase 4 | Determines TLS strategy and CA distribution |
| 5 | 🟡 **Port 80 / OMV nginx disposition** | Phase 2 | Decide whether OMV's LAN exposure is accepted or closed |
| 6 | 🟡 **LAN-exposed 111 / 5353 / 5355** | Phase 2 | Pre-existing exposure, outside the console's scope |
| 7 | 🟡 **Console hostname + DNS** | Phase 4 | Needs a stable identity for TLS |
| 8 | 🟡 **PKI custody** (OD-04) | Phase 4 | Determines CA type and device trust process |
| 9 | 🔴 **SaltStack reconciliation** | Phase 5 | Two privileged management paths cannot both be accountable |
| 10 | 🟡 **Self-management scope** — which operations the helper may perform | Phase 5 | Defines the capability ceiling for SERVER-02 |
| 11 | 🟡 **PostgreSQL vs SQLite for Convex** | Phase 3 | Affects backup and RPO design |
| 12 | 🟡 **Where does this design document live?** | — | Written to the console repo; `Server Arrangement` arguably owns SERVER-02 host architecture |
| 13 | 🟡 **Commit the uncommitted workspace work?** | — | 36 staged + 12 modified files, verified but never committed; deploying uncommitted code is a risk |

---

## 9. Risks

| ID | Risk | Severity | Mitigation |
|---|---|---|---|
| R-1 | No firewall today; SSH 22, OMV 80, rpcbind 111, avahi exposed to the whole LAN | 🔴 High | Phase 2 before any deployment |
| R-2 | Docker rewrites host rulesets and can become the de facto firewall | 🔴 High | Loopback-only publishing; explicit `DOCKER-USER`; audit after each start |
| R-3 | No backups; single disk, no RAID | 🔴 High | Phase 0; off-host copies; tested restore |
| R-4 | Control plane and audit chain share a failure domain with the host | 🔴 High | Accepted for now; independent audit export (OD-07) as partial mitigation |
| R-5 | Two unaccountable privileged paths (SaltStack + agent) | 🔴 High | Decision 9 before Phase 5 |
| R-6 | 2 physical cores shared with OMV; no resource caps | 🟡 Medium | Mandatory cgroup limits (§2.4) |
| R-7 | `unattended-upgrades` can disrupt a deployment mid-cycle | 🟡 Medium | Pause during phases; document the policy |
| R-8 | OMV may claim or index Docker-owned paths under `/srv` | 🟡 Medium | Verify share-exclusion model in Phase 0 |
| R-9 | Convex cannot self-provide failover | 🟡 Medium | Documented; out-of-band recovery only |
| R-10 | Anonymous provider grants full console control (SECURITY.md F-2) | 🟡 Medium | Must close before real data lands |
| R-11 | OTP key rotation still outstanding (SECURITY.md F-1) | 🟡 Medium | Owner action at the provider, before Phase 4 |
| R-12 | No audit-chain verification path exists (F-5) | 🟡 Medium | Phase 7; blocks trustworthy recovery |

---

## 10. Recommended sequence

```
Phase 0  Backups + decisions          ← highest value, zero risk
   ↓
Phase 1  Docker                       ← infrastructure change
   ↓
Phase 2  Firewall                     ← before anything is exposed
   ↓
Phase 3  Self-hosted Convex           ← unlocks typecheck, creates the first real data
   ↓
Phase 4  Console + security gates     ← F-1/F-2 closed before real data
   ↓
Phase 5  SERVER-02 agent enrolment    ← self-management, ceiling proven
   ↓
Phase 6  SERVER-01 agent enrolment    ← parity
   ↓
Phase 7  Hardening                    ← CSP, audit verification, RBAC
```

**Before any of it:** commit the verified decoupling work in the local workspace. Deploying from an uncommitted tree means the first production run is also the first execution of unreviewed code.

---

*Assessment only. No software installed, no service modified, no configuration changed on SERVER-02. All figures measured 2026-09-26 22:52 BST via `ssh gman-remote`.*
