// The Cloudflare Worker entry point. Wiring only: service.js has the logic.
//
// Bindings (wrangler.toml): DB (D1), ZONE_NAME, ZONE_ID, SERVER_URL (vars),
// CF_API_TOKEN (a secret, scoped Zone:DNS:Edit on the one zone; never logged).
// ALERT_WEBHOOK (optional secret): where housekeeping alerts are POSTed.

import { createService } from './service.js'
import { cloudflareDns } from './dns.js'

function serviceFor(env, extraLog) {
  const log = (event, fields = {}) => {
    console.log(JSON.stringify({ event, ...fields }))
    extraLog?.(event, fields)
  }
  return createService({
    db: env.DB,
    dns: cloudflareDns({ token: env.CF_API_TOKEN, zoneId: env.ZONE_ID, zone: env.ZONE_NAME }),
    zone: env.ZONE_NAME,
    serverUrl: env.SERVER_URL,
    log,
  })
}

export default {
  async fetch(request, env) {
    return serviceFor(env).fetch(request)
  },

  async scheduled(_event, env, ctx) {
    const alerts = []
    const report = await serviceFor(env, (event, fields) => { if (event.startsWith('ALERT_')) alerts.push({ event, ...fields }) }).housekeeping()
    if (alerts.length && env.ALERT_WEBHOOK) {
      ctx.waitUntil(fetch(env.ALERT_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service: 'redstart-name-service', alerts, report }),
      }))
    }
  },
}
