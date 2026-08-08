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
import { app, BrowserWindow, Menu, ipcMain, nativeTheme, session, dialog, shell } from 'electron'
import { initMcpManager } from './mcp-manager.mjs'
import * as fsTool from './fs/fs-tool.mjs'
import { setTrashImpl, moveToTrash } from './fs/trash.mjs'
import { resolveWithinRoot } from './fs/path-scope.mjs'
import { toHexColor } from './color.mjs'
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

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
      let urlPath
      try {
        urlPath = decodeURIComponent(req.url.split('?')[0])
      } catch {
        res.writeHead(400, { 'Content-Type': 'text/plain' })
        res.end('Bad request')
        return
      }
      const ext = path.extname(urlPath)
      const resolved = path.resolve(chatUiDir, '.' + urlPath)

      // Containment check via path.relative: anything outside chatUiDir
      // yields a relative path that is absolute or starts with "..".
      const rel = path.relative(chatUiDir, resolved)
      if (path.isAbsolute(rel) || rel === '..' || rel.startsWith('..' + path.sep)) {
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
// on the remote Redstart Nest server. The tool logic lives in ./fs/, vendored
// from Nest on 2026-08-07 when Nest deleted its copy; see fs/fs-tool.mjs.
//
// No folder is granted by default. The model gets zero local file tools until
// the user picks one (Settings → Server, or the folder control under the chat
// composer), which keeps "the model can touch my disk" an explicit act and
// leaves Nest's own server-side file capability reachable for users who never
// grant one.
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

// fs-tool.mjs emits MCP-shaped defs; the chat-ui speaks OpenAI function-calling.
function toOpenAiToolDefs(defs) {
  return defs.map((d) => ({
    type: 'function',
    function: { name: d.name, description: d.description, parameters: d.inputSchema },
  }))
}

// Returns { tools, classes } rather than a bare array. `classes` tells the
// chat-ui which of these are destructive, which is what keeps fs_delete_file out
// of "always allow" — Nest's server-side policy gate has no reach over tools
// that execute here, so this manifest is the only control. Older chat-ui builds
// that expect an array still work: they read `.tools` off it as undefined and
// fall back, and the shape check lives in tools.svelte.ts.
ipcMain.handle('fs:get-tools', async () => {
  if (!fsRootDir) return { tools: [], classes: {} }
  return {
    tools: toOpenAiToolDefs(fsTool.toolDefs(twigFsCfg())),
    classes: fsTool.TOOL_CLASSES,
  }
})

ipcMain.handle('fs:execute', async (_e, { name, args }) => {
  return fsTool.callTool(name, args, twigFsCfg())
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
// Local file explorer API
// ---------------------------------------------------------------------------
// Structured counterparts to the model-facing fs_* tools, for the Files tab in
// the chat-ui. Deliberately separate from fs:execute: those tools return MCP
// text shaped for a model to read ("[DIR]  notes/"), and parsing that back out
// in the UI would break the moment the wording changed. These return data.
//
// They are also NOT advertised to the model. Renaming and moving are user
// operations here; the model's tool set is unchanged.
//
// Shapes mirror Redstart Nest's /files/* API so the explorer component can
// treat "this computer" and "the server" as two instances of one thing.
// ---------------------------------------------------------------------------

const PREVIEWABLE_EXTENSIONS = new Set(['.txt', '.md', '.csv', '.json', '.log', '.py', '.js', '.ts', '.html', '.css', '.yml', '.yaml', '.xml', '.ini', '.cfg'])
const MAX_LOCAL_PREVIEW_CHARS = 20000
const MAX_LOCAL_ENTRIES = 1000

/** Resolve a browser-supplied path inside the granted folder, or throw. */
function resolveLocal(relPath) {
  if (!fsRootDir) throw new Error('No folder has been granted yet.')
  return resolveWithinRoot(fsRootDir, relPath && relPath !== '.' ? relPath : '.')
}

const toRelative = (full) => path.relative(fsRootDir, full).split(path.sep).join('/')

ipcMain.handle('fs:browse', async (_e, { path: relPath } = {}) => {
  try {
    const full = resolveLocal(relPath)
    const stat = fs.statSync(full)
    if (!stat.isDirectory()) return { error: 'Not a folder' }

    const entries = []
    for (const entry of fs.readdirSync(full, { withFileTypes: true }).slice(0, MAX_LOCAL_ENTRIES)) {
      const childFull = path.join(full, entry.name)
      // The trash folder backs recoverable deletion; browsing it would invite
      // deleting already-deleted things, the one path that could destroy data.
      if (entry.isDirectory() && entry.name === '.trash') continue
      let childStat
      try {
        childStat = fs.statSync(childFull)
      } catch {
        continue
      }
      entries.push({
        name: entry.name,
        path: toRelative(childFull),
        type: childStat.isDirectory() ? 'folder' : 'file',
        size: childStat.isDirectory() ? null : childStat.size,
        modified: childStat.mtime.toISOString(),
        previewable: !childStat.isDirectory() && PREVIEWABLE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()),
      })
    }
    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'folder' ? -1 : 1))
    return { path: toRelative(full) || '.', entries }
  } catch (err) {
    return { error: err.message }
  }
})

