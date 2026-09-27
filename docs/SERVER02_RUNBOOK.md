# SERVER-02 Implementation Runbook

**Status:** NOT EXECUTED — every phase below is a proposal
**Date:** 2026-09-26
**Companion:** `docs/SERVER02_DEPLOYMENT_DESIGN.md`
**Target:** `gman-02` (Debian 13 trixie) via `ssh gman-remote`

> **NOTHING IN THIS RUNBOOK HAS BEEN RUN.** No software installed, no service
> modified, no configuration changed. Commands are written for the Owner (or a
> future operator with approval) to execute phase by phase.
>
> **Each phase ends with an approval gate. Do not proceed past a gate until it
> is explicitly cleared.**

---

## Phase ordering note

The Owner-specified order places **firewall (Phase 1) before Docker (Phase 2)**.
This is correct and is deliberately better than the design document's original
draft order, which put Docker first.

**Why it matters:** Docker rewrites host `iptables`/`nftables` chains on install.
Installing it onto a host with **no firewall at all** lets Docker silently become
the de facto firewall — the exact inversion the console's security model exists to
prevent. Establishing a deny-by-default base *first* means Docker's chains land on
top of a known-good policy, and `DOCKER-USER` can be hardened immediately.

**Consequence for Phase 1:** it protects nothing yet, because no console service
exists to protect. Its job is to establish the base policy and to close the
pre-existing LAN exposures (ports 111, 5353, 5355) before anything new lands.

---

## Pre-flight prerequisites

Complete before Phase 0.

| # | Prerequisite | Status |
|---|---|---|
| 1 | `ssh gman-remote` works non-interactively | 🟩 DONE — verified 2026-09-26 |
| 2 | Tailscale connected, `100.80.65.109` reachable | 🟩 DONE — verified |
| 3 | SERVER-01 reachable from SERVER-02 (SSH/22, ~5.8 ms) | 🟩 DONE — verified |
| 4 | Convex default ports 3210/3211/6791 free | 🟩 DONE — verified |
| 5 | Port 443 free; port 80 occupied by OMV nginx | 🟩 DONE — verified |
| 6 | Console decoupling work committed | 🔴 **NOT DONE** — 36 staged + 12 modified files uncommitted |
| 7 | Backup destination chosen | 🟨 AWAITING DECISION |
| 8 | Docker / firewall / proxy / SaltStack decisions | 🟨 AWAITING DECISION |

> ⚠️ **Item 6 is a genuine risk.** The first deployment of this stack would also
> be the first execution of uncommitted, unreviewed code. Resolve before Phase 6.

---

# Phase 0 — Backup Preparation

**Status:** 🟨 **AWAITING DECISION** (backup destination, RPO/RTO)

## Objective

Establish a verified backup capability **before** any data exists. Current state:
no `omv-backup`, no cron, no timers, single disk with no RAID. Local staging does
not count as a backup.

## Commands to execute

```bash
# 0.1 — Confirm the current absence (baseline evidence)
dpkg -l | grep -i omv-backup || echo "NOT_INSTALLED"
crontab -l | grep -v '^#' || echo "no user crontab"
systemctl list-timers --no-legend | grep -Ei 'backup|dump' || echo "no backup timers"
df -h /

# 0.2 — Create the staging tree (Owner decision on final destination first)
sudo mkdir -p /srv/backups/{convex,audit,config,secrets}
sudo chmod 700 /srv/backups/secrets
sudo chown -R ghub:users /srv/backups

# 0.3 — Capture the pristine host configuration (rollback reference)
mkdir -p ~/server02-baseline
sshd -T            > ~/server02-baseline/sshd-effective.txt 2>/dev/null
ip -brief address  > ~/server02-baseline/network.txt
ip route           > ~/server02-baseline/routes.txt
systemctl list-units --state=running --no-pager > ~/server02-baseline/services.txt
dpkg -l            > ~/server02-baseline/packages.txt
ls -la /etc/nginx/sites-enabled/ > ~/server02-baseline/nginx-sites.txt

# 0.4 — Commit the console decoupling work (local workspace, not SERVER-02)
cd "E:/AI-Development/GHub/projects/Server Console"
git status && git diff --cached --stat
# Owner reviews, then:
git commit -m "Complete Freebuff/Vly decoupling and repository hygiene"
```

## Expected output

- `0.1` prints `NOT_INSTALLED`, `no user crontab`, `no backup timers` — confirms the gap
- `0.2` creates four directories; `/srv/backups/secrets` is `0700`
- `0.3` produces five plain-text baseline files in `~/server02-baseline/`
- `0.4` shows a reviewable diff before commit

## Security checks

- [ ] `/srv/backups/secrets` is mode `0700`, owned by a non-root service account
- [ ] No secret material is written to any git-tracked path
- [ ] Baseline captures contain **no** private keys, tokens, or passwords
- [ ] `sshd -T` output reviewed — confirm `PasswordAuthentication no` still holds
- [ ] Off-host destination is **not** on the same disk as the source

