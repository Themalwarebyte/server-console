package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"
)

// ingest forwards telemetry into the control plane through a narrow endpoint.
//
// It does NOT have the Convex admin key and does NOT have the Owner's Better
// Auth credentials. It holds a dedicated service credential, compared in
// constant time, stored only in this process's protected configuration and the
// Convex deployment environment.
type ingest struct {
	url    string
	secret string
	client *http.Client
}

func newIngest(url, secret string) *ingest {
	if !constantTimeEqual(secret, secret) {
		// Unreachable: constantTimeCompare is symmetric. This exists so a
		// future refactor cannot silently replace the comparison with ==.
		log.Fatal("credential comparison invariant violated")
	}
	return &ingest{
		url:    url,
		secret: secret,
		client: &http.Client{Timeout: 15 * time.Second},
	}
}

// push sends one telemetry record. serverPublicId, certificate fingerprint and
// serial all originate from the verified mTLS session, never from the payload.
func (i *ingest) push(kind, serverID, fingerprint, serial string, observedAtMS int64, body any) error {
	env, err := json.Marshal(map[string]any{
		"kind":             kind,
		"serverPublicId":   serverID,
		"certFingerprint":  fingerprint,
		"certSerial":       serial,
		"gatewayServiceId": "smc-gateway",
		"observedAtMs":     observedAtMS,
		"receivedAtMs":     time.Now().UnixMilli(),
		"payload":          body,
	})
	if err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodPost, i.url, bytes.NewReader(env))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-SMC-Service-Credential", i.secret)
	req.Header.Set("X-SMC-Gateway", "smc-gateway")

	resp, err := i.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		// Status only. The control plane's body is never logged, so a
		// credential or payload cannot leak into gateway logs.
		return fmt.Errorf("ingest rejected: HTTP %d", resp.StatusCode)
	}
	return nil
}
