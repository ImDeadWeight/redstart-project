// SPDX-License-Identifier: AGPL-3.0-only

// Package duckdns registers the Caddy DNS provider module
// dns.providers.duckdns for the Caddy that Redstart Nest bundles.
//
// It exists because the community plugin of the same name publishes no
// license, so it cannot be redistributed inside a binary. This module is
// Redstart's own: a thin Caddy wrapper over github.com/libdns/duckdns (MIT),
// which does all of the actual DNS work.
//
// The configuration is the libdns provider's own JSON fields, unchanged:
//
//	{ "name": "duckdns", "api_token": "{env.REDSTART_DNS_TOKEN}",
//	  "override_domain": "", "resolver": "" }
//
// Nest always passes the token as an {env.NAME} placeholder (caddy-config.mjs
// refuses a literal), so Provision resolves placeholders before use.
package duckdns

import (
	"errors"
	"strings"

	"github.com/caddyserver/caddy/v2"
	libdnsduckdns "github.com/libdns/duckdns"
	"github.com/libdns/libdns"
)

// ModuleID is the Caddy module this package registers.
const ModuleID = "dns.providers.duckdns"

// Provider is the Caddy module. It embeds the libdns provider, so the
// provider's JSON fields are the module's configuration and its record
// methods are what Caddy's DNS-01 solver calls.
type Provider struct {
	*libdnsduckdns.Provider
}

func init() {
	caddy.RegisterModule(Provider{})
}

// CaddyModule returns the Caddy module information.
func (Provider) CaddyModule() caddy.ModuleInfo {
	return caddy.ModuleInfo{
		ID:  ModuleID,
		New: func() caddy.Module { return &Provider{Provider: new(libdnsduckdns.Provider)} },
	}
}

// ErrNoToken is returned by Provision when the token is empty after
// placeholder replacement (an unset environment variable, usually).
var ErrNoToken = errors.New(ModuleID + ": api_token is empty (is its environment variable set?)")

// Provision replaces placeholders in every field and refuses an empty token,
// so a missing secret fails at startup rather than at the first renewal.
func (p *Provider) Provision(caddy.Context) error {
	repl := caddy.NewReplacer()
	p.APIToken = repl.ReplaceAll(p.APIToken, "")
	p.OverrideDomain = repl.ReplaceAll(p.OverrideDomain, "")
	p.Resolver = repl.ReplaceAll(p.Resolver, "")
	if strings.TrimSpace(p.APIToken) == "" {
		return ErrNoToken
	}
	return nil
}

// Interface guards: what Caddy loads, and what the DNS-01 solver needs.
var (
	_ caddy.Module          = (*Provider)(nil)
	_ caddy.Provisioner     = (*Provider)(nil)
	_ libdns.RecordAppender = (*Provider)(nil)
	_ libdns.RecordDeleter  = (*Provider)(nil)
	_ libdns.RecordGetter   = (*Provider)(nil)
)
