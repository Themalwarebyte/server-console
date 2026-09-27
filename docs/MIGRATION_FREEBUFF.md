# Platform Migration Report — Freebuff/Vly → Self-Hosted

**Date:** 2026-09-26
**Scope:** removal of platform dependency from the Server Management Console prototype.
**Rule observed:** no functionality was removed without documentation.
**Status (verified 2026-09-26, working tree after `95c7361`): COMPLETE.** Five rows
previously reported as done were found still present and have now actually been
removed (see the 🔴 → 🟩 rows below). The last residual coupling — the Freebuff
`customJwt` auth provider in `src/convex/auth.config.ts` — has also been removed
as an approved cleanup; see "Freebuff `customJwt` auth provider — REMOVED" below.

## BEFORE — what depended on Freebuff/Vly

| # | Dependency | Where | What it did |
|---|---|---|---|
| 1 | `@vly-ai/integrations` package | `package.json`, `bun.lock`, `src/main.tsx` (side-effect import) | Platform integration client (AI/email/payments) injected into every page load |
| 2 | `VlyToolbar` / `vly-toolbar-readonly.tsx` | root of repo, imported by `src/main.tsx` | Platform dev toolbar for element selection/publishing; file was injected by the platform runtime, not authored |
| 3 | `vlyPlugin()` | `vite.config.ts` | Vite plugin for platform preview integration |
| 4 | `RouteSyncer` | `src/main.tsx` | `window.parent.postMessage` iframe navigation sync for the platform preview shell |
| 5 | `ToolbarErrorBoundary` | `src/main.tsx` | Error boundary that existed only to isolate toolbar crashes |
| 6 | `src/instrumentation.tsx` | `src/main.tsx` import | Global error dialog + `reportErrorToVly()` posting stack traces to `VITE_VLY_MONITORING_URL` with `VITE_VLY_APP_ID`; linked errors to the Freebuff editor |
| 7 | `src/lib/vly-integrations.ts` | nothing imported it | Dead module instantiating the Vly integration client with `VLY_INTEGRATION_KEY` |
| 8 | OTP delivery endpoint | `src/convex/auth/emailOtp.ts` | Sign-in codes sent through `https://auth.freebuff.app/send_otp` with a **hard-coded API key committed to source** |
| 9 | Manifest identity | `public/manifest.webmanifest` | App named "freebuff.com application", white theme colors |
| 10 | Platform env vars | runtime | `VITE_VLY_APP_ID`, `VITE_VLY_MONITORING_URL`, `VLY_INTEGRATION_KEY`, `VLY_APP_NAME` |
| 11 | Platform residue | root | `main.ts` (Deno static server used by platform), `sst-env.d.ts`, `package-lock.json` (repo uses bun), `integrations.md` |
| 12 | Build/dev assumptions | `vite.config.ts`, README | HMR/dev-server config owned by platform; README described the template, not this project |

## AFTER — what replaces each item

| Before item | Replacement | Status |
|---|---|---|
| `@vly-ai/integrations` import + package | Removed. Dropped from `package.json` and `bun.lock`; `node_modules/@vly-ai` pruned. No source imports remain. | 🟩 done |
| `VlyToolbar` + toolbar file | Removed; file deleted. No replacement (dev-only tool). | 🟩 done |
| `vlyPlugin()` | Removed. `vite.config.ts` is now `plugins: [react(), tailwindcss()]`; the Vite build no longer depends on `@vly-ai/integrations`. | 🟩 done |
| `RouteSyncer` | Removed. Browser routing is self-contained. | 🟩 done |
| `ToolbarErrorBoundary` | Removed with the toolbar. `RootErrorBoundary` retained for observable error rendering. | 🟩 done |
| `src/instrumentation.tsx` | Deleted. Errors now surface via the console and `RootErrorBoundary`. A future self-hosted telemetry hook can be added deliberately. | 🟩 done |
| `src/lib/vly-integrations.ts` | Deleted. Nothing imported it; verified before removal. | 🟩 done |
| Freebuff OTP endpoint + committed key | `OTP_ENDPOINT_URL` + `OTP_API_KEY` read from the Convex backend environment; startup fails with a clear message if unset. **The old key must still be rotated — removal from source does not revoke it.** | 🟩 code done · 🔵 key rotation pending (Owner) |
| Manifest | Rebranded to "Server Management Console" with dark theme colors. | 🟩 done |
| Platform env vars | `VLY_INTEGRATION_KEY` removed with its module; `VLY_APP_NAME` removed from `auth/emailOtp.ts` (literal `"Server Management Console"` used instead); `VLY_CONVEX_AUTH_ISSUER` removed with the `customJwt` provider; `VITE_VLY_APP_ID` / `VITE_VLY_MONITORING_URL` already gone. **No `VLY_*` variable is read anywhere in source.** | 🟩 done |
| Root residue files | Deleted: `main.ts`, `sst-env.d.ts`, `package-lock.json`, `integrations.md`. Also removed the stale `vly-toolbar-readonly.tsx` entry from `tsconfig.app.json` `include`. | 🟩 done |
| Build/dev ownership | `vite.config.ts` is standard Vite; README rewritten for this project; `convex.json` pins the functions dir. | 🟩 done |

## Convex URL as the single backend integration point

`src/main.tsx` now requires exactly one environment variable, `VITE_CONVEX_URL`, and throws a clear error at boot if it is missing. Pointing it at the managed deployment or a self-hosted Convex instance is a configuration change, not a code change.

## Functionality intentionally NOT preserved

- The VlyToolbar element-inspection/publish workflow (platform authoring tool; not product functionality).
- Remote error reporting to platform monitoring (replace later with a self-hosted choice — open decision).
- The "Continue as guest" **anonymous provider remains in code** for demo parity but is flagged in `AUTHENTICATION_PLAN.md` for removal before production. No privileged behavior was added or removed in this migration.

## Freebuff `customJwt` auth provider — REMOVED

`src/convex/auth.config.ts` previously registered a second provider trusting
Freebuff-issued RS256 tokens from `${issuer}/api/web/.well-known/jwks.json`,
configured by `VLY_CONVEX_AUTH_ISSUER` (default `https://freebuff.com`).

**Removed 2026-09-26 (approved cleanup).** Deleted the `customJwt` provider
entry and the `freebuffIssuer` constant. `providers` now contains only the
self-issued `CONVEX_SITE_URL` entry, which is unchanged.

| Fact | Detail |
|---|---|
| Sign-in impact | **None.** The UI only ever called `signIn("email-otp", …)`; the `vly-convex` provider had no sign-in entry point. It was an inbound federated-token trust anchor only. |
| Preserved | The self-issued provider and its warning against converting it to `customJwt` (that path rejects tokens without a `kid` header and would loop `/auth` forever). |
| `VLY_CONVEX_AUTH_ISSUER` | No longer read anywhere. |
| Not changed | `Anonymous` provider still present (SECURITY.md F-2, tracked in `AUTHENTICATION_PLAN.md`). No new auth system introduced. |

`LOCAL_VALIDATION_GUIDE.md` §3.5 described commenting this provider out as an
optional local test step. That step is **no longer needed** — the trust anchor
no longer exists.

## Residual platform touchpoints (out of scope for this repo)

- The Freebuff preview/build pipeline still runs this project in the authoring environment; it is unaffected by these changes.
- The rotated-key requirement is an Owner action on the provider side.
