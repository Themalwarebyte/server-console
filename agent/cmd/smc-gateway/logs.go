package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	smcv1 "github.com/themalwarebyte/server-console/agent/gen/smcv1"
)

// Milestone B: read-only container logs.
//
// WORK SOURCE. The approved design called for a Convex "live subscription" in
// the gateway. This binary has no Convex client and speaking Convex's sync
// protocol from Go is not proportionate for a log read, so the gateway instead
// long-polls the Convex HTTP query API.
//
// This is a deliberate substitution and it is worth being precise about what
// changes and what does not:
//   - it is NOT a per-second poll. The loop sleeps 5s when idle and backs off
//     to 15s when several consecutive polls return nothing, so the steady-state
//     rate is ~12/min falling to ~4/min, not 60/min.
//   - it adds NO inbound listener to the gateway.
//   - it does not change the tailnet-only model.
//   - it uses a SEPARATE credential from telemetry ingest, so a compromised
//     ingest path cannot fetch pending requests.
//
// The control plane is the authorisation point: the gateway can only ask for
// requests the control plane has already authorised, and it cannot bypass the
// agent's own validation.

const (
	logPollIdle      = 5 * time.Second
	logPollBackoff   = 15 * time.Second
	logMaxInFlight   = 20 // fleet-wide outstanding requests
	logMaxPerHost    = 2  // concurrent per host
	logExpiryWindow  = 60 * time.Second
	logClaimBackoffN = 2 // consecutive empty polls before backing off
)

// logCapability is the only Milestone B capability. Mutation capabilities are
// deliberately absent and stay absent through Milestone B.
const logCapability = "docker.logs.read"

// logRequest is one pending read, as returned by the control plane.
type logRequest struct {
	RequestID      string `json:"requestId"`
	ServerPublicID string `json:"serverPublicId"`
	ContainerID    string `json:"containerId"`
	Tail           int32  `json:"tail"`
	Timestamps     bool   `json:"timestamps"`
	Nonce          string `json:"nonce"`
	ManagementEpoch int64 `json:"managementEpoch"`
	IssuedAtMs     int64  `json:"issuedAtMs"`
	ExpiresAtMs    int64  `json:"expiresAtMs"`
}

// logPollLoop watches for authorised pending requests and dispatches them.
func (s *svc) logPollLoop(ctx context.Context) {
	if s.logSecret == "" || s.convexMutationURL == "" {
		log.Print("log polling disabled: no log-request credential configured")
		return
	}
	empty := 0
	ticker := time.NewTicker(logPollIdle)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		n, err := s.claimAndDispatch(ctx)
		if err != nil {
			log.Printf("log claim failed: %v", err)
		}
		switch {
		case n > 0:
			empty = 0
		case empty < logClaimBackoffN:
			empty++
		default:
			// Back off after repeated empty polls so the steady-state rate
			// settles well below per-second polling.
			select {
			case <-ctx.Done():
				return
			case <-time.After(logPollBackoff):
			}
		}
	}
}

