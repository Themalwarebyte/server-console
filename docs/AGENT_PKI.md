# Agent PKI

The agent channel uses a private CA on SERVER-02. **The CA private key is the
root of trust for every managed host and is never in Git, never in a VITE_
variable, and never leaves SERVER-02.**

Current CA (authoritative):

```
subject : O=Server Management Console, CN=SMC Agent CA
sha256  : A6:72:32:B8:5F:7B:AF:DF:0C:CB:94:9A:59:37:91:F1:72:52:17:CA:9F:B7:99:A8:9B:28:D5:87:6D:B0:2C:16
valid   : 10 years
path    : /srv/platform/agent-gateway/tls/ca.key   (0600 root:root)
```

The original CA's key was destroyed by an accidental `rm -rf` on
`/srv/platform/agent-gateway/tls` while fixing a permissions error. See
"CA incident" below.

## Identity model

A managed host is identified by its immutable `serverPublicId`, carried in a
**URI SAN**:

```
spiffe://smc/srv_2b6e40af15
```

The gateway authorises on the verified client certificate. It never trusts a
hostname, a CommonName, or a `serverPublicId` supplied inside a payload: the
gateway overwrites that field from the certificate before forwarding telemetry,
and a `Hello` that disagrees with the certificate is a hard rejection.

Certificates must carry `extendedKeyUsage = clientAuth` and be signed by this
CA. Revocation is recorded in the control plane
(`agentIngest.revokeCertificate`); because agents re-dial rather than holding a
session open, a revoked certificate is refused on the next connection.

## CA incident

**What happened.** While correcting a directory-permission problem during the
Milestone A deployment, a remediation command ran `rm -rf
/srv/platform/agent-gateway/tls`. That directory held `ca.key`, so the original
CA private key was destroyed. The command was careless, not necessary.

**Impact: none, and this is verifiable.**

- No agent certificate had been issued from that CA at the time
- No agent had been enrolled
- No agent identity was compromised, so **no revocation was required**
- The original CA fingerprint
  `46:AD:A1:46:7E:ED:D5:2D:CD:87:B6:57:4A:2C:5A:D6:54:FC:6B:17:F5:EC:FE:6A:E3:A7:79:A0:08:1C:D2:31`
  is absent from all active trust material, from both certificate chains, from
  the live configuration, and from the repository

**Recovery.** The CA was re-keyed and the gateway certificate re-issued. The
gateway's own private key was preserved and reused, because it is the server's
identity and was never exposed. Both the gateway certificate and the SERVER-02
agent certificate were re-verified to chain to the replacement CA.

**Verification after the incident**

```
openssl verify -CAfile agents-ca.crt tls/gateway.crt   -> OK
openssl verify -CAfile agents-ca.crt agent.crt        -> OK
old CA fingerprint in active trust material            -> absent
```

## Known gap

The CA private key exists in exactly one place, on one host. Losing SERVER-02
means losing the ability to issue agent certificates for the fleet.

**POST-V0.1:** encrypted off-host escrow of the CA key, or an offline root with
an online issuing CA. Until then, treat `/srv/platform/agent-gateway/tls/ca.key`
as the highest-value secret on SERVER-02 and keep the pre/post-deduplication
backups until V0.1 is stable.