## Rollback plan

Phase 0 is additive. Rollback = `sudo rm -rf /srv/backups` and, if the commit is
undesired, `git reset --soft HEAD~1`. **No system state is modified**, so rollback
is complete and riskless.

## Verification steps

1. `ls -ld /srv/backups/secrets` → `drwx------`
2. `ls -1 ~/server02-baseline/` → five files present
3. Off-host destination reachable and writable from SERVER-02
4. **Perform one test file transfer and one test restore** — an unverified backup is a hypothesis

## Owner approval gate

🟨 **BLOCKED — requires decision 3 (backup destination + RPO/RTO).**
Do not proceed until an off-host destination exists and a test restore has
succeeded.

---

# Phase 1 — Firewall Preparation

**Status:** ⚪ **NOT STARTED**

## Objective

Establish a deny-by-default host firewall **before** Docker exists, so Docker's
chains land on a known-good base. Close the pre-existing LAN exposures.

## Commands to execute

```bash
# 1.1 — Record current exposure as a baseline
sudo ss -tulpn > ~/server02-baseline/ports-before.txt

# 1.2 — Install nftables (native on Debian 13; not present today)
sudo apt update
sudo apt install -y nftables
sudo systemctl enable nftables

# 1.3 — Write the base policy
sudo tee /etc/nftables.conf > /dev/null <<'EOF'
#!/usr/sbin/nft -f
flush ruleset

table inet filter {
  set tailnet { type ipv4_addr; flags interval; elements = { 100.64.0.0/10 } }

  chain input {
    type filter hook input priority 0; policy drop;
    ct state established,related accept
    iif lo accept
    ip protocol icmp accept
    ip6 nexthdr ipv6-icmp accept
    ip saddr @tailnet tcp dport { 22, 443 } accept
    ip saddr 192.168.1.0/24 tcp dport 80 accept comment "OMV web UI - see decision 5"
  }

  chain forward {
    type filter hook forward priority 0; policy drop;
  }

  chain output {
    type filter hook output priority 0; policy accept;
  }
}
EOF

# 1.4 — Validate BEFORE applying (nft -c checks syntax without loading)
sudo nft -c -f /etc/nftables.conf

# 1.5 — Apply
sudo systemctl restart nftables
sudo nft list ruleset
```

> ⚠️ **LOCKOUT PREVENTION — non-negotiable.**
> Keep the **current SSH session open** in a second terminal. Apply the rules, then
> **immediately** verify tailnet SSH still works from a third session
> (`ssh gman-remote true`). Only once that succeeds may you close the original
> session. If the new session fails, the old session is your way out.

## Expected output

- `1.1` lists `22`, `80`, `111`, `5353`, `5355`, `8384`, `22000`, `41641` on `0.0.0.0`
- `1.2` installs `nftables`; `systemctl is-enabled nftables` → `enabled`
- `1.4` prints nothing on success (syntax OK)
- `1.5` `nft list ruleset` shows `policy drop` on input and forward

## Security checks

- [ ] `chain input` policy is `drop`
- [ ] `chain forward` policy is `drop`
- [ ] SSH reachable **from the tailnet** (100.80.65.109 path)
- [ ] Port 443 reachable from tailnet, refused from LAN
- [ ] **Ports 111, 5353, 5355 no longer reachable from LAN** (pre-existing exposure closed)
- [ ] Port 8384 still `127.0.0.1`-only; 22000 still tailnet-only (Syncthing unaffected)
- [ ] Tailnet access to SSH survives a `nftables` restart

## Rollback plan

```bash
# Immediate recovery from the retained session:
sudo nft flush ruleset          # removes all rules, restores full connectivity
sudo systemctl disable --now nftables
sudo rm /etc/nftables.conf
# Then re-establish SSH reachability from the tailnet before retrying.
```

`sshd` is untouched by this phase, so rollback always leaves a usable session.

## Verification steps

1. From a **LAN** host: `nc -z 192.168.1.200 22` → **refused**
2. From a **LAN** host: `nc -z 192.168.1.200 111` → **refused**
3. From the tailnet: `ssh gman-remote 'echo ok'` → `ok`
4. `sudo nft list chain inet filter input` → confirm the tailnet set and policies
5. Reboot-free check: `sudo systemctl restart nftables && ssh gman-remote true`

## Owner approval gate

🟨 **Requires decision 2 (firewall ownership) before `1.2`, and decision 5
(OMV port 80 disposition) before `1.3`.** Confirm the tailnet SSH path works
before declaring this phase complete.

---

# Phase 2 — Docker Installation

**Status:** ⚪ **NOT STARTED**

## Objective

