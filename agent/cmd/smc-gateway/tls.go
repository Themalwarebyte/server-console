package main

import (
	"crypto/tls"
	"crypto/x509"
	"log"
)

// x509Pool parses the agent CA bundle. An empty or unusable bundle is fatal:
// the gateway must never run without a way to verify agent certificates.
func x509Pool(pemBytes []byte) *x509.CertPool {
	p := x509.NewCertPool()
	if !p.AppendCertsFromPEM(pemBytes) {
		log.Fatal("agent CA bundle contains no usable certificates")
	}
	return p
}

// serverTLS requires a client certificate on every connection and verifies it
// against the agent CA. The certificate's URI SAN is the agent's identity;
// hostname is never an identity, and verification is never skipped.
func serverTLS(cert tls.Certificate, pool *x509.CertPool) *tls.Config {
	return &tls.Config{
		Certificates: []tls.Certificate{cert},
		ClientCAs:    pool,
		ClientAuth:   tls.RequireAndVerifyClientCert,
		MinVersion:   tls.VersionTLS13,
	}
}