ipcMain.handle('fs:preview', async (_e, { path: relPath } = {}) => {
  try {
    const full = resolveLocal(relPath)
    if (!PREVIEWABLE_EXTENSIONS.has(path.extname(full).toLowerCase())) {
      return { error: 'No preview is available for this file type' }
    }
    const text = fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n')
    return { text: text.slice(0, MAX_LOCAL_PREVIEW_CHARS), truncated: text.length > MAX_LOCAL_PREVIEW_CHARS }
  } catch (err) {
    return { error: err.message }
  }
})

ipcMain.handle('fs:mkdir', async (_e, { path: relPath } = {}) => {
  try {
    const full = resolveLocal(relPath)
    if (path.relative(fsRootDir, full) === '') return { error: 'A folder needs a name' }
    if (fs.existsSync(full)) return { error: 'Something with that name already exists' }
    fs.mkdirSync(full, { recursive: true })
    return { path: toRelative(full) }
  } catch (err) {
    return { error: err.message }
  }
})

ipcMain.handle('fs:move', async (_e, { from, to } = {}) => {
  try {
    // BOTH paths go through containment — checking only the source would let
    // the destination write anywhere on the user's disk.
    const fromFull = resolveLocal(from)
    const toFull = resolveLocal(to)
    if (path.relative(fsRootDir, fromFull) === '') return { error: 'Cannot move the granted folder itself' }
    if (path.relative(fsRootDir, toFull) === '') return { error: 'The new name cannot be empty' }
    if (!fs.existsSync(fromFull)) return { error: 'Not found' }
    if (fs.existsSync(toFull)) return { error: 'Something with that name already exists' }
    // A folder cannot be moved inside itself; fs.renameSync answers that with a
    // bare EINVAL that would surface as an unexplained failure.
    const inner = path.relative(fromFull, toFull)
    if (inner !== '' && !inner.startsWith('..') && !path.isAbsolute(inner)) {
      return { error: 'A folder cannot be moved inside itself' }
    }
    fs.mkdirSync(path.dirname(toFull), { recursive: true })
    fs.renameSync(fromFull, toFull)
    return { path: toRelative(toFull) }
  } catch (err) {
    return { error: err.message }
  }
})

ipcMain.handle('fs:trash', async (_e, { path: relPath } = {}) => {
  try {
    const full = resolveLocal(relPath)
    if (path.relative(fsRootDir, full) === '') return { error: 'Cannot delete the granted folder itself' }
    if (!fs.existsSync(full)) return { error: 'Not found' }
    const stat = fs.lstatSync(full)
    if (stat.isDirectory() && !stat.isSymbolicLink() && fs.readdirSync(full).length > 0) {
      return { error: 'That folder is not empty. Remove its contents first.' }
    }
    // Same recoverable deletion the model's fs_delete_file uses — a user-driven
    // delete should be exactly as undoable as a model-driven one.
    const outcome = await moveToTrash(fsRootDir, full)
    if (!outcome.ok) return { error: outcome.error }
    return { path: toRelative(full), recoverable: outcome.method, hint: outcome.hint }
  } catch (err) {
    return { error: err.message }
  }
})

// ---------------------------------------------------------------------------
// Shell chrome
// ---------------------------------------------------------------------------
// The window runs with a hidden title bar (no icon, no app name, no menu) and
// a Window Controls Overlay: Windows draws only the minimize/maximize/close
// buttons, floating over the web content, in colors we control. The chat-ui
// renders a slim drag strip along the top edge (see `.twig-titlebar` in the
// chat-ui CSS) so the window can still be moved, and reports its light/dark
// theme here so both the overlay buttons and nativeTheme follow the app.

// The chat-ui renders smaller in Twig than in a browser. At 100% the composer
// and message text are oversized for a desktop window, so the whole web content
// is zoomed — uniformly, rather than by overriding font sizes, so spacing and
// hit targets scale with the text instead of drifting apart from it.
const UI_ZOOM = 0.8

