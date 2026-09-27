# Local Self-Hosting Validation Guide

**Purpose:** verify that the Server Management Console runs against a
**self-hosted Convex instance on your local machine** before any SERVER-02
deployment. Nothing in this guide touches SERVER-01, SERVER-02, or the
application's architecture.

**Mode:** documentation only. No code changes are required or included.

**Repo:** `https://github.com/Themalwarebyte/server-console.git`

---

# 1. Prerequisites

| Requirement | Version / assumption | Notes |
|---|---|---|
| Operating system | Linux (Debian/Ubuntu recommended) or macOS; Windows via WSL2 | The Convex self-hosted images are Linux containers; WSL2 works fine |
| Bun | ≥ 1.1 (repo pins nothing older) | `bun --version` to check; install via `curl -fsSL https://bun.sh/install \| bash` |
| Node.js | ≥ 20.19 or ≥ 22.12 | Required by Vite 7 and the Convex CLI (`npx convex …`) even though the app uses Bun |
| Docker | Engine + Compose v2 | `docker compose version` should succeed |
| Disk | ≥ 5 GiB free | Docker images (~2 GiB) + build artifacts + DB volume |
| RAM | ≥ 4 GiB free | Convex backend container is comfortable in ~1 GiB; browser + Vite need headroom |
| Ports free | 5173, 3210, 3211, 6791 | The Convex compose file binds 3210/3211/6791; Vite uses 5173 |
| Git | any recent | For cloning |
| Convex account | **Not required** | Self-hosted validation deliberately avoids Convex cloud entirely |

Tools you'll actually type: `bun`, `npx convex`, `docker compose`, `openssl`
(for the auth key material), a browser.

---

# 2. Repository setup

## 2.1 Clone

```bash
git clone https://github.com/Themalwarebyte/server-console.git
cd server-console
```

## 2.2 Install dependencies

```bash
bun install
```

Expect ~390 packages, no postinstall drama. If `bun` is unavailable, `npm
install` works too but delete the stray `package-lock.json` ambiguity first
(the repo is bun-lockfile-first).

## 2.3 Environment variables

Create `.env.local` in the repo root (this file is gitignored — verify with
`git check-ignore .env.local`):

```bash
# Frontend: URL of the self-hosted Convex backend, reachable from the BROWSER.
# For local validation, that's the backend's sync port:
VITE_CONVEX_URL=http://127.0.0.1:3210
```

That single variable is all the frontend needs. Everything else below belongs
to the backend container or the Convex deployment environment — **not** to
`.env.local`.

Where configuration belongs (summary):

| Variable | Where it lives | Who reads it |
|---|---|---|
| `VITE_CONVEX_URL` | `.env.local` (repo root) | Browser bundle at build/dev time |
| `CONVEX_SELF_HOSTED_URL` | `.env.local` (repo root) | `npx convex dev` CLI pushes |
| `CONVEX_SELF_HOSTED_ADMIN_KEY` | `.env.local` (repo root) | `npx convex dev` CLI pushes + dashboard login |
| `CONVEX_CLOUD_ORIGIN` | docker-compose env for backend container | Backend (its public URL) |
| `CONVEX_SITE_ORIGIN` | docker-compose env for backend container | Backend (its HTTP-actions URL, 3211) |
| `SITE_URL` | Convex deployment env (dashboard or `convex env set`) | Convex Auth redirects |
| `JWT_PRIVATE_KEY`, `JWKS` | Convex deployment env | Convex Auth token signing/verification |
| `OTP_ENDPOINT_URL`, `OTP_API_KEY` | Convex deployment env | Sign-in code delivery (email) |

## 2.4 Avoiding secret commits

- `.gitignore` already blocks `.env`, `.env.local`, `.env.*.local`. Verify with
  `git status` after creating `.env.local` — it must not appear.
- Never paste the admin key or JWT private key into any file that isn't
  gitignored.
- Precedent: an API key was previously committed to this repo and had to be
  rotated (see `docs/SECURITY.md` F-1). Treat that as the cautionary tale.

---

# 3. Self-hosted Convex setup

## 3.1 Run Convex locally (Docker Compose)

```bash
mkdir -p ~/convex-selfhosted && cd ~/convex-selfhosted
npx degit get-convex/convex-backend/self-hosted/docker/docker-compose.yml docker-compose.yml
docker compose pull
docker compose up -d
```

