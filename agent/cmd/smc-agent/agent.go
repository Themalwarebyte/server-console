package main

import (
	"crypto/x509"
	"encoding/pem"
	"os"

	"context"
	"io"
	"log"
	"sync"
	"sync/atomic"
	"time"

	smcv1 "github.com/themalwarebyte/server-console/agent/gen/smcv1"
	"github.com/themalwarebyte/server-console/agent/internal/agentid"
	"github.com/themalwarebyte/server-console/agent/internal/helperclient"
	"github.com/themalwarebyte/server-console/agent/internal/ipc"
)
// agent drives the single long-lived stream.

// agent drives the single long-lived stream.
//
// Cadence follows the approved model: 5 s heartbeat, 5 s host telemetry, 10 s
// per-container telemetry, event-driven lifecycle events, 30 s full reconcile.
// Nothing expensive runs on the 5 s path.
type agent struct {
	id      string
	version string
	proto   string
	helper   *helperclient.Client
	certPath string
	stream  smcv1.AgentChannel_ConnectClient

	seq atomic.Uint64

	sendMu sync.Mutex

	ceiling map[string]bool

	// ---- log request enforcement (Milestone B) ----
	// nonces rejects replayed envelopes within nonceWindow.
	nonces *nonceSet
	// logSlots bounds concurrent reads held by this agent.
	logSlots chan struct{}
	// rate is a fixed per-minute counter.
	rate logRate
	// epoch is the highest management epoch this agent has observed.
	epoch atomic.Int64

	// lastHost backs the CPU delta across samples.
	lastHostCPU float64
	lastHostTS  time.Time
}

func (a *agent) loop(ctx context.Context) error {
	log.Printf("connecting to gateway as %s (agent %s, protocol %s)", a.id, a.version, a.proto)

	// Receive loop: HelloAck establishes the ceiling; Ping keeps the channel
	// warm. Milestone A denies every action, so Action is logged and refused.
	go a.receive(ctx)

	// Cadence timers.
	heartbeat := time.NewTicker(5 * time.Second)
	hostT := time.NewTicker(5 * time.Second)
	containerT := time.NewTicker(10 * time.Second)
	reconcileT := time.NewTicker(30 * time.Second)
	defer heartbeat.Stop()
	defer hostT.Stop()
	defer containerT.Stop()
	defer reconcileT.Stop()

	a.sendHello()
	a.sendHost(ctx)
	a.sendDocker(ctx)

	for {
		select {
		case <-ctx.Done():
			log.Print("context cancelled; closing stream")
			return ctx.Err()
		case <-heartbeat.C:
			if err := a.sendHeartbeat(); err != nil {
				return err
			}
		case <-hostT.C:
			if err := a.sendHost(ctx); err != nil {
				log.Printf("host telemetry: %v", err)
			}
		case <-containerT.C:
			if err := a.sendDocker(ctx); err != nil {
				log.Printf("docker telemetry: %v", err)
			}
		case <-reconcileT.C:
			// A full pass repairs anything an event stream might have missed.
			if err := a.sendDocker(ctx); err != nil {
				log.Printf("docker reconcile: %v", err)
			}
		}
	}
}

func (a *agent) receive(ctx context.Context) {
	for {
		msg, err := a.stream.Recv()
		if err != nil {
			if err != io.EOF && ctx.Err() == nil {
				log.Printf("receive: %v", err)
			}
			return
		}
		switch p := msg.Payload.(type) {
		case *smcv1.GatewayMessage_HelloAck:
			a.applyCeiling(p.HelloAck)
		case *smcv1.GatewayMessage_Ping:
			log.Printf("ping from gateway")
		case *smcv1.GatewayMessage_Log:
			// A log read is validated and executed on this host, then relayed
			// back on the same stream. The result is never buffered here.
			m := p.Log
			go func() {
				res := a.handleLogRequest(ctx, m)
				_ = a.send(&smcv1.AgentMessage{
					Payload: &smcv1.AgentMessage_LogResult{LogResult: res},
				})
			}()

		case *smcv1.GatewayMessage_Action:
			// Milestone A ceiling is read-only, so an action can never be
			// authorised. It is refused and the refusal is reported.
			log.Printf("REFUSING action %s (%s): not permitted by local ceiling",
				p.Action.GetTaskId(), p.Action.GetCapability())
			_ = a.send(&smcv1.AgentMessage{Payload: &smcv1.AgentMessage_Ack{
				Ack: &smcv1.ActionAck{
					TaskId:  p.Action.GetTaskId(),
					Accepted: false,
					Reason:   "capability not in local ceiling for this milestone",
				},
			}})
		}
	}
}

func (a *agent) applyCeiling(ack *smcv1.HelloAck) {
	a.ceiling = map[string]bool{}
	for _, c := range ack.GetCeiling() {
		a.ceiling[c.GetCode()] = true
	}
	log.Printf("session %s established: protocol %s, ceiling %v",
		ack.GetSessionId(), ack.GetProtocolVersion(), ack.GetCeiling())
}

func (a *agent) sendHello() {
	fp := a.certFingerprint()
	log.Printf("hello serverPublicId=%s cert=%s", a.id, fp)
	_ = a.send(&smcv1.AgentMessage{Payload: &smcv1.AgentMessage_Hello{
		Hello: &smcv1.Hello{
			ServerPublicId:   a.id,
			AgentVersion:     a.version,
			ProtocolVersion:  a.proto,
			CertFingerprint:  fp,
		},
	}})
}

