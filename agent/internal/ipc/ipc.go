// Package ipc defines the local helper protocol.
//
// The helper is the ONLY component that touches the Docker socket or the
// kernel's power controls. The agent cannot: it has no docker group membership
// and no sudo rule, so the socket at /var/run/docker.sock is unreadable to it.
//
// Milestone A exposes exactly two fixed read-only operations. Mutation
// operations are deliberately not present yet, and when they are added each must
// take an exact container ID or name and reject wildcards, regex selectors,
// arbitrary selectors and arbitrary Docker API paths.
package ipc

// Operation names. This list is the entire Milestone B surface.
//
// containerLogs is READ-ONLY and takes an exact container id. There is no
// name matching, no prefix, no regex, no glob, and no "all containers". There is
// no follow parameter, so no unbounded stream is reachable even by a hostile
// caller. Mutation operations are deliberately absent; when they are added in
// Milestone C they land as separate named operations, never as a parameter here,
// so any widening of this surface is visible in review.
const (
	OpHostTelemetry   = "hostTelemetry"
	OpDockerTelemetry = "dockerTelemetry"
	OpContainerLogs   = "containerLogs"
)

// Milestone B limits. These are the ceilings, not merely the defaults: a caller
// asking for more is clamped, and exceeding the byte cap truncates rather than
// failing.
const (
	MaxLogLines     = 500
	MaxLogBytes     = 256 * 1024
	MaxLogLineBytes = 4 * 1024
	MaxLogTail      = 500
)

// Request is one newline-delimited JSON request over the Unix socket.
type Request struct {
	Op string `json:"op"`

	// containerLogs parameters. ContainerID must be an exact Docker id.
	ContainerID string `json:"containerId,omitempty"`
	Tail        int    `json:"tail,omitempty"`
	Timestamps  bool   `json:"timestamps,omitempty"`
}

// Response is one newline-delimited JSON response.
//
// Milestone A never returns an error to the agent that would contain host
// detail it should not see; failures are reported by class only.
type Response struct {
	OK    bool              `json:"ok"`
	Err   string            `json:"err,omitempty"`
	Host  *HostTelemetry    `json:"host,omitempty"`
	Docker *DockerTelemetry `json:"docker,omitempty"`
	Logs  *LogResponse      `json:"logs,omitempty"`
}

// LogResponse is a bounded, redacted container log tail.
type LogResponse struct {
	ContainerID string     `json:"containerId"`
	Lines       []LogLine  `json:"lines"`
	Truncated   bool       `json:"truncated"`
	TotalBytes  int        `json:"totalBytes"`
	DurationMs  int64      `json:"durationMs"`
}

// LogLine is one redacted line. TimestampMs is 0 when timestamps were not
// requested. Text has ANSI and control characters removed.
type LogLine struct {
	TimestampMs int64  `json:"timestampMs"`
	Text        string `json:"text"`
}

// Mount is a filesystem usage record.
type Mount struct {
	MountPoint  string  `json:"mountPoint"`
	Fstype      string  `json:"fstype"`
	TotalBytes  uint64  `json:"totalBytes"`
	UsedBytes   uint64  `json:"usedBytes"`
	AvailBytes  uint64  `json:"availBytes"`
	UsedPercent float64 `json:"usedPercent"`
}

// HostTelemetry is read-only host state.
type HostTelemetry struct {
	Hostname       string   `json:"hostname"`
	OSName         string   `json:"osName"`
	OSVersion      string   `json:"osVersion"`
	Kernel         string   `json:"kernel"`
	Arch           string   `json:"arch"`
	BootID         string   `json:"bootId"`
	UptimeSeconds  int64    `json:"uptimeSeconds"`
	Load1          float64  `json:"load1"`
	Load5          float64  `json:"load5"`
	Load15         float64  `json:"load15"`
	CPUPercent     float64  `json:"cpuPercent"`
	LogicalCPUCount       int      `json:"LogicalCPUCount"`
	MemTotalBytes  uint64   `json:"memTotalBytes"`
	MemAvailBytes  uint64   `json:"memAvailableBytes"`
	MemUsedBytes   uint64   `json:"memUsedBytes"`
	Disks          []Mount  `json:"disks"`
	TailscaleIPs   []string `json:"tailscaleIps"`
	LANIPs         []string `json:"lanIps"`
}

// Container is one observed container.
//
// HealthCheckPresent is recorded separately from Health so that a container with
// no HEALTHCHECK is never rendered as healthy. Health is never synthesised.
type Container struct {
	ID                string   `json:"id"`
	Name              string   `json:"name"`
	Image             string   `json:"image"`
	State             string   `json:"state"`
	HealthCheckPresent bool    `json:"healthCheckPresent"`
	Health            string   `json:"health"`
	Status            string   `json:"status"`
	CPUPercent        float64  `json:"cpuPercent"`
	MemoryBytes       uint64   `json:"memoryBytes"`
	RestartCount      int32    `json:"restartCount"`
	Ports             []string `json:"ports"`
	StartedAtMS       int64    `json:"startedAtMs"`
}

// DockerTelemetry is read-only Docker state.
type DockerTelemetry struct {
	DaemonReachable bool        `json:"daemonReachable"`
	EngineVersion   string      `json:"engineVersion"`
	ComposeVersion  string      `json:"composeVersion"`
	APIVersion      string      `json:"apiVersion"`
	Total           int          `json:"total"`
	Running         int          `json:"running"`
	Exited          int          `json:"exited"`
	Restarting      int          `json:"restarting"`
	Paused          int          `json:"paused"`
	Unhealthy       int          `json:"unhealthy"`
	WithHealthcheck int          `json:"withHealthcheck"`
	Containers      []Container  `json:"containers"`
	Error           string       `json:"error,omitempty"`
}
