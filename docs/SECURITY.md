# Security — Server Management Console

**Status:** prototype · **Last updated:** 2026-09-26

## Security posture summary

The prototype demonstrates the security *concepts* of the target architecture in
its data model and server-side checks, but it is a demo: telemetry is seeded,
agents do not exist, and authentication/authorization are not production-grade.
Do not connect real servers or real credentials to this system until the gaps
below close.

## 1. Known findings

### F-1 · Committed OTP API key — ROTATION REQUIRED (open)

`src/convex/auth/emailOtp.ts` historically contained a hard-coded API key for
the Freebuff OTP endpoint (`fb_email_…`). The key has been removed from source
and replaced with `OTP_ENDPOINT_URL`/`OTP_API_KEY` environment reads, **but the
old key remains valid in git history and on the provider side.**

- Owner action: rotate/revoke the key with the provider.
- Do not rely on source removal as remediation.

### F-2 · Anonymous provider grants full control (open, demo-only)

"Continue as guest" signs in via the Anonymous provider and receives full
console control. Acceptable for the demo estate; must be removed or reduced to
read-only before production. Tracked in AUTHENTICATION_PLAN.md.

### F-3 · Authorization is binary (open)

Every mutation authenticates; nothing authorizes by role or resource. The
`role` field on users is unread. Tracked in AUTHORIZATION_MODEL.md.

### F-4 · Replay/expiry protection is decorative (open)

Task envelopes carry `nonce`, `expiresAt`, `controlEpoch`, and `envelopeHash`,
but no enforcement path exists: expiry is never checked, nonce uniqueness is
unenforced, and there is no executed-task ledger. These become real when the
agent/gateway layer exists.

### F-5 · Audit chain is built but unverified (open)

Each event commits to its predecessor's hash; nothing ever recomputes or
verifies the chain, nothing signs finalized records, and copies B (server-local)
and C (off-host) do not exist. Export is absent.

### F-6 · Audit actor is hardcoded (open)

Mutations record `"Owner"` as the actor instead of deriving identity from the
session. Breaks attribution the moment a second user exists.

### F-7 · Input validation gaps (open)

Mutation args are typed primitives but unbounded; cross-references (server IDs
in rules) are not validated against existing records; no rate limiting; no CSP
is configured by this repo (reverse proxy must supply headers when self-hosted).

## 2. Strengths to preserve

- Capability ceiling enforced **server-side** (`restartContainer` refuses
  disabled/unsupported capabilities) — the core anti-"compromised console"
  idea, already real.
- Append-only, hash-chained audit design with correlation IDs and no secret
  values in events.
- Task envelope field set matches the target architecture (taskRef, nonce,
  expiry, epoch, signer, hash).
- `returnTo` redirect validation on `/auth` rejects non-relative and
  protocol-relative targets (open-redirect resistant).
- Logs render as plain text in a bounded window; React default encoding covers
  container names.
- No secrets in the client bundle; browser only ever sees `VITE_CONVEX_URL`.

## 3. Secrets handling policy

- No secret belongs in source. Current secret-bearing file:
  `src/convex/auth/emailOtp.ts` reads `OTP_ENDPOINT_URL` + `OTP_API_KEY` from
  the Convex backend environment.
- Frontend env (`VITE_*`) is public by definition — only ever contain
  non-secret configuration.
- Convex secrets: set via deployment environment (dashboard/CLI), never in
  code or `.env` files committed to the repo.
- `.gitignore` blocks `.env`, `.env.local`, `.env.*.local`.

## 4. Before real server connection (ordered gates)

1. Rotate the OTP key (F-1) and confirm the mail transport is self-hosted.
2. Remove or restrict anonymous access (F-2).
3. Implement role checks with deny-by-default (F-3) and session-derived audit
   actors (F-6).
4. Add argument validation/limits and rate limiting (F-7); add CSP headers at
   the reverse proxy.
5. Only after the above: agent/gateway work may begin, which makes F-4/F-5
   enforceable rather than decorative.