Install Docker Engine + Compose v2 natively, with all ports loopback-only and
all containers resource-capped. Docker is **not** installed today.

## Commands to execute

```bash
# 2.1 — Confirm trixie support in Docker's repository BEFORE adding it
curl -fsSL https://download.docker.com/linux/debian/dists/ | grep -o 'trixie' | head -1
# If "trixie" is absent, use the Debian-packaged fallback in 2.2b.

# 2.2a — Preferred: Docker's official repository
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg \
  | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/debian $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io \
  docker-buildx-plugin docker-compose-plugin

# 2.2b — Fallback if trixie is unsupported upstream
sudo apt install -y docker.io docker-compose-v2

# 2.3 — Configure the data root and default hardening
sudo mkdir -p /etc/docker
sudo tee /etc/docker/daemon.json > /dev/null <<'EOF'
{
  "data-root": "/srv/docker",
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" },
  "live-restore": true
}
EOF

# 2.4 — Apply and verify (does NOT start any container)
sudo systemctl enable --now docker
docker --version && docker compose version
docker info --format '{{.DockerRootDir}} {{.Driver}} {{.ServerVersion}}'

# 2.5 — Inspect what Docker did to the firewall
sudo nft list ruleset > ~/server02-baseline/nft-after-docker.txt
diff ~/server02-baseline/ports-before.txt <(sudo ss -tulpn) || true
```

## Expected output

- `2.1` prints `trixie` (proceed with 2.2a) or nothing (use 2.2b)
- `2.4` prints `29.x.x`, `v2.x.x`, and `/srv/docker overlay 29.x.x`
- `2.5` diff shows **no new host listeners** — Docker must not open ports by itself

## Security checks

- [ ] `data-root` is `/srv/docker`, not the default `/var/lib/docker`
- [ ] **No container is running** and no ports published
- [ ] `nft` input policy still `drop` after Docker's chain insertion
- [ ] `iptables -S DOCKER-USER` exists (even empty) — this is the hook hardened in Phase 5
- [ ] OMV web UI still reachable on port 80 from the LAN
- [ ] Syncthing unaffected
- [ ] `live-restore` enabled (containers survive daemon restarts)
- [ ] Log rotation capped (prevents unbounded disk growth)

## Rollback plan

```bash
sudo systemctl disable --now docker
sudo apt purge -y docker-ce docker-ce-cli containerd.io \
  docker-buildx-plugin docker-compose-plugin
sudo rm -rf /srv/docker /etc/docker
# Then restore firewall:  sudo nft flush ruleset && sudo systemctl restart nftables
# Then re-apply Phase 1 policy from /etc/nftables.conf
```

**Order matters:** roll back Docker *first*, then repair the firewall. Removing
Docker removes its chains, but the deny-by-default base must be re-verified
afterwards.

## Verification steps

1. `docker run --rm hello-world` → success, then confirm it published nothing
2. `sudo ss -tulpn` → identical to `ports-before.txt` apart from Docker's internal bridges
3. `sudo nft list chain inet filter input` → still `policy drop`
4. OMVS: `http://192.168.1.200` still loads
5. `docker info` → `DockerRootDir` is `/srv/docker`

## Owner approval gate

🟨 **Requires decision 1 (Docker on an OMV host).** Confirm the trixie package
source before proceeding, and confirm OMV is healthy after installation.

---

# Phase 3 — Storage Layout

**Status:** ⚪ **NOT STARTED**

## Objective

Create the directory tree, dedicated networks, and volume strategy for the
control plane and managed-node roles.

## Commands to execute

```bash
# 3.1 — Create the tree
sudo mkdir -p /srv/docker/volumes
sudo mkdir -p /srv/console/{compose,config,secrets,dist}
sudo mkdir -p /srv/console/config/caddy
sudo chmod 700 /srv/console/secrets
sudo chown -R ghub:users /srv/console /srv/docker

# 3.2 — Verify OMV does not claim these paths
sudo find /srv -maxdepth 2 -name '*.omv*' 2>/dev/null
sudo ls -la /srv

# 3.3 — Create the three networks
docker network create --driver bridge --internal convex-data
docker network create --driver bridge convex-proxy
docker network create --driver bridge convex-agents
docker network ls

# 3.4 — Pre-create the Convex data volume
docker volume create convex-data
docker volume inspect convex-data
```

## Expected output

- `3.1` five top-level directories; `secrets` at `0700`
- `3.3` three networks; `convex-data` shows `internal: true` (no route off-host)
- `3.4` volume `convex-data` mounted at `/home/convex/data`

## Security checks

- [ ] `/srv/console/secrets` is `0700` and **not** world-readable
- [ ] `convex-data` network is `internal: true` — the database cannot egress
- [ ] `convex-agents` is the only network with outbound intent
- [ ] No secrets committed to `/srv/console/compose` (that tree is git-managed)
- [ ] OMV share engine has not indexed or claimed `/srv/docker` or `/srv/console`
- [ ] Disk still shows >3 TiB free