func (a *agent) certFingerprint() string {
	// Reported for operator traceability. The gateway uses its own verified
	// certificate value as authoritative and rejects any mismatch, so this is
	// never trusted for authorisation.
	der, err := os.ReadFile(a.certPath)
	if err != nil {
		return ""
	}
	if block, _ := pem.Decode(der); block != nil {
		if c, err := x509.ParseCertificate(block.Bytes); err == nil {
			return agentid.Fingerprint(c.Raw)
		}
	}
	return ""
}

func (a *agent) sendHeartbeat() error {
	h, _ := a.helper.HostTelemetry(context.Background())
	boot := ""
	var up int64
	if h != nil {
		boot, up = h.BootID, h.UptimeSeconds
	}
	return a.send(&smcv1.AgentMessage{Payload: &smcv1.AgentMessage_Heartbeat{
		Heartbeat: &smcv1.Heartbeat{
			ObservedAtMs:  time.Now().UnixMilli(),
			Seq:           a.seq.Add(1),
			UptimeSeconds: up,
			BootId:        boot,
		},
	}})
}

func (a *agent) sendHost(ctx context.Context) error {
	h, err := a.helper.HostTelemetry(ctx)
	if err != nil {
		return err
	}
	// CPU is a delta against the previous sample, so the figure is current
	// usage rather than a lifetime average.
	now := time.Now()
	var pct float64
	if !a.lastHostTS.IsZero() {
		if delta := h.CPUPercent - a.lastHostCPU; delta >= 0 {
			if el := now.Sub(a.lastHostTS).Seconds(); el > 0 {
				pct = delta / el * 100
			}
		}
	}
	a.lastHostCPU, a.lastHostTS = h.CPUPercent, now
	if pct < 0 {
		pct = 0
	}

	return a.send(&smcv1.AgentMessage{Payload: &smcv1.AgentMessage_Host{
		Host: &smcv1.HostTelemetry{
			ObservedAtMs:      now.UnixMilli(),
			Seq:               a.seq.Add(1),
			ServerPublicId:    a.id,
			Hostname:          h.Hostname,
			OsName:            h.OSName,
			OsVersion:         h.OSVersion,
			Kernel:            h.Kernel,
			Arch:              h.Arch,
			BootId:            h.BootID,
			UptimeSeconds:     h.UptimeSeconds,
			Load_1:            h.Load1,
			Load_5:            h.Load5,
			Load_15:           h.Load15,
			CpuPercent:        pct,
			LogicalCpuCount: uint32(h.LogicalCPUCount),
			MemTotalBytes:     h.MemTotalBytes,
			MemAvailableBytes: h.MemAvailBytes,
			MemUsedBytes:      h.MemUsedBytes,
			Disk:              toProtoMounts(h.Disks),
			TailscaleIps:      h.TailscaleIPs,
			LanIps:            h.LANIPs,
			AgentVersion:      a.version,
			ProtocolVersion:   a.proto,
		},
	}})
}

func (a *agent) sendDocker(ctx context.Context) error {
	d, err := a.helper.DockerTelemetry(ctx)
	if err != nil {
		return err
	}
	cs := make([]*smcv1.Container, 0, len(d.Containers))
	for _, c := range d.Containers {
		cs = append(cs, &smcv1.Container{
			Id:                 c.ID,
			Name:               c.Name,
			Image:              c.Image,
			State:              c.State,
			HealthCheckPresent: c.HealthCheckPresent,
			// Health is only ever forwarded when Docker reported a check.
			Health:       c.Health,
			Status:       c.Status,
			CpuPercent:   c.CPUPercent,
			MemoryBytes:  c.MemoryBytes,
			RestartCount: c.RestartCount,
			Ports:        c.Ports,
			StartedAtMs:  c.StartedAtMS,
		})
	}
	return a.send(&smcv1.AgentMessage{Payload: &smcv1.AgentMessage_Docker{
		Docker: &smcv1.DockerTelemetry{
			ObservedAtMs:     time.Now().UnixMilli(),
			Seq:              a.seq.Add(1),
			ServerPublicId:   a.id,
			DaemonReachable:  d.DaemonReachable,
			EngineVersion:    d.EngineVersion,
			ComposeVersion:   d.ComposeVersion,
			ApiVersion:       d.APIVersion,
			Total:            uint32(d.Total),
			Running:          uint32(d.Running),
			Exited:           uint32(d.Exited),
			Restarting:       uint32(d.Restarting),
			Paused:           uint32(d.Paused),
			Unhealthy:        uint32(d.Unhealthy),
			WithHealthcheck:  uint32(d.WithHealthcheck),
			Containers:       cs,
		},
	}})
}

func (a *agent) send(m *smcv1.AgentMessage) error {
	// Serialised so ordering on the stream is deterministic.
	a.sendMu.Lock()
	defer a.sendMu.Unlock()
	if a.stream == nil {
		return nil
	}
	return a.stream.Send(m)
}

func toProtoMounts(in []ipc.Mount) []*smcv1.Mount {
	out := make([]*smcv1.Mount, 0, len(in))
	for _, m := range in {
		out = append(out, &smcv1.Mount{
			MountPoint:  m.MountPoint,
			Fstype:      m.Fstype,
			TotalBytes:  m.TotalBytes,
			UsedBytes:   m.UsedBytes,
			AvailBytes:  m.AvailBytes,
			UsedPercent: int32(m.UsedPercent),
		})
	}
	return out
}
