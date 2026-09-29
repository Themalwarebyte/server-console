package main

import (
	"bufio"
	"context"
	"errors"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/docker/docker/api/types/container"

	"github.com/themalwarebyte/server-console/agent/internal/ipc"
)

// Redaction is BEST EFFORT. It cannot be relied on to catch every secret in
// every format, and it does NOT make log content safe to render. It raises the
// cost of casual disclosure; the console tells the operator as much.
//
// Everything here runs on the managed host, before any byte of log text leaves
// it, so unredacted content never reaches the gateway or the control plane.

var (
	reAssignSecret = regexp.MustCompile(
		`(?i)\b(password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|client[_-]?secret|private[_-]?key|auth)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)`)
	reAuthHeader  = regexp.MustCompile(`(?i)\b(authorization|proxy-authorization)\b(\s*:\s*)\S+.*`)
	reCookie      = regexp.MustCompile(`(?i)\b(cookie|set-cookie)\b(\s*:\s*).*`)
	reBearer      = regexp.MustCompile(`(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}`)
	reAWSKey      = regexp.MustCompile(`\bAKIA[0-9A-Z]{16}\b`)
	reJWT         = regexp.MustCompile(`\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b`)
	rePrivKey     = regexp.MustCompile(`(?s)-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----`)
	reConnString  = regexp.MustCompile(`(?i)\b([a-z0-9+.-]+://)([^:@\s/]+):([^@\s/]+)@`)
	rePlatformSec = regexp.MustCompile(`(?i)\b(BETTER_AUTH_SECRET|CONVEX_SELF_HOSTED_ADMIN_KEY|SMC_GATEWAY_SECRET)\b(\s*[:=]\s*)\S+`)
)

const redactionMarker = "[REDACTED]"

// errNotExactID marks a refused selector: anything that is not a full 64-char
// lowercase hex id never reaches Docker.
var errNotExactID = errors.New("container id must be a full 64-character hex id")

// redact applies the best-effort patterns above to one line.
func redact(line string) string {
	if line == "" {
		return line
	}
	out := line
	out = rePrivKey.ReplaceAllString(out, redactionMarker)
	out = reAssignSecret.ReplaceAllString(out, "${1}${2}"+redactionMarker)
	out = reAuthHeader.ReplaceAllString(out, "${1}${2}"+redactionMarker)
	out = reCookie.ReplaceAllString(out, "${1}${2}"+redactionMarker)
	out = reBearer.ReplaceAllString(out, redactionMarker)
	out = reAWSKey.ReplaceAllString(out, redactionMarker)
	out = reJWT.ReplaceAllString(out, redactionMarker)
	out = reConnString.ReplaceAllString(out, "${1}${2}"+redactionMarker)
	out = rePlatformSec.ReplaceAllString(out, "${1}${2}"+redactionMarker)
	return out
}

// sanitize removes ANSI escapes and control characters so log text cannot
// manipulate the console. Tab and newline structure is preserved; CR becomes a
// space so a carriage return cannot overwrite an already-rendered line.
func sanitize(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	inEscape := false
	for i := 0; i < len(s); i++ {
		c := s[i]
		if inEscape {
			if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '~' {
				inEscape = false
			}
			continue
		}
		if c == 0x1b {
			inEscape = true
			continue
		}
		switch {
		case c == '\n' || c == '\t':
			b.WriteByte(c)
		case c == '\r':
			b.WriteByte(' ')
		case c < 0x20 || c == 0x7f:
			// dropped
		default:
			b.WriteByte(c)
		}
	}
	return b.String()
}

// isExactContainerID accepts only a full 64-character lowercase hex id. This is
// what makes name, prefix, regex, glob and "all containers" selection
// impossible.
func isExactContainerID(s string) bool {
	if len(s) != 64 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

// splitTimestamp extracts a leading Docker RFC3339 timestamp when requested.
func splitTimestamp(line string, want bool) (int64, string) {
	if !want || len(line) < 30 {
		return 0, line
	}
	sp := strings.IndexByte(line, ' ')
	if sp <= 0 {
		return 0, line
	}
	if t, err := time.Parse(time.RFC3339Nano, line[:sp]); err == nil {
		return t.UnixMilli(), line[sp+1:]
	}
	return 0, line
}

// containerLogs reads a bounded, redacted tail for one exact container id.
// The caller measures duration itself.
func (d *dockerCollector) containerLogs(ctx context.Context, req ipc.Request) (*ipc.LogResponse, error) {
	cli, err := d.conn()
	if err != nil {
		return nil, err
	}

	id := strings.TrimSpace(req.ContainerID)
	if id == "" || !isExactContainerID(id) {
		return nil, errNotExactID
	}

	tail := req.Tail
	if tail <= 0 {
		tail = 100
	}
	if tail > ipc.MaxLogTail {
		tail = ipc.MaxLogTail
	}

	// Follow is hard-wired false: no caller can request an unbounded stream.
	rc, err := cli.ContainerLogs(ctx, id, container.LogsOptions{
		ShowStdout: true,
		ShowStderr: true,
		Timestamps: req.Timestamps,
		Tail:       strconv.Itoa(tail),
		Follow:     false,
	})
	if err != nil {
		return nil, err
	}
	defer rc.Close()

	out := &ipc.LogResponse{ContainerID: id, Lines: []ipc.LogLine{}}
	sc := bufio.NewScanner(rc)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)

	total := 0
	for sc.Scan() {
		raw := strings.TrimRight(sc.Text(), "\r\n")
		if raw == "" {
			continue
		}
		ts, text := splitTimestamp(raw, req.Timestamps)
		text = sanitize(redact(text))

		if len(text) > ipc.MaxLogLineBytes {
			text = text[:ipc.MaxLogLineBytes] + "...[truncated]"
			out.Truncated = true
		}
		if total+len(text) > ipc.MaxLogBytes || len(out.Lines) >= ipc.MaxLogLines {
			out.Truncated = true
			break
		}
		total += len(text)
		out.Lines = append(out.Lines, ipc.LogLine{TimestampMs: ts, Text: text})
	}

	out.TotalBytes = total
	return out, nil
}
