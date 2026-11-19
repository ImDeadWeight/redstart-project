'use strict'

// =============================================================================
// Redstart Nest — the bundled Caddy's configuration (TLS plan C3)
// =============================================================================
// A pure function: settings in, Caddy JSON out. No I/O, no clock, no secrets.
//
// JSON rather than a Caddyfile: built programmatically there is no quoting or
// escaping to get wrong, and it is Caddy's native format, so no adapter sits
// between what this returns and what Caddy runs. deploy/Caddyfile stays as the
// bring-your-own-proxy reference.
//
// What the config says, and the invariant behind each part (each one is a
// test in scripts/test-caddy-config.mjs):
//
//   :443, SNI and Host = <hostname> only
//       /.well-known/redstart-tls-health → Caddy's own 200 (the serving check)
//       /mcp, /mcp/*  → 127.0.0.1:<mcpPort>
//       everything    → 127.0.0.1:<gatewayPort>
//     Upstreams are LOOPBACK. The gateway binds loopback while Caddy fronts
//     it (C6), so a LAN upstream here would be a config that cannot work.
//     A TLS handshake for any other name has no connection policy and fails:
//     the box answers as its name and nothing else.
//   :80
//     httpsServing                 → 308 to https://<hostname>{uri}
//     not serving, fallback        → plain proxy, same routes, labelled by
//                                    the launcher and the chat UI (C8)
//     not serving, requireHttps    → a static 503 "HTTPS isn't working yet"
//     `httpsServing` is C5's SERVING verdict only (review R1): a renewal
//     warning or an unreachable public resolver must never downgrade this.
//   Every proxied request carries X-Redstart-Proxy: {env.REDSTART_PROXY_SECRET},
//     SET (so a client-sent copy is replaced), read from the environment.
//   Admin API disabled. Caddy's default is an unauthenticated config endpoint
//     on localhost:2019 that any local process could use to reroute traffic.
//   No secret in the output. Every credential field of the DNS provider block
//     must be an {env.NAME} placeholder; a literal is refused here, so the
//     config file Nest writes to disk can never hold one.
//   DNS-01 only: the HTTP and TLS-ALPN challenges are disabled, because the
//     name points at a private address no CA can reach.
//   :8443 (only when the admin panel is set to be reachable on the network):
//     the control plane, from 127.0.0.1:<adminPort>, same name and certificate,
//     same proxy secret. No :80 counterpart: admin is never plain HTTP here.
//   Listens on IPv4 only (tcp4/0.0.0.0), never IPv6: a machine's global IPv6
//     addresses are reachable from the internet unless the router blocks
//     them, and Nest must not depend on that (listenOn below).
//   HTTP/1.1 and HTTP/2 only. HTTP/3 would need a UDP firewall rule as well,
//     for no gain on a LAN.
// =============================================================================

export const PROXY_SECRET_ENV = 'REDSTART_PROXY_SECRET'

/** Where Caddy serves the control plane over HTTPS, when the admin panel is reachable on the network. */
export const ADMIN_HTTPS_PORT = 8443

/** Answered by Caddy itself on :443 (tls-health.mjs's serving check). */
export const TLS_HEALTH_PATH = '/.well-known/redstart-tls-health'
export const PROXY_HEADER = 'X-Redstart-Proxy'

export const ACME_PRODUCTION = 'https://acme-v02.api.letsencrypt.org/directory'
export const ACME_STAGING = 'https://acme-staging-v02.api.letsencrypt.org/directory'

/** Fields of a DNS provider block that hold a credential. */
const SECRET_FIELDS = /token|password|secret|key/i
const ENV_PLACEHOLDER = /^\{env\.[A-Z][A-Z0-9_]*\}$/

/** RFC 1123 hostname, at least two labels, lower case. */
const HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

const REQUIRE_HTTPS_PAGE = [
  '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">',
  '<title>Redstart Nest</title>',
  '<p style="font:16px system-ui;max-width:32em;margin:3em auto;padding:0 1em">',
  "HTTPS isn't working on this Nest yet, and it is set to refuse unencrypted connections.",
  ' Ask your admin to check the Network panel.</p>',
].join('')

