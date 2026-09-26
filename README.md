# Server Management Console

A private, self-hosted management console for a small estate of independent
servers. Prototype stage: full UI and workflows over a Convex backend, with all
server telemetry simulated. Connected does not mean coupled — the console is
never required for workload operation.

## Stack

- **Frontend:** React 19 · TypeScript · Vite · Tailwind v4 · shadcn/ui · Framer Motion
- **Backend:** Convex (target: self-hosted on SERVER-02) with Convex Auth
- **Package manager:** Bun

## Getting started

```bash
bun install
cp .env.example .env.local   # if absent, create .env.local manually:
                             #   VITE_CONVEX_URL=https://<your-convex>.convex.cloud
bun run dev
```

Push backend functions (requires an authorized Convex deployment):

```bash
bun run convex:push
```

## Scripts

| Script | Purpose |
|---|---|
| `bun run dev` | Vite dev server |
| `bun run build` | Typecheck + production build to `dist/` |
| `bun run typecheck` | `tsc -b --noEmit` |
| `bun run convex:push` | Push Convex functions (`convex dev --once`) |
| `bun run check` | typecheck + function push |
| `bun run lint` / `format` | ESLint / Prettier |

## Environment

Only one variable is required by the browser app:

- `VITE_CONVEX_URL` — Convex backend URL (managed cloud or self-hosted).

Backend-only secrets (never committed): `OTP_ENDPOINT_URL`, `OTP_API_KEY`
(sign-in code delivery), plus Convex Auth material per its manual setup guide.
See `docs/DEPLOYMENT.md`.

## Documentation

| Doc | Contents |
|---|---|
| `docs/ARCHITECTURE.md` | Current + target architecture, component map |
| `docs/SECURITY.md` | Findings, strengths, secrets policy, pre-production gates |
| `docs/AUTHENTICATION_PLAN.md` | Approved future auth model (owner-only, MFA-ready) |
| `docs/AUTHORIZATION_MODEL.md` | Role matrix and deny-by-default function policy |
| `docs/DEPLOYMENT.md` | SERVER-02 deployment requirements and open questions |
| `docs/LOCAL_VALIDATION_GUIDE.md` | Run the console against self-hosted Convex locally, step by step |
| `docs/RECOVERY.md` | Backup/restore and replay-protection design |
| `docs/MIGRATION_FREEBUFF.md` | Platform decoupling report (before/after) |
| `docs/STATUS.md` | Current phase ledger |

## Security note

This is a prototype. Do not connect real servers or production credentials.
The demo "Continue as guest" path grants full console access by design and must
be removed before any real deployment. See `docs/SECURITY.md`.
