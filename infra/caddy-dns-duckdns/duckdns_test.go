// SPDX-License-Identifier: AGPL-3.0-only

package duckdns

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/caddyserver/caddy/v2"
)

// The module ID is the contract with caddy-config.mjs ({"name": "duckdns"}
// under dns.providers) and with caddy.yml's list-modules smoke.
func TestModuleID(t *testing.T) {
	info := Provider{}.CaddyModule()
	if string(info.ID) != "dns.providers.duckdns" {
		t.Fatalf("module ID %q", info.ID)
	}
	if _, ok := info.New().(*Provider); !ok {
		t.Fatalf("New() does not return *Provider")
	}
}

// Caddy decodes the JSON block into New()'s value: the embedded provider's
// fields must land on it.
func TestJSONFieldsReachTheLibdnsProvider(t *testing.T) {
	p := Provider{}.CaddyModule().New().(*Provider)
	raw := `{"api_token":"{env.REDSTART_TEST_DUCKDNS}","override_domain":"o.example","resolver":"1.1.1.1:53"}`
	if err := json.Unmarshal([]byte(raw), p); err != nil {
		t.Fatal(err)
	}
	if p.APIToken != "{env.REDSTART_TEST_DUCKDNS}" || p.OverrideDomain != "o.example" || p.Resolver != "1.1.1.1:53" {
		t.Fatalf("decoded token=%q override=%q resolver=%q", p.APIToken, p.OverrideDomain, p.Resolver)
	}
}

func TestProvisionResolvesTheEnvPlaceholder(t *testing.T) {
	t.Setenv("REDSTART_TEST_DUCKDNS", "tok-123")
	p := Provider{}.CaddyModule().New().(*Provider)
	p.APIToken = "{env.REDSTART_TEST_DUCKDNS}"
	if err := p.Provision(caddy.Context{}); err != nil {
		t.Fatal(err)
	}
	if p.APIToken != "tok-123" {
		t.Fatalf("token %q", p.APIToken)
	}
}

func TestProvisionRefusesAnEmptyToken(t *testing.T) {
	t.Setenv("REDSTART_TEST_DUCKDNS", "")
	p := Provider{}.CaddyModule().New().(*Provider)
	p.APIToken = "{env.REDSTART_TEST_DUCKDNS}"
	if err := p.Provision(caddy.Context{}); !errors.Is(err, ErrNoToken) {
		t.Fatalf("err %v, want ErrNoToken", err)
	}
}
