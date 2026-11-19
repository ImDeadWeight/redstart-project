'use strict'

import * as http from 'node:http'

// =============================================================================
// Redstart Nest — move an HTTP listener to another bind host, keep its handler
// =============================================================================
// The network-mode owner (C2b) moves the gateway and the MCP server between
// 127.0.0.1 and 0.0.0.0 while they run: when Caddy starts fronting them,
// and when Caddy gives up and the household falls back to plain HTTP.
// Restarting either server for that would cost far more than a socket.
// stopMcpServer() kills every plugin child and Python kernel, and
// startGateway() resets the upstream. So only the LISTENER moves: a new
// server with the same request handlers, on the same port, other host.
//
// Same port, different host: on every platform 127.0.0.1:P and 0.0.0.0:P
// conflict, so the old listener is CLOSED FIRST (connections dropped, not
// waited for; idle keep-alive would otherwise hold the port), and only then
// does the new one bind. Clients see a reset and reconnect; the MCP client
// re-initialises its session, as it already does after a role change.
// =============================================================================

/**
 * @param {http.Server} server  the running server
 * @param {string} host         the new bind host
 * @returns {Promise<http.Server>} the new server, listening
 */
export async function rebindHttpServer(server, host) {
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('rebindHttpServer: the server is not listening on a TCP port')
  const port = address.port
  const handlers = server.listeners('request')
  const upgrades = server.listeners('upgrade')

  await new Promise((resolve) => {
    server.closeAllConnections?.()
    server.close(() => resolve())
  })

  const next = http.createServer()
  for (const h of handlers) next.on('request', h)
  for (const h of upgrades) next.on('upgrade', h)
  await new Promise((resolve, reject) => {
    next.once('error', reject)
    next.listen(port, host, () => { next.off('error', reject); resolve() })
  })
  return next
}
