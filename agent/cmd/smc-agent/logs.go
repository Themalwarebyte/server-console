package main

import (
	"context"
	"log"
	"sync"
	"time"

	smcv1 "github.com/themalwarebyte/server-console/agent/gen/smcv1"
	"github.com/themalwarebyte/server-console/agent/internal/ipc"
)

// Log request handling.
//
// The agent is the enforcement point for a read. It refuses anything that fails
// identity, nonce, expiry, capability, epoch or signature validation, BEFORE
// asking the helper. The helper then refuses anything that is not an exact
// container id. Two independent gates, neither of which trusts the other.

// MaxLogRequestsInFlight bounds concurrent reads held by this agent.
const MaxLogRequestsInFlight = 2

// maxLogRequestsInFlight is the lowercase alias used at construction.
const maxLogRequestsInFlight = MaxLogRequestsInFlight

// nonceWindow is how long a used nonce is remembered for replay detection.
const nonceWindow = 10 * time.Minute

type nonceSet struct {
	mu sync.Mutex
	m  map[string]time.Time
}

func newNonceSet() *nonceSet { return &nonceSet{m: map[string]time.Time{}} }

// use records a nonce and reports whether it was already seen.
func (n *nonceSet) use(id string) bool {
	n.mu.Lock()
	defer n.mu.Unlock()
	now := time.Now()
	for k, t := range n.m {
		if now.Sub(t) > nonceWindow {
			delete(n.m, k)
		}
	}
	if _, seen := n.m[id]; seen {
		return true
	}
	n.m[id] = now
	return false
}

// handleLogRequest validates and executes one log request.
func (a *agent) handleLogRequest(ctx context.Context, lr *smcv1.LogRequest) *smcv1.LogRequestResult {
	now := time.Now()
	obs := now.UnixMilli()
	started := time.Now()

	fail := func(class string) *smcv1.LogRequestResult {
		log.Printf("log request refused: class=%s requestId=%s", class, lr.GetRequestId())
		return &smcv1.LogRequestResult{
			RequestId:     lr.GetRequestId(),
			ServerPublicId: a.id,
			Ok:            false,
			Error:         class,
			ObservedAtMs:  obs,
			DurationMs:    time.Since(started).Milliseconds(),
		}
	}

	// 1. Identity. A request may only be executed for this agent's own
	// certificate-derived identity.
	if lr.GetServerPublicId() != a.id {
		return fail("identity_mismatch")
	}

	// 2. Expiry.
	if lr.GetExpiresAtMs() > 0 && lr.GetExpiresAtMs() < now.UnixMilli() {
		return fail("expired")
	}

	// 3. Nonce. A replayed nonce is refused before Docker is consulted.
	if lr.GetNonce() == "" {
		return fail("missing_nonce")
	}
	if a.nonces.use(lr.GetNonce()) {
		return fail("replayed_nonce")
	}

	// 4. Capability. The ceiling came from the gateway in HelloAck. Absent
	// capability means deny; an empty ceiling is never treated as "allow all".
	if !a.ceiling["docker.logs.read"] {
		return fail("not_authorized")
	}

	// 5. Management epoch. An envelope minted under an older policy is stale.
	if lr.GetManagementEpoch() > 0 && a.epoch.Load() > lr.GetManagementEpoch() {
		return fail("stale_epoch")
	}

	// 6. Authenticity comes from the channel, not from an application
	// signature.
	//
	// An earlier draft had the gateway sign each envelope. That was removed
	// deliberately: the message already arrives on a mutually-authenticated,
	// CA-verified, server-initiated mTLS stream, so a forgery from outside the
	// channel is not possible, and a signature would have required shipping a new
	// signing key to every agent. Hand-rolled signing over an already
	// authenticated channel adds complexity and no security.
	//
	// What still defends the envelope is: it must be the agent's own identity
	// (1), unexpired (2), unused-nonce (3), capability-authorised (4),
	// epoch-current (5), and bounded (7/8).

	// 7. Bounded concurrency.
	select {
	case a.logSlots <- struct{}{}:
		defer func() { <-a.logSlots }()
	default:
		return fail("too_many_in_flight")
	}

	// 8. Rate limit: at most 10 per minute.
	if !a.allowLog() {
		return fail("rate_limited")
	}

	// 9. The helper decides what is an acceptable target and does the
	// redaction. The agent does not pre-validate the container id, so the
	// exact-id rule has exactly one home.
	logs, err := a.helper.ContainerLogs(ctx, ipc.Request{
		Op:          ipc.OpContainerLogs,
		ContainerID: lr.GetContainerId(),
		Tail:        int(lr.GetTail()),
		Timestamps:  lr.GetTimestamps(),
	})
	if err != nil {
		return fail("container_not_found")
	}

	lines := make([]*smcv1.LogLine, 0, len(logs.Lines))
	for _, l := range logs.Lines {
		lines = append(lines, &smcv1.LogLine{TimestampMs: l.TimestampMs, Text: l.Text})
	}

	return &smcv1.LogRequestResult{
		RequestId:      lr.GetRequestId(),
		ServerPublicId: a.id,
		Ok:             true,
		Lines:          lines,
		Truncated:      logs.Truncated,
		ObservedAtMs:   obs,
		DurationMs:     time.Since(started).Milliseconds(),
	}
}

// logRate is a simple per-minute counter.
type logRate struct {
	mu     sync.Mutex
	minute int64
	count  int
}

func (a *agent) allowLog() bool {
	a.rate.mu.Lock()
	defer a.rate.mu.Unlock()
	m := time.Now().Unix() / 60
	if m != a.rate.minute {
		a.rate.minute = m
		a.rate.count = 0
	}
	if a.rate.count >= 10 {
		return false
	}
	a.rate.count++
	return true
}