function port(name, value) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`${name} must be a port number, got ${value}`)
  return value
}

/**
 * Check a DNS provider block and return a copy. Its `name` is the Caddy
 * module (dns.providers.<name>); every credential-looking field must be an
 * {env.NAME} placeholder.
 *
 * @param {Record<string, unknown>} provider
 */
export function checkDnsProvider(provider) {
  if (!provider || typeof provider !== 'object' || Array.isArray(provider)) throw new Error('dnsProvider must be an object')
  if (typeof provider.name !== 'string' || !/^[a-z0-9_]+$/.test(provider.name)) {
    throw new Error('dnsProvider.name must name a Caddy dns provider module')
  }
  for (const [field, value] of Object.entries(provider)) {
    if (field === 'name') continue
    if (typeof value !== 'string') throw new Error(`dnsProvider.${field} must be a string`)
    if (SECRET_FIELDS.test(field) && !ENV_PLACEHOLDER.test(value)) {
      throw new Error(`dnsProvider.${field} must be an {env.NAME} placeholder; a credential is never written into the config`)
    }
  }
  return { ...provider }
}

/**
 * IPv4 ONLY, bound explicitly. Two reasons, both found on real hardware
 * on 2026-11-19:
 *
 *  - NOT ON THE INTERNET. Most home connections now give every machine
 *    GLOBAL IPv6 addresses (this project's own test machine has seven),
 *    and those are reachable from anywhere unless the router's IPv6
 *    firewall blocks them, which Nest cannot see or rely on. Windows'
 *    "allow this app?" prompt also adds a rule for ANY remote address. An
 *    IPv6 listener therefore put the chat login page one router setting
 *    away from the open internet. LAN IPv4 sits behind the router's NAT,
 *    and nothing in Redstart ever asks a router to forward a port (no
 *    UPnP, no NAT-PMP). Nothing on the LAN needs IPv6: the names carry A
 *    records (private IPv4) only. Before HTTPS every LAN listener was
 *    already IPv4-only (0.0.0.0); this keeps Caddy the same.
 *  - NOT A SILENT SPLIT. A bare ':80' is one dual-stack IPv6 socket, and on
 *    Windows that bind succeeds even while another process holds
 *    0.0.0.0:80, so IPv4 clients reach that process and Caddy reports
 *    nothing (Nest's own port80-proxy, first real run). Binding tcp4
 *    explicitly makes that "Port 80 is in use".
 */
function listenOn(p) {
  return [`tcp4/0.0.0.0:${p}`]
}

function reverseProxy(upstreamPort) {
  return {
    handler: 'reverse_proxy',
    upstreams: [{ dial: `127.0.0.1:${upstreamPort}` }],
    // -1: flush every write at once, so an SSE token stream reaches the phone
    // as it is produced rather than in buffered chunks.
    flush_interval: -1,
    headers: { request: { set: { [PROXY_HEADER]: [`{env.${PROXY_SECRET_ENV}}`] } } },
  }
}

/**
 * Caddy's own answer on :443, before anything is proxied: "HTTPS works" must
 * not depend on whether a model happens to be loaded (the gateway only runs
 * while one is), so tls-health.mjs's serving check asks Caddy, not Nest.
 */
function healthRoute() {
  return {
    match: [{ path: [TLS_HEALTH_PATH] }],
    handle: [{ handler: 'static_response', status_code: 200, body: 'ok', headers: { 'Cache-Control': ['no-store'] } }],
    terminal: true,
  }
}

/** The same routes on :443 and on the :80 fallback. */
function appRoutes({ mcpPort, gatewayPort }) {
  return [
    { match: [{ path: ['/mcp', '/mcp/*'] }], handle: [reverseProxy(mcpPort)], terminal: true },
    { handle: [reverseProxy(gatewayPort)], terminal: true },
  ]
}

/**
 * @param {{
 *   hostname: string,
 *   dnsProvider: Record<string, string>,
 *   gatewayPort: number,
 *   mcpPort: number,
 *   httpsServing: boolean,
 *   requireHttps: boolean,
 *   storageDir: string,
 *   acmeStaging?: boolean,
 *   httpsPort?: number,
 *   httpPort?: number,
 * }} opts
 */
