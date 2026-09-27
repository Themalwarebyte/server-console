// Package agentid implements local key generation and CSR creation.
//
// The private key is generated ON THE MANAGED HOST and never leaves it. Only the
// CSR travels. The certificate identity is the immutable serverPublicId carried
// in a URI SAN, so authorisation never depends on hostname or CN.
package agentid

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/pem"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
)

// SPFFEPrefix is the URI SAN scheme. serverPublicId is the full SPIFFE ID.
const SPFFEPrefix = "spiffe://smc/"

// GenerateKey creates the host's ECDSA P-256 private key locally.
func GenerateKey() (*ecdsa.PrivateKey, error) {
	return ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
}

// SaveKey writes a private key with 0600 permissions in a 0700 directory.
func SaveKey(path string, k *ecdsa.PrivateKey) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	der, err := x509.MarshalECPrivateKey(k)
	if err != nil {
		return err
	}
	return os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: der}), 0o600)
}

// LoadKey reads a locally generated private key.
func LoadKey(path string) (*ecdsa.PrivateKey, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	block, _ := pem.Decode(b)
	if block == nil {
		return nil, fmt.Errorf("%s is not PEM", path)
	}
	return x509.ParseECPrivateKey(block.Bytes)
}

// CSR creates a certificate signing request whose only identity is the
// serverPublicId in a URI SAN. The CommonName is informational and is never used
// for authorisation.
func CSR(k *ecdsa.PrivateKey, serverPublicId, agentVersion string) ([]byte, error) {
	uri, err := url.Parse(SPFFEPrefix + serverPublicId)
	if err != nil {
		return nil, err
	}
	tmpl := &x509.CertificateRequest{
		Subject:            pkix.Name{CommonName: serverPublicId, Organization: []string{"Server Management Console"}},
		URIs:               []*url.URL{uri},
		SignatureAlgorithm: x509.ECDSAWithSHA256,
	}
	der, err := x509.CreateCertificateRequest(rand.Reader, tmpl, k)
	if err != nil {
		return nil, err
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: der}), nil
}

// Fingerprint is the lowercase hex SHA-256 of a DER certificate, used as the
// operator-visible and gateway-recorded identity of an agent certificate.
func Fingerprint(der []byte) string {
	sum := sha256.Sum256(der)
	return hex.EncodeToString(sum[:])
}

// ServerIDFromCert extracts the serverPublicId from the URI SAN. This is the
// authoritative identity: it comes from the verified certificate, never from a
// payload field.
func ServerIDFromCert(cert *x509.Certificate) (string, bool) {
	for _, u := range cert.URIs {
		if u != nil && u.Scheme == "smc" && u.Host == "" && u.Path != "" {
			return u.Path, true
		}
	}
	return "", false
}
