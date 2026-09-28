# Server Management Console — agent gateway
#
# Static binary on a minimal base. The image contains no shell, no Docker
# client, no Docker socket and no package manager. It cannot execute anything
# on the host: the only thing it can do is terminate mTLS and forward
# telemetry to the narrow Convex ingest endpoint.
FROM alpine:3.20

# Root trust store plus the Caddy internal CA, so the gateway can verify the
# control plane's TLS certificate on the ingest call. Verification is never
# disabled; the CA is added rather than bypassed.
RUN apk add --no-cache ca-certificates

COPY caddy-root.crt /usr/local/share/ca-certificates/caddy-root.crt
RUN cat /usr/local/share/ca-certificates/caddy-root.crt \
      >> /etc/ssl/certs/ca-certificates.crt \
    && rm -f /usr/local/share/ca-certificates/caddy-root.crt

COPY smc-gateway /usr/local/bin/smc-gateway
RUN chmod 0555 /usr/local/bin/smc-gateway

# Unprivileged: the gateway has no need for root and is given none.
RUN addgroup -g 20001 smc && adduser -D -H -u 20001 -G smc -s /sbin/nologin smc
USER 20001:20001

ENTRYPOINT ["/usr/local/bin/smc-gateway"]
