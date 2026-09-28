package agentid

import (
	"crypto/x509"
	"encoding/pem"
	"net/url"
	"testing"
)

// The gateway authorises on the certificate URI SAN. A SPIFFE id whose trust
// domain is the authority component parses as Scheme "spiffe", Host "smc",
// Path "/<id>" â€” an earlier build wrongly expected Scheme "smc", which would
// have refused every correctly issued certificate.
func TestServerIDFromCert(t *testing.T) {
	cases := []struct {
		name string
		uri  string
		want string
		ok   bool
	}{
		{"spiffe authority domain", "spiffe://smc/srv_2b6e40af15", "srv_2b6e40af15", true},
		{"wrong authority domain", "spiffe://other/srv_1", "", false},
		{"wrong scheme", "https://smc/srv_1", "", false},
		{"empty path", "spiffe://smc/", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			u, err := url.Parse(tc.uri)
			if err != nil {
				t.Fatalf("parse: %v", err)
			}
			cert := &x509.Certificate{URIs: []*url.URL{u}}
			got, ok := ServerIDFromCert(cert)
			if ok != tc.ok || got != tc.want {
				t.Fatalf("ServerIDFromCert = (%q,%v), want (%q,%v)", got, ok, tc.want, tc.ok)
			}
		})
	}
}

func TestServerIDFromCertNoSAN(t *testing.T) {
	if _, ok := ServerIDFromCert(&x509.Certificate{}); ok {
		t.Fatal("a certificate with no SAN must not yield an identity")
	}
}

// The CSR must carry the identity in a URI SAN, because that is the only thing
// the gateway trusts. CommonName is informational and must not be relied on.
func TestCSRCarriesURISAN(t *testing.T) {
	key, err := GenerateKey()
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	pemDER, err := CSR(key, "srv_7f3a91c2e8", "0.1.0")
	if err != nil {
		t.Fatalf("csr: %v", err)
	}
	block := decodePEM(t, pemDER)
	csr, err := x509.ParseCertificateRequest(block)
	if err != nil {
		t.Fatalf("parse csr: %v", err)
	}
	if err := csr.CheckSignature(); err != nil {
		t.Fatalf("csr signature: %v", err)
	}
	if len(csr.URIs) != 1 {
		t.Fatalf("expected 1 URI SAN, got %d", len(csr.URIs))
	}
	if csr.URIs[0].String() != "spiffe://smc/srv_7f3a91c2e8" {
		t.Fatalf("URI SAN = %q", csr.URIs[0].String())
	}
}

func decodePEM(t *testing.T, b []byte) []byte {
	t.Helper()
	block, _ := pem.Decode(b)
	if block == nil {
		t.Fatal("not PEM")
	}
	return block.Bytes
}
