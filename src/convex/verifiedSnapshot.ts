// VERIFIED OPERATOR SNAPSHOT — read-only observations taken 2026-09-27 through
// the approved SSH aliases (ooflowdesk-remote = SERVER-01, gman-remote =
// SERVER-02). No value here is invented; every field was read from the host.
//
// This is a snapshot, not live telemetry. There are no agents in V0.1.

export const VERIFIED_SNAPSHOT = {
  takenAt: 1790528792 * 1000, // 2026-09-27T17:06:32Z / 17:08:47Z
  servers: [
    {
      publicId: "srv_7f3a91c2e8",
      displayName: "SERVER-01",
      hostname: "gman",
      lifecycleState: "ACTIVE",
      environment: "production",
      region: "LAN 192.168.1.190 · rack unit",
      tailscaleName: "ooflowdesk.tail0ab69b.ts.net",
      os: { name: "Debian GNU/Linux 13 (trixie)", kernel: "7.1.8+deb13-amd64", arch: "x86_64" },
      // observed
      cores: 4,
      memoryGb: 11.6, // 12144076 kB
      diskGb: 238.3, // / total
      diskUsedGb: 67.1,
      cpuLoad: 3.14,
      memUsedPct: 53.3, // (12144076-5671592)/12144076
      observedUptimeSeconds: 375865,
      docker: {
        version: "29.8.0",
        running: 42,
        total: 47,
        stopped: 4,
        unhealthy: 3,
        healthy: false, // 3 containers report unhealthy
        composeVersion: "5.5.1",
        daemonActive: true,
        rootDir: "/var/lib/docker",
        images: 94,
      },
      agentStatus: "not_enrolled",
      // agent and identity are intentionally ABSENT: no agent, no mTLS cert.
      // The UI must render "Not enrolled" / "Not issued" rather than zeros.
    },
    {
      publicId: "srv_2b6e40af15",
      displayName: "SERVER-02",
      hostname: "gman-02",
      lifecycleState: "ACTIVE",
      environment: "production",
      region: "LAN 192.168.1.200 · control plane",
      tailscaleName: "gman-02.tail0ab69b.ts.net",
      os: { name: "Debian GNU/Linux 13 (trixie)", kernel: "6.12.107+deb13-amd64", arch: "x86_64" },
      cores: 4,
      memoryGb: 15.5, // 16292096 kB
      diskGb: 3918.99, // 3918994300928 bytes
      diskUsedGb: 6.7,
      cpuLoad: 0.07,
      memUsedPct: 11.8, // (16292096-14367164)/16292096
      observedUptimeSeconds: 119012,
      docker: {
        version: "29.8.1",
        running: 8,
        total: 8,
        stopped: 0,
        unhealthy: 0,
        healthy: true,
        composeVersion: "5.5.1",
        daemonActive: true,
        rootDir: "/opt/schoolcore/docker",
        images: 10,
      },
      agentStatus: "not_enrolled",
    },
  ],
} as const;

/**
 * Real container inventory, as reported by Docker itself.
 *
 * `healthcheck` is taken from Docker's own status string. Where Docker reports
 * no HEALTHCHECK the row is stored with `healthcheckPresent: false` and
 * `health` omitted, so the UI shows "No health check" rather than a guess.
 *
 * SERVER-01 is a shared production host with 47 containers; the full list is
 * retained. SERVER-02 has 8.
 */
