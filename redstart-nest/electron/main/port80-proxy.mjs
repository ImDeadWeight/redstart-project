'use strict'

// Reverse-proxy :80 -> 127.0.0.1:<gateway port> so users can browse to
// http://redstart.local (no port suffix) instead of http://redstart.local:19080.
//
// This is deliberately kept separate from the tool gateway so the proven
// pipeline on the gateway port stays the fallback: if port 80 is already taken
// by other software, the proxy simply doesn't start and the :19080 URL keeps
// working. It forwards plain HTTP (including SSE streaming) and WebSocket
// upgrades unchanged, so the URL bar stays on http://redstart.local throughout.

import { createServer, request } from 'node:http'

let proxyServer = null

function buildForwardHeaders(req, targetPort) {
  // Preserve the original headers but point Host at the local gateway so its
  // own host-based routing keeps working.
  return { ...req.headers, host: `127.0.0.1:${targetPort}` }
}

export function startPort80Proxy(config) {
  stopPort80Proxy()

  if (!config?.networkMode) return

  const targetPort = config.port || 19080
  // If the gateway itself is already on 80 there is nothing to proxy.
  if (targetPort === 80) return

  const server = createServer((req, res) => {
    const proxyReq = request(
      {
        host: '127.0.0.1',
        port: targetPort,
        method: req.method,
        path: req.url,
        headers: buildForwardHeaders(req, targetPort)
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 502, proxyRes.headers)
        proxyRes.pipe(res)
      }
    )
    proxyReq.on('error', () => {
      if (!res.headersSent) res.writeHead(502)
      res.end('Bad gateway')
    })
    req.pipe(proxyReq)
  })

  // Forward WebSocket (and any other) upgrades so real-time transports survive
  // the extra hop. No-op in practice today (chat streaming uses SSE over HTTP),
  // but keeps the proxy transparent if a WS transport is ever added.
  server.on('upgrade', (req, clientSocket, head) => {
    const proxyReq = request({
      host: '127.0.0.1',
      port: targetPort,
      method: req.method,
      path: req.url,
      headers: buildForwardHeaders(req, targetPort)
    })
    proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
      const headerLines = Object.entries(proxyRes.headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\r\n')
      clientSocket.write(`HTTP/1.1 101 Switching Protocols\r\n${headerLines}\r\n\r\n`)
      if (proxyHead && proxyHead.length) proxySocket.unshift(proxyHead)
      proxySocket.pipe(clientSocket)
      clientSocket.pipe(proxySocket)
    })
    proxyReq.on('error', () => clientSocket.destroy())
    clientSocket.on('error', () => proxyReq.destroy())
    if (head && head.length) proxyReq.write(head)
    proxyReq.end()
  })

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`Port 80 in use — clean URL disabled, use http://redstart.local:${targetPort}`)
    } else {
      console.warn('Port 80 proxy error:', err.message)
    }
    proxyServer = null
  })

  server.listen(80, '0.0.0.0', () => {
    proxyServer = server
    console.log(`Port 80 proxy -> 127.0.0.1:${targetPort} (browse http://redstart.local)`)
  })
}

export function stopPort80Proxy() {
  if (proxyServer) {
    try { proxyServer.close() } catch {}
    proxyServer = null
  }
}
