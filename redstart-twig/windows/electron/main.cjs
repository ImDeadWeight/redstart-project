'use strict'

// =============================================================================
// Redstart Twig (Windows) — Electron main process
// =============================================================================

const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { app, BrowserWindow, ipcMain, session } = require('electron')

// ---------------------------------------------------------------------------
// Static file server
// ---------------------------------------------------------------------------
// Served over HTTP (not file://) so that service workers, IndexedDB, and
// fetch APIs work — Chromium treats file:// as an opaque origin and blocks them.
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
    : path.join(__dirname, '..', '..', '..', 'redstart-nest', 'src', 'chat-ui', 'dist')

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
      // should go to the configured remote server. Return JSON 503 so the
      // chat-ui shows a clean error instead of trying to parse HTML as JSON.
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
// connect-src must allow arbitrary http/https because the user configures
// the Redstart Nest address at runtime — we can't know the IP at build time.
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
// Network discovery IPC
// ---------------------------------------------------------------------------
// Mirrors the Android NetworkDiscovery Capacitor plugin interface so the
// chat-ui can use the same code path on both platforms via redstartTwigAPI.network.
// Port 8765 matches the beacon port in Redstart Nest — both sides must agree.
// ---------------------------------------------------------------------------

const BEACON_PORT = 8765

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
            // Verify app identity and require a running model — avoids false
            // positives from other HTTP services on port 8765.
            if (data.app !== 'beaver-dam' || !data.server?.running) { resolve(null); return }

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

  // Always probe 127.0.0.1 first to catch the case where Redstart Nest and
  // Redstart Twig run on the same machine with Redstart Nest bound to localhost only.
  probes.push(probeBeacon('127.0.0.1', timeout).then(s => s && found.push(s)))

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
        ? path.join(process.resourcesPath, 'app.asar.unpacked', 'electron', 'preload.cjs')
        : path.join(__dirname, 'preload.cjs'),
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
