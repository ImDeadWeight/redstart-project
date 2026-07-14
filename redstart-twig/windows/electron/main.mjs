// =============================================================================
// Redstart Twig (Windows) — Electron main process
// =============================================================================
// This is the Windows desktop companion to Redstart Nest. Its job is simple:
// serve the same SvelteKit chat-ui that the Android app uses and scan the
// local network to find a running Redstart Nest instance automatically.
//
// I kept this separate from Redstart Nest intentionally — Redstart Nest is the
// server manager (runs on the PC hosting the GPU), while Redstart Twig is just
// a client (runs anywhere on the network). Separating them means a user could
// run Redstart Twig on a laptop while Redstart Nest runs on a desktop.
//
// The scan uses the same beacon protocol as the Android app (port 8765), so
// both clients work identically without duplicating server-side logic.
// =============================================================================

// Static import of 'electron' fails in some Electron 33 builds because Node.js
// statically analyses node_modules/electron/index.js (the npm install shim)
// during the link phase, before Electron's own built-in API provider is active.
// Dynamic import runs at execution time, when Electron's module system IS ready.
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const { app, BrowserWindow, ipcMain, session } = await import('electron')

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// ---------------------------------------------------------------------------
// Static file server
// ---------------------------------------------------------------------------
// I serve the chat-ui from a local HTTP server on a random port rather than
// loading the files directly with file:// URLs. Service workers (which power
// the offline PWA features), IndexedDB, and some fetch APIs all require a
// proper HTTP origin to work — file:// URLs are treated as opaque origins by
// browsers and Electron's Chromium behaves the same way. The random port
// means multiple Redstart Twig windows won't collide with each other.
// ---------------------------------------------------------------------------

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.mjs':  'application/javascript',
  '.css':  'text/css',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.woff2':'font/woff2',
  '.woff': 'font/woff',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
}

let fileServer = null

function startFileServer() {
  const chatUiDir = app.isPackaged
    ? path.join(process.resourcesPath, 'chat-ui')
    : path.join(__dirname, '..', '..', '..', '..', 'redstart-nest', 'src', 'chat-ui', 'dist')

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const urlPath = req.url.split('?')[0]
      const ext = path.extname(urlPath)
      const resolved = path.resolve(chatUiDir, '.' + urlPath)

      if (!resolved.startsWith(chatUiDir + path.sep) && resolved !== chatUiDir) {
        res.writeHead(403, { 'Content-Type': 'text/plain' })
        res.end('Forbidden')
        return
      }

      // API-like paths (no extension, not root) are llama-server calls that
      // should go to the user's configured remote server. Return JSON 503 so
      // the chat-ui shows "Server unavailable" cleanly instead of trying to
      // parse index.html as JSON.
      if (!ext && urlPath !== '/') {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'No server configured. Go to Settings → Server to enter your Redstart Nest address.' }))
        return
      }

      let filePath = resolved
      if (!ext || !fs.existsSync(filePath)) {
        filePath = path.join(chatUiDir, 'index.html')
      }

      try {
        const content = fs.readFileSync(filePath)
        res.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream' })
        res.end(content)
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('Not found')
      }
    })

    server.listen(0, '127.0.0.1', () => {
      fileServer = server
      resolve(server.address().port)
    })
    server.on('error', reject)
  })
}

// ---------------------------------------------------------------------------
// CSP (Content Security Policy)
// ---------------------------------------------------------------------------
// I have to keep connect-src open to arbitrary http/https/ws/wss addresses
// because the user can point Redstart Twig at any IP on their network. Unlike
// Redstart Nest (where I know the exact server address at build time), here I
// have no idea at build time what IP the Redstart Nest machine will have.
// ---------------------------------------------------------------------------

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self' http: https: ws: wss:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
].join('; ')

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.on('before-quit', () => {
  if (fileServer) { fileServer.close(); fileServer = null }
})

// ---------------------------------------------------------------------------
// Network discovery IPC — mirrors the Android NetworkDiscovery Capacitor plugin
// interface so the chat-ui can use the same code path on both platforms.
// ---------------------------------------------------------------------------

// I use port 8765 to match the beacon port in Redstart Nest. Both sides need to
// agree on this number — it's not configurable on purpose because the whole
// point is zero-configuration discovery.
const BEACON_PORT = 8765

// probeBeacon contacts a single IP and checks whether Redstart Nest is there.
// I verify the app identity ("redstart-nest") before trusting the response so
// that other HTTP services on port 8765 don't get mistaken for Redstart Nest.
// I also require server.running to be true — if Redstart Nest is open but hasn't
// started a model yet, there's nothing to connect to.
function probeBeacon(ip, timeout) {
  return new Promise((resolve) => {
    const req = http.get(
      { hostname: ip, port: BEACON_PORT, path: '/', timeout },
      (res) => {
        let body = ''
        res.on('data', chunk => { body += chunk })
        res.on('end', () => {
          try {
            const data = JSON.parse(body)
            if (data.app !== 'redstart-nest' || !data.server?.running) { resolve(null); return }

            // Same-machine discovery → use localUrl; LAN discovery → use networkUrl
            const url = ip === '127.0.0.1' ? data.server.localUrl : data.server.networkUrl
            if (!url) { resolve(null); return }

            resolve({ url, ip, port: data.server.port })
          } catch { resolve(null) }
        })
      }
    )
    req.on('error', () => resolve(null))
    req.on('timeout', () => { req.destroy(); resolve(null) })
  })
}

ipcMain.handle('network:get-info', () => {
  const interfaces = os.networkInterfaces()
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
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
})

ipcMain.handle('network:scan', async (_, { subnet, timeout = 400 }) => {
  const found = []
  const probes = []

  // I always probe 127.0.0.1 first to handle the case where Redstart Nest and
  // Redstart Twig are running on the same machine. In that case the LAN scan
  // would find the local IP too, but this ensures we catch localhost-only
  // mode where Redstart Nest isn't bound to 0.0.0.0.
  probes.push(probeBeacon('127.0.0.1', timeout).then(s => s && found.push(s)))

  // Scan LAN for Redstart Nest instances broadcasting on the beacon port
  for (let i = 1; i <= 254; i++) {
    probes.push(probeBeacon(`${subnet}.${i}`, timeout).then(s => s && found.push(s)))
  }

  await Promise.all(probes)
  return { servers: found }
})

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [CSP],
      },
    })
  })

  const port = await startFileServer()

  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: 'Redstart Twig',
    show: false,
    backgroundColor: '#09090b',
    webPreferences: {
      contextIsolation: true,
      sandbox: false,
      preload: app.isPackaged
        ? path.join(process.resourcesPath, 'app.asar.unpacked', 'electron', 'preload.mjs')
        : path.join(__dirname, 'preload.mjs'),
    },
  })

  win.once('ready-to-show', () => win.show())

  win.webContents.on('before-input-event', (_, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools()
  })

  win.loadURL(`http://127.0.0.1:${port}/`)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
