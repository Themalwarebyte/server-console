# Recovery — Server Management Console

**Status:** design, partially applicable · **Last updated:** 2026-09-26

## Principle

The console is never required for workload operation. Recovery here concerns
the management plane itself; SERVER-01/SERVER-02 workloads keep their own
independent recovery paths (unchanged by this project).

## Scenario: console offline (pre-deployment: Convex cloud unreachable)

- UI becomes read-only-inoperative; no data flows.
- Workloads unaffected (nothing couples them to the console).
- Agent heartbeats: N/A until agents exist.

## Scenario: self-hosted Convex backend down (post-deployment)

- Restart via compose; data persists in the configured volume/database.
- If the backend is unrecoverable, restore per below.
- Mutations fail closed while the backend is down — the UI cannot queue
  privileged actions that bypass durable state.

## Scenario: database restored from backup

Current prototype: safe by construction (no real tasks execute; nothing to
replay).

Post-agent-era requirement (design, enforce then): a restored database must
not resurface previously executed tasks. Controls to implement with the agent
layer:

- globally unique task IDs + nonce;
- short execution expiry, checked at dispatch AND at the helper;
- agent-side persistent executed-task ledger;
- control-plane recovery epoch (`controlEpoch` field already exists in the
  task schema — increment on any restore and have agents reject tasks from
  older epochs);
- on restore: cancel all non-terminal tasks from before the restore point.

## Scenario: secrets compromised

- Rotate `OTP_API_KEY`, JWT keys, and Convex admin keys.
- Convex auth secrets live in deployment environment config; re-provision and
  redeploy. Git history never contains them (the historical OTP key in git
  history is the known exception — rotation closes it).

## Scenario: SERVER-02 itself lost

- Rebuild console from: this repo + DEPLOYMENT.md + latest database backup +
  audit export + secret material.
- SERVER-01 workloads and SERVER-02 workloads are NOT restored from the
  console; their recovery is independent by design.

## Backup testing

A backup is not real until a restore has been rehearsed. Required drill before
accepting the deployment as production: snapshot → mutate → restore → verify
integrity → verify expected state. Record results in STATUS.md.

## Break-glass

The Owner retains direct SSH/local access to both servers independent of this
console. No console capability may ever become a prerequisite for that path.
