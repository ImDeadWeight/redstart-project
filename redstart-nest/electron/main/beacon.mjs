'use strict'

import { createServer } from 'http'

// ---------------------------------------------------------------------------
// Beacon — lightweight discovery endpoint for Redstart Twig and other
// clients. Returns a minimal payload so the beacon no longer leaks
// configuration details (version, auth state, MCP server list, URLs).
// ---------------------------------------------------------------------------

const BEACON_PORT = 8765

export function startBeaconServer(getRunning, getPort) {
  const server = createServer((req, res) => {
    const running = !!getRunning()
    const port = getPort()

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    })
    res.end(JSON.stringify({ running, port }))
  })

  return new Promise((resolve, reject) => {
    server.listen(BEACON_PORT, '0.0.0.0', () => {
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
