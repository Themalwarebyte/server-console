# Architecture — Server Management Console

**Status:** prototype, self-hosting-ready codebase · **Last updated:** 2026-09-26

## Current architecture (as built)

```
Owner browser ──HTTPS──► React SPA (Vite static build)
                             │ WebSocket/HTTP sync (VITE_CONVEX_URL)
                             ▼
                   Convex backend  ← target: self-hosted on SERVER-02
                    ├─ Convex Auth (email OTP + anonymous*)
                    ├─ queries/mutations (src/convex/console.ts)
                    └─ document store (src/convex/schema.ts)

* anonymous provider is demo-only; see AUTHENTICATION_PLAN.md
```

The application is a single-page React client subscribed reactively to a Convex
backend. There is no other server component. Everything "privileged" in the UI
is a database write on the Convex deployment — nothing touches real hosts.

## Target architecture (Owner decision: self-hosted Convex on SERVER-02)

```
SERVER-02
├─ reverse proxy (TLS termination, private-network ingress)
│   ├─ /            → static React build
│   └─ /convex/*    → self-hosted Convex backend (3210/3211, loopback only)
├─ self-hosted Convex (backend + dashboard containers)
│   └─ database storage (SQLite volume or PostgreSQL — decision pending)
└─ future agent gateway (Go, gRPC/mTLS — not started)
```

Design principles carried from the architecture plan: unique per-server
identity, outbound agent connections, split privilege behind a local helper,
capability ceilings, deny-by-default communication, durable audit, and console
independence from workloads. None of the agent-side components exist yet.

## Component map

| Component | Location | Notes |
|---|---|---|
| Entry point | `src/main.tsx` | Providers, routes, error boundary. Requires `VITE_CONVEX_URL`. |
| Console shell | `src/components/console/ConsoleLayout.tsx` | Authenticated nav shell |
| Shared UI | `src/components/console/ui.tsx` | Badges, dots, meters, log viewer |
| Pages | `src/pages/` | Landing, Auth, Console (fleet), Servers, ServerDetail, Communication, Tasks, Enrollment |
| Domain logic | `src/convex/console.ts` | Seed, queries, mutations, audit chain, capability gate |
| Data model | `src/convex/schema.ts` | servers, containers, tasks, auditEvents, commRules, enrollments, meta |
| Auth | `src/convex/auth*.ts` | Convex Auth: email OTP (+ anonymous, demo-only) |
| Theme | `src/index.css` | Dark "Modern" theme, oklch tokens |

## Simulation boundary

All server telemetry, agent activity, certificates, and task "executions" are
seeded demo data (`seed` mutation). UI copy labels servers SERVER-01/02, but no
real host is involved. The capability ceiling check in `restartContainer` is
real server-side logic against demo data.
