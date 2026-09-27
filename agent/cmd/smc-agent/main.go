// Command smc-agent is the unprivileged agent that runs on each managed host.
//
// It holds no privileged group membership, has no sudo rule, and cannot read the
// Docker socket. It dials OUT to the gateway over a single long-lived mTLS gRPC
// stream and reports read-only telemetry gathered through the local helper.
package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"net"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/metadata"

	smcv1 "github.com/themalwarebyte/server-console/agent/gen/smcv1"
	"github.com/themalwarebyte/server-console/agent/internal/agentid"
	"github.com/themalwarebyte/server-console/agent/internal/helperclient"
)

var (
	version      = "0.1.0"
	protoVersion = "smc-agent/1"

	serverID     = flag.String("server", "", "immutable serverPublicId (must match the certificate URI SAN)")
	gatewayAddr  = flag.String("gateway", "", "gateway address host:port")
	stateDir     = flag.String("state", "/var/lib/smc-agent", "state directory")
	caFile       = flag.String("ca", "", "CA bundle used to verify the gateway")
	certFile     = flag.String("cert", "", "agent certificate")
	keyFile      = flag.String("key", "", "agent private key (never leaves this host)")
	enrollToken  = flag.String("enroll-token", "", "one-time enrollment token used on first connect")
	bootstrap    = flag.Bool("init-key", false, "generate the local key and CSR, then exit")
	csrOut       = flag.String("csr-out", "", "write the CSR here (with -init-key)")
	runFor       = flag.Duration("once", 0, "run for this long then exit (0 = run forever)")
	printVersion = flag.Bool("version", false, "print the agent version and exit")
)

func main() {
	flag.Parse()
	log.SetFlags(log.LstdFlags | log.LUTC)
	log.SetPrefix("smc-agent ")

	if *printVersion {
		fmt.Printf("smc-agent %s (protocol %s)\n", version, protoVersion)
		return
	}
	if *serverID == "" {
		log.Fatal("-server is required (the immutable serverPublicId)")
	}

	if *bootstrap {
		if err := initIdentity(); err != nil {
			log.Fatalf("init-key: %v", err)
		}
		return
	}
	if *gatewayAddr == "" {
		log.Fatal("-gateway is required")
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if *runFor > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, *runFor)
		defer cancel()
	}

	if err := run(ctx); err != nil && !errors.Is(err, context.Canceled) {
		log.Fatalf("agent stopped: %v", err)
	}
}

// initIdentity generates this host's OWN key and CSR. Nothing is uploaded, and
// the private key never leaves this machine.
func initIdentity() error {
	keyPath := filepath.Join(*stateDir, "agent.key")
	if _, err := os.Stat(keyPath); err == nil {
		log.Printf("key already present at %s; refusing to overwrite", keyPath)
		return nil
	}
	key, err := agentid.GenerateKey()
	if err != nil {
		return err
	}
	if err := agentid.SaveKey(keyPath, key); err != nil {
		return err
	}
	log.Printf("generated local ECDSA P-256 key at %s (mode 0600)", keyPath)

	csr, err := agentid.CSR(key, *serverID, version)
	if err != nil {
		return err
	}
	out := *csrOut
	if out == "" {
		out = filepath.Join(*stateDir, "agent.csr")
	}
	if err := os.MkdirAll(filepath.Dir(out), 0o700); err != nil {
		return err
	}
	if err := os.WriteFile(out, csr, 0o600); err != nil {
		return err
	}
	log.Printf("wrote CSR to %s (URI SAN identity: %s)", out, agentid.SPFFEPrefix+*serverID)
	return nil
}

func run(ctx context.Context) error {
	caPEM, err := os.ReadFile(*caFile)
	if err != nil {
		return fmt.Errorf("read CA: %w", err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caPEM) {
		return errors.New("CA bundle contains no usable certificates")
	}
	cert, err := tls.LoadX509KeyPair(*certFile, *keyFile)
	if err != nil {
		return fmt.Errorf("load agent keypair: %w", err)
	}

	host, _, err := net.SplitHostPort(*gatewayAddr)
	if err != nil {
		return fmt.Errorf("-gateway must be host:port: %w", err)
	}

	creds := credentials.NewTLS(&tls.Config{
		Certificates: []tls.Certificate{cert},
		RootCAs:      pool,
		ServerName:   host,
		MinVersion:   tls.VersionTLS13,
		// Verification is never skipped. The agent's own identity is its
		// certificate; the gateway's is verified against the CA and dial name.
		InsecureSkipVerify: false,
	})

	conn, err := grpc.NewClient(*gatewayAddr, grpc.WithTransportCredentials(creds))
	if err != nil {
		return fmt.Errorf("dial gateway: %w", err)
	}
	defer conn.Close()

	// A one-time enrollment token rides as stream metadata on a first connect
	// only. It is never repeated in a frame and never logged.
	if strings.TrimSpace(*enrollToken) != "" {
		ctx = metadata.AppendToOutgoingContext(ctx, "x-smc-enroll-token", strings.TrimSpace(*enrollToken))
		log.Print("attaching one-time enrollment token for first connect")
	}

	client := smcv1.NewAgentChannelClient(conn)
	stream, err := client.Connect(ctx)
	if err != nil {
		return fmt.Errorf("open stream: %w", err)
	}

	a := &agent{
		id:      *serverID,
		version: version,
		proto:   protoVersion,
		helper:  helperclient.New(""),
		stream:  stream,
	}
	return a.loop(ctx)
}

var _ = os.Getenv
var _ = time.Second
