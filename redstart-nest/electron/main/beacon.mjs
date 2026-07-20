'use strict'

import { createServer } from 'http'

// ---------------------------------------------------------------------------
// Beacon — lightweight discovery endpoint for Redstart Twig and other
// clients. Returns a minimal payload so the beacon no longer leaks
// configuration details (version, auth state, MCP server list, URLs).
// ---------------------------------------------------------------------------

const BEACON_PORT = 8765

// bindPort defaults to the well-known beacon port; callers (tests) may pass 0
// to bind an ephemeral port and avoid colliding with a running instance.
export function startBeaconServer(getRunning, getPort, bindPort = BEACON_PORT) {
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
    res.end(JSON.stringify({ app: 'redstart-nest', running, port }))
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
