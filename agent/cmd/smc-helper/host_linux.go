package main

import (
	"bufio"
	"encoding/json"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"

	"github.com/themalwarebyte/server-console/agent/internal/ipc"
)

// collectHost gathers read-only host telemetry from procfs and sysfs.
// The only external process invoked is a fixed-argv `ip addr` with no user
// input, which is what makes interface enumeration reliable without a netlink
// dependency. There is no shell and no interpolated argument.
func collectHost() (*ipc.HostTelemetry, error) {
	h := &ipc.HostTelemetry{}

	if b, err := os.ReadFile("/etc/os-release"); err == nil {
		for _, line := range strings.Split(string(b), "\n") {
			k, v, ok := strings.Cut(line, "=")
			if !ok {
				continue
			}
			v = strings.Trim(v, `"`)
			switch k {
			case "PRETTY_NAME", "NAME":
				if h.OSName == "" {
					h.OSName = v
				}
			case "VERSION_ID":
				h.OSVersion = v
			}
		}
	}
	if b, err := os.ReadFile("/proc/sys/kernel/hostname"); err == nil {
		h.Hostname = strings.TrimSpace(string(b))
	}
	if b, err := os.ReadFile("/proc/sys/kernel/osrelease"); err == nil {
		h.Kernel = strings.TrimSpace(string(b))
	}
	if b, err := os.ReadFile("/proc/sys/kernel/random/boot_id"); err == nil {
		h.BootID = strings.TrimSpace(string(b))
	}
	var uts syscall.Utsname
	if err := syscall.Uname(&uts); err == nil {
		h.Arch = charsToString(uts.Machine[:])
	}

	if b, err := os.ReadFile("/proc/uptime"); err == nil {
		if f := strings.Fields(string(b)); len(f) > 0 {
			h.UptimeSeconds = int64(atof(f[0]))
		}
	}
	if b, err := os.ReadFile("/proc/loadavg"); err == nil {
		f := strings.Fields(string(b))
		if len(f) >= 3 {
			h.Load1, h.Load5, h.Load15 = atof(f[0]), atof(f[1]), atof(f[2])
		}
	}
	h.LogicalCPUCount = countLogicalCPUs()
	if h.LogicalCPUCount < 1 {
		h.LogicalCPUCount = 1
	}

	if mi, err := readMemInfo(); err == nil {
		h.MemTotalBytes = mi.total
		h.MemAvailBytes = mi.avail
		if h.MemTotalBytes > h.MemAvailBytes {
			h.MemUsedBytes = h.MemTotalBytes - h.MemAvailBytes
		}
	}
	if m, err := readMounts(); err == nil {
		h.Disks = m
	}
	h.TailscaleIPs, h.LANIPs = readIPs()
	return h, nil
}

// readIPs enumerates interface addresses and classifies them. The Tailscale
// CGNAT range 100.64.0.0/10 identifies tailnet addresses; everything else on a
// physical interface is treated as LAN.
func readIPs() (tailscale, lan []string) {
	out, err := execFixedIP()
	if err != nil {
		return nil, nil
	}
	current := ""
	for _, raw := range out {
		line := strings.TrimSpace(raw)
		if line == "" {
			continue
		}
		// Lines like "2: eno1: <BROADCAST,...>"
		if idx := strings.Index(line, ":"); idx > 0 {
			if n := line[idx+1:]; !strings.HasPrefix(n, " ") {
				fields := strings.SplitN(n, ":", 2)
				if len(fields) == 2 {
					current = strings.TrimSpace(fields[0])
					continue
				}
			}
		}
		if !strings.HasPrefix(line, "inet ") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		addr := fields[1]
		if current == "lo" {
			continue
		}
		if strings.HasPrefix(addr, "100.") && isTailnet(addr) {
			tailscale = append(tailscale, addr)
		} else if !strings.Contains(addr, ":") {
			lan = append(lan, addr)
		}
	}
	return tailscale, lan
}

func isTailnet(addr string) bool {
	parts := strings.Split(addr, ".")
	if len(parts) != 4 {
		return false
	}
	a, _ := strconv.Atoi(parts[0])
	b, _ := strconv.Atoi(parts[1])
	return a == 100 && b >= 64 && b <= 127
}

