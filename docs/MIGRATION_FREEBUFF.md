# Platform Migration Report — Freebuff/Vly → Self-Hosted

**Date:** 2026-09-26
**Scope:** removal of platform dependency from the Server Management Console prototype.
**Rule observed:** no functionality was removed without documentation.

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
| `@vly-ai/integrations` import + package | Removed. No replacement needed — no feature used it. | 🟩 done |
| `VlyToolbar` + toolbar file | Removed; file deleted. No replacement (dev-only tool). | 🟩 done |
| `vlyPlugin()` | Removed from `vite.config.ts`; plugin list is now `react()` + `tailwindcss()`. | 🟩 done |
| `RouteSyncer` | Removed. Browser routing is self-contained. | 🟩 done |
| `ToolbarErrorBoundary` | Removed with the toolbar. `RootErrorBoundary` retained for observable error rendering. | 🟩 done |
| `src/instrumentation.tsx` | Deleted. Errors now surface via the console and `RootErrorBoundary`. A future self-hosted telemetry hook can be added deliberately. | 🟩 done |
| `src/lib/vly-integrations.ts` | Deleted (dead code). | 🟩 done |
| Freebuff OTP endpoint + committed key | `OTP_ENDPOINT_URL` + `OTP_API_KEY` read from the Convex backend environment; startup fails with a clear message if unset. **The old key must still be rotated — removal from source does not revoke it.** | 🟩 code done · 🔵 key rotation pending (Owner) |
| Manifest | Rebranded to "Server Management Console" with dark theme colors. | 🟩 done |
| Platform env vars | No longer referenced anywhere in source. | 🟩 done |
| Root residue files | Deleted: `main.ts`, `sst-env.d.ts`, `package-lock.json`, `integrations.md`. | 🟩 done |
| Build/dev ownership | `vite.config.ts` is standard Vite; README rewritten for this project; `convex.json` pins the functions dir. | 🟩 done |

## Convex URL as the single backend integration point

`src/main.tsx` now requires exactly one environment variable, `VITE_CONVEX_URL`, and throws a clear error at boot if it is missing. Pointing it at the managed deployment or a self-hosted Convex instance is a configuration change, not a code change.

## Functionality intentionally NOT preserved

- The VlyToolbar element-inspection/publish workflow (platform authoring tool; not product functionality).
- Remote error reporting to platform monitoring (replace later with a self-hosted choice — open decision).
- The "Continue as guest" **anonymous provider remains in code** for demo parity but is flagged in `AUTHENTICATION_PLAN.md` for removal before production. No privileged behavior was added or removed in this migration.

## Residual platform touchpoints (out of scope for this repo)

- The Freebuff preview/build pipeline still runs this project in the authoring environment; it is unaffected by these changes.
- The rotated-key requirement is an Owner action on the provider side.
