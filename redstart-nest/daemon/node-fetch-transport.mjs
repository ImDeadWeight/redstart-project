// =============================================================================
// A fetch-shaped GET over node:http/node:https — for bulk downloads only.
// =============================================================================
// Exists because Node 26's built-in fetch (undici 8.12) delivers a response
// body at a fixed ~220 chunks/s on Windows: 16 KB chunks, one per ~4.5 ms
// timer tick, a flat ~3.4 MB/s ceiling no matter how fast the link is.
// Measured 2026-11-11 against the same Hugging Face CDN file:
//
//   Node 24 fetch            64 MB/s
//   Node 26 fetch             3.4 MB/s   ← what nestd was getting
//   Node 26 node:https       64 MB/s
//   Node 26 https → toWeb    65 MB/s    (so web streams are not the problem)
//
// Only the transport changes. The caller still gets a real Response, so
// fetchFollowingRedirects() — and with it every per-hop host check — runs
// unmodified on top of this. Small API calls keep using global fetch; the cap
// only matters once a body is gigabytes.
//
// Deliberately minimal: GET only, no redirect following (node:https never
// follows, which is exactly redirect:'manual'), no body to send. http: is
// accepted so the suite can drive it against a local server; the URL policies
// the downloader runs under already refuse plaintext in production.
//
// When the undici regression is fixed upstream this can be deleted and the
// downloader pointed back at global fetch — re-measure first (numbers above).
// =============================================================================

import * as http from 'node:http'
import * as https from 'node:https'
import { Readable } from 'node:stream'

// Statuses a Response may not carry a body for — the constructor throws.
const NULL_BODY_STATUSES = new Set([204, 205, 304])

export function nodeFetch(url, { headers = {}, signal } = {}) {
  return new Promise((resolve, reject) => {
    let target
    try { target = new URL(url) } catch (err) { reject(err); return }
    const mod = target.protocol === 'https:' ? https : target.protocol === 'http:' ? http : null
    if (!mod) { reject(new Error(`Unsupported protocol: ${target.protocol}`)); return }
    if (signal?.aborted) { reject(signal.reason); return }

    let res = null
    // Abort by hand rather than via request({ signal }): Node's own wiring
    // replaces the reason with a generic AbortError, and the downloader's
    // timeouts put the user-facing message IN the reason ("stalled — no data
    // for 60 s"). Destroying with the reason carries it through toWeb() to the
    // reader.read() that is waiting.
    const onAbort = () => {
      req.destroy(signal.reason)
      res?.destroy(signal.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    const req = mod.request(target, { method: 'GET', headers }, (incoming) => {
      res = incoming
      res.once('close', () => signal?.removeEventListener('abort', onAbort))

      const h = new Headers()
      for (const [k, v] of Object.entries(res.headers)) {
        if (v === undefined) continue
        if (Array.isArray(v)) for (const item of v) h.append(k, item)
        else h.set(k, v)
      }
      const status = res.statusCode
      let body = null
      if (NULL_BODY_STATUSES.has(status)) res.resume()
      else body = Readable.toWeb(res)
      resolve(new Response(body, { status, statusText: res.statusMessage, headers: h }))
    })
    req.once('error', (err) => {
      signal?.removeEventListener('abort', onAbort)
      reject(err)
    })
    req.end()
  })
}
