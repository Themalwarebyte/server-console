// Command smc-gateway is the agent control plane on SERVER-02.
//
// It terminates mTLS, derives each agent's identity from its verified client
// certificate, and forwards telemetry into the control plane through a narrow
// authenticated ingest endpoint.
//
// It has NO Docker socket, is not privileged, and executes no host command. It
// never dials an agent: agents initiate the stream.
package main

import (
	"context"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/peer"
	"google.golang.org/grpc/status"

	smcv1 "github.com/themalwarebyte/server-console/agent/gen/smcv1"
	"github.com/themalwarebyte/server-console/agent/internal/agentid"
)

var (
	protoVersion = "smc-agent/1"
	listenAddr   = flag.String("listen", "100.80.65.109:8446", "listen address (Tailscale only)")
	serverCert   = flag.String("cert", "/etc/smc-gateway/tls/gateway.crt", "gateway server certificate")
	serverKey    = flag.String("key", "/etc/smc-gateway/tls/gateway.key", "gateway server private key")
	caFile       = flag.String("ca", "/etc/smc-gateway/tls/agents-ca.crt", "CA bundle for verifying agents")
	ingestURL    = flag.String("ingest-url", "https://gman-02.tail0ab69b.ts.net:8443/api/smc/ingest", "narrow Convex ingest endpoint")
	logSecret    = flag.String("log-secret-file", "/etc/smc-gateway/log.secret", "DEDICATED log-request credential")
	ingestSecret = flag.String("ingest-secret-file", "/etc/smc-gateway/ingest.secret", "gateway service credential")

	// Milestone A ceiling. Only these two are granted, and the local ceiling is
	// applied here in addition to the central policy.
	ceiling = map[string]bool{
		"host.telemetry.read":   true,
		"docker.telemetry.read": true,
	// Milestone B: read-only logs. Mutation capabilities are absent and stay
	// absent; nothing here can authorise a start, stop, restart, reboot or
	// shutdown.
	"docker.logs.read": true,
	}
)

type agentSession struct {
	ServerID     string
	Fingerprint  string
	CertSerial   string
	AgentVersion string
	ConnectedAt  time.Time
	// out carries dispatch messages to the connected agent.
	out          chan *smcv1.GatewayMessage
	LastSeen     atomic.Int64
	Active       atomic.Bool
}

type registry struct {
	mu       sync.RWMutex
	byServer map[string]*agentSession
}

func newRegistry() *registry { return &registry{byServer: map[string]*agentSession{}} }

func (r *registry) bind(s *agentSession) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.byServer[s.ServerID] = s
}

func (r *registry) get(id string) (*agentSession, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	s, ok := r.byServer[id]
	return s, ok
}

func (r *registry) snapshot() []*agentSession {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]*agentSession, 0, len(r.byServer))
	for _, s := range r.byServer {
		out = append(out, s)
	}
	return out
}

func main() {
	flag.Parse()
	log.SetFlags(log.LstdFlags | log.LUTC)
	log.SetPrefix("smc-gateway ")

	cert, err := tls.LoadX509KeyPair(*serverCert, *serverKey)
	if err != nil {
		log.Fatalf("load gateway keypair: %v", err)
	}
	caPEM, err := os.ReadFile(*caFile)
	if err != nil {
		log.Fatalf("read agent CA: %v", err)
	}
	pool := x509Pool(caPEM)

	// Milestone A binds the Tailscale address only. Refusing any other bind is
	// a hard startup failure rather than a warning.
	if err := assertTailnetOnly(*listenAddr); err != nil {
		log.Fatalf("refusing to start: %v", err)
	}

	logSec, err := os.ReadFile(*logSecret)
	if err != nil {
		log.Printf("log-request credential unavailable: %v", err)
	}
	secret, err := os.ReadFile(*ingestSecret)
	if err != nil {
		log.Fatalf("read ingest credential: %v", err)
	}

	creds := credentials.NewTLS(serverTLS(cert, pool))
	ln, err := net.Listen("tcp", *listenAddr)
	if err != nil {
		log.Fatalf("listen %s: %v", *listenAddr, err)
	}

	// The admin/debug surface is deliberately absent: no reflection, no health
	// endpoint, no pprof.
	srv := grpc.NewServer(
		grpc.Creds(creds),
		grpc.MaxRecvMsgSize(8<<20),
		grpc.MaxSendMsgSize(8<<20),
	)
	reg := newRegistry()
	svc := &svc{
		reg:            reg,
		ingest:          newIngest(*ingestURL, trimSpace(secret)),
		convexMutationURL: strings.TrimSuffix(*ingestURL, "/api/smc/ingest") + "/api/mutation",
		logSecret:       trimSpace(logSec),
		client:          &http.Client{Timeout: 20 * time.Second},
	}
	smcv1.RegisterAgentChannelServer(srv, svc)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		srv.GracefulStop()
	}()

	go svc.logPollLoop(ctx)

	go func() {
		pctx, pcancel := context.WithCancel(context.Background())
		defer pcancel()
		svc.logPollLoop(pctx)
	}()

	log.Printf("listening on %s (mTLS, agent CA trust, no Docker socket, no host execution)", *listenAddr)
	if err := srv.Serve(ln); err != nil && !errors.Is(err, grpc.ErrServerStopped) {
		log.Fatalf("serve: %v", err)
	}
}