## Rollback plan

```bash
docker volume rm convex-data
docker network rm convex-data convex-proxy convex-agents
sudo rm -rf /srv/docker/volumes /srv/console
```

Safe to run at any point in this phase — no service depends on these yet.

## Verification steps

1. `docker network inspect convex-data --format '{{.Internal}}'` → `true`
2. `ls -ld /srv/console/secrets` → `drwx------`
3. `docker volume ls` → `convex-data` present
4. `df -h /` → unchanged, >3 TiB available

## Owner approval gate

🟩 **No blocking decision.** Proceed once the OMV share-exclusion check in `3.2`
returns clean. If OMV claims these paths, escalate before continuing.

---

# Phase 4 — Caddy Deployment

**Status:** ⚪ **NOT STARTED**

## Objective

Deploy the TLS edge on port 443 with automatic private-CA certificates. Avoids
the port 80 conflict entirely and isolates the console from the OMV failure
domain.

## Commands to execute

```bash
# 4.1 — Retrieve the official self-hosted Convex compose file (host reference)
mkdir -p ~/convex-selfhosted && cd ~/convex-selfhosted
curl -fsSL -o docker-compose.yml \
  https://raw.githubusercontent.com/get-convex/convex-backend/main/self-hosted/docker/docker-compose.yml
head -40 docker-compose.yml

# 4.2 — Create the Caddyfile
sudo tee /srv/console/config/caddy/Caddyfile > /dev/null <<'EOF'
console.gman-02.tail0ab69b.ts.net {
	tls internal

	handle /convex/* {
		reverse_proxy 127.0.0.1:3210
	}

	handle {
		root * /srv/console/dist
		file_server
	}

	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		X-Content-Type-Options "nosniff"
		X-Frame-Options "DENY"
		Referrer-Policy "no-referrer"
		Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' wss://console.gman-02.tail0ab69b.ts.net; img-src 'self' data:; frame-ancestors 'none'"
	}

	log {
		output file /var/log/caddy/access.log
	}
}
EOF

# 4.3 — Compose file for the edge
sudo tee /srv/console/compose/caddy.yml > /dev/null <<'EOF'
services:
  caddy:
    image: caddy:2-alpine
    container_name: smc-caddy
    restart: unless-stopped
    ports:
      - "127.0.0.1:443:443"
      - "127.0.0.1:80:80"
    volumes:
      - /srv/console/config/caddy/Caddyfile:/etc/caddy/Caddyfile:ro
      - /srv/console/dist:/srv/console/dist:ro
      - caddy-data:/data
      - caddy-config:/config
    cap_drop: [ALL]
    cap_add: [NET_BIND_SERVICE]
    security_opt: [no-new-privileges:true]
    deploy:
      resources:
        limits: { cpus: "0.5", memory: 256m }
volumes:
  caddy-data:
  caddy-config:
EOF

# 4.4 — Validate the Caddyfile before starting
cd /srv/console/compose
docker compose -f caddy.yml config --quiet && echo "compose config OK"

# 4.5 — Start
docker compose -f caddy.yml up -d
docker compose -f caddy.yml ps
```

## Expected output

- `4.1` prints the official compose YAML
- `4.4` prints `compose config OK`
- `4.5` `smc-caddy` shows `Up`, bound to `127.0.0.1:443` — **not** `0.0.0.0`
- Caddy log shows a certificate issued for the console hostname

## Security checks

- [ ] Ports bound to **`127.0.0.1` only** — never `0.0.0.0`
- [ ] `cap_drop: ALL` with only `NET_BIND_SERVICE` added back
- [ ] `no-new-privileges` applied
- [ ] Caddyfile and `dist` mounted **read-only**
- [ ] `live-restore`/`restart: unless-stopped` set
- [ ] CSP header present (SECURITY.md F-7 requires the proxy to supply it)
- [ ] 443 reachable **from the tailnet only**; refused from the LAN
- [ ] Caddy root CA exported for device distribution (Phase 6)

## Rollback plan

```bash
cd /srv/console/compose && docker compose -f caddy.yml down
# Remove volumes only if discarding issued certificates:
docker volume rm caddy-data caddy-config
sudo rm -rf /srv/console/config/caddy
```

Nothing else depends on Caddy yet, so rollback is complete.

## Verification steps

1. `docker compose -f caddy.yml ps` → `127.0.0.1:443->443/tcp`
2. `curl -k --resolve console.gman-02.tail0ab69b.ts.net:443:127.0.0.1 \
     https://console.gman-02.tail0ab69b.ts.net/` → serves `dist/`
3. `curl -sI http://127.0.0.1:443` → security headers present
4. From a LAN host: `nc -z 192.168.1.200 443` → **refused**
5. `docker exec smc-caddy caddy validate --config /etc/caddy/Caddyfile` → valid

