# Deployment — Server Management Console on SERVER-02

**Status:** prepared, NOT deployed · **Last updated:** 2026-09-26
**Rule:** do not assume SERVER-02 specifications. Unknowns are marked
**OPEN QUESTION** and must be answered from the actual host before deployment.

## Target architecture (Owner decision)

```
SERVER-02
├─ reverse proxy
│    TLS termination · private-network ingress only
│    ├─ /            → static React build (frontend)
│    └─ /convex/*    → self-hosted Convex backend (loopback)
├─ self-hosted Convex
│    ├─ backend container      (HTTP 3210, HTTP actions 3211)
│    ├─ dashboard container    (6791, loopback only)
│    └─ database storage       (SQLite volume or external PostgreSQL)
├─ backups                     (database dumps + audit export, off-host copy)
└─ future agent gateway        (Go, gRPC/mTLS — reserved, not built)
```

The console is one application on the private application platform SERVER-02
hosts; the platform may carry other apps later under the same proxy pattern.

## Required services

1. **Reverse proxy** (Caddy or nginx — **OPEN QUESTION** which the Owner
   prefers; Caddy simplifies internal-CA TLS).
2. **Self-hosted Convex backend + dashboard** via the official
   `docker-compose.yml` (backend, dashboard; optionally PostgreSQL).
3. **Static file serving** for the Vite build (`bun run build` → `dist/`).
4. **Docker Engine + Compose v2** on the host.

## Ports

| Port | Service | Binding |
|---|---|---|
| 443 | Reverse proxy (UI + Convex via path routing) | Private network / tailnet only |
| 80 | Redirect to 443 | same |
| 3210 | Convex backend API | 127.0.0.1 only |
| 3211 | Convex backend HTTP actions | 127.0.0.1 only |
| 6791 | Convex dashboard | 127.0.0.1 only (or proxy-guarded) |

No inbound port is ever opened for agents; future agents dial out.

## Networking requirements

- Owner browser reaches SERVER-02 over a private path (Tailscale or equivalent
  per plan OD-03 — **OPEN QUESTION** final choice).
- Management ports are not reachable from LAN or public interfaces.
- SERVER-02 firewall denies by default; only 443 (private) allowed inbound.
- **OPEN QUESTION:** existing firewall backend on SERVER-02 (nftables/iptables),
  current rules, and whether Tailscale is already installed.

## TLS requirements

- Certificate for the console hostname. Recommended: private CA (offline root,
  online intermediate) per plan OD-04, or internal-CA certificate via Caddy.
- **OPEN QUESTION:** PKI custody decision (OD-04) and whether a private CA
  already exists.
- Browser trust: the Owner's devices must trust the issuing CA.

## Environment variables & secrets

Frontend (public by definition):
- `VITE_CONVEX_URL` — URL of the self-hosted Convex backend as reachable from
  the browser (e.g. `https://convex.<internal-domain>`).

Convex backend environment (secrets, never in repo):
- `OTP_ENDPOINT_URL` — self-hosted/Owner-controlled OTP mail endpoint.
- `OTP_API_KEY` — key for that endpoint. **Rotation of the previously
  committed key is still required** (SECURITY.md F-1).
- `SITE_URL`, `JWKS`, `JWT_PRIVATE_KEY` — Convex Auth material per the
  self-hosted setup guide (CLI does not support self-hosted deployments; auth
  setup is manual — follow Convex's manual Convex Auth instructions).

`.env.local` (gitignored) template is documented in the repo README because
`.env.example` cannot be created through the authoring environment's
sensitive-file policy.

## Database & storage

- Start: Convex backend with a persistent Docker volume (SQLite).
- Production target: point the backend at PostgreSQL per Convex self-hosted
  docs — **OPEN QUESTION** whether PostgreSQL runs on SERVER-02 or is
  provisioned (and RPO/RTO per plan OD-08).
- Audit export storage: an independent, write-restricted destination per
  plan OD-07 — **OPEN QUESTION**.

## Backup requirements

- Database: scheduled dumps (daily minimum) + WAL/PITR if RPO demands it.
- Audit copy C: periodic append-only export to independent storage.
- Convex auth secrets + admin keys: backed up with the secret store, never in
  Git.
- Restore procedure: see RECOVERY.md (restores must not replay executed tasks
  once the agent layer exists).

## Update process

1. `git pull` on a maintenance checkout (or deploy from a tagged release).
2. `bun install && bun run check` (typecheck + convex push).
3. `bun run build` → deploy `dist/` behind the proxy.
4. Update Convex containers per upstream release notes; snapshot the database
   volume before upgrading the backend.
5. Rollback: keep the previous `dist/` and the pre-upgrade volume snapshot;
   redeploy previous tag.

## Known prerequisites before first deployment

- Remove or restrict anonymous access (SECURITY.md F-2) — required, not
  optional, because the deployment will hold real (if modest) audit data.
- Rotate OTP key (F-1).
- Answer OPEN QUESTIONS above; record answers in docs/STATUS.md.
