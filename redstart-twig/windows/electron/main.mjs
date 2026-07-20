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

// Electron 33 supports an ESM main entry: import the built-in `electron` module
// statically and Electron's own ESM loader hook resolves the bare specifier to
// the live API (this is the same pattern Redstart Nest's index.mjs uses). A
// dynamic `await import('electron')` must NOT be used here — it sends the CJS
// install shim through Node's ESM export-preparse and crashes at startup.
import { app, BrowserWindow, Menu, ipcMain, nativeTheme, session, dialog } from 'electron'
import { initMcpManager } from './mcp-manager.mjs'
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Set once the main window exists, so dialogs can be parented to it.
let mainWindow = null

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
// I also require running to be true — if Redstart Nest is open but hasn't
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
            if (data.app !== 'redstart-nest' || !data.running) { resolve(null); return }

            // The beacon sends a minimal { app, running, port } payload, so we
            // build the connection URL from the responding IP + port ourselves
            // rather than trusting a server-supplied URL.
            const port = data.port
            if (!port) { resolve(null); return }

            resolve({ url: `http://${ip}:${port}`, ip, port })
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

// ---------------------------------------------------------------------------
// Local file system tools (Option A — "Claude Desktop" style)
// ---------------------------------------------------------------------------
// When the chat-ui runs inside Twig, fs_* tool calls execute HERE, against a
// folder on THIS machine that the user explicitly grants — instead of running
// on the remote Redstart Nest server. The tool logic is reused verbatim from
// Redstart Nest (fs-tool.mjs + path-scope.mjs) so behaviour and the
// path-containment security model stay identical on both.
// ---------------------------------------------------------------------------

const fsConfigPath = () => path.join(app.getPath('userData'), 'twig-fs-config.json')

let fsRootDir = null

function loadFsRoot() {
  try {
    return JSON.parse(fs.readFileSync(fsConfigPath(), 'utf8')).rootDir || null
  } catch {
    return null
  }
}

function saveFsRoot(rootDir) {
  try {
    fs.writeFileSync(fsConfigPath(), JSON.stringify({ rootDir }, null, 2))
  } catch (err) {
    console.warn('Could not persist fs root:', err.message)
  }
}

// Shape expected by fs-tool.mjs. Default-deny: no granted folder → disabled.
function twigFsCfg() {
  return { fileSystem: { enabled: !!fsRootDir, rootDir: fsRootDir } }
}

// Lazily import the shared Nest fs-tool module. In dev it lives in the source
// tree; in a packaged build it's copied next to the app via extraResources
// (see electron-builder.json). Dynamic import — safe for this plain-ESM module,
// unlike the electron shim — lets the path differ between the two layouts.
let fsToolModule = null
async function getFsTool() {
  if (fsToolModule) return fsToolModule
  const fsToolPath = app.isPackaged
    ? path.join(process.resourcesPath, 'fs-tool', 'fs-tool.mjs')
    : path.join(__dirname, '..', '..', '..', 'redstart-nest', 'electron', 'main', 'fs-tool.mjs')
  fsToolModule = await import(pathToFileURL(fsToolPath).href)
  return fsToolModule
}

// fs-tool.mjs emits MCP-shaped defs; the chat-ui speaks OpenAI function-calling.
function toOpenAiToolDefs(defs) {
  return defs.map((d) => ({
    type: 'function',
    function: { name: d.name, description: d.description, parameters: d.inputSchema },
  }))
}

ipcMain.handle('fs:get-tools', async () => {
  if (!fsRootDir) return []
  const t = await getFsTool()
  return toOpenAiToolDefs(t.toolDefs(twigFsCfg()))
})

ipcMain.handle('fs:execute', async (_e, { name, args }) => {
  const t = await getFsTool()
  return t.callTool(name, args, twigFsCfg())
})

ipcMain.handle('fs:pick-root', async () => {
  const opts = {
    title: 'Choose a folder Redstart Twig may read and write',
    properties: ['openDirectory', 'createDirectory'],
  }
  const res = mainWindow
    ? await dialog.showOpenDialog(mainWindow, opts)
    : await dialog.showOpenDialog(opts)
  if (res.canceled || !res.filePaths?.length) return { rootDir: fsRootDir }
  fsRootDir = res.filePaths[0]
  saveFsRoot(fsRootDir)
  return { rootDir: fsRootDir }
})