export const VERIFIED_CONTAINERS: {
  serverPublicId: string;
  name: string;
  image: string;
  state: string;
  healthcheckPresent: boolean;
  health?: string;
  dockerStatus: string;
  ports: string[];
}[] = [
  // ---------------- SERVER-01 (gman) : 47 total ----------------
  { serverPublicId: "srv_7f3a91c2e8", name: "church-platform-api-1", image: "church-platform-app:def3a24a", state: "running", healthcheckPresent: true, health: "healthy", dockerStatus: "Up 4 days (healthy)", ports: [] },
  { serverPublicId: "srv_7f3a91c2e8", name: "church-platform-member-web-1", image: "church-platform-app:def3a24a", state: "running", healthcheckPresent: true, health: "healthy", dockerStatus: "Up 4 days (healthy)", ports: [] },
  { serverPublicId: "srv_7f3a91c2e8", name: "church-platform-admin-web-1", image: "church-platform-app:def3a24a", state: "running", healthcheckPresent: true, health: "healthy", dockerStatus: "Up 4 days (healthy)", ports: [] },
  { serverPublicId: "srv_7f3a91c2e8", name: "church-platform-postgres-1", image: "postgres:18.4-bookworm", state: "running", healthcheckPresent: true, health: "healthy", dockerStatus: "Up 4 days (healthy)", ports: ["5432/tcp"] },
  { serverPublicId: "srv_7f3a91c2e8", name: "neolife-web", image: "neolife-web:b371fcf", state: "running", healthcheckPresent: true, health: "healthy", dockerStatus: "Up 4 days (healthy)", ports: ["3000/tcp"] },
  { serverPublicId: "srv_7f3a91c2e8", name: "neolife-postgres", image: "postgres:16-alpine", state: "running", healthcheckPresent: true, health: "healthy", dockerStatus: "Up 4 days (healthy)", ports: ["5432/tcp"] },
  { serverPublicId: "srv_7f3a91c2e8", name: "neolife-tunnel", image: "cloudflare/cloudflared:2026.7.3", state: "running", healthcheckPresent: false, dockerStatus: "Up 4 days", ports: [] },
  { serverPublicId: "srv_7f3a91c2e8", name: "ooflowdesk-api", image: "ooflowdesk-api:113f5124", state: "running", healthcheckPresent: true, health: "healthy", dockerStatus: "Up 4 days (healthy)", ports: ["3100/tcp"] },
  { serverPublicId: "srv_7f3a91c2e8", name: "ooflowdesk-web", image: "ooflowdesk-web:bOpty0Ft4", state: "running", healthcheckPresent: true, health: "healthy", dockerStatus: "Up 4 days (healthy)", ports: ["3000/tcp"] },
  { serverPublicId: "srv_7f3a91c2e8", name: "zongfitness-web", image: "zongfitness-web:v3", state: "running", healthcheckPresent: false, dockerStatus: "Up 4 days", ports: ["3000/tcp"] },
  { serverPublicId: "srv_7f3a91c2e8", name: "ooflowdesk-gateway", image: "caddy:2-alpine", state: "running", healthcheckPresent: true, health: "healthy", dockerStatus: "Up 4 days (healthy)", ports: ["80/tcp", "443/tcp", "2019/tcp", "443/udp", "127.0.0.1:3000->3000/tcp"] },
  { serverPublicId: "srv_7f3a91c2e8", name: "zongfitness-web-rollback-v3-broken", image: "524411d7e429", state: "exited", healthcheckPresent: false, dockerStatus: "Exited (1) 3 weeks ago", ports: [] },
  { serverPublicId: "srv_7f3a91c2e8", name: "ghub-production-api-1", image: "ghub-production-runtime:b33b608", state: "running", healthcheckPresent: true, health: "healthy", dockerStatus: "Up 4 days (healthy)", ports: ["4000/tcp"] },
  { serverPublicId: "srv_7f3a91c2e8", name: "ghub-production-web-1", image: "ghub-production-runtime:b33b608", state: "running", healthcheckPresent: true, health: "healthy", dockerStatus: "Up 4 days (healthy)", ports: ["3000/tcp"] },
  { serverPublicId: "srv_7f3a91c2e8", name: "zongfitness-fitness-db", image: "postgres:16-bookworm", state: "running", healthcheckPresent: true, health: "healthy", dockerStatus: "Up 4 days (healthy)", ports: ["5432/tcp"] },
  { serverPublicId: "srv_7f3a91c2e8", name: "zongfitness-fitness-dev", image: "zongfitness-fitness-dev:latest", state: "running", healthcheckPresent: true, health: "healthy", dockerStatus: "Up 4 days (healthy)", ports: ["3000/tcp"] },
  { serverPublicId: "srv_7f3a91c2e8", name: "zongfitness-fitness-tunnel", image: "cloudflare/cloudflared:2026.7.3", state: "running", healthcheckPresent: false, dockerStatus: "Up 4 days", ports: [] },
  { serverPublicId: "srv_7f3a91c2e8", name: "church-platform-tunnel", image: "cloudflare/cloudflared:2026.7.3", state: "running", healthcheckPresent: false, dockerStatus: "Up 4 days", ports: [] },
  { serverPublicId: "srv_7f3a91c2e8", name: "zongfitness-tunnel", image: "cloudflare/cloudflared:2026.7.3", state: "running", healthcheckPresent: false, dockerStatus: "Up 4 days", ports: [] },
  { serverPublicId: "srv_7f3a91c2e8", name: "zongfitness-web-1", image: "zongfitness-landing:latest", state: "restarting", healthcheckPresent: false, dockerStatus: "Restarting (1)", ports: [] },
  { serverPublicId: "srv_7f3a91c2e8", name: "zongfitness-app-1", image: "caddy:2-alpine", state: "created", healthcheckPresent: false, dockerStatus: "Created", ports: [] },
  { serverPublicId: "srv_7f3a91c2e8", name: "church-platform-gateway-1", image: "caddy:2-alpine", state: "running", healthcheckPresent: false, dockerStatus: "Up 4 days", ports: ["443/tcp", "2019/tcp", "443/udp", "127.0.0.1:3403->80/tcp"] },
  { serverPublicId: "srv_7f3a91c2e8", name: "church-platform-valkey-1", image: "valkey/valkey:8.1.9-alpine", state: "running", healthcheckPresent: true, health: "healthy", dockerStatus: "Up 4 days (healthy)", ports: ["6379/tcp"] },
  { serverPublicId: "srv_7f3a91c2e8", name: "ooflowdesk-web-rollback-ocFG", image: "ooflowdesk-web:ocFGHu8VQK", state: "exited", healthcheckPresent: false, dockerStatus: "Exited (143) 4 weeks ago", ports: [] },
  { serverPublicId: "srv_7f3a91c2e8", name: "kenya-web-candidate", image: "ooflowdesk-web:ocFGHu8VQK", state: "exited", healthcheckPresent: false, dockerStatus: "Exited (255) 5 months ago", ports: ["127.0.0.1:3999->3000/tcp"] },
  { serverPublicId: "srv_7f3a91c2e8", name: "ooflowdesk-api-rollback-6e5a877", image: "ooflowdesk-api:6e5a877-v2", state: "exited", healthcheckPresent: false, dockerStatus: "Exited (0) 4 weeks ago", ports: [] },
  { serverPublicId: "srv_7f3a91c2e8", name: "ooflowdesk-manual-gateway", image: "caddy:2-alpine", state: "running", healthcheckPresent: true, health: "healthy", dockerStatus: "Up 4 days (healthy)", ports: ["80/tcp", "443/tcp", "2019/tcp", "443/udp", "127.0.0.1:3010->3010/tcp"] },
  { serverPublicId: "srv_7f3a91c2e8", name: "ooflowdesk-manual-web", image: "ooflowdesk-node-dev:24", state: "running", healthcheckPresent: true, health: "healthy", dockerStatus: "Up 4 days (healthy)", ports: [] },
  { serverPublicId: "srv_7f3a91c2e8", name: "ooflowdesk-manual-api", image: "ooflowdesk-node-dev:24", state: "running", healthcheckPresent: true, health: "starting", dockerStatus: "Up 1 second (health: starting)", ports: ["127.0.0.1:3110->3100/tcp"] },
  { serverPublicId: "srv_7f3a91c2e8", name: "ooflowdesk-manual-postgres", image: "postgres:18.4-bookworm", state: "running", healthcheckPresent: true, health: "healthy", dockerStatus: "Up 4 days (healthy)", ports: ["5432/tcp"] },
  { serverPublicId: "srv_7f3a91c2e8", name: "ooflowdesk-manual-valkey", image: "valkey/valkey:8.1.9-alpine", state: "running", healthcheckPresent: true, health: "healthy", dockerStatus: "Up 4 days (healthy)", ports: ["6379/tcp"] },
  { serverPublicId: "srv_7f3a91c2e8", name: "ooflowdesk-development-web", image: "ooflowdesk-web:dev-149fa4f", state: "running", healthcheckPresent: true, health: "healthy", dockerStatus: "Up 4 days (healthy)", ports: ["3000/tcp"] },
  { serverPublicId: "srv_7f3a91c2e8", name: "ooflowdesk-api-dev", image: "ooflowdesk-node-dev:24", state: "restarting", healthcheckPresent: false, dockerStatus: "Restarting (2)", ports: [] },
  { serverPublicId: "srv_7f3a91c2e8", name: "ghub-production-app-1", image: "caddy:2-alpine", state: "running", healthcheckPresent: true, health: "healthy", dockerStatus: "Up 4 days (healthy)", ports: ["80/tcp", "443/tcp", "2019/tcp", "443/udp", "127.0.0.1:3300->3200/tcp"] },
  { serverPublicId: "srv_7f3a91c2e8", name: "ghub-prelaunch-tunnel", image: "cloudflare/cloudflared:latest", state: "running", healthcheckPresent: false, dockerStatus: "Up 4 days", ports: [] },
  { serverPublicId: "srv_7f3a91c2e8", name: "ghub-prelaunch-app", image: "ghub-prelaunch:local", state: "running", healthcheckPresent: true, health: "healthy", dockerStatus: "Up 4 days (healthy)", ports: ["127.0.0.1:3200->3200/tcp"] },
  { serverPublicId: "srv_7f3a91c2e8", name: "ooflowdesk-cloudflared", image: "41320ce229c5", state: "running", healthcheckPresent: false, dockerStatus: "Up 4 days", ports: [] },
  { serverPublicId: "srv_7f3a91c2e8", name: "ooflowdesk-development-gateway", image: "caddy:2-alpine", state: "running", healthcheckPresent: true, health: "healthy", dockerStatus: "Up 4 days (healthy)", ports: ["80/tcp", "443/tcp", "2019/tcp", "443/udp", "127.0.0.1:3002->3002/tcp"] },
  { serverPublicId: "srv_7f3a91c2e8", name: "ooflowdesk-postgres-dev", image: "postgres:18.4-bookworm", state: "running", healthcheckPresent: true, health: "healthy", dockerStatus: "Up 4 days (healthy)", ports: ["5432/tcp"] },
  { serverPublicId: "srv_7f3a91c2e8", name: "ooflowdesk-clamav-dev", image: "clamav/clamav:1.4.5", state: "running", healthcheckPresent: true, health: "healthy", dockerStatus: "Up 4 days (healthy)", ports: ["3310/tcp", "7357/tcp"] },
  { serverPublicId: "srv_7f3a91c2e8", name: "ooflowdesk-valkey-dev", image: "valkey/valkey:8.1.9-alpine", state: "running", healthcheckPresent: true, health: "healthy", dockerStatus: "Up 4 days (healthy)", ports: ["6379/tcp"] },
  { serverPublicId: "srv_7f3a91c2e8", name: "ooflowdesk-valkey", image: "valkey/valkey:8.1.9-alpine", state: "running", healthcheckPresent: true, health: "healthy", dockerStatus: "Up 4 days (healthy)", ports: ["6379/tcp"] },
  { serverPublicId: "srv_7f3a91c2e8", name: "ooflowdesk-clamav", image: "clamav/clamav:1.4.5", state: "running", healthcheckPresent: true, health: "healthy", dockerStatus: "Up 4 days (healthy)", ports: ["127.0.0.1:3310->3310/tcp", "7357/tcp"] },
  { serverPublicId: "srv_7f3a91c2e8", name: "ooflowdesk-postgres", image: "postgres:18.4-bookworm", state: "running", healthcheckPresent: true, health: "healthy", dockerStatus: "Up 4 days (healthy)", ports: ["5432/tcp"] },
  { serverPublicId: "srv_7f3a91c2e8", name: "ooflowdesk-staging-gateway", image: "caddy:2-alpine", state: "running", healthcheckPresent: true, health: "healthy", dockerStatus: "Up 4 days (healthy)", ports: ["80/tcp", "443/tcp", "2019/tcp", "443/udp", "127.0.0.1:3001->3001/tcp"] },
  { serverPublicId: "srv_7f3a91c2e8", name: "ooflowdesk-staging-web", image: "nginx:alpine", state: "running", healthcheckPresent: false, dockerStatus: "Up 4 days", ports: ["80/tcp"] },
  { serverPublicId: "srv_7f3a91c2e8", name: "filebrowser", image: "filebrowser/filebrowser:latest", state: "running", healthcheckPresent: true, health: "healthy", dockerStatus: "Up 4 days (healthy)", ports: ["0.0.0.0:8080->80/tcp", "[::]:8080->80/tcp"] },

  // ---------------- SERVER-02 (gman-02) : 8 total ----------------
  { serverPublicId: "srv_2b6e40af15", name: "convex-backend", image: "ghcr.io/get-convex/convex-backend:latest", state: "running", healthcheckPresent: true, health: "healthy", dockerStatus: "Up 8 hours (healthy)", ports: ["127.0.0.1:3210-3211->3210-3211/tcp"] },
  { serverPublicId: "srv_2b6e40af15", name: "convex-dashboard", image: "ghcr.io/get-convex/convex-dashboard:latest", state: "running", healthcheckPresent: false, dockerStatus: "Up 8 hours", ports: ["127.0.0.1:6791->6791/tcp"] },
  { serverPublicId: "srv_2b6e40af15", name: "smc-caddy", image: "caddy:2-alpine", state: "running", healthcheckPresent: false, dockerStatus: "Up 29 minutes", ports: ["80/tcp", "100.80.65.109:443->443/tcp", "2019/tcp", "443/udp", "100.80.65.109:8443-8445->8443-8445/tcp"] },
  { serverPublicId: "srv_2b6e40af15", name: "schoolcore-convex-backend", image: "ghcr.io/get-convex/convex-backend", state: "running", healthcheckPresent: true, health: "healthy", dockerStatus: "Up 26 minutes (healthy)", ports: ["3210-3211/tcp"] },
  { serverPublicId: "srv_2b6e40af15", name: "schoolcore-convex-dashboard", image: "ghcr.io/get-convex/convex-dashboard", state: "running", healthcheckPresent: false, dockerStatus: "Up 26 minutes", ports: ["6791/tcp"] },
  { serverPublicId: "srv_2b6e40af15", name: "schoolcore-postgres", image: "postgres:17-alpine", state: "running", healthcheckPresent: true, health: "healthy", dockerStatus: "Up 27 minutes (healthy)", ports: ["5432/tcp"] },
  { serverPublicId: "srv_2b6e40af15", name: "schoolcore-frontend", image: "schoolcore-frontend:df14e98", state: "running", healthcheckPresent: true, health: "healthy", dockerStatus: "Up About an hour (healthy)", ports: ["80/tcp"] },
  { serverPublicId: "srv_2b6e40af15", name: "schoolcore-cloudflared", image: "cloudflare/cloudflared:2026.9.3", state: "running", healthcheckPresent: false, dockerStatus: "Up 4 hours", ports: [] },
];