## Owner approval gate

🟨 **Requires decision 4 (Caddy vs separate nginx), decision 7 (hostname), and
decision 8 (PKI).** `tls internal` means every Owner device must trust the Caddy
root CA — confirm that is acceptable before issuing certificates.

---

# Phase 5 — Self-Hosted Convex Deployment

**Status:** ⚪ **NOT STARTED** (requires Phase 2)

## Objective

Run the Convex backend, dashboard, and database on SERVER-02, reachable only via
loopback, and generate `src/convex/_generated/` — which is the prerequisite for
the first real typecheck verdict in this project's history.

## Commands to execute

```bash
# 5.1 — Prepare the Convex compose file
cd /srv/console/compose
sudo cp ~/convex-selfhosted/docker-compose.yml ./convex.yml
# Edit: publish ports to 127.0.0.1 only, attach to convex-data + convex-proxy,
#       set CONVEX_CLOUD_ORIGIN / CONVEX_SITE_ORIGIN, add resource limits.

# 5.2 — Pull and start
docker compose -f convex.yml pull
docker compose -f convex.yml up -d
docker compose -f convex.yml ps
docker logs --tail 50 convex-backend

# 5.3 — Confirm loopback-only binding
sudo ss -tulpn | grep -E ':(3210|3211|6791)'

# 5.4 — Generate the admin key
docker compose -f convex.yml exec backend ./generate_admin_key.sh
# Store the output in /srv/console/secrets/convex-admin-key (mode 0400).
# NEVER commit it.

# 5.5 — Generate JWT key material OUTSIDE the repository
mkdir -p ~/convex-keys && cd ~/convex-keys
npm i jose
cat > generateKeys.mjs <<'EOF'
import { exportJWK, exportPKCS8, generateKeyPair } from "jose";
const keys = await generateKeyPair("RS256", { extractable: true });
const privateKey = await exportPKCS8(keys.privateKey);
const publicKey = await exportJWK(keys.publicKey);
const jwks = JSON.stringify({ keys: [{ use: "sig", ...publicKey }] });
process.stdout.write(`JWT_PRIVATE_KEY="${privateKey.trimEnd().replace(/\n/g, " ")}"\n`);
process.stdout.write(`JWKS=${jwks}\n`);
EOF
node generateKeys.mjs > ~/convex-keys/keys.env
chmod 600 ~/convex-keys/keys.env

# 5.6 — Configure the repository (run on the workstation, not SERVER-02)
cd "E:/AI-Development/GHub/projects/Server Console"
# Create .env.local (gitignored — verify with: git check-ignore .env.local)
#   VITE_CONVEX_URL=https://console.gman-02.tail0ab69b.ts.net
#   CONVEX_SELF_HOSTED_URL=https://console.gman-02.tail0ab69b.ts.net
#   CONVEX_SELF_HOSTED_ADMIN_KEY=<from 5.4>

# 5.7 — Push functions (generates src/convex/_generated/)
bunx convex env set SITE_URL https://console.gman-02.tail0ab69b.ts.net
bunx convex env set CONVEX_SITE_URL https://console.gman-02.tail0ab69b.ts.net
bunx convex env set JWT_PRIVATE_KEY "<from keys.env>"
bunx convex env set JWKS "<from keys.env>"
bunx convex env set OTP_ENDPOINT_URL "<Owner-controlled mail endpoint>"
bunx convex env set OTP_API_KEY "<key>"
bun run convex:push          # expect: "Convex functions ready!"

# 5.8 — First genuine typecheck verdict
bun run typecheck
```

## Expected output

- `5.3` shows `127.0.0.1:3210`, `127.0.0.1:3211`, `127.0.0.1:6791` — **not** `0.0.0.0`
- `5.7` ends with `Convex functions ready!`
- `5.8` **`src/convex/_generated/` now exists** and the 74 TS2307/TS7006/TS7031 errors resolve

## Security checks

- [ ] Convex ports bound to `127.0.0.1` exclusively
- [ ] `convex-data` network is `internal: true`
- [ ] Admin key stored at `0400`, **never** in git or a compose file
- [ ] `JWT_PRIVATE_KEY` / `JWKS` generated outside the repository
- [ ] `OTP_API_KEY` is a **rotated** value (SECURITY.md F-1 still open)
- [ ] `docker logs` shows no secrets
- [ ] Container has `cap_drop: ALL`, memory limit, `no-new-privileges`
- [ ] **No Docker socket mounted** anywhere

## Rollback plan

```bash
cd /srv/console/compose
docker compose -f convex.yml down          # keeps the data volume
docker compose -f convex.yml down -v       # destroys data — full reset
```

To revert to pre-Convex state, also remove `.env.local` and `src/convex/_generated/`
from the workstation. The repository itself is never modified by a push.