This starts two containers:

| Container | Port | Purpose |
|---|---|---|
| `backend` | 3210 (sync/API), 3211 (HTTP actions) | The Convex backend itself |
| `dashboard` | 6791 | Data browser / function runner UI |

Storage: by default the compose file uses a **named Docker volume** for the
SQLite database. That volume is your data — deleting it deletes everything
(see §7 rollback). Mount it somewhere deliberate if you want the data to
survive `docker compose down -v` mistakes. Postgres is optional later
(`DATABASE_URL` on the backend container) and NOT needed for validation.

Expected startup order: `backend` becomes ready first; `dashboard` can start
any time after. Check with `docker compose ps` until both show running/healthy.

## 3.2 Backend container environment

If you run everything on `127.0.0.1` the compose defaults already work. The
variables that matter (edit `docker-compose.yml` only if you change hosts):

- `CONVEX_CLOUD_ORIGIN` — the backend's own URL as clients reach it
  (default: `http://127.0.0.1:3210`).
- `CONVEX_SITE_ORIGIN` — the HTTP-actions URL (default:
  `http://127.0.0.1:3211`). Convex Auth's sign-in routes are HTTP actions, so
  this must be correct.

## 3.3 Generate the admin key

```bash
cd ~/convex-selfhosted
docker compose exec backend ./generate_admin_key.sh
```

Copy the key (long, starts with a recognizable prefix). It authorizes both
`npx convex` pushes and dashboard logins.

## 3.4 Authentication configuration

Convex Auth (already wired in this repo) needs three deployment env vars.
**Because `npx convex` supports self-hosted deployments, set them via CLI:**

```bash
cd /path/to/server-console
# after step 4.1's .env.local is in place and functions are pushed once:
npx convex env set SITE_URL http://localhost:5173
```