// execFixedIP runs `ip -j -o addr` with a fixed argv. No shell, no user input.
func execFixedIP() ([]string, error) {
	cmd := exec.Command("/usr/sbin/ip", "-o", "addr")
	b, err := cmd.Output()
	if err != nil {
		// Some minimal images ship ip at /bin/ip.
		cmd = exec.Command("/bin/ip", "-o", "addr")
		b, err = cmd.Output()
		if err != nil {
			return nil, err
		}
	}
	return strings.Split(string(b), "\n"), nil
}

type memInfo struct{ total, avail uint64 }

func readMemInfo() (memInfo, error) {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return memInfo{}, err
	}
	defer f.Close()
	var mi memInfo
	s := bufio.NewScanner(f)
	for s.Scan() {
		parts := strings.Fields(s.Text())
		if len(parts) < 2 {
			continue
		}
		kb := uint64(atof(parts[1]))
		switch parts[0] {
		case "MemTotal:":
			mi.total = kb * 1024
		case "MemAvailable:":
			mi.avail = kb * 1024
		}
	}
	return mi, s.Err()
}

// skipFS lists pseudo and container filesystems. Only real storage is reported,
// so the console never shows an overlay mount as a disk.
var skipFS = map[string]bool{
	"proc": true, "sysfs": true, "devtmpfs": true, "devpts": true, "tmpfs": true,
	"cgroup": true, "cgroup2": true, "efivarfs": true, "securityfs": true,
	"debugfs": true, "tracefs": true, "pstore": true, "bpf": true, "configfs": true,
	"fusectl": true, "hugetlbfs": true, "mqueue": true, "autofs": true,
	"binfmt_misc": true, "overlay": true, "squashfs": true, "ramfs": true,
	"nsfs": true, "rpc_pipefs": true, "fuse.gvfsd-fuse": true,
}

func readMounts() ([]ipc.Mount, error) {
	f, err := os.Open("/proc/mounts")
	if err != nil {
		return nil, err
	}
	defer f.Close()

	seen := map[string]bool{}
	var out []ipc.Mount
	s := bufio.NewScanner(f)
	for s.Scan() {
		parts := strings.Fields(s.Text())
		if len(parts) < 3 {
			continue
		}
		mp := unescapeMount(parts[1])
		fstype := parts[2]
		if skipFS[fstype] || seen[mp] {
			continue
		}
		seen[mp] = true
		var st syscall.Statfs_t
		if err := syscall.Statfs(mp, &st); err != nil {
			continue
		}
		bs := uint64(st.Bsize)
		total := st.Blocks * bs
		avail := st.Bavail * bs
		used := (st.Blocks - st.Bfree) * bs
		if total == 0 {
			continue
		}
		out = append(out, ipc.Mount{
			MountPoint:  mp,
			Fstype:      fstype,
			TotalBytes:  total,
			UsedBytes:   used,
			AvailBytes:  avail,
			UsedPercent: float64(used) / float64(total) * 100,
		})
	}
	return out, s.Err()
}

// unescapeMount decodes the octal escapes the kernel uses for spaces (\040).
func unescapeMount(s string) string {
	if !strings.Contains(s, `\`) {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+3 < len(s) {
			if v, err := strconv.ParseUint(s[i+1:i+4], 8, 8); err == nil {
				b.WriteByte(byte(v))
				i += 3
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

// countLogicalCPUs counts LOGICAL processors, which is what /proc/cpuinfo
// enumerates. Physical core count is deliberately NOT reported: reading it
// reliably requires topology (e.g. thread_siblings_list or core_id) that is not
// uniformly available, and inferring it from the logical count would be wrong
// on any host with SMT.
func countLogicalCPUs() int {
	f, err := os.Open("/proc/cpuinfo")
	if err != nil {
		return 0
	}
	defer f.Close()
	n := 0
	s := bufio.NewScanner(f)
	for s.Scan() {
		if strings.HasPrefix(s.Text(), "processor") {
			n++
		}
	}
	return n
}

func atof(s string) float64 {
	v, _ := strconv.ParseFloat(strings.TrimSpace(s), 64)
	return v
}

func charsToString(c []int8) string {
	b := make([]byte, 0, len(c))
	for _, v := range c {
		if v == 0 {
			break
		}
		b = append(b, byte(v))
	}
	return string(b)
}

var _ = json.Marshal