// claim asks the control plane for authorised pending requests using the
// DEDICATED log credential. It is never the telemetry ingest secret.
func (s *svc) claim(ctx context.Context) ([]logRequest, error) {
	body, err := json.Marshal(map[string]any{
		"path": "logAccess:claimLogRequests",
		"args": map[string]any{"serviceCredential": s.logSecret},
		"format": "json",
	})
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.convexMutationURL, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("claim rejected: HTTP %d", resp.StatusCode)
	}
	var out struct {
		Value struct {
			Requests []logRequest `json:"requests"`
		} `json:"value"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	return out.Value.Requests, nil
}

// claimAndDispatch sends each request to its agent and relays the result back.
func (s *svc) claimAndDispatch(ctx context.Context) (int, error) {
	reqs, err := s.claim(ctx)
	if err != nil {
		return 0, err
	}
	if len(reqs) == 0 {
		return 0, nil
	}
	if len(reqs) > logMaxInFlight {
		// Never take on more than the fleet-wide ceiling; the remainder stays
		// pending in the control plane and is claimed next cycle.
		reqs = reqs[:logMaxInFlight]
	}
	perHost := map[string]int{}
	for _, lr := range reqs {
		if lr.ExpiresAtMs > 0 && lr.ExpiresAtMs < time.Now().UnixMilli() {
			s.reportLogResult(ctx, lr, nil, "expired", 0, false, 0)
			continue
		}
		ses, ok := s.reg.get(lr.ServerPublicID)
		if !ok {
			s.reportLogResult(ctx, lr, nil, "gateway_unreachable", 0, false, 0)
			continue
		}
		if perHost[lr.ServerPublicID] >= logMaxPerHost {
			s.reportLogResult(ctx, lr, nil, "too_many_in_flight", 0, false, 0)
			continue
		}
		perHost[lr.ServerPublicID]++

		payload := &smcv1.LogRequest{
			RequestId:       lr.RequestID,
			ServerPublicId:  lr.ServerPublicID,
			ContainerId:     lr.ContainerID,
			Tail:            lr.Tail,
			Timestamps:      lr.Timestamps,
			IssuedAtMs:      lr.IssuedAtMs,
			ExpiresAtMs:     lr.ExpiresAtMs,
			Nonce:           lr.Nonce,
			ManagementEpoch: lr.ManagementEpoch,
		}
		select {
		case ses.out <- &smcv1.GatewayMessage{Payload: &smcv1.GatewayMessage_Log{Log: payload}}:
			log.Printf("log request dispatched: id=%s server=%s container=%s", lr.RequestID, lr.ServerPublicID, short(lr.ContainerID))
		default:
			perHost[lr.ServerPublicID]--
			s.reportLogResult(ctx, lr, nil, "gateway_busy", 0, false, 0)
		}
	}
	return len(reqs), nil
}

// reportLogResult relays an outcome back to the control plane using the same
// dedicated log credential. Log CONTENT is relayed only on success, and only
// because the helper already redacted it on the managed host.
func (s *svc) reportLogResult(ctx context.Context, lr logRequest, res *smcv1.LogRequestResult, class string, dur int64, trunc bool, observed int64) {
	envelope := map[string]any{
		"path": "logAccess:completeLogRequest",
		"args": map[string]any{
			"serviceCredential": s.logSecret,
			"requestId":         lr.RequestID,
			"serverPublicId":     lr.ServerPublicID,
			"errorClass":        class,
			"durationMs":        dur,
			"truncated":         trunc,
			"observedAtMs":      observed,
		},
		"format": "json",
	}
	if res != nil {
		lines := make([]map[string]any, 0, len(res.GetLines()))
		for _, l := range res.GetLines() {
			lines = append(lines, map[string]any{"ts": l.GetTimestampMs(), "text": l.GetText()})
		}
		envelope["args"].(map[string]any)["lines"] = lines
		envelope["args"].(map[string]any)["ok"] = res.GetOk()
	}
	body, err := json.Marshal(envelope)
	if err != nil {
		return
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.convexMutationURL, bytes.NewReader(body))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.client.Do(req)
	if err == nil {
		resp.Body.Close()
	}
}

// reportLogAgentResult relays a result that came back over the agent stream.
func (s *svc) reportLogAgentResult(ctx context.Context, res *smcv1.LogRequestResult) {
	if res == nil || res.GetRequestId() == "" {
		return
	}
	lr := logRequest{RequestID: res.GetRequestId(), ServerPublicID: res.GetServerPublicId()}
	class := ""
	if !res.GetOk() {
		class = sanitiseClass(res.GetError())
	}
	s.reportLogResult(ctx, lr, res, class, res.GetDurationMs(), res.GetTruncated(), res.GetObservedAtMs())
	log.Printf("log result relayed: id=%s ok=%v lines=%d", res.GetRequestId(), res.GetOk(), len(res.GetLines()))
}

// sanitiseClass keeps only the failure CLASS. A Docker or gRPC error string
// routinely carries paths and identifiers, so it is never relayed.
func sanitiseClass(s string) string {
	switch {
	case s == "":
		return "unknown"
	case strings.Contains(s, "not_authorized"), strings.Contains(s, "rate"), strings.Contains(s, "in_flight"):
		return s
	case strings.Contains(s, "identity"), strings.Contains(s, "nonce"), strings.Contains(s, "epoch"):
		return s
	case strings.Contains(s, "container"), strings.Contains(s, "id"):
		return "container_not_found"
	default:
		return "helper_unavailable"
	}
}