// assertTailnetOnly refuses a bind that is not a Tailscale CGNAT address.
func assertTailnetOnly(addr string) error {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("listen address must be host:port: %w", err)
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return errors.New("listen host must be an IP, not a name")
	}
	v4 := ip.To4()
	if v4 == nil {
		return errors.New("listen host must be an IPv4 Tailscale (100.64.0.0/10) address")
	}
	if v4[0] != 100 || v4[1] < 64 || v4[1] > 127 {
		return fmt.Errorf("listen host %s is not a Tailscale address (100.64.0.0/10)", ip)
	}
	return nil
}

type svc struct {
	smcv1.UnimplementedAgentChannelServer
	reg   *registry
	ingest *ingest

	// ---- Milestone B ----
	// convexMutationURL is the Convex HTTP mutation API root. Claim and
	// complete are MUTATIONS, so they must not be posted to /api/query.
	convexMutationURL string
	// logSecret is the DEDICATED log-request credential. It is never the
	// telemetry ingest secret, so a compromised ingest path cannot fetch
	// pending requests.
	logSecret string
	client     *http.Client
}

// Connect accepts exactly one long-lived, agent-initiated stream.
func (s *svc) Connect(stream smcv1.AgentChannel_ConnectServer) error {
	// Identity comes from the verified client certificate. It is never taken
	// from a payload field.
	id, fp, serial, notAfterMs, err := peerIdentity(stream.Context())
	if err != nil {
		log.Printf("rejecting stream: %v", err)
		return status.Error(codes.Unauthenticated, "client certificate identity could not be established")
	}

	ses := &agentSession{
		ServerID:    id,
		Fingerprint: fp,
		CertSerial:  serial,
		ConnectedAt: time.Now(),
		out:         make(chan *smcv1.GatewayMessage, 8),
	}
	ses.Active.Store(true)
	ses.LastSeen.Store(time.Now().UnixMilli())
	s.reg.bind(ses)
	log.Printf("agent connected: serverPublicId=%s cert=%s serial=%s", id, short(fp), serial)
	// Health signal on the same authenticated channel: a connection is a state
	// change the control plane needs, and it is not telemetry. The agent version
	// is not known until Hello arrives, so it is filled in there.
	go s.reportStatus(id, fp, serial, "connected", "", "", notAfterMs)
	defer func() {
		ses.Active.Store(false)
		log.Printf("agent disconnected: serverPublicId=%s", id)
		go s.reportStatus(id, fp, serial, "disconnected", "", "", notAfterMs)
	}()

	if err := stream.Send(&smcv1.GatewayMessage{Payload: &smcv1.GatewayMessage_HelloAck{
		HelloAck: &smcv1.HelloAck{
			SessionId:                    fmt.Sprintf("sess-%d", time.Now().Unix()),
			ProtocolVersion:              protoVersion,
			ServerTimeMs:                 time.Now().UnixMilli(),
			HeartbeatIntervalMs:          5000,
			HostTelemetryIntervalMs:     5000,
			ContainerTelemetryIntervalMs: 10000,
			Ceiling:                      ceilingList(),
		},
	}}); err != nil {
		return err
	}

	for {
		msg, err := stream.Recv()
		if err != nil {
			return err
		}
		ses.LastSeen.Store(time.Now().UnixMilli())

		switch p := msg.Payload.(type) {
		case *smcv1.AgentMessage_Hello:
			// Cross-check only. The certificate remains authoritative; a
			// mismatch is a hard failure, not a warning.
			if p.Hello.GetServerPublicId() != id {
				log.Printf("rejecting: hello claimed %s but certificate is %s",
					p.Hello.GetServerPublicId(), id)
				return status.Error(codes.PermissionDenied, "server identity mismatch")
			}
			ses.AgentVersion = p.Hello.GetAgentVersion()
			log.Printf("hello ok: agentVersion=%s protocol=%s", ses.AgentVersion, p.Hello.GetProtocolVersion())

		case *smcv1.AgentMessage_Heartbeat:
			// Heartbeats are session state, not telemetry. A missed heartbeat
			// is what makes a host OFFLINE, so nothing is forwarded here.

		case *smcv1.AgentMessage_Host:
			// serverPublicId is overwritten with the certificate-derived value
			// so a payload can never attribute telemetry to another host.
			p.Host.ServerPublicId = id
			if err := s.ingest.push("host", id, fp, serial, p.Host.ObservedAtMs, p.Host); err != nil {
				s.reportIngestError(id, fp, serial, "host", err)
		log.Printf("ingest host: %v", err)
			}

		case *smcv1.AgentMessage_Docker:
			p.Docker.ServerPublicId = id
			if err := s.ingest.push("docker", id, fp, serial, p.Docker.ObservedAtMs, p.Docker); err != nil {
				s.reportIngestError(id, fp, serial, "docker", err)
		log.Printf("ingest docker: %v", err)
			}

		case *smcv1.AgentMessage_Event:
			p.Event.ServerPublicId = id
			if err := s.ingest.push("event", id, fp, serial, p.Event.ObservedAtMs, p.Event); err != nil {
				s.reportIngestError(id, fp, serial, "event", err)
		log.Printf("ingest event: %v", err)
			}

		case *smcv1.AgentMessage_LogResult:
			go s.reportLogAgentResult(stream.Context(), p.LogResult)

		case *smcv1.AgentMessage_Ack, *smcv1.AgentMessage_Result:
			// Milestone A never dispatches actions, so these are unexpected.
			log.Printf("received an action outcome that Milestone A cannot have issued")
		}
	}
}

