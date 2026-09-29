/**
 * Log policy — shared constants, credential separation, and the error-class
 * allowlist.
 *
 * CREDENTIAL SEPARATION
 *   SMC_GATEWAY_SECRET  telemetry INGEST only. It cannot claim log work.
 *   SMC_LOG_WORK_SECRET log WORK only. It cannot ingest arbitrary telemetry.
 *
 * They are independent, so compromising one path does not yield the other.
 */

/** Milestone B limits. Re-enforced in the helper AND in the control plane. */
export const LOG_LIMITS = {
  /** Maximum lines in one response. */
  maxLines: 500,
  /** Maximum total payload, in bytes. */
  maxBytes: 256 * 1024,
  /** Maximum length of a single line, in bytes. */
  maxLineBytes: 4 * 1024,
  /** Request lifetime before it is abandoned. */
  requestTtlMs: 60_000,
  /** Hard retention for a delivered result before automatic deletion. */
  resultTtlMs: 120_000,
  /** Concurrent reads per host, enforced at gateway and agent. */
  maxConcurrentPerHost: 2,
  /** Outstanding reads fleet-wide. */
  maxOutstanding: 20,
} as const;

/**
 * The only failure classes the platform will store or display.
 *
 * Anything unrecognised collapses to "unknown", so an upstream message, path or
 * stack trace can never reach the database, the audit chain, or the UI.
 */
const ERROR_CLASSES = new Set([
  "unknown",
  "identity_mismatch",
  "expired",
  "missing_nonce",
  "replayed_nonce",
  "not_authorized",
  "stale_epoch",
  "too_many_in_flight",
  "rate_limited",
  "container_not_found",
  "helper_unavailable",
  "gateway_unreachable",
  "gateway_busy",
  "bad_claim_lease",
]);

export function sanitiseErrorClass(v: unknown): string {
  const s = typeof v === "string" ? v : "";
  return ERROR_CLASSES.has(s) ? s : "unknown";
}

/**
 * Verifies the DEDICATED log-work credential in constant time.
 *
 * This is deliberately NOT the ingest secret. The two grants are independent.
 */
export function requireLogWorkCredential(presented: string): void {
  const expected = process.env.SMC_LOG_WORK_SECRET;
  if (!expected || expected.length < 32) {
    throw new Error("log-work credential is not configured");
  }
  if (!constantTimeEqual(presented, expected)) {
    throw new Error("unauthorized");
  }
}

/**
 * constantTimeEqual compares without leaking content through timing.
 *
 * Implemented over UTF-8 bytes rather than Buffer so behaviour does not depend
 * on which Buffer type the Convex runtime exposes.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  const n = Math.max(x.byteLength, y.byteLength);
  let diff = x.byteLength ^ y.byteLength;
  for (let i = 0; i < n; i++) {
    const xi = i < x.byteLength ? x[i] : 0;
    const yi = i < y.byteLength ? y[i] : 0;
    diff |= xi ^ yi;
  }
  return diff === 0;
}
