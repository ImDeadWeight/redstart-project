'use strict'

import { createServer } from 'http'
import { BEACON_PORT } from './ports.mjs'

// ---------------------------------------------------------------------------
// Beacon — lightweight discovery endpoint for Redstart Twig and other
// clients. Returns a minimal payload so the beacon no longer leaks
// configuration details (version, auth state, MCP server list, URLs).
// ---------------------------------------------------------------------------

// bindPort defaults to the well-known beacon port; callers (tests) may pass 0
// to bind an ephemeral port and avoid colliding with a running instance.
//
// getOrigin (TLS plan C7) returns "https://<name>" while Nest's HTTPS is
// SERVING, else null. Only then does the payload gain `origin`. The name is
// already public (DNS, certificate transparency logs), so this discloses
// nothing new, and it is only ever a bare https origin: anything else is
// dropped rather than sent. Clients must still build their URL from the
// RESPONDING IP unless that name resolves to it (Twig's network.mjs), so a
// spoofed beacon gains nothing it could not already do with its own IP.
const ORIGIN_RE = /^https:\/\/[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/

export function beaconPayload({ running, port, origin = null }) {
  const body = { app: 'redstart-nest', running: !!running, port }
  if (typeof origin === 'string' && ORIGIN_RE.test(origin)) body.origin = origin
  return body
}

export function startBeaconServer(getRunning, getPort, bindPort = BEACON_PORT, getOrigin = () => null) {
  const server = createServer((req, res) => {
    const running = !!getRunning()
    const port = getPort()

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    })
    // Minimal identity + liveness contract. The `app` marker lets clients tell
    // a Redstart Nest apart from any other service that happens to listen on
    // 8765 (positive identification), without leaking config/version/auth/URLs.
    // The same identity is already broadcast in cleartext over mDNS, so this
    // discloses nothing new. Clients build the connection URL from the
    // responding IP + this port themselves.
    let origin = null
    try { origin = getOrigin() } catch { /* no origin is always safe */ }
    res.end(JSON.stringify(beaconPayload({ running, port, origin })))
  })

  return new Promise((resolve, reject) => {
    server.listen(bindPort, '0.0.0.0', () => {
      resolve(server)
    })
    server.on('error', reject)
  })
}

export function stopBeaconServer(server) {
  if (server) {
    server.close()
    server = null
  }
}