export function buildCaddyConfig({
  hostname, dnsProvider, gatewayPort, mcpPort, httpsServing, requireHttps, storageDir,
  acmeStaging = false, httpsPort = 443, httpPort = 80,
  // The control plane over HTTPS (2026-11-19): when set, Caddy also serves
  // the admin listener (on loopback, at adminPort) on adminHttpsPort, same
  // name, same certificate. Never on :80: there is no plain-HTTP admin route.
  adminPort = null, adminHttpsPort = ADMIN_HTTPS_PORT,
}) {
  if (typeof hostname !== 'string' || !HOSTNAME_RE.test(hostname)) throw new Error(`not a hostname: ${JSON.stringify(hostname)}`)
  if (typeof storageDir !== 'string' || !storageDir) throw new Error('storageDir is required')
  if (typeof httpsServing !== 'boolean' || typeof requireHttps !== 'boolean') {
    throw new Error('httpsServing and requireHttps must be booleans')
  }
  port('gatewayPort', gatewayPort)
  port('mcpPort', mcpPort)
  port('httpsPort', httpsPort)
  port('httpPort', httpPort)
  if (adminPort !== null) { port('adminPort', adminPort); port('adminHttpsPort', adminHttpsPort) }
  const provider = checkDnsProvider(dnsProvider)
  const routes = appRoutes({ mcpPort, gatewayPort })

  let plainRoutes
  if (httpsServing) {
    // {http.request.uri} is path + query. The redirect names the hostname, not
    // the Host header: a request to http://192.168.1.50 lands on the name.
    plainRoutes = [{
      handle: [{
        handler: 'static_response',
        status_code: 308,
        headers: { Location: [`https://${hostname}${httpsPort === 443 ? '' : `:${httpsPort}`}{http.request.uri}`] },
      }],
      terminal: true,
    }]
  } else if (requireHttps) {
    plainRoutes = [{
      handle: [{
        handler: 'static_response',
        status_code: 503,
        headers: { 'Content-Type': ['text/html; charset=utf-8'], 'Cache-Control': ['no-store'] },
        body: REQUIRE_HTTPS_PAGE,
      }],
      terminal: true,
    }]
  } else {
    plainRoutes = routes
  }

  return {
    admin: { disabled: true, config: { persist: false } },
    logging: {
      logs: { default: { writer: { output: 'stdout' }, encoder: { format: 'json' }, level: 'INFO' } },
    },
    storage: { module: 'file_system', root: storageDir },
    apps: {
      http: {
        http_port: httpPort,
        https_port: httpsPort,
        servers: {
          https: {
            listen: listenOn(httpsPort),
            protocols: ['h1', 'h2'],
            // The Host header must match the SNI the handshake was made for.
            strict_sni_host: true,
            tls_connection_policies: [{ match: { sni: [hostname] } }],
            routes: [{ match: [{ host: [hostname] }], handle: [{ handler: 'subroute', routes: [healthRoute(), ...routes] }], terminal: true }],
            // The :80 server below is ours; Caddy must not add its own.
            automatic_https: { disable_redirects: true },
          },
          http: {
            listen: listenOn(httpPort),
            protocols: ['h1', 'h2'],
            routes: plainRoutes,
            automatic_https: { disable: true },
          },
          ...(adminPort !== null ? {
            admin: {
              listen: listenOn(adminHttpsPort),
              protocols: ['h1', 'h2'],
              strict_sni_host: true,
              tls_connection_policies: [{ match: { sni: [hostname] } }],
              routes: [{ match: [{ host: [hostname] }], handle: [reverseProxy(adminPort)], terminal: true }],
              automatic_https: { disable_redirects: true },
            },
          } : {}),
        },
      },
      tls: {
        automation: {
          policies: [{
            subjects: [hostname],
            issuers: [{
              module: 'acme',
              ca: acmeStaging ? ACME_STAGING : ACME_PRODUCTION,
              challenges: {
                http: { disabled: true },
                'tls-alpn': { disabled: true },
                // Generous: DuckDNS can take minutes to show a TXT record.
                dns: { provider, propagation_timeout: '10m' },
              },
            }],
          }],
        },
      },
    },
  }
}
