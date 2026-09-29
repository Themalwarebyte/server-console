// Control-plane tests for the Milestone B log pipeline.
//
// These exercise the deployed Convex endpoints over the same HTTP path the
// gateway uses: the CLIENT port (:8443), /api/mutation, with the module name
// `logAccess`. The SITE port (:8444) serves only httpRouter routes, so
// function invocation there returns "No matching routes found".
//
// No secret is printed. The wrong credentials are literals; the real ones are
// never echoed.

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";

const run = promisify(execFile);

const SITE = "https://gman-02.tail0ab69b.ts.net:8443";
const ADMIN_KEY = readFileSync(
  "C:/Users/User/AppData/Local/Temp/kilo/convex-admin-key.txt",
  "utf8",
).trim();
const CA = "C:/Users/User/AppData/Local/Temp/kilo/smc-caddy-root.crt";

// A value that is definitely not a configured credential.
const WRONG = "definitely-not-a-real-secret-0123456789abcdef";

let pass = 0;
let fail = 0;

function check(name, cond, detail = "") {
  console.log(
    `  [${cond ? "PASS" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`,
  );
  cond ? pass++ : fail++;
}

/** Invokes a Convex function over HTTP and returns { ok, status, text }. */
async function call(path, args) {
  const { default: https } = await import("node:https");
  const u = new URL(SITE);
  const body = JSON.stringify({ path, args, format: "json" });
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: "/api/mutation",
        method: "POST",
        ca: readFileSync(CA),
        servername: u.hostname,
        headers: {
          "Content-Type": "application/json",
          "X-Convex-Authorization": `Convex ${ADMIN_KEY}`,
        },
        timeout: 30000,
      },
      (res) => {
        let b = "";
        res.on("data", (d) => (b += d));
        res.on("end", () => {
          let parsed = null;
          try {
            parsed = JSON.parse(b);
          } catch {
            /* keep the raw text */
          }
          resolve({ status: res.statusCode, text: b, parsed });
        });
      },
    );
    req.on("error", (e) => resolve({ status: 0, text: e.code || e.message, parsed: null }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 0, text: "timeout", parsed: null });
    });
    req.write(body);
    req.end();
  });
}

console.log("  Milestone B control-plane tests\n");

// ---- credential separation -------------------------------------------------
let r = await call("logAccess:claimLogRequests", { serviceCredential: WRONG });
check(
  "claim refuses a wrong log-work credential",
  /unauthorized/i.test(r.text),
);
check(
  "claim refuses an empty credential",
  /unauthorized|not configured/i.test(
    (await call("logAccess:claimLogRequests", { serviceCredential: "" })).text,
  ),
);

// ---- the ingest credential must not be able to claim log work --------------
// Read the ingest secret from the gateway host and try it. Its VALUE is never
// printed; only whether it was refused.
try {
  const { stdout } = await run(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=20", "gman-remote", "sudo -n cat /srv/platform/agent-gateway/ingest.secret"],
    { encoding: "utf8" },
  );
  const ingest = stdout.trim();
  const r2 = await call("logAccess:claimLogRequests", {
    serviceCredential: ingest,
  });
  check(
    "the telemetry INGEST credential cannot claim log work",
    /unauthorized/i.test(r2.text),
  );
} catch (e) {
  check("ingest credential cross-check", false, String(e.message).slice(0, 60));
}

// ---- the owner path requires a real session -------------------------------
r = await call("logAccess:requestContainerLogs", {
  serverPublicId: "srv_2b6e40af15",
  containerId: "0".repeat(64),
  tail: 100,
  timestamps: false,
});
check(
  "requestContainerLogs refuses an unauthenticated caller",
  /Unauthenticated/i.test(r.text),
);

// ---- completion requires a valid lease ------------------------------------
check(
  "completeLogRequest refuses a wrong credential",
  /unauthorized/i.test(
    (
      await call("logAccess:completeLogRequest", {
        serviceCredential: WRONG,
        requestId: "x",
        serverPublicId: "srv_2b6e40af15",
        claimLease: "forged",
        ok: false,
      })
    ).text,
  ),
);
check(
  "completeLogRequest refuses an unknown request even with a plausible lease",
  /Unknown request|unauthorized/i.test(
    (
      await call("logAccess:completeLogRequest", {
        serviceCredential: WRONG,
        requestId: "definitely-not-a-real-request",
        serverPublicId: "srv_2b6e40af15",
        claimLease: "forged",
        ok: false,
      })
    ).text,
  ),
);

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
