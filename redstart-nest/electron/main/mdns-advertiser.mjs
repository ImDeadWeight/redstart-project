'use strict'

import { Bonjour } from 'bonjour-service'
import { getGatewayPort } from './tools-gateway.mjs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as os from 'node:os'

const execFileAsync = promisify(execFile)

let bonjour = null
let advertised = null

function logInterfaces() {
  const ifaces = os.networkInterfaces()
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const addr of addrs) {
      if (!addr.internal && addr.family === 'IPv4') {
        console.log(`mDNS interface: ${name} -> ${addr.address}`)
      }
    }
  }
}

async function ensureMdnsFirewallRule() {
  if (process.platform !== 'win32') return
  const ruleName = 'Redstart Nest mDNS'

  try {
    const { stdout } = await execFileAsync('netsh', [
      'advfirewall', 'firewall', 'show', 'rule',
      `name=${ruleName}`,
      'dir=in'
    ])
    if (stdout && stdout.includes(ruleName)) return
  } catch {}

  try {
    await execFileAsync('netsh', [
      'advfirewall', 'firewall', 'add', 'rule',
      `name=${ruleName}`,
      'dir=in', 'action=allow', 'protocol=UDP',
      'localport=5353'
    ])
    console.log('mDNS firewall rule added (inbound UDP 5353)')
  } catch (err) {
    console.warn('mDNS firewall rule requires elevation:', err.message)
  }
}

export function startMdnsAdvertiser(config) {
  stopMdnsAdvertiser()

  if (!config?.networkMode) return

  // bonjour-service uses `host` verbatim as the A-record name (no suffix is
  // appended), and mDNS resolvers only ever query names ending in `.local`.
  // So the advertised host MUST carry the `.local` suffix — normalize to it
  // rather than stripping it.
  const rawHost = (config.advertisedHost || '').trim().replace(/\.local$/i, '')
  const host = rawHost ? `${rawHost}.local` : null
  const port = getGatewayPort(config.port) || config.port
  if (!port) return

  logInterfaces()

  if (host) {
    ensureMdnsFirewallRule().catch(() => {})
  }

  try {
    bonjour = new Bonjour()
    advertised = bonjour.publish({
      name: 'Redstart Nest',
      type: 'http',
      port,
      ...(host ? { host } : {}),
      disableIPv6: true,
      txt: {
        path: '/',
        service: 'redstart-nest',
      }
    })

    console.log(`mDNS advertising Redstart Nest on port ${port}${host ? ` as ${host}` : ''}`)
  } catch (err) {
    console.warn('mDNS advertiser failed to start:', err.message)
    bonjour = null
    advertised = null
  }
}

export function stopMdnsAdvertiser() {
  if (advertised) {
    try { advertised.stop() } catch {}
    advertised = null
  }
  if (bonjour) {
    try { bonjour.destroy() } catch {}
    bonjour = null
  }
}