// Two units are in play and they are NOT interchangeable:
//   - the drag strip is web content, measured in CSS pixels, and is scaled by
//     UI_ZOOM along with everything else
//   - the window-controls overlay is drawn by Windows, in device pixels, and
//     ignores zoom entirely
// So the native height is derived from the CSS height rather than written
// twice: leave them as independent constants and any zoom change silently
// misaligns the drag strip with the buttons it is supposed to sit beside.
// TITLEBAR_CSS_HEIGHT must equal --twig-titlebar-height in the chat-ui's app.css.
const TITLEBAR_CSS_HEIGHT = 40
const TITLEBAR_HEIGHT = Math.round(TITLEBAR_CSS_HEIGHT * UI_ZOOM)

// Fallback colours only. The renderer reports the background it is ACTUALLY
// painting (see below), because these two values drifted: the app renders
// oklch(0.12 0 0) = #060606 while this said #09090b, which showed up as a
// visibly lighter band behind the minimise/maximise/close buttons. Anything
// that has to match a stylesheet by hand eventually stops matching it.
// Dark only — the chat-ui has no light mode, so there is no light variant to
// fall back to. A light entry here would only be reachable by a stale renderer.
const TITLEBAR_COLORS = {
  color: '#060606',
  symbolColor: '#e4e4e7',
  height: TITLEBAR_HEIGHT,
}

// `theme` is still accepted for wire compatibility with older chat-ui builds
// but is no longer read; the background the renderer reports is what matters.
ipcMain.handle('shell:set-theme', (_e, { background }) => {
  nativeTheme.themeSource = 'dark'
  const color = toHexColor(background) ?? TITLEBAR_COLORS.color
  try {
    mainWindow?.setTitleBarOverlay({ ...TITLEBAR_COLORS, color })
  } catch {
    /* overlay not supported (non-Windows) */
  }
})

app.whenReady().then(async () => {
  fsRootDir = loadFsRoot()

  // NO default folder grant. Twig used to create <Documents>\Redstart-twig on
  // first launch so the local tools worked out of the box — but that meant a
  // folder was ALWAYS granted, which in turn meant Twig's local file tools were
  // always present and (once client-side precedence lands) Nest's server-side
  // File System capability could never be reached from Twig by anyone. Granting
  // the model access to a real folder on the user's disk should be something
  // the user did on purpose, not a first-launch side effect.
  //
  // Existing installs keep whatever they already granted — loadFsRoot() above
  // reads the persisted value, and nothing here clears it.

  // Deletions go to the OS recycle bin. Injected rather than imported inside
  // fs/trash.mjs so that module (and fs-tool.mjs with it) stays loadable under
  // plain node for containment tests. Without this the tools still work — they
  // fall back to a .trash/ folder inside the granted root.
  setTrashImpl((fullPath) => shell.trashItem(fullPath))

  // No File/Edit/View menu — the chat-ui is the whole interface. F12 devtools
  // is re-bound below via before-input-event, so nothing of value is lost.
  Menu.setApplicationMenu(null)

  // Default the window chrome to dark (matches backgroundColor below) until the
  // renderer reports its actual theme and background via shell:set-theme.
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

  // Without an explicit icon the window (and so the taskbar button) falls back
  // to Electron's default. electron-builder's `win.icon` only skins the
  // installed .exe — it does not reach the running window, which is why the
  // taskbar showed the generic icon in dev and after launch.
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'icon.ico')
    : path.join(__dirname, '..', '..', '..', 'redstart-nest', 'build', 'icon.ico')

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    title: 'Redstart Twig',
    ...(fs.existsSync(iconPath) ? { icon: iconPath } : {}),
    show: false,
    // Matches the chat-ui's --background so the frame does not flash a
    // different shade before the first paint.
    backgroundColor: TITLEBAR_COLORS.color,
    // Hidden title bar + Window Controls Overlay: no native bar, no app
    // icon/name — just themed min/max/close buttons over the web content.
    titleBarStyle: 'hidden',
    titleBarOverlay: TITLEBAR_COLORS,
    webPreferences: {
      contextIsolation: true,
      sandbox: false,
      preload: app.isPackaged
        ? path.join(process.resourcesPath, 'app.asar.unpacked', 'electron', 'preload.mjs')
        : path.join(__dirname, 'preload.mjs'),
    },
  })

  mainWindow.once('ready-to-show', () => mainWindow.show())

  // Applied after load rather than at construction: zoom is a property of the
  // loaded document, so setting it earlier is discarded by the first navigation.
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow?.webContents.setZoomFactor(UI_ZOOM)
  })

  mainWindow.webContents.on('before-input-event', (_, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') mainWindow.webContents.toggleDevTools()
  })

  mainWindow.on('closed', () => { mainWindow = null })

  mainWindow.loadURL(`http://127.0.0.1:${port}/`)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
