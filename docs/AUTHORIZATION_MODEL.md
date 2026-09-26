# Authorization Model — Server Management Console

**Status:** approved model, not yet implemented · **Last updated:** 2026-09-26

## Current state

Authorization is binary: authenticated = full control. Queries are open to any
signed-in user (including anonymous), mutations check only authentication, and
the `role` field on the user record is unread. This is documented as finding
F-3 in SECURITY.md and is the primary gap before production.

## Approved model

Four roles, aligned with the architecture plan's Owner/Admin/Operator/Auditor/
Viewer, collapsed for a two-server estate with one principal user:

| Role | Inventory & health | Container logs | Container restart | Communication rules | Enrollment | User/role admin |
|---|---|---|---|---|---|---|
| **Owner** | ✅ | ✅ | ✅ | ✅ draft/approve/revoke | ✅ approve/reject | ✅ |
| **Operator** | ✅ | ✅ | ✅ | draft only (Owner approves) | ❌ view only | ❌ |
| **Auditor** | ✅ | ✅ (bounded) | ❌ | ❌ view only | ❌ view only | ❌ |
| **Viewer** | ✅ | ❌ | ❌ | ❌ view only | ❌ view only | ❌ |

Rule: **anything not granted is denied.** There is no wildcard and no
"admin" override role beyond Owner.

## Resource scopes (future, only when >1 delegated user exists)

Permissions attach to resources, not just roles:

```
subject (user) × action (capability) × resource scope
```

Scope targets, in increasing granularity: `server` → `project` → `container` →
`communication rule` → `task`. The MVP scope for Owner-only operation is
"all resources" and needs no scope rows. Introduce scope records only when a
second real user exists (Owner decision, per the plan's OD-10).

## Deny-by-default function policy

Every Convex function declares its requirement and the default is deny:

- Public: landing page assets only. No data function is public.
- Authenticated + role check: everything under `console.*`.
- Queries that expose inventory enforce the Viewer floor; mutations enforce
  the action's role row above.
- The audit chain write path is never directly callable — it happens only
  inside domain mutations.

## Implementation plan (when triggered)

1. Resolve the acting user's role in a shared `requireRole(ctx, minimum)`
   helper; reject with a typed error on failure.
2. Thread the real user identity into every audit event (closes F-6).
3. Gate each mutation against the matrix; add a regression test per row.
4. Defer resource-scope tables until a delegation decision exists.

Explicitly out of scope now: implementing any of the above. This document is
the contract the implementation must satisfy.