ipcMain.handle('fs:get-root', () => ({ rootDir: fsRootDir }))

// ---------------------------------------------------------------------------
// Shell chrome
// ---------------------------------------------------------------------------
// The window runs with a hidden title bar (no icon, no app name, no menu) and
// a Window Controls Overlay: Windows draws only the minimize/maximize/close
// buttons, floating over the web content, in colors we control. The chat-ui
// renders a slim drag strip along the top edge (see `.twig-titlebar` in the
// chat-ui CSS) so the window can still be moved, and reports its light/dark
// theme here so both the overlay buttons and nativeTheme follow the app.

// Overlay height must match the chat-ui's --twig-titlebar-height drag strip.
const TITLEBAR_HEIGHT = 32
const TITLEBAR_COLORS = {
  dark:  { color: '#09090b', symbolColor: '#e4e4e7', height: TITLEBAR_HEIGHT },
  light: { color: '#ffffff', symbolColor: '#18181b', height: TITLEBAR_HEIGHT },
}

ipcMain.handle('shell:set-theme', (_e, { theme }) => {
  const mode = theme === 'light' ? 'light' : 'dark'
  nativeTheme.themeSource = mode
  try {
    mainWindow?.setTitleBarOverlay(TITLEBAR_COLORS[mode])
  } catch {
    /* overlay not supported (non-Windows) */
  }
})

app.whenReady().then(async () => {
  fsRootDir = loadFsRoot()

  // Default grant: <Documents>\Redstart-twig. Created on first launch so the
  // local file tools work out of the box, scoped to a folder that is clearly
  // the app's own. The user can point elsewhere via the picker at any time.
  if (!fsRootDir) {
    try {
      const defaultRoot = path.join(app.getPath('documents'), 'Redstart-twig')
      fs.mkdirSync(defaultRoot, { recursive: true })
      fsRootDir = defaultRoot
      saveFsRoot(fsRootDir)
    } catch (err) {
      console.warn('Could not create default fs root:', err.message)
    }
  }

  // No File/Edit/View menu — the chat-ui is the whole interface. F12 devtools
  // is re-bound below via before-input-event, so nothing of value is lost.
  Menu.setApplicationMenu(null)

  // Default the window chrome to dark (matches backgroundColor #09090b) until
  // the renderer reports its actual theme via shell:set-theme.
  nativeTheme.themeSource = 'dark'

  // Local stdio MCP servers (Claude Desktop model) — process supervision +
  // JSONL pipe live in mcp-manager.mjs; the chat-ui's MCP client drives them
  // over the preload bridge like any other MCP connection.
  initMcpManager({ app, ipcMain, getWindow: () => mainWindow })

  // The chat-ui ships as a PWA. In this desktop shell the service worker only
  // causes stale-content bugs: it precaches an app shell and keeps serving it
  // across launches (Windows reuses ephemeral ports, so a previously registered
  // SW re-takes control of the local file server's origin), shadowing the
  // freshly built UI on disk. Purge the SW + HTTP caches on every startup so we
  // always load the current UI. localStorage/IndexedDB — settings, saved
  // conversations — are deliberately preserved.
  try {
    await session.defaultSession.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] })
    await session.defaultSession.clearCache()
  } catch (err) {
    console.warn('Could not clear cached UI storage:', err.message)
  }

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [CSP],
      },
    })
  })

  const port = await startFileServer()

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    title: 'Redstart Twig',
    show: false,
    backgroundColor: '#09090b',
    // Hidden title bar + Window Controls Overlay: no native bar, no app
    // icon/name — just themed min/max/close buttons over the web content.
    titleBarStyle: 'hidden',
    titleBarOverlay: TITLEBAR_COLORS.dark,
    webPreferences: {
      contextIsolation: true,
      sandbox: false,
      preload: app.isPackaged
        ? path.join(process.resourcesPath, 'app.asar.unpacked', 'electron', 'preload.mjs')
        : path.join(__dirname, 'preload.mjs'),
    },
  })

  mainWindow.once('ready-to-show', () => mainWindow.show())

  mainWindow.webContents.on('before-input-event', (_, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') mainWindow.webContents.toggleDevTools()
  })

  mainWindow.on('closed', () => { mainWindow = null })

  mainWindow.loadURL(`http://127.0.0.1:${port}/`)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