## Verification steps

1. `curl -s http://127.0.0.1:3210/version` → responds
2. `curl -s http://127.0.0.1:3211/version` → responds
3. Dashboard at `http://127.0.0.1:6791` accepts the admin key
4. From a LAN host: `nc -z 192.168.1.200 3210` → **refused**
5. `test -d src/convex/_generated` → true
6. **`bun run typecheck` → 0 errors** (74 before codegen)
7. **Configure and test a database backup job** (Phase 0 destination) — data now exists

## Owner approval gate

🟨 **Requires a decision 11 (SQLite vs PostgreSQL) and an Owner-controlled
`OTP_ENDPOINT_URL`.** Note that removing the anonymous provider (SECURITY.md F-2)
is a **Phase 6 gate**, not a Phase 5 one — do not expose the console to real data
until it is closed.

---

# Phase 6 — Server Management Console Deployment

**Status:** 🔴 **BLOCKED** (requires Phase 5 codegen; also requires the uncommitted workspace work to be resolved)

## Objective

Build the static console, serve it through Caddy, and run the full validation
checklist before any real data enters the system.

## Commands to execute

```bash
# 6.1 — Build on the workstation (needs a clean, committed tree)
cd "E:/AI-Development/GHub/projects/Server Console"
git status                                   # must be clean
bun install --frozen-lockfile
bun run typecheck                            # must be 0 errors
bun run build                                # → dist/

# 6.2 — Transfer the static build to SERVER-02
scp -r dist gman-remote:/tmp/smc-dist
ssh gman-remote 'sudo rm -rf /srv/console/dist/* && sudo cp -r /tmp/smc-dist/* /srv/console/dist/ && sudo chown -R root:root /srv/console/dist && sudo rm -rf /tmp/smc-dist'
ssh gman-remote 'ls -la /srv/console/dist'

# 6.3 — Export the Caddy root CA for device trust
ssh gman-remote 'docker cp smc-caddy:/data/caddy/pki/authorities/local/root.crt /tmp/smc-root.crt'
scp gman-remote:/tmp/smc-root.crt .

# 6.4 — Security gates BEFORE real data (SECURITY.md)
#   F-1: OTP key rotated at the provider
#   F-2: anonymous provider removed or restricted to read-only
# Verify F-2 is actually enforced, not merely documented.

# 6.5 — Run the validation checklist
# Follow docs/LOCAL_VALIDATION_GUIDE.md §5 — all 11 checks:
#   1  App starts (landing page renders)
#   2  Auth works (OTP code delivered)
#   3  Dashboard loads after sign-in
#   4  Seed the demo estate
#   5  Data queries (Servers, server detail)
#   6  Mutations (restart container)
#   7  Audit records (chained hash visible)
#   8  Replay demo (REJECTION event)
#   9  Communication workflow (draft/approve/revoke)
#  10  Enrollment workflow (invite/approve)
#  11  Dashboard cross-check (auditEvents seq increasing)
```

## Expected output

- `6.1` `git status` clean; typecheck `0 errors`; `dist/` with hashed assets
- `6.2` `/srv/console/dist/index.html` present
- `6.3` `smc-root.crt` on the workstation
- `6.5` all 11 checklist rows pass

## Security checks

- [ ] Build produced from a **clean, committed** tree
- [ ] No secrets in `dist/` (grep for `convex.cloud`, `fb_email_`, `VLY_`)
- [ ] **F-2 closed** — anonymous access removed or read-only, and verified by attempting it
- [ ] **F-1 closed** — OTP key rotated at the provider
- [ ] Caddy root CA installed on each Owner device
- [ ] CSP active — console renders without CSP violations in DevTools
- [ ] Console reachable from the tailnet; **refused from the LAN**
- [ ] WebSocket connects to the Convex origin through the proxy

## Rollback plan

```bash
ssh gman-remote 'sudo rm -rf /srv/console/dist/*'   # console down, Convex intact
# Convex keeps running; only the static frontend is removed.
```

The frontend is stateless — rollback is deleting files. Convex and its data are
unaffected, which is the benefit of the static-build design.

## Verification steps

1. Tailnet device: `https://console.gman-02.tail0ab69b.ts.net` → landing page renders
2. DevTools → Network → WS → open WebSocket to the console origin
3. LAN host: `nc -z 192.168.1.200 443` → **refused**
4. Sign in with email OTP; code arrives at the mail endpoint
5. Complete all 11 checklist items in `LOCAL_VALIDATION_GUIDE.md` §5
6. Dashboard shows `auditEvents` with increasing `seq`
7. Attempt anonymous "Continue as guest" → **must be refused** (F-2 verification)

## Owner approval gate

🟨 **Requires decisions 7, 8 (hostname/TLS) and explicit closure of SEC-.md F-1
and F-2.** Also requires the uncommitted workspace work to be committed first —
deploying unreviewed code as the first production execution is avoidable risk.

