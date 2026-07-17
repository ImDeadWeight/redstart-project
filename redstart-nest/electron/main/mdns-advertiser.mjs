'use strict'

import { Bonjour } from 'bonjour-service'
import { getGatewayPort } from './tools-gateway.mjs'

let bonjour = null
let advertised = null

export function startMdnsAdvertiser(config) {
  stopMdnsAdvertiser()

  if (!config?.networkMode) return

  const host = (config.advertisedHost || '').trim() || null
  const port = getGatewayPort(config.port) || config.port
  if (!port) return

  try {
    bonjour = new Bonjour()
    advertised = bonjour.publish({
      name: 'Redstart Nest',
      type: 'http',
      port,
      txt: {
        path: '/',
        service: 'redstart-nest',
        ...(host ? { host } : {})
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
