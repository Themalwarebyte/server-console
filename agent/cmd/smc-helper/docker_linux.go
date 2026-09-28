package main

import (
	"context"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/client"

	"github.com/themalwarebyte/server-console/agent/internal/ipc"
)

// dockerCollector reads the local Docker estate. It is the only component that
// opens /var/run/docker.sock, and it only ever reads.
type dockerCollector struct {
	once sync.Once
	cli  *client.Client
	err  error

	// Previous CPU sample, so a percentage reflects current usage rather than
	// a lifetime average.
	prevCPU map[string]float64
	prevTS  time.Time
}

func newDockerCollector() *dockerCollector {
	return &dockerCollector{prevCPU: map[string]float64{}}
}

func (d *dockerCollector) conn() (*client.Client, error) {
	d.once.Do(func() {
		// No fixed API version: negotiate, so the helper works across the Docker
		// versions actually deployed on the two hosts.
		cli, err := client.NewClientWithOpts(client.FromEnv, client.WithAPIVersionNegotiation())
		d.cli, d.err = cli, err
	})
	return d.cli, d.err
}

// collect produces a full read-only snapshot of the Docker estate.
func (d *dockerCollector) collect() (*ipc.DockerTelemetry, error) {
	cli, err := d.conn()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	if _, err := cli.Ping(ctx); err != nil {
		return nil, err
	}
	info, err := cli.Info(ctx)
	if err != nil {
		return nil, err
	}

	out := &ipc.DockerTelemetry{
		DaemonReachable: true,
		EngineVersion:   info.ServerVersion,
		APIVersion:      apiVersionString(cli),
		Containers:      []ipc.Container{},
	}

	all, err := cli.ContainerList(ctx, container.ListOptions{All: true})
	if err != nil {
		return nil, err
	}

	now := time.Now()
	for i := range all {
		c := all[i]
		row := ipc.Container{
			ID:        c.ID,
			Name:      strings.TrimPrefix(c.Names[0], "/"),
			Image:     c.Image,
			State:     c.State,
			Status:    c.Status,
			StartedAtMS: c.Created * 1000,
			Ports:     []string{},
		}

		// Health is only ever populated from an actual Docker healthcheck.
		// The list endpoint does not carry it, so it comes from inspect, and a
		// container with no healthcheck keeps healthCheckPresent=false and an
		// empty health. Health is never synthesised.
		if insp, err := cli.ContainerInspect(ctx, c.ID); err == nil {
			row.RestartCount = int32(insp.RestartCount)
			row.Ports = publishedPorts(insp.NetworkSettings)
			if insp.State != nil {
				if insp.State.Health != nil {
					row.HealthCheckPresent = true
					row.Health = string(insp.State.Health.Status)
					if row.Health == "" {
						row.Health = "starting"
					}
				}
				if insp.State.StartedAt != "" {
					if t, err := time.Parse(time.RFC3339Nano, insp.State.StartedAt); err == nil {
						row.StartedAtMS = t.UnixMilli()
					}
				}
			}
		}

		// A container that is not running has no live resource figures worth
		// sampling, and sampling it would be wasted work. Exited and created
		// containers are reported without a CPU or memory figure rather than
		// with a misleading one.
		if c.State == "running" {
			if stats, err := containerStats(ctx, cli, c.ID); err == nil {
				row.CPUPercent = d.cpuDelta(c.ID, stats.CPU, now)
				row.MemoryBytes = stats.Mem
			}
		}

		countState(out, c.State)
		if row.HealthCheckPresent {
			out.WithHealthcheck++
			if row.Health == "unhealthy" {
				out.Unhealthy++
			}
		}
		out.Containers = append(out.Containers, row)
	}

	out.Total = len(all)
	out.ComposeVersion = composeVersion()
	return out, nil
}

func countState(t *ipc.DockerTelemetry, state string) {
	switch state {
	case "running":
		t.Running++
	case "exited", "dead":
		t.Exited++
	case "restarting":
		t.Restarting++
	case "paused":
		t.Paused++
	}
}

type cgroupStats struct {
	CPU float64 // per-CPU cumulative seconds
	Mem uint64
}

// containerStats reads one container's cumulative CPU and current memory.
func containerStats(ctx context.Context, cli *client.Client, id string) (cgroupStats, error) {
	resp, err := cli.ContainerStats(ctx, id, false)
	if err != nil {
		return cgroupStats{}, err
	}
	defer resp.Body.Close()

	raw, err := decodeJSON(resp.Body)
	if err != nil {
		return cgroupStats{}, err
	}

	cpu := raw.CPUStats.CPUUsage.TotalUsage
	n := len(raw.CPUStats.CPUUsage.PercpuUsage)
	if n == 0 {
		if raw.CPUStats.OnlineCPUs > 0 {
			n = int(raw.CPUStats.OnlineCPUs)
		} else {
			n = 1
		}
	}
	if cpu == 0 {
		return cgroupStats{}, nil
	}
	return cgroupStats{
		CPU: float64(cpu) / float64(n),
		Mem: raw.MemoryStats.Usage,
	}, nil
}

// statsDoc is the subset of a container stats payload that is used.
type statsDoc struct {
	CPUStats struct {
		CPUUsage struct {
			TotalUsage  uint64   `json:"total_usage"`
			PercpuUsage []uint64 `json:"percpu_usage"`
		} `json:"cpu_usage"`
		OnlineCPUs uint32 `json:"online_cpus"`
	} `json:"cpu_stats"`
	MemoryStats struct {
		Usage uint64 `json:"usage"`
	} `json:"memory_stats"`
}

// cpuDelta converts cumulative CPU into a percentage over the sample window.
func (d *dockerCollector) cpuDelta(id string, totalCPU float64, now time.Time) float64 {
	prev, hadPrev := d.prevCPU[id]
	prevTS := d.prevTS
	d.prevCPU[id] = totalCPU
	if now.After(prevTS) {
		d.prevTS = now
	}
	if !hadPrev || prevTS.IsZero() {
		return 0
	}
	delta := totalCPU - prev
	if delta < 0 {
		return 0
	}
	elapsed := now.Sub(prevTS).Seconds()
	if elapsed <= 0 {
		return 0
	}
	pct := delta / elapsed * 100
	if pct < 0 {
		return 0
	}
	return pct
}

// publishedPorts renders only host-published mappings, so an internally
// network-reachable port is never mistaken for an exposed one.
func publishedPorts(ns *types.NetworkSettings) []string {
	out := []string{}
	if ns == nil || ns.Ports == nil {
		return out
	}
	for p, bindings := range ns.Ports {
		for _, b := range bindings {
			out = append(out, b.HostIP+":"+string(b.HostPort)+"->"+string(p))
		}
	}
	return out
}

func composeVersion() string {
	for _, p := range []string{"/usr/local/bin/docker", "/usr/bin/docker"} {
		out, err := exec.Command(p, "compose", "version", "--short").Output()
		if err == nil {
			return strings.TrimSpace(string(out))
		}
	}
	return ""
}

// apiVersionString reports the negotiated API version, for operator visibility
// when a host runs a different Docker release.
func apiVersionString(cli *client.Client) string {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if v, err := cli.ServerVersion(ctx); err == nil && v.APIVersion != "" {
		return v.APIVersion
	}
	return "negotiated"
}
