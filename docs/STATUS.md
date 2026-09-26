# STATUS — Server Management Console

**Last updated:** 2026-09-26 · **Phase:** platform decoupling complete, self-hosting prepared

## DONE 🟩

- Prototype UI: landing, auth, fleet overview, servers, server detail, communication, tasks & audit, enrollment (dark Modern theme).
- Prototype workflows: task ledger with replay-attempt demo, communication rule draft→approve→revoke, enrollment invitation ceremony, bounded log viewing, recovery-drill record.
- Data model: servers, containers, tasks, auditEvents (hash-chained), commRules, enrollments, meta.
- Security concepts: capability ceiling enforced server-side, task envelope fields (nonce/expiry/epoch/hash), audit hash chain, deny-by-default communication semantics.
- Platform decoupling: all Freebuff/Vly coupling removed (see MIGRATION_FREEBUFF.md).
- Convex self-hosting preparation: convex.json, env contract, docs, typecheck green.

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

- `bun tsc -b --noEmit` passes after decoupling.
- Convex functions push validated with `bun convex dev --once` against the current deployment.
