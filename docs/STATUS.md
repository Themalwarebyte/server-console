# STATUS — Server Management Console

**Last updated:** 2026-09-26 · **Phase:** platform decoupling complete, self-hosting prepared

## DONE 🟩

- Prototype UI: landing, auth, fleet overview, servers, server detail, communication, tasks & audit, enrollment (dark Modern theme).
- Prototype workflows: task ledger with replay-attempt demo, communication rule draft→approve→revoke, enrollment invitation ceremony, bounded log viewing, recovery-drill record.
- Data model: servers, containers, tasks, auditEvents (hash-chained), commRules, enrollments, meta.
- Security concepts: capability ceiling enforced server-side, task envelope fields (nonce/expiry/epoch/hash), audit hash chain, deny-by-default communication semantics.
- Platform decoupling: **COMPLETE** — `@vly-ai/integrations`, `vlyPlugin()`, `src/lib/vly-integrations.ts`, `integrations.md` removed; all `VLY_*` env references gone; Freebuff `customJwt` auth provider removed from `auth.config.ts`. No `VLY_*` or `freebuff` reference remains in source.
- Convex self-hosting preparation: convex.json, env contract, docs. **Typecheck is NOT green on a fresh clone** — see Verification state.

## NOT DONE ⚪

- Self-hosted deployment to SERVER-02 (blocked pending Owner authorization + OPEN QUESTION answers in DEPLOYMENT.md).
- Real agents (mgmt-agent / privileged helper) — design only.
- Server connection (SERVER-01 / SERVER-02) — not authorized.
- Docker control — not implemented by design.
- Firewall control — not implemented by design.
- WebAuthn/passkeys, RBAC enforcement, audit verification/export, real task execution path.

## NEEDS DECISION 🟨

- Reverse proxy choice (Caddy vs nginx) and PostgreSQL placement on SERVER-02.
- PKI custody (plan OD-04), audit destination (OD-07), RPO/RTO (OD-08).
- When to remove the anonymous login path (recommended: before first self-hosted deploy).

## BLOCKED 🔴

- Real server access, production deployment, privileged operations: Owner approval not granted.

## OPEN QUESTIONS

See DEPLOYMENT.md (marked inline). Top blockers: SERVER-02 OS/firewall/Tailscale state; mail provider for OTP; backup destination.

## Verification state

- `bun tsc -b --noEmit` **fails on a fresh clone**: 74 errors, all rooted in the
  missing gitignored `src/convex/_generated/` (11 × TS2307 → 63 cascading
  implicit-`any`). Generating it requires a Convex deployment —
  `convex codegen` refuses without `CONVEX_DEPLOYMENT`.
- `bun run build` fails at the same `tsc -b` gate.
- `bun run lint` fails: 26 errors, 16 warnings (pre-existing; unused
  `ShieldAlert`/`Skeleton`, `Date.now()` in render at `ServerDetail.tsx:111`).
- Convex functions push was validated against the managed cloud deployment; that
  state is not reproducible from a clean checkout.

## Phase 3 — local self-hosting validation (2026-09-26)

Repository: `https://github.com/Themalwarebyte/server-console.git` @ `95c7361`.
Local machine: Windows, Bun 1.4.2, Node 24.18.0, Docker 29.8.0 + Compose 5.5.1.

### DONE 🟩

- Repository cloned and verified; `bun install` → 390 packages, `bun.lock` unchanged.
- Repository hygiene: `.env.keys` and `isolate/` removed from Git tracking
  (local copies retained) and added to `.gitignore`.
- Documentation reconciled against the code — MIGRATION_FREEBUFF.md (5 rows were
  inaccurate), DEPLOYMENT.md (Convex CLI self-hosted support is real, verified in
  `convex@1.46.0`), LOCAL_VALIDATION_GUIDE.md (package count).
- Convex default ports 3210/3211/3217 confirmed free.

### IN PROGRESS 🔵

- Typecheck/build gate — blocked pending a Convex deployment for codegen.

### BLOCKED 🔴

- Typecheck/build cannot be validated offline: codegen needs a deployment, and
  the only non-self-hosted option is Convex **cloud** provisioning (not authorized).
- `bun run check` = `typecheck && convex dev --once`; not run, because with no
  `CONVEX_DEPLOYMENT` the CLI would provision a cloud project.
- Local Convex stack not started: host has 15.7 GB RAM with only 0.6 GB free
  across 9 running Docker containers. Stopping other projects' containers is an
  Owner decision.

### NEEDS DECISION 🟨

- `.env.keys` was tracked from the initial commit. Removal from tracking does not
  purge history; regenerate the key if the repo is ever made public.
- `isolate/` contained a prebuilt bundle with baked-in Convex **cloud** URLs
  (`aromatic-ladybug-960`, `happy-otter-123`). Confirm that is acceptable history.
- Finish or formally accept the platform decoupling — **done**, no open items.
- Pre-existing lint errors: fix now or defer?