`JWT_PRIVATE_KEY` and `JWKS` must be generated (they're not random-by-default).
Create `generateKeys.mjs` anywhere **outside the repo** (e.g. `~/convex-selfhosted/generateKeys.mjs`):

```js
import { exportJWK, exportPKCS8, generateKeyPair } from "jose";
const keys = await generateKeyPair("RS256", { extractable: true });
const privateKey = await exportPKCS8(keys.privateKey);
const publicKey = await exportJWK(keys.publicKey);
const jwks = JSON.stringify({ keys: [{ use: "sig", ...publicKey }] });
process.stdout.write(`JWT_PRIVATE_KEY="${privateKey.trimEnd().replace(/\n/g, " ")}"\n`);
process.stdout.write(`JWKS=${jwks}\n`);
```

Run it with `bun generateKeys.mjs` (or `npm i jose && node generateKeys.mjs`).
Copy the two output lines — this is the exact script from the official
Convex Auth manual-setup page (`labs.convex.dev/auth/setup/manual`), which is
the authority if anything here drifts.

Then set both on the deployment:

```bash
npx convex env set JWT_PRIVATE_KEY "<paste the JWT_PRIVATE_KEY line>"
npx convex env set JWKS "<paste the JWKS line>"
```

And the OTP delivery variables (this repo reads them in
`src/convex/auth/emailOtp.ts`; sign-in codes cannot be delivered without them):

```bash
# Point this at any mail endpoint you control that accepts
# POST {to, otp, appName} with an x-api-key header.
# For pure local validation you may run a tiny receiver (see §5 note).
npx convex env set OTP_ENDPOINT_URL https://your-mail-endpoint.example/send
npx convex env set OTP_API_KEY "<your key>"
```

Finally, `auth.config.ts` in this repo reads `CONVEX_SITE_URL` for the
self-issued-token provider — set it to the HTTP-actions origin:

```bash
npx convex env set CONVEX_SITE_URL http://127.0.0.1:3211
```

## 3.5 Freebuff trust anchor — no longer present

The `customJwt` provider that trusted `https://freebuff.com`-issued tokens in
`src/convex/auth.config.ts` was removed as part of the platform decoupling. No
extra local step is needed for a clean validation run.

---

# 4. Application connection

## 4.1 How `VITE_CONVEX_URL` is configured

- Read once at dev-server/build time by Vite from `.env.local`.
- Consumed in `src/main.tsx`: `new ConvexReactClient(convexUrl)`, which throws
  a clear boot error if missing.
- **It must be the sync/API origin (3210 default), not the HTTP-actions origin
  (3211).** The Convex client derives HTTP-action URLs from the sync URL
  itself.

## 4.2 How the frontend connects

`ConvexAuthProvider` wraps the client; all queries/mutations/auth calls flow
over a WebSocket + HTTP against `VITE_CONVEX_URL`. No other URL exists in the
client — there is no API base URL to configure anywhere else.

## 4.3 Push functions first

```bash
# in the repo root, with CONVEX_SELF_HOSTED_URL/ADMIN_KEY in .env.local:
bun run convex:push     # runs: convex dev --once
```

Expected output ends with `Convex functions ready!`.

## 4.4 Start the app

```bash
bun run dev
```

Open `http://localhost:5173`.

## 4.5 Verify the connection

1. **No boot error** — if `VITE_CONVEX_URL` were missing/unset you'd get a
   thrown error instead of the app.
2. **DevTools → Network → WS:** an open WebSocket to `ws://127.0.0.1:3210`.
3. **Dashboard check:** open `http://localhost:6791`, paste the admin key,
   open the `servers` table — empty is fine, the table existing proves the
   schema pushed.

---

# 5. Validation checklist

Run through in order; each step depends on the previous.

| # | Check | How | Pass criteria |
|---|---|---|---|
| 1 | App starts | `bun run dev`, open `localhost:5173` | Landing page renders, styled (dark theme) |
| 2 | Auth works | Click "Enter the console" → sign-in; enter an email; request code | Code-delivery fires (check your mail endpoint's logs); OTP entry appears |
| 3 | Dashboard loads | Complete OTP sign-in | Redirect to `/console` with no blank page |
| 4 | Seed | On the empty console, click **Provision demo estate** | Fleet stats populate; two server cards appear |
| 5 | Data queries | Visit Servers, open a server detail | Capability table + container table render from Convex |
| 6 | Mutations | Restart a container from server detail | Toast success; container restart count bumps; task appears in ledger |
| 7 | Audit records | Tasks & audit page | New `COMPLETION` event with a `#seq`, chained hash visible |
| 8 | Replay demo | "Simulate replay attempt" button | New REJECTION audit event; task flagged |
| 9 | Communication workflow | Draft a rule → approve → revoke | Status transitions visible; audit events for each |
| 10 | Enrollment workflow | Create invitation → approve | Status transitions; audit event created |
| 11 | Dashboard cross-check | `localhost:6791` → `auditEvents` table | Documents exist with increasing `seq` values |

Sign-in delivery note: the OTP endpoint just needs to accept a `POST` with
`{to, otp, appName}` and an `x-api-key` header. If you don't have a mail
endpoint handy, the fastest validation path is a hosted request inspector —
create a bin at `webhook.site`, copy its URL into `OTP_ENDPOINT_URL`, set any
value as `OTP_API_KEY`, and read the 6-digit code from the inspector's page.
A 10-line local Bun server that logs the code works equally well. Test-only.

```bash
npx convex env set OTP_ENDPOINT_URL "https://webhook.site/your-uuid"
npx convex env set OTP_API_KEY "local-test"
```

---

# 6. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Boot error: "VITE_CONVEX_URL is not configured" | `.env.local` missing/empty | Create it per §2.3; restart `bun run dev` (Vite env is read at startup) |
| `convex dev --once` says "mix of cloud and self-hosted" | Stale `CONVEX_DEPLOYMENT` env or `.convex` dir from the managed-cloud era | Delete `.env.local` lines mentioning `CONVEX_DEPLOYMENT`; `rm -rf .convex`; retry |
| Push auth failure (401/403) | Wrong/missing `CONVEX_SELF_HOSTED_ADMIN_KEY` | Regenerate via `docker compose exec backend ./generate_admin_key.sh`; re-paste |
| Browser WS fails / queries hang | Wrong port in `VITE_CONVEX_URL` (3211 instead of 3210) | Use the sync origin `http://127.0.0.1:3210` |
| Sign-in code never arrives | OTP env vars unset on the deployment, or endpoint rejects | `npx convex env list` to confirm; check receiver logs |
| Sign-in loops back to /auth forever | `JWT_PRIVATE_KEY`/`JWKS`/`CONVEX_SITE_URL` unset or mismatched | Re-set all three; tokens can't be verified without them |
| `function pointers` / schema push errors | Stale generated code | `rm -rf src/convex/_generated && bun run convex:push` |
| Dashboard 6791 asks for key repeatedly | Admin key not accepted | Re-paste; confirm same key as CLI's |
| `docker compose up` port conflict | 3210/3211/6791 already bound | Stop the conflicting service or edit the compose ports |
| Build fails on `tsc` | Node version below Vite 7's floor | Use Node ≥ 20.19 / 22.12 |
| Everything looks unstyled | Tailwind not loading | Confirm `src/index.css` import still present in `src/main.tsx` (it is, by default) |

---

# 7. Rollback plan

## Return to the current working state

The application code is untouched by local validation — there's nothing in the
repo to revert. To restore the *previous working configuration* (managed Convex
cloud):

1. Edit `.env.local`: set `VITE_CONVEX_URL=https://<deployment>.convex.cloud`,
   remove `CONVEX_SELF_HOSTED_URL`/`CONVEX_SELF_HOSTED_ADMIN_KEY`.
2. Remove the `.convex/` directory if the self-hosted run created one.
3. `bun run dev` — the app now talks to the managed deployment again.
4. Data parity: the managed deployment still holds its own seeded data; the
   self-hosted instance holds whatever you created locally. They never mix.

## Remove local test data

```bash
cd ~/convex-selfhosted
docker compose down        # stops containers, KEEPS the data volume
docker compose down -v     # stops AND deletes the data volume — full reset
```

Full cleanup: `docker compose down -v && docker rmi $(docker images "ghcr.io/get-convex/*" -q)`.

## Avoiding production impact

- This validation runs entirely on `127.0.0.1`; nothing listens on a public
  interface, nothing egresses to your servers.
- The self-hosted instance and the managed deployment are **separate data
  stores** — pushes with `CONVEX_SELF_HOSTED_URL` set can never reach the
  cloud deployment, and vice versa (Convex enforces not mixing the two).
- No SSH, no agents, no changes to SERVER-01/SERVER-02 are part of this
  guide. Your two real servers are untouched throughout.

---

# 8. Prepare for SERVER-02 migration

Before SERVER-02 deployment work can begin, collect and record the following
from the actual host (none of it can be assumed). Suggested format: add
answers to `docs/STATUS.md` or a new `docs/BASELINE_INVENTORY.md`.

| Information needed | Why it matters | How to collect |
|---|---|---|
| **OS + version** | Container compatibility, package names | `cat /etc/os-release` |
| **Kernel** | Docker feature support | `uname -r` |
| **Docker version** | Compose v2 features | `docker --version && docker compose version` |
| **CPU / RAM / disk** | Capacity planning (§1 estimates) | `nproc`, `free -h`, `df -h` |
| **Ports in use** | Conflicts with 443/3210/3211/6791 | `ss -tulpn` |
| **Firewall backend** | nftables vs iptables; where allow rules go | `sudo nft list ruleset \| head`, `sudo iptables -L -n` |
| **Existing firewall rules** | Don't collide with running services | As above, plus `ufw status` if present |
| **Tailscale present?** | Private-access path (OD-03) | `tailscale status` |
| **Current Tailscale policy** | Whether management traffic would be allowed | Admin console / `tailscale status --json` |
| **PostgreSQL present?** | Backend DB choice | `psql --version`, `systemctl list-units \| grep -i postgres` |
| **Backup destination** | OD-07 independent audit/DB copies | Owner's answer — NAS, second server, object storage? |
| **RPO/RTO expectation** | Backup frequency design | Owner's answer (OD-08) |
| **Mail/OTP provider** | Sign-in delivery on self-hosted | Owner's answer |
| **Reverse proxy preference** | Caddy vs nginx | Owner's answer |
| **PKI status** | TLS for the console (OD-04) | Existing private CA? Hardware tokens? |

Items marked "Owner's answer" are decisions, not discoveries — record them in
`docs/STATUS.md` under NEEDS DECISION when answered.

---

*End of guide. No code was modified to produce this document; every command
here runs on your local machine only.*