// reportStatus publishes a connection-state change to the control plane over the
// existing authenticated ingest endpoint. No new channel, credential, or
// listener is involved.
func (s *svc) reportStatus(id, fp, serial, state, agentVersion, protoVersion string, notAfterMs int64) {
	_ = s.ingest.push("status", id, fp, serial, time.Now().UnixMilli(), map[string]any{
		"state":           state,
		"agentVersion":    agentVersion,
		"protocolVersion": protoVersion,
		// Leaf certificate expiry, as a date. The control plane records it so
		// the UI can warn; no certificate material leaves the gateway.
		"certNotAfterMs": notAfterMs,
		// The capability ceiling this gateway granted to the host, echoed back
		// so the control plane knows exactly what each host supports. Support
		// is never inferred from an agent version number.
		"capabilities": ceilingList(),
	})
}

// reportIngestError records a failure as a class, never as a message. The raw
// error text frequently contains URLs, request ids, and identifiers, so it is
// logged for the operator and deliberately not forwarded.
func (s *svc) reportIngestError(id, fp, serial, kind string, err error) {
	class := "ingest_rejected"
	if err != nil {
		msg := err.Error()
		switch {
		case strings.Contains(msg, "401") || strings.Contains(msg, "unauthorized"):
			class = "ingest_rejected"
		case strings.Contains(msg, "x509") || strings.Contains(msg, "certificate"):
			class = "identity_mismatch"
		case strings.Contains(msg, "timeout") || strings.Contains(msg, "deadline"):
			class = "helper_timeout"
		}
	}
	_ = s.ingest.push("error", id, fp, serial, time.Now().UnixMilli(), map[string]any{
		"errorClass": class,
		"kind":       kind,
	})
}
// peerIdentity extracts the agent's immutable identity from the verified
// client certificate, plus the fingerprint and serial for the audit trail.
func peerIdentity(ctx context.Context) (id, fingerprint, serial string, notAfterMs int64, err error) {
	p, ok := peer.FromContext(ctx)
	if !ok {
		return "", "", "", 0, errors.New("no peer information")
	}
	ti, ok := p.AuthInfo.(credentials.TLSInfo)
	if !ok {
		return "", "", "", 0, errors.New("transport is not TLS")
	}
	if len(ti.State.PeerCertificates) == 0 {
		return "", "", "", 0, errors.New("no client certificate presented")
	}
	leaf := ti.State.PeerCertificates[0]

	// The certificate must actually be usable for client authentication.
	if leaf.ExtKeyUsage != nil {
		clientAuth := false
		for _, eku := range leaf.ExtKeyUsage {
			if eku == x509.ExtKeyUsageClientAuth {
				clientAuth = true
			}
		}
		if !clientAuth {
			return "", "", "", 0, errors.New("certificate is not valid for clientAuth")
		}
	}
	id, ok = agentid.ServerIDFromCert(leaf)
	if !ok {
		return "", "", "", 0, errors.New("certificate has no smc URI SAN identity")
	}
	return id, agentid.Fingerprint(leaf.Raw), leaf.SerialNumber.String(), leaf.NotAfter.UnixMilli(), nil
}

func ceilingList() []*smcv1.Capability {
	out := make([]*smcv1.Capability, 0, len(ceiling))
	for code := range ceiling {
		out = append(out, &smcv1.Capability{Code: code})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].GetCode() < out[j].GetCode() })
	return out
}

func short(s string) string {
	if len(s) > 16 {
		return s[:16] + "…"
	}
	return s
}

func trimSpace(b []byte) string {
	for len(b) > 0 && (b[len(b)-1] == '\n' || b[len(b)-1] == '\r' || b[len(b)-1] == ' ') {
		b = b[:len(b)-1]
	}
	return string(b)
}

// constantTimeEqual is the only comparison used for the service credential.
func constantTimeEqual(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

var _ = json.Marshal
