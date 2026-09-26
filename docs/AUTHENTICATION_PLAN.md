# Authentication Plan — Server Management Console

**Status:** design, approved direction — implementation not started · **Last updated:** 2026-09-26

## Current state (prototype)

Convex Auth with two providers:

1. **Email OTP** — 6-digit code, 15-minute validity. Delivery moved off the
   Freebuff endpoint to `OTP_ENDPOINT_URL`/`OTP_API_KEY` env config (still any
   generic HTTP mail provider; self-hosted replacement required at deployment).
2. **Anonymous** — "Continue as guest" button. Full-control demo access.

Neither is production-grade. No MFA, no WebAuthn, no session revocation, no
step-up, no idle timeout. Sessions are Convex-managed JWTs in a cookie.

## Target model (approved direction)

- **Owner-only administration initially.** One administrative identity
  (the Owner) holds full console authority. No other accounts until a
  delegation decision is made.
- **No anonymous privileged access.** The Anonymous provider is removed (or
  hard-restricted to read-only demo mode) before any real data exists.
- **Server-side authorization on every function.** Authentication is not
  authorization; every query and mutation checks role + scope server-side
  (see AUTHORIZATION_MODEL.md).
- **MFA/passkey ready.** The design leaves a clean path to WebAuthn/passkeys
  without rearchitecting (see "WebAuthn path" below). Passkeys are NOT
  implemented now per Owner direction.
- **Audit identity tied to real user.** Every audit event records the
  authenticated user's ID/email, not a hardcoded label. This closes
  SECURITY.md F-6.

## Phased approach

### Phase A — harden what exists (no new auth tech)

1. Remove the guest/anonymous path from `/auth` and from the auth provider
   list, or gate it behind an explicit demo flag with read-only authorization.
2. Derive audit actors from `getAuthUserId` → user record.
3. Add session policy: max lifetime, idle timeout, and revocation on demand
   (a `sessions`-aware sign-out).
4. First-run bootstrap: the first account to sign in becomes Owner (or Owner is
   provisioned by env-configured email allowlist — decide at implementation).

### Phase B — transport and delivery

5. Self-hosted OTP delivery: point `OTP_ENDPOINT_URL` at an Owner-controlled
   mail provider; enforce code entropy, attempt limits, and single-use
   semantics. (OPEN QUESTION: which mail provider runs on Owner infra?)
6. Optional second factor at this stage: TOTP, if passkeys are deferred.

### Phase C — WebAuthn/passkeys (NOT implemented now)

7. Add passkey registration/authentication as the primary factor for the
   Owner; keep email OTP as recovery only.
8. Step-up authentication for R3 (security-sensitive) actions: require a
   fresh WebAuthn assertion immediately before approving communication
   rules, enrollment, or quarantine decisions.

The Convex Auth provider architecture allows adding a WebAuthn provider
alongside OTP without changing the session model or the UI shell — this is the
reason the passkey path stays open.

## Explicitly out of scope (this phase)

- Implementing WebAuthn/passkeys (Owner direction: design only).
- Multi-user delegation, RBAC rollout (see AUTHORIZATION_MODEL.md for the
  model that will govern it).
- External OIDC/IdP integration.
