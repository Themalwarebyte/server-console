// Command smc-helper is the sole privileged component on a managed host.
//
// It runs as root, listens ONLY on a Unix domain socket, and exposes exactly two
// fixed read-only operations in Milestone A. It has no shell, no exec path, no
// arbitrary command vector and no generic Docker passthrough. Anything not in
// this file does not exist.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"github.com/themalwarebyte/server-console/agent/internal/ipc"
)

const (
	sockDir  = "/run/smc-agent"
	sockPath = sockDir + "/helper.sock"
	// Per-request ceiling, matched by the agent's client timeout. A full Docker
	// pass inspects and samples every container, so this is generous by design
	// rather than a tight 10s window that would abort a real enumeration.
	requestTimeout = 45 * time.Second
	maxRequestSize = 64 * 1024
)

func main() {
	log.SetFlags(log.LstdFlags | log.LUTC)
	log.SetPrefix("smc-helper ")

	// The helper is the only process that must be able to read the Docker
	// socket, so it runs with a minimal but sufficient environment.
	if err := os.MkdirAll(sockDir, 0o750); err != nil {
		log.Fatalf("create %s: %v", sockDir, err)
	}
	if err := os.Chown(sockDir, 0, agentGID()); err != nil {
		log.Printf("warn: chown %s: %v", sockDir, err)
	}
	// A stale socket from an unclean exit would block binding.
	_ = os.Remove(sockPath)

	ln, err := net.Listen("unix", sockPath)
	if err != nil {
		log.Fatalf("listen %s: %v", sockPath, err)
	}
	// 0660 root:smc-agent — only the agent group may connect.
	if err := os.Chmod(sockPath, 0o660); err != nil {
		log.Fatalf("chmod %s: %v", sockPath, err)
	}
	if err := os.Chown(sockPath, 0, agentGID()); err != nil {
		log.Printf("warn: chown %s: %v", sockPath, err)
	}
	log.Printf("listening on %s (read-only operations: %s, %s, %s)",
		sockPath, ipc.OpHostTelemetry, ipc.OpDockerTelemetry, ipc.OpContainerLogs)

	col := newCollector()

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go func() {
		<-ctx.Done()
		_ = ln.Close()
		_ = os.Remove(sockPath)
	}()

	for {
		conn, err := ln.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				log.Print("shutting down")
				return
			}
			log.Printf("accept: %v", err)
			continue
		}
		go col.serve(ctx, conn)
	}
}

// agentGID resolves the smc-agent primary group so the socket is owned by
// root:smc-agent without hardcoding a numeric id that would differ per host.
func agentGID() int {
	data, err := os.ReadFile("/etc/group")
	if err != nil {
		return -1
	}
	for _, line := range splitLines(string(data)) {
		var name, _, gid, _ = split4(line)
		if name == "smc-agent" {
			var n int
			if _, err := fmt.Sscanf(gid, "%d", &n); err == nil {
				return n
			}
		}
	}
	return -1
}

func splitLines(s string) []string {
	var out []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			out = append(out, s[start:i])
			start = i + 1
		}
	}
	if start < len(s) {
		out = append(out, s[start:])
	}
	return out
}

func split4(line string) (string, string, string, string) {
	var parts [4]string
	n := 0
	cur := ""
	for i := 0; i < len(line) && n < 4; i++ {
		if line[i] == ':' {
			parts[n] = cur
			n++
			cur = ""
		} else {
			cur += string(line[i])
		}
	}
	parts[n] = cur
	return parts[0], parts[1], parts[2], parts[3]
}

// collector serialises collection so two agents cannot both walk Docker at once.
// There is only ever one agent, but this also keeps CPU cost bounded.
type collector struct {
	mu sync.Mutex
	dc *dockerCollector
}

func newCollector() *collector {
	return &collector{dc: newDockerCollector()}
}

func (c *collector) serve(ctx context.Context, conn net.Conn) {
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(requestTimeout))

	r := bufio.NewReaderSize(conn, 4096)
	line, err := r.ReadString('\n')
	if err != nil {
		return
	}
	if len(line) > maxRequestSize {
		writeJSON(conn, ipc.Response{OK: false, Err: "request too large"})
		return
	}

	var req ipc.Request
	if err := json.Unmarshal([]byte(line), &req); err != nil {
		writeJSON(conn, ipc.Response{OK: false, Err: "malformed request"})
		return
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	logStart := time.Now()

	switch req.Op {
	case ipc.OpHostTelemetry:
		h, err := collectHost()
		if err != nil {
			writeJSON(conn, ipc.Response{OK: false, Err: "host telemetry unavailable"})
			return
		}
		writeJSON(conn, ipc.Response{OK: true, Host: h})

	case ipc.OpDockerTelemetry:
		d, err := c.dc.collect()
		if err != nil {
			// A daemon that is down is a legitimate observation, not a helper
			// failure, so it is reported as data with reachable=false.
			writeJSON(conn, ipc.Response{OK: true, Docker: &ipc.DockerTelemetry{
				DaemonReachable: false,
			}})
			return
		}
		writeJSON(conn, ipc.Response{OK: true, Docker: d})

	case ipc.OpContainerLogs:
		// Read-only. The exact-64-hex-id check lives in containerLogs, so a
		// name, prefix, regex, glob or "all containers" is refused before
		// Docker is ever consulted. There is no follow parameter at all.
		l, err := c.dc.containerLogs(ctx, req)
		if err != nil || l == nil {
			writeJSON(conn, ipc.Response{OK: false, Err: "logs unavailable"})
			return
		}
		l.DurationMs = time.Since(logStart).Milliseconds()
		writeJSON(conn, ipc.Response{OK: true, Logs: l})

	default:
		// Milestone A has no other operation. Unknown ops are refused outright.
		writeJSON(conn, ipc.Response{OK: false, Err: "operation not available in this milestone"})
	}
	_ = ctx
}

func writeJSON(conn net.Conn, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	_ = conn.SetWriteDeadline(time.Now().Add(requestTimeout))
	_, _ = conn.Write(append(b, '\n'))
}

var _ = filepath.Join // keep filepath import for future socket relocation