---

# Phase 7 — SERVER-02 Agent Preparation

**Status:** ⚪ **NOT STARTED** (requires decision 9)

## Objective

Build the privileged boundary (`local-helper`) and enrol SERVER-02 as an
**ordinary** server with no privileged exception. The agent manages the node;
the Owner manages the control plane.

## Commands to execute

```bash
# 7.1 — Reconcile SaltStack BEFORE enrolling (decision 9)
sudo salt-call --local sys.list_functions > ~/server02-baseline/salt-modules.txt
systemctl is-enabled salt-minion 2>/dev/null || echo "salt-minion not enabled"
# Either restrict Salt's reach over the console-managed domain, or designate the
# helper as a Salt module so its actions land in the audit chain.

# 7.2 — Create the dedicated helper identity (non-root)
sudo useradd --system --create-home --shell /usr/sbin/nologin smc-helper
sudo install -d -o root -g root -m 0750 /opt/smc-helper

# 7.3 — Narrow sudoers allowlist — NOT NOPASSWD: ALL
sudo visudo -f /etc/sudoers.d/smc-helper
```

```
# /etc/sudoers.d/smc-helper — content to add
Cmnd_Alias SMC_HELPER = /usr/bin/docker restart caddy, \
                       /usr/bin/docker restart convex-backend, \
                       /usr/bin/docker restart convex-dashboard, \
                       /usr/bin/systemctl reload nginx, \
                       /usr/bin/journalctl -u convex-backend -n 200 --no-pager

%smc-helper ALL=(root) NOPASSWD: SMC_HELPER
Defaults!SMC_HELPER !set_home, noexec, restrict
```

> ⚠️ `noexec` and `restrict` are hardening flags. Verify they do not break the
> intended commands **before** relying on them — test each one explicitly.

```bash
# 7.4 — Issue the agent identity + mTLS certificate
# Agent certificate issued by the same CA as SERVER-01's, with SERVER-02's own
# subject. No shared credential with SERVER-01.

# 7.5 — Start the agent — OUTBOUND ONLY
systemctl enable --now smc-agent
ss -tulpn | grep smc-agent || echo "no inbound agent listener (correct)"

# 7.6 — Verify parity
# SERVER-02 must appear in the console as an ordinary server with its own
# identity, its own certificate, and the same capability ceiling as SERVER-01.
```

## Expected output

- `7.2` `smc-helper` exists, system account, `nologin` shell
- `7.5` **no inbound listener** — the agent dials out only
- `7.6` SERVER-02 visible in the console fleet view

## Security checks

- [ ] `smc-helper` is **non-root**, `nologin`, system account
- [ ] sudoers is a **named command allowlist** — no `NOPASSWD: ALL`
- [ ] `smc-helper` cannot escalate outside the allowlist
- [ ] Agent has **no inbound listener** and no inbound port opened in the firewall
- [ ] Agent certificate is unique to SERVER-02, not shared with SERVER-01
- [ ] **No privileged exception exists for SERVER-02** — verified by attempting a forbidden action
- [ ] SaltStack reach reconciled (decision 9) — no second unaccountable control path
- [ ] Every agent action produces an audit event with a session-derived actor
- [ ] Capability ceiling refusal is **audited**, not just blocked

## Rollback plan

```bash
sudo systemctl disable --now smc-agent
sudo rm /etc/sudoers.d/smc-helper
sudo userdel --remove smc-helper
sudo rm -rf /opt/smc-helper
# Revoke the agent certificate in the CA and remove the identity from the console.
```

Fully reversible. The helper holds no state; the control plane is untouched.

## Verification steps

1. `getent passwd smc-helper` → system account, `nologin`
2. `sudo -u smc-helper sudo -n -l` → lists **only** the allowlisted commands
3. `sudo -u smc-helper sudo -n apt install cowsay` → **refused** (escalation blocked)
4. `ss -tulpn | grep smc-agent` → empty (outbound only)
5. Console: restart a Convex container via the normal UI → succeeds, audited
6. Console: attempt an action above SERVER-02's ceiling → **refused and audited**
7. Confirm no `isLocalhost` / bypass code path exists in the authorization layer

## Owner approval gate

🔴 **Requires decision 9 (SaltStack reconciliation) and decision 10
(self-management scope).** The capability ceiling cannot be demonstrated while a
second privileged path exists.

---

# Phase 8 — SERVER-01 Enrollment Preparation

**Status:** ⚪ **NOT STARTED** (requires Phase 7 to prove the model)

## Objective

Replicate the agent model onto SERVER-01 **identically** — same image, same
configuration, same capability ceiling, same audit schema — and demonstrate that
no host-specific code path exists. The model must be proven on SERVER-02 first;
SERVER-01 is the replication target, not the proving ground.

