// Package helperclient is the agent's client for the local privileged helper.
//
// The agent has no docker group membership and no sudo rule, so it cannot read
// the Docker socket itself. Every privileged or socket-mediated read goes
// through this client over the Unix socket.
package helperclient

import (
	"bufio"
	"context"
	"encoding/json"
	"net"
	"time"

	"github.com/themalwarebyte/server-console/agent/internal/ipc"
)

// DefaultSocket is the only path the agent will talk to.
const DefaultSocket = "/run/smc-agent/helper.sock"

// DefaultTimeout is generous because the helper performs a real Docker
// enumeration. A full pass inspects and samples every container, which on a
// shared production host is not instantaneous. The helper applies the same
// bound, so neither side can wedge on a stuck collector.
const DefaultTimeout = 45 * time.Second

type Client struct {
	Socket  string
	Timeout time.Duration
}

// ContainerLogs performs a read-only, bounded, redacted log tail for one exact
// container id.
//
// The helper owns the exact-id rule and the redaction. The agent deliberately
// does NOT pre-validate the target, so that rule has exactly one home and
// cannot drift between the two.
func (c *Client) ContainerLogs(ctx context.Context, req ipc.Request) (*ipc.LogResponse, error) {
	resp, err := c.call(ctx, req.Op)
	if err != nil {
		return nil, err
	}
	if !resp.OK || resp.Logs == nil {
		return nil, unavailableError(resp.Err)
	}
	return resp.Logs, nil
}

func New(socket string) *Client {
	if socket == "" {
		socket = DefaultSocket
	}
	return &Client{Socket: socket, Timeout: DefaultTimeout}
}

func (c *Client) call(ctx context.Context, op string) (*ipc.Response, error) {
	d := net.Dialer{Timeout: c.Timeout}
	conn, err := d.DialContext(ctx, "unix", c.Socket)
	if err != nil {
		return nil, err
	}
	defer conn.Close()

	deadline := time.Now().Add(c.Timeout)
	_ = conn.SetDeadline(deadline)

	body, err := json.Marshal(ipc.Request{Op: op})
	if err != nil {
		return nil, err
	}
	if _, err := conn.Write(append(body, '\n')); err != nil {
		return nil, err
	}

	r := bufio.NewReaderSize(conn, 1<<20)
	line, err := r.ReadBytes('\n')
	if err != nil && len(line) == 0 {
		return nil, err
	}
	var resp ipc.Response
	if err := json.Unmarshal(line, &resp); err != nil {
		return nil, err
	}
	return &resp, nil
}

func (c *Client) HostTelemetry(ctx context.Context) (*ipc.HostTelemetry, error) {
	resp, err := c.call(ctx, ipc.OpHostTelemetry)
	if err != nil {
		return nil, err
	}
	if !resp.OK || resp.Host == nil {
		return nil, errUnavailable(resp.Err)
	}
	return resp.Host, nil
}

func (c *Client) DockerTelemetry(ctx context.Context) (*ipc.DockerTelemetry, error) {
	resp, err := c.call(ctx, ipc.OpDockerTelemetry)
	if err != nil {
		return nil, err
	}
	if !resp.OK || resp.Docker == nil {
		return nil, errUnavailable(resp.Err)
	}
	return resp.Docker, nil
}

type unavailableError string

func (e unavailableError) Error() string { return "helper: " + string(e) }

func errUnavailable(s string) error {
	if s == "" {
		s = "unavailable"
	}
	return unavailableError(s)
}
