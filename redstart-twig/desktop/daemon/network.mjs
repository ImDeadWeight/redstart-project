// =============================================================================
// Redstart Twig: finding a Redstart Nest on the local network
// =============================================================================
// Mirrors the Android NetworkDiscovery Capacitor plugin's interface, so the
// chat-ui uses one code path on both platforms. The scan uses Nest's beacon
// (port 8765), the same protocol the Android app speaks, so both clients find
// servers identically without duplicating server-side logic. Moved from
// Electron's main.mjs in the Tauri move, unchanged.
// =============================================================================

import * as http from 'node:http'
import * as os from 'node:os'

// Must match the beacon port in Redstart Nest. Not configurable on purpose:
// the point is zero-configuration discovery.
export const BEACON_PORT = 8765

/**
 * Contact one IP and check whether Redstart Nest is there. The app identity
 * ("redstart-nest") is verified so another HTTP service on the port is not
 * mistaken for Nest, and `running` must be true: Nest open with no model
 * started has nothing to connect to.
 */
export function probeBeacon(ip, timeout, port = BEACON_PORT) {
  return new Promise((resolve) => {
    const req = http.get({ hostname: ip, port, path: '/', timeout }, (res) => {
      let body = ''
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => {
        try {
          const data = JSON.parse(body)
          if (data.app !== 'redstart-nest' || !data.running) { resolve(null); return }
          // The beacon sends a minimal { app, running, port } payload. The URL
          // is built from the responding IP and that port, never from a
          // server-supplied URL.
          const serverPort = data.port
          if (!serverPort) { resolve(null); return }
          resolve({ url: `http://${ip}:${serverPort}`, ip, port: serverPort })
        } catch { resolve(null) }
      })
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => { req.destroy(); resolve(null) })
  })
}

export const handlers = {
  'network:get-info': () => {
    const interfaces = os.networkInterfaces()
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name] ?? []) {
        if (iface.family === 'IPv4' && !iface.internal) {
          const parts = iface.address.split('.')
          return {
            ip: iface.address,
            subnet: `${parts[0]}.${parts[1]}.${parts[2]}`,
            gateway: `${parts[0]}.${parts[1]}.${parts[2]}.1`,
          }
        }
      }
    }
    throw new Error('No active network interface found')
  },

  'network:scan': async ({ subnet, timeout = 400 } = {}) => {
    if (typeof subnet !== 'string' || !/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(subnet)) {
      throw new Error('network:scan needs a subnet like 192.168.1')
    }
    const found = []
    // 127.0.0.1 first, for Nest and Twig on one machine in localhost-only
    // mode, where Nest is not bound to the LAN address.
    const probes = [probeBeacon('127.0.0.1', timeout).then((s) => s && found.push(s))]
    for (let i = 1; i <= 254; i++) {
      probes.push(probeBeacon(`${subnet}.${i}`, timeout).then((s) => s && found.push(s)))
    }
    await Promise.all(probes)
    return { servers: found }
  },
}