SERVER-01 hosts live workloads, so this phase is assessment-then-enrol, with
explicit Owner authorization required before anything touches it.

## Commands to execute

```bash
# 8.1 — Verify SERVER-01 prerequisites (already partially confirmed)
ssh gman-remote 'timeout 5 bash -c "</dev/tcp/100.94.91.17/22" && echo REACHABLE'

# 8.2 — Inspect SERVER-01 (on SERVER-01 itself, not from here)
#   - Docker present? version?
#   - Which ports are in use?
#   - Is there a firewall?
#   - Free RAM/disk?
# NOTE: SERVER-01 currently runs OMV + Docker with projects. Do NOT modify it
#       during assessment.

# 8.3 — Enrol with the SAME image and configuration as SERVER-02
scp smc-agent <SERVER-01>:~/
ssh <SERVER-01> 'sudo useradd --system --create-home --shell /usr/sbin/nologin smc-helper'
ssh <SERVER-01> 'sudo cp /path/to/smc-helper-sudoers /etc/sudoers.d/smc-helper && sudo visudo -c'
ssh <SERVER-01> 'systemctl enable --now smc-agent'
```

## Expected output

- `8.1` `REACHABLE`
- `8.3` agent starts, dials out, appears in the console

## Security checks

- [ ] **Identical agent image and configuration** as SERVER-02
- [ ] **Identical capability ceiling** — no host-specific allowances
- [ ] **Identical audit schema** — same events, same fields
- [ ] SERVER-01's own projects unaffected (it hosts live workloads)
- [ ] Agent outbound-only; no inbound port opened on SERVER-01
- [ ] No privileged exception for SERVER-01 either

## Rollback plan

```bash
ssh <SERVER-01> 'sudo systemctl disable --now smc-agent'
ssh <SERVER-01> 'sudo rm /etc/sudoers.d/smc-helper && sudo userdel smc-helper'
# Revoke certificate; remove identity from console.
```

## Verification steps

1. SERVER-01 appears in the console as an ordinary server
2. An action on SERVER-01 behaves **identically** to the same action on SERVER-02
3. Both audit events share the same schema
4. No code path distinguishes the two hosts — grep the authorization layer for
   hostname/identity conditionals and confirm none exist
5. SERVER-01's existing containers and services still running normally

## Owner approval gate

🟨 **Requires Phase 7 complete** (the model must be proven on SERVER-02 before
being replicated) **and Owner authorization to touch SERVER-01 at all** — it hosts
live workloads and was previously off-limits.

---

# Status Summary

| Phase | Scope | Status | Blocking decision |
|---|---|---|---|
| 0 | Backup preparation | 🟨 AWAITING DECISION | 3 — destination, RPO/RTO |
| 1 | Firewall preparation | ⚪ NOT STARTED | 2, 5 |
| 2 | Docker installation | ⚪ NOT STARTED | 1 |
| 3 | Storage layout | ⚪ NOT STARTED | — (verify OMV exclusion) |
| 4 | Caddy deployment | ⚪ NOT STARTED | 4, 7, 8 |
| 5 | Self-hosted Convex | ⚪ NOT STARTED | 11 |
| 6 | Console deployment | 🔴 BLOCKED | 7, 8 + F-1/F-2 closure |
| 7 | SERVER-02 agent | ⚪ NOT STARTED | 9, 10 |
| 8 | SERVER-01 enrollment | ⚪ NOT STARTED | Owner authorization for SERVER-01 |

**Nothing in this runbook has been executed.** SERVER-02 remains unmodified:
Docker not installed, nftables not installed, no services altered.

---

# Standing Risks

| ID | Risk | Mitigation phase |
|---|---|---|
| R-1 | LAN-exposed services with no firewall | Phase 1 |
| R-2 | Docker chains becoming the de facto firewall | Phases 1 → 2 (ordering matters) |
| R-3 | No backups; single disk, no RAID | Phase 0 |
| R-4 | Control plane shares a failure domain with its host | Accepted; audit export mitigates |
| R-5 | SaltStack + agent = two unaccountable control paths | Phase 7, decision 9 |
| R-6 | 2 physical cores shared with OMV | Resource caps in all compose files |
| R-7 | `unattended-upgrades` may disrupt a phase | Pause during phases 2 and 5 |
| R-10 | Anonymous provider grants full control (F-2) | Phase 6 gate |
| R-11 | OTP key rotation outstanding (F-1) | Phase 6 gate |
| R-12 | No audit-chain verification path (F-5) | Post-deployment hardening |
| R-13 | Uncommitted workspace code | Resolve before Phase 6 |

---

*Runbook only. No software installed, no service modified, no configuration
changed on SERVER-02 or SERVER-01. Baseline measured 2026-09-26 22:52 BST via
`ssh gman-remote`.*
