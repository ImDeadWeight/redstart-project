// =============================================================================
// Redstart Nest — Electron main process
// =============================================================================
// This is the heart of the application. I chose Electron because it lets me
// ship a native Windows desktop app that can manage OS-level processes (like
// launching llama-server.exe) while still using web technologies for the UI.
//
// The overall design: Redstart Nest is a launcher and monitor for llama.cpp. It
// doesn't do any AI inference itself — it just starts the llama-server binary
// with the right arguments and then gets out of the way. The actual model
// runs in llama-server, which also serves the chat UI directly via --path.
//
// Key architectural decisions documented inline below.
// =============================================================================

import { app, BrowserWindow, ipcMain, dialog, nativeImage, session } from 'electron'
import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import * as path from 'path'
import * as fs from 'fs'
import { BUILTIN_TOOLS, BUILTIN_GROUPS, BUILTIN_CAPABILITIES, expandDisabledToolIds } from './tools-definitions.mjs'
import { getUserTools, getUserGroups, addUserTool, deleteUserTool, addUserGroup, deleteUserGroup, getExternalServers, addExternalServer, deleteExternalServer, getCapabilities, setCapabilityConfig, ensureDefaultCapabilityFolders } from './tools-storage.mjs'
import { startGateway, stopGateway, updateGatewayConfig, getGatewayPort } from './tools-gateway.mjs'
import { startMcpServer, stopMcpServer, updateMcpConfig, getMcpServerRunning, closeAllMcpSessions, estimateActiveToolTokens } from './mcp-server.mjs'
import { getAuthRequired, setAuthRequired, hasOwner, createOwner } from './auth.mjs'
import { encryptSecret, decryptSecret } from './secrets.mjs'
import { testConnection as testPostgresConnection } from './postgres-tool.mjs'
import * as crypto from 'crypto'
import * as os from 'os'
import * as zlib from 'zlib'
import * as http from 'http'
import { startBeaconServer, stopBeaconServer } from './beacon.mjs'
import { startMdnsAdvertiser, stopMdnsAdvertiser } from './mdns-advertiser.mjs'
import { startPort80Proxy, stopPort80Proxy } from './port80-proxy.mjs'
import { cleanupOldConversations } from './conversations-storage.mjs'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const execFileAsync = promisify(execFile)

// ---------------------------------------------------------------------------
// Redstart pixel-art icon — minimal PNG encoder + 32×32 American Redstart bust
// (placeholder design — a graphic artist will replace this). I wrote a
// minimal PNG encoder from scratch here rather than pulling in an image
// library. The icon is only 32×32 pixels and I didn't want to add a
// dependency just to display a taskbar icon. Node's built-in zlib handles the
// deflate compression that PNG requires, so the only cost is a little code.
// ---------------------------------------------------------------------------

function pngEncode(width, height, getPixel) {
  function crc32(buf) {
    const t = new Uint32Array(256)
    for (let i = 0; i < 256; i++) {
      let c = i
      for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
      t[i] = c
    }
    let v = 0xFFFFFFFF
    for (let i = 0; i < buf.length; i++) v = t[(v ^ buf[i]) & 0xFF] ^ (v >>> 8)
    return (v ^ 0xFFFFFFFF) >>> 0
  }
  function mkchunk(type, data) {
    const tb = Buffer.from(type, 'ascii')
    const lb = Buffer.allocUnsafe(4); lb.writeUInt32BE(data.length, 0)
    const cb = Buffer.allocUnsafe(4); cb.writeUInt32BE(crc32(Buffer.concat([tb, data])), 0)
    return Buffer.concat([lb, tb, data, cb])
  }
  const ihdr = Buffer.allocUnsafe(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  const rows = []
  for (let y = 0; y < height; y++) {
    rows.push(0) // filter byte: None
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = getPixel(x, y)
      rows.push(r, g, b, a)
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    mkchunk('IHDR', ihdr),
    mkchunk('IDAT', zlib.deflateSync(Buffer.from(rows))),
    mkchunk('IEND', Buffer.alloc(0)),
  ])
}

function makeRedstartIconPng() {
  // Color palette (RGBA)
  const _ = [0,0,0,0], K = [28,25,23,255], O = [249,115,22,255]
  const R = [194,65,12,255], W = [250,250,249,255], Y = [217,119,6,255]
  // 32×32 pixel art: American Redstart bust (placeholder — designed as a
  // starting point for a graphic artist to replace). Front-facing head on a
  // wide chest, orange flank flashes (the redstart's actual field mark) with
  // rust shading beneath, white throat, small crest, amber beak.
  const g = [
    [_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
    [_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,K,K,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
    [_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,K,K,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
    [_,_,_,_,_,_,_,_,_,_,_,_,_,K,K,K,K,K,K,_,_,_,_,_,_,_,_,_,_,_,_,_],
    [_,_,_,_,_,_,_,_,_,_,_,_,K,K,K,K,K,K,K,K,_,_,_,_,_,_,_,_,_,_,_,_],
    [_,_,_,_,_,_,_,_,_,_,_,K,K,K,K,K,K,K,K,K,K,_,_,_,_,_,_,_,_,_,_,_],
    [_,_,_,_,_,_,_,_,_,_,K,K,K,K,K,K,K,K,K,K,K,K,_,_,_,_,_,_,_,_,_,_],
    [_,_,_,_,_,_,_,_,_,_,K,K,K,K,K,K,K,K,K,K,K,K,_,_,_,_,_,_,_,_,_,_],
    [_,_,_,_,_,_,_,_,_,_,K,K,W,W,K,K,K,K,W,W,K,K,_,_,_,_,_,_,_,_,_,_],
    [_,_,_,_,_,_,_,_,_,_,K,K,W,W,K,K,K,K,W,W,K,K,_,_,_,_,_,_,_,_,_,_],
    [_,_,_,_,_,_,_,_,_,_,K,K,K,K,K,K,K,K,K,K,K,K,_,_,_,_,_,_,_,_,_,_],
    [_,_,_,_,_,_,_,_,_,_,K,K,K,K,K,K,K,K,K,K,K,K,_,_,_,_,_,_,_,_,_,_],
    [_,_,_,_,_,O,O,O,_,_,_,K,K,K,K,K,K,K,K,K,K,_,_,_,O,O,O,_,_,_,_,_],
    [_,_,_,_,O,O,O,O,O,_,_,_,K,K,K,Y,Y,K,K,K,_,_,_,O,O,O,O,O,_,_,_,_],
    [_,_,_,_,O,O,O,O,O,O,_,K,K,K,K,Y,Y,K,K,K,K,_,O,O,O,O,O,O,_,_,_,_],
    [_,_,_,_,O,O,O,O,O,O,_,_,K,K,K,K,K,K,K,K,_,_,O,O,O,O,O,O,_,_,_,_],
    [_,_,_,_,O,O,O,O,O,O,_,K,K,K,K,K,K,K,K,K,K,_,O,O,O,O,O,O,_,_,_,_],
    [_,_,_,_,O,O,O,O,O,O,K,K,K,W,K,K,K,K,W,K,K,K,O,O,O,O,O,O,_,_,_,_],
    [_,_,_,_,O,O,O,O,O,O,O,K,W,W,W,W,W,W,W,W,K,O,O,O,O,O,O,O,_,_,_,_],
    [_,_,_,_,O,R,R,O,O,O,O,W,W,W,W,W,W,W,W,W,W,O,O,O,O,R,R,O,_,_,_,_],
    [_,_,_,_,R,R,R,R,O,O,O,W,W,W,W,W,W,W,W,W,W,O,O,O,R,R,R,R,_,_,_,_],
    [_,_,_,_,R,R,R,R,R,O,K,W,W,W,W,W,W,W,W,W,W,K,O,R,R,R,R,R,_,_,_,_],
    [_,_,_,_,R,R,R,R,R,O,K,W,W,W,W,W,W,W,W,W,W,K,O,R,R,R,R,R,_,_,_,_],
    [_,_,_,_,R,R,R,R,R,O,K,W,W,W,W,W,W,W,W,W,W,K,O,R,R,R,R,R,_,_,_,_],
    [_,_,_,_,R,R,R,R,K,K,K,W,W,W,W,W,W,W,W,W,W,K,K,K,R,R,R,R,_,_,_,_],
    [_,_,_,_,_,_,R,K,K,K,K,K,W,W,W,W,W,W,W,W,K,K,K,K,K,R,_,_,_,_,_,_],
    [_,_,_,_,_,_,_,_,K,K,K,K,K,W,W,W,W,W,W,K,K,K,K,K,_,_,_,_,_,_,_,_],
    [_,_,_,_,_,_,_,_,K,K,K,K,K,K,K,K,K,K,K,K,K,K,K,K,_,_,_,_,_,_,_,_],
    [_,_,_,_,_,_,_,_,_,_,K,K,K,K,K,K,K,K,K,K,K,K,_,_,_,_,_,_,_,_,_,_],
    [_,_,_,_,_,_,_,_,_,_,_,K,K,K,K,K,K,K,K,K,K,_,_,_,_,_,_,_,_,_,_,_],
    [_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
    [_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
  ]
  return pngEncode(32, 32, (x, y) => g[y][x])
}

// SVG version of the same icon — injected as favicon into the chat window
const REDSTART_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" shape-rendering="crispEdges">',
  '<rect x="15" y="1" width="2" height="1" fill="#1c1917"/>',
  '<rect x="15" y="2" width="2" height="1" fill="#1c1917"/>',
  '<rect x="13" y="3" width="6" height="1" fill="#1c1917"/>',
  '<rect x="12" y="4" width="8" height="1" fill="#1c1917"/>',
  '<rect x="11" y="5" width="10" height="1" fill="#1c1917"/>',
  '<rect x="10" y="6" width="12" height="1" fill="#1c1917"/>',
  '<rect x="10" y="7" width="12" height="1" fill="#1c1917"/>',
  '<rect x="10" y="8" width="2" height="1" fill="#1c1917"/>',
  '<rect x="12" y="8" width="2" height="1" fill="#fafaf9"/>',
  '<rect x="14" y="8" width="4" height="1" fill="#1c1917"/>',
  '<rect x="18" y="8" width="2" height="1" fill="#fafaf9"/>',
  '<rect x="20" y="8" width="2" height="1" fill="#1c1917"/>',
  '<rect x="10" y="9" width="2" height="1" fill="#1c1917"/>',
  '<rect x="12" y="9" width="2" height="1" fill="#fafaf9"/>',
  '<rect x="14" y="9" width="4" height="1" fill="#1c1917"/>',
  '<rect x="18" y="9" width="2" height="1" fill="#fafaf9"/>',
  '<rect x="20" y="9" width="2" height="1" fill="#1c1917"/>',
  '<rect x="10" y="10" width="12" height="1" fill="#1c1917"/>',
  '<rect x="10" y="11" width="12" height="1" fill="#1c1917"/>',
  '<rect x="5" y="12" width="3" height="1" fill="#f97316"/>',
  '<rect x="11" y="12" width="10" height="1" fill="#1c1917"/>',
  '<rect x="24" y="12" width="3" height="1" fill="#f97316"/>',
  '<rect x="4" y="13" width="5" height="1" fill="#f97316"/>',
  '<rect x="12" y="13" width="3" height="1" fill="#1c1917"/>',
  '<rect x="15" y="13" width="2" height="1" fill="#d97706"/>',
  '<rect x="17" y="13" width="3" height="1" fill="#1c1917"/>',
  '<rect x="23" y="13" width="5" height="1" fill="#f97316"/>',
  '<rect x="4" y="14" width="6" height="1" fill="#f97316"/>',
  '<rect x="11" y="14" width="4" height="1" fill="#1c1917"/>',
  '<rect x="15" y="14" width="2" height="1" fill="#d97706"/>',
  '<rect x="17" y="14" width="4" height="1" fill="#1c1917"/>',
  '<rect x="22" y="14" width="6" height="1" fill="#f97316"/>',
  '<rect x="4" y="15" width="6" height="1" fill="#f97316"/>',
  '<rect x="12" y="15" width="8" height="1" fill="#1c1917"/>',
  '<rect x="22" y="15" width="6" height="1" fill="#f97316"/>',
  '<rect x="4" y="16" width="6" height="1" fill="#f97316"/>',
  '<rect x="11" y="16" width="10" height="1" fill="#1c1917"/>',
  '<rect x="22" y="16" width="6" height="1" fill="#f97316"/>',
  '<rect x="4" y="17" width="6" height="1" fill="#f97316"/>',
  '<rect x="10" y="17" width="3" height="1" fill="#1c1917"/>',
  '<rect x="13" y="17" width="1" height="1" fill="#fafaf9"/>',
  '<rect x="14" y="17" width="4" height="1" fill="#1c1917"/>',
  '<rect x="18" y="17" width="1" height="1" fill="#fafaf9"/>',
  '<rect x="19" y="17" width="3" height="1" fill="#1c1917"/>',
  '<rect x="22" y="17" width="6" height="1" fill="#f97316"/>',
  '<rect x="4" y="18" width="7" height="1" fill="#f97316"/>',
  '<rect x="11" y="18" width="1" height="1" fill="#1c1917"/>',
  '<rect x="12" y="18" width="8" height="1" fill="#fafaf9"/>',
  '<rect x="20" y="18" width="1" height="1" fill="#1c1917"/>',
  '<rect x="21" y="18" width="7" height="1" fill="#f97316"/>',
  '<rect x="4" y="19" width="1" height="1" fill="#f97316"/>',
  '<rect x="5" y="19" width="2" height="1" fill="#c2410c"/>',
  '<rect x="7" y="19" width="4" height="1" fill="#f97316"/>',
  '<rect x="11" y="19" width="10" height="1" fill="#fafaf9"/>',
  '<rect x="21" y="19" width="4" height="1" fill="#f97316"/>',
  '<rect x="25" y="19" width="2" height="1" fill="#c2410c"/>',
  '<rect x="27" y="19" width="1" height="1" fill="#f97316"/>',
  '<rect x="4" y="20" width="4" height="1" fill="#c2410c"/>',
  '<rect x="8" y="20" width="3" height="1" fill="#f97316"/>',
  '<rect x="11" y="20" width="10" height="1" fill="#fafaf9"/>',
  '<rect x="21" y="20" width="3" height="1" fill="#f97316"/>',
  '<rect x="24" y="20" width="4" height="1" fill="#c2410c"/>',
  '<rect x="4" y="21" width="5" height="1" fill="#c2410c"/>',
  '<rect x="9" y="21" width="1" height="1" fill="#f97316"/>',
  '<rect x="10" y="21" width="1" height="1" fill="#1c1917"/>',
  '<rect x="11" y="21" width="10" height="1" fill="#fafaf9"/>',
  '<rect x="21" y="21" width="1" height="1" fill="#1c1917"/>',
  '<rect x="22" y="21" width="1" height="1" fill="#f97316"/>',
  '<rect x="23" y="21" width="5" height="1" fill="#c2410c"/>',
  '<rect x="4" y="22" width="5" height="1" fill="#c2410c"/>',
  '<rect x="9" y="22" width="1" height="1" fill="#f97316"/>',
  '<rect x="10" y="22" width="1" height="1" fill="#1c1917"/>',
  '<rect x="11" y="22" width="10" height="1" fill="#fafaf9"/>',
  '<rect x="21" y="22" width="1" height="1" fill="#1c1917"/>',
  '<rect x="22" y="22" width="1" height="1" fill="#f97316"/>',
  '<rect x="23" y="22" width="5" height="1" fill="#c2410c"/>',
  '<rect x="4" y="23" width="5" height="1" fill="#c2410c"/>',
  '<rect x="9" y="23" width="1" height="1" fill="#f97316"/>',
  '<rect x="10" y="23" width="1" height="1" fill="#1c1917"/>',
  '<rect x="11" y="23" width="10" height="1" fill="#fafaf9"/>',
  '<rect x="21" y="23" width="1" height="1" fill="#1c1917"/>',
  '<rect x="22" y="23" width="1" height="1" fill="#f97316"/>',
  '<rect x="23" y="23" width="5" height="1" fill="#c2410c"/>',
  '<rect x="4" y="24" width="4" height="1" fill="#c2410c"/>',
  '<rect x="8" y="24" width="3" height="1" fill="#1c1917"/>',
  '<rect x="11" y="24" width="10" height="1" fill="#fafaf9"/>',
  '<rect x="21" y="24" width="3" height="1" fill="#1c1917"/>',
  '<rect x="24" y="24" width="4" height="1" fill="#c2410c"/>',
  '<rect x="6" y="25" width="1" height="1" fill="#c2410c"/>',
  '<rect x="7" y="25" width="5" height="1" fill="#1c1917"/>',
  '<rect x="12" y="25" width="8" height="1" fill="#fafaf9"/>',
  '<rect x="20" y="25" width="5" height="1" fill="#1c1917"/>',
  '<rect x="25" y="25" width="1" height="1" fill="#c2410c"/>',
  '<rect x="8" y="26" width="5" height="1" fill="#1c1917"/>',
  '<rect x="13" y="26" width="6" height="1" fill="#fafaf9"/>',
  '<rect x="19" y="26" width="5" height="1" fill="#1c1917"/>',
  '<rect x="8" y="27" width="16" height="1" fill="#1c1917"/>',
  '<rect x="10" y="28" width="12" height="1" fill="#1c1917"/>',
  '<rect x="11" y="29" width="10" height="1" fill="#1c1917"/>',
  '</svg>',
].join('')

const REDSTART_FAVICON = 'data:image/svg+xml;base64,' + Buffer.from(REDSTART_SVG).toString('base64')

// HTML injected before </head> on every page load via the redstart-chat:// protocol.
// The script runs immediately (before Svelte boots) and uses a MutationObserver
// to catch the greeting headline once Svelte has rendered it.
const HEAD_INJECT = [
  '<title>Redstart</title>',
  `<link rel="icon" type="image/svg+xml" href="${REDSTART_FAVICON}"/>`,
  '<link rel="stylesheet" href="/redstart-theme.css"/>',
  '<script>',
  '  try { localStorage.setItem("mode-watcher-mode","dark") } catch {}',
  '  document.documentElement.classList.add("dark")',
  '  new MutationObserver(function(ms) {',
  '    for (var m of ms) if (m.attributeName==="class" && !document.documentElement.classList.contains("dark")) document.documentElement.classList.add("dark")',
  '  }).observe(document.documentElement,{attributes:true,attributeFilter:["class"]})',
  '  ;(function(){',
  '    function patch(){var h=document.querySelector("h1");if(h&&h.textContent.trim()==="Hello there"){h.textContent="Hello! I\'m Redstart!";return true}return false}',
  '    if(!patch()){var o=new MutationObserver(function(){if(patch())o.disconnect()});o.observe(document.body,{childList:true,subtree:true});setTimeout(function(){o.disconnect()},8000)}',
  '  })()',
  '</script>',
].join('\n')

// Shown in the chat window while the llama-server is still loading its model.
// meta-refresh retries every 2 s; once the server responds with HTML our proxy
// takes over and injects the full Redstart theme.
const WAITING_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="refresh" content="2">
<title>Redstart — Connecting…</title>
<link rel="icon" type="image/svg+xml" href="${REDSTART_FAVICON}"/>
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;background:#09090b;display:flex;align-items:center;justify-content:center;font-family:ui-monospace,monospace;color:#a1a1aa}
h2{font-size:1rem;font-weight:600;color:#f97316;margin-bottom:.5rem}
p{font-size:.75rem}
.dot{animation:blink 1.4s infinite both}
.dot:nth-child(2){animation-delay:.2s}
.dot:nth-child(3){animation-delay:.4s}
@keyframes blink{0%,80%,100%{opacity:0}40%{opacity:1}}
</style>
</head>
<body>
<div style="text-align:center">
<h2>Connecting to llama-server<span class="dot">.</span><span class="dot">.</span><span class="dot">.</span></h2>
<p>The model is loading — this page will refresh automatically.</p>
</div>
</body>
</html>`

let redstartIcon
try {
  redstartIcon = nativeImage.createFromBuffer(makeRedstartIconPng())
} catch (err) {
  console.error('Redstart icon generation failed:', err)
  redstartIcon = null
}

let mainWindow = null
let serverProcess = null
let serverEma = 0
const EMA_ALPHA = 0.2

let lastServerConfig = null  // set on launch, cleared on stop/exit
let beaconServerInstance = null

// ---------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------

function getSettingsPath() {
  return path.join(app.getPath('userData'), 'settings.json')
}

function readSettings() {
  const p = getSettingsPath()
  if (!fs.existsSync(p)) return {}
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return {} }
}

function writeSettings(data) {
  fs.writeFileSync(getSettingsPath(), JSON.stringify(data, null, 2), 'utf8')
}

// ---------------------------------------------------------------------------
// userData migration (Beaver -> Redstart rename)
// ---------------------------------------------------------------------------
// package.json's "name" changed from "beaver" to "redstart", which moves
// Electron's userData directory from %APPDATA%\beaver\ to %APPDATA%\redstart\.
// This copies the old profile/account/tool/settings files over once so an
// existing install doesn't look wiped after the update. One-time and
// idempotent: only copies a file if it doesn't already exist at the new
// location, and only if the old directory is actually there. Must run before
// anything reads profiles.json/accounts.json/tools.json/settings.json.
function migrateUserDataFromBeaver() {
  const newDir = app.getPath('userData')
  const oldDir = path.join(app.getPath('appData'), 'beaver')
  if (oldDir === newDir || !fs.existsSync(oldDir)) return

  const files = ['profiles.json', 'accounts.json', 'tools.json', 'settings.json']
  for (const file of files) {
    const oldPath = path.join(oldDir, file)
    const newPath = path.join(newDir, file)
    if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
      fs.mkdirSync(newDir, { recursive: true })
      fs.copyFileSync(oldPath, newPath)
      console.log(`Migrated ${file} from the old Beaver userData directory`)
    }
  }
}

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

function resolveBinary() {
  const settings = readSettings()
  if (settings.serverBinPath && fs.existsSync(settings.serverBinPath)) {
    return settings.serverBinPath
  }

  const candidates = []

  if (app.isPackaged) {
    // Packaged: binary is placed at resources/bin/ via extraResources in electron-builder.json
    candidates.push(path.join(process.resourcesPath, 'bin', 'llama-server.exe'))
  } else {
    // Dev: look in the project tree
    const projectRoot = path.join(__dirname, '..', '..')
    candidates.push(
      path.join(projectRoot, 'llama-cpp-turboquant', 'build', 'bin', 'Release', 'llama-server.exe'),
      path.join(projectRoot, 'llama-server.exe'),
      path.join(process.cwd(), 'llama-server.exe'),
    )
  }

  return candidates.find(p => fs.existsSync(p)) || null
}

// ---------------------------------------------------------------------------
// Tool gateway config builder
// ---------------------------------------------------------------------------
// Resolves a profile's tool settings (group/tool IDs) into a flat list of
// allowed base URLs for the gateway. Called whenever the server starts or the
// user applies a profile change while the server is running.

function buildGatewayConfig(llamaConfig) {
  const toolSettings = llamaConfig?.tools

  // Server-enforced tool bans. The admin disables capability/tool IDs at the
  // profile level; expand them to the concrete MCP function names the model
  // sees so the gateway can strip them from every completions request.
  const disabledTools = expandDisabledToolIds(toolSettings?.disabledToolIds)

  const allTools = [
    ...BUILTIN_TOOLS.map(t => ({ ...t, builtIn: true })),
    ...getUserTools(),
  ]
  const allGroups = [
    ...BUILTIN_GROUPS.map(g => ({ ...g, builtIn: true })),
    ...getUserGroups(),
  ]

  if (!toolSettings?.enabled) {
    return {
      disabledTools,
      webFetch: { enabled: false, whitelistEnabled: true, allowedBaseUrls: [], activeTools: [], maxFetchTokens: 2000 },
      postgres: { enabled: false },
      documents: { enabled: false },
      sqlite: { enabled: false },
      vault:     { enabled: false },
      file_system: { enabled: false },
      git:       { enabled: false },
      scholar: { enabled: false },
    }
  }

  const toolIdSet = new Set(toolSettings.activeToolIds || [])

  // Add all tool IDs from active groups
  for (const groupId of (toolSettings.activeGroupIds || [])) {
    const group = allGroups.find(g => g.id === groupId)
    if (group) group.toolIds.forEach(id => toolIdSet.add(id))
  }

  const allowedBaseUrls = []
  const activeTools = []
  for (const id of toolIdSet) {
    const tool = allTools.find(t => t.id === id)
    if (tool?.baseUrl) {
      allowedBaseUrls.push(tool.baseUrl)
      activeTools.push({ name: tool.name, baseUrl: tool.baseUrl, description: tool.description || '' })
    }
  }

  // Capability providers (Postgres, Documents) are only active for this
  // profile when BOTH the admin has configured+enabled them globally AND
  // this profile's activeToolIds includes them — same relationship
  // externalServers already have to profiles, extended with a per-profile flag.
  const capabilities = getCapabilities()

  const postgresWanted = toolIdSet.has('postgres') && capabilities.postgres.enabled && !!capabilities.postgres.connectionStringEnc
  let postgresConnectionString = null
  if (postgresWanted) {
    try {
      postgresConnectionString = decryptSecret(capabilities.postgres.connectionStringEnc)
    } catch (err) {
      console.warn('Failed to decrypt Postgres connection string:', err.message)
    }
  }

  const documentsWanted = toolIdSet.has('documents') && capabilities.documents.enabled && !!capabilities.documents.outputDir
  const sqliteWanted = toolIdSet.has('sqlite') && capabilities.sqlite.enabled && !!capabilities.sqlite.rootDir
  const vaultWanted = toolIdSet.has('vault') && capabilities.vault.enabled && !!capabilities.vault.rootDir
  const gitWanted = toolIdSet.has('git') && capabilities.git.enabled && !!capabilities.git.rootDir
  const fileSystemWanted = toolIdSet.has('file_system') && capabilities.file_system.enabled && !!capabilities.file_system.rootDir
  const scholarWanted = toolIdSet.has('scholar') && capabilities.scholar.enabled

  return {
    disabledTools,
    webFetch: {
      enabled: true,
      // Per-profile toggle: with the whitelist OFF the model may fetch any
      // public http(s) URL (private/LAN addresses always blocked in the
      // provider). Defaults to ON — restriction is the out-of-box posture.
      whitelistEnabled: toolSettings.whitelistEnabled !== false,
      allowedBaseUrls,
      activeTools,
      maxFetchTokens: toolSettings.maxFetchTokens ?? 2000,
    },
    postgres: {
      enabled: postgresWanted && !!postgresConnectionString,
      connectionString: postgresConnectionString,
      maxRows: capabilities.postgres.maxRows,
    },
    documents: {
      enabled: documentsWanted,
      outputDir: capabilities.documents.outputDir,
    },
    sqlite: {
      enabled: sqliteWanted,
      rootDir: capabilities.sqlite.rootDir,
      maxRows: capabilities.sqlite.maxRows,
      maxFileBytes: capabilities.sqlite.maxFileBytes,
    },
    vault: {
      enabled: vaultWanted,
      rootDir: capabilities.vault.rootDir,
    },
    git: {
      enabled: gitWanted,
      rootDir: capabilities.git.rootDir,
    },
    file_system: {
      enabled: fileSystemWanted,
      rootDir: capabilities.file_system.rootDir,
    },
    scholar: {
      enabled: scholarWanted,
      venueFilter: capabilities.scholar.venueFilter,
      // PDFs land in the Documents folder so read_document can pick them up.
      saveDir: capabilities.documents.outputDir,
    },
  }
}

// Re-resolves and pushes tool config to the already-running gateway/MCP
// server — used after a capability's global config changes (connection
// string, output folder) so a change takes effect without a full restart.
// No-op if the server isn't running or no profile has been launched yet.
function refreshLiveToolsConfig() {
  if (!lastServerConfig) return
  if (!getGatewayPort(lastServerConfig.port ?? 19080)) return
  const cfg = buildGatewayConfig(lastServerConfig)
  updateGatewayConfig(cfg)
  updateMcpConfig(cfg)
}

// ---------------------------------------------------------------------------
// Profile helpers
// ---------------------------------------------------------------------------

function getProfilesPath() {
  return path.join(app.getPath('userData'), 'profiles.json')
}

function readProfiles() {
  const p = getProfilesPath()
  if (!fs.existsSync(p)) return { profiles: {} }
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return { profiles: {} } }
}

function writeProfiles(data) {
  fs.writeFileSync(getProfilesPath(), JSON.stringify(data, null, 2), 'utf8')
}

// ---------------------------------------------------------------------------
// Network helpers
// ---------------------------------------------------------------------------

function getLocalIp() {
  const interfaces = os.networkInterfaces()
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address
    }
  }
  return '127.0.0.1'
}

// ---------------------------------------------------------------------------
// Token EMA parser
// ---------------------------------------------------------------------------

function parseEvalTokensPerSec(line) {
  // llama_print_timings:        eval time = ... X tokens per second)
  const match = line.match(/eval time\s+=.+?(\d+\.?\d*)\s+tokens per second/)
  return match ? parseFloat(match[1]) : null
}

// ---------------------------------------------------------------------------
// Server health poll
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Discovery beacon server
// Runs on a fixed port (8765) as long as Redstart Nest is open, regardless of
// whether a llama-server is running. Redstart Twig scans for this beacon to
// confirm it found a real Redstart Nest instance and to get the actual server URL.
// ---------------------------------------------------------------------------

async function startDiscoveryBeacon() {
  beaconServerInstance = await startBeaconServer(
    () => !!serverProcess,
    () => lastServerConfig?.port ?? 19080,
  )
  console.log(`Redstart Nest beacon listening on port 8765`)
}

// ---------------------------------------------------------------------------
// Redstart proxy server
// ---------------------------------------------------------------------------
// Chat UI is served directly by llama-server via --path and accessed through
// the gateway in any browser. No captive BrowserWindow or local proxy needed.
// ---------------------------------------------------------------------------

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self' http://127.0.0.1:* https://127.0.0.1:* ws://127.0.0.1:* wss://127.0.0.1:* https://api.github.com",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
].join('; ')

function applyCSP(session) {
  session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [CSP],
      },
    })
  })
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 800,
    icon: redstartIcon,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.mjs'),
    },
  })

  if (!app.isPackaged) {
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', '..', 'dist', 'index.html'))
  }
}

// The launcher and chat windows are plain UI (no WebGL/canvas-heavy work) —
// disabling GPU compositing frees the CUDA device from competing with
// llama-server's own inference workload for the same GPU.
app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  migrateUserDataFromBeaver()
  // Pre-provision default capability folders (<Documents>\Redstart\...) so
  // Documents/SQLite/Vault/Git are one-click enable out of the box. Fills
  // only unset paths — a user-chosen folder is never overridden — and leaves
  // every capability disabled.
  ensureDefaultCapabilityFolders(path.join(app.getPath('documents'), 'Redstart'))
  applyCSP(session.defaultSession)
  killOrphanedServers()
  const cleanedConversations = cleanupOldConversations()
  if (cleanedConversations > 0) console.log(`Cleaned ${cleanedConversations} conversations older than 30 days`)
  startDiscoveryBeacon()
  createWindow()
  setupIpcHandlers()
})

function killOrphanedServers() {
  // I call this both at startup and before the app quits. The startup call
  // handles the case where a previous session crashed without cleaning up —
  // if a stale llama-server.exe is still running, it holds port 19080 and the
  // next launch silently fails. The quit call is a best-effort safety net for
  // the normal exit path, though the child process should exit on its own too.
  try {
    execFile('taskkill', ['/F', '/IM', 'llama-server.exe'], () => {})
  } catch { /* no orphans, fine */ }
}

// Ensure Windows Firewall has an inbound rule for the gateway port so LAN
// clients can reach it. Checks first (no elevation) and only calls elevate.exe
// if the rule is missing — so UAC only fires once per port, ever.
function ensureFirewallRule(gatewayPort) {
  if (process.platform !== 'win32') return
  const ruleName = `RedstartNest Gateway ${gatewayPort}`

  execFile('netsh', ['advfirewall', 'firewall', 'show', 'rule', `name=${ruleName}`, 'dir=in'],
    (_err, stdout) => {
      if (stdout && stdout.includes(ruleName)) return // Rule already present

      const elevatePath = app.isPackaged
        ? path.join(process.resourcesPath, 'elevate.exe')
        : null
      if (!elevatePath || !fs.existsSync(elevatePath)) {
        console.warn(`Gateway firewall: elevate.exe not found, skipping rule for port ${gatewayPort}`)
        return
      }

      execFile(elevatePath, [
        'netsh', 'advfirewall', 'firewall', 'add', 'rule',
        `name=${ruleName}`,
        'dir=in', 'action=allow', 'protocol=TCP',
        `localport=${gatewayPort}`,
      ], err => {
        if (err) console.warn(`Could not add firewall rule for gateway port ${gatewayPort}:`, err.message)
      })
    }
  )
}

app.on('before-quit', () => {
  killOrphanedServers()
  stopGateway()
  stopMcpServer()
  stopMdnsAdvertiser()
  stopPort80Proxy()
  if (serverProcess) {
    serverProcess = null
  }
  if (beaconServerInstance) {
    stopBeaconServer(beaconServerInstance)
    beaconServerInstance = null
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------

function setupIpcHandlers() {

  // --- Hardware ---

  ipcMain.handle('hardware:scan', async () => {
    const specs = {
      cpu: { name: '', cores: 0, threads: 0, architecture: process.arch, supportsAVX: false },
      gpu: { name: '', vram: 0, cudaAvailable: false },
      memory: { total: 0, available: 0 },
      os: { platform: process.platform, arch: process.arch },
    }

    // Single PowerShell call queries everything and returns JSON — no wmic, no header-row parsing bug
    const psScript = `
$r = @{ cpu = @{ name=''; cores=0; threads=0 }; memory = @{ totalBytes=0 }; gpu = @{ name=''; vramMb=0; cuda=$false } }
try {
  $c = Get-CimInstance Win32_Processor | Select-Object -First 1
  $r.cpu.name    = [string]$c.Name
  $r.cpu.cores   = [int]$c.NumberOfCores
  $r.cpu.threads = [int]$c.NumberOfLogicalProcessors
} catch {}
try {
  $r.memory.totalBytes = [long](Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory
} catch {}
try {
  $nv = & nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits 2>$null
  if ($nv) {
    $p = $nv -split ','
    $r.gpu.name   = $p[0].Trim()
    $r.gpu.vramMb = [int]$p[1].Trim()
    $r.gpu.cuda   = $true
  }
} catch {}
if (-not $r.gpu.cuda) {
  try {
    $g = Get-CimInstance Win32_VideoController | Select-Object -First 1
    $r.gpu.name   = [string]$g.Name
    $r.gpu.vramMb = if ($g.AdapterRAM) { [int]([Math]::Round($g.AdapterRAM / 1MB)) } else { 0 }
  } catch {}
}
$r | ConvertTo-Json -Compress
`
    try {
      const out = await execFileAsync('powershell', [
        '-NoProfile', '-NonInteractive', '-Command', psScript,
      ])
      const raw = JSON.parse(out.stdout.trim())
      specs.cpu.name    = raw.cpu?.name    || ''
      specs.cpu.cores   = raw.cpu?.cores   || 0
      specs.cpu.threads = raw.cpu?.threads || 0
      specs.memory.total       = (raw.memory?.totalBytes || 0) / (1024 ** 3)
      specs.gpu.name           = raw.gpu?.name   || ''
      specs.gpu.vram           = raw.gpu?.vramMb || 0
      specs.gpu.cudaAvailable  = !!raw.gpu?.cuda
      specs.cpu.supportsAVX    = /AVX/i.test(specs.cpu.name) ||
                                  /AVX/i.test(process.env.PROCESSOR_IDENTIFIER || '')
    } catch (e) {
      console.error('Hardware scan error:', e)
    }

    return specs
  })

  ipcMain.handle('hardware:select-model', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'GGUF Models', extensions: ['gguf'] }, { name: 'All Files', extensions: ['*'] }],
    })
    return result.canceled ? null : result.filePaths[0]
  })

  // --- Profiles ---

  ipcMain.handle('profiles:list', () => {
    const data = readProfiles()
    return Object.keys(data.profiles)
  })

  ipcMain.handle('profiles:save', (_, name, config) => {
    const data = readProfiles()
    data.profiles[name] = config
    writeProfiles(data)
    return true
  })

  ipcMain.handle('profiles:load', (_, name) => {
    const data = readProfiles()
    return data.profiles[name] || null
  })

  ipcMain.handle('profiles:delete', (_, name) => {
    const data = readProfiles()
    delete data.profiles[name]
    writeProfiles(data)
    return true
  })

  ipcMain.handle('profiles:generate-defaults', (_, hardware) => {
    const { cpu } = hardware

    // Physical cores give better LLM throughput than logical (hyperthreads
    // fight each other for cache on inference workloads)
    const physCores    = cpu.cores   || Math.ceil((cpu.threads || 4) / 2)
    const inferThreads = Math.max(4, Math.min(physCores, 12))

    // gpuLayers/nCpuMoe are left undefined here on purpose — omitting -ngl and
    // --n-cpu-moe lets llama-server's own --fit (on by default) decide both,
    // live against actual free VRAM and the model's real tensor sizes at load
    // time. That's strictly better than a JS estimate computed once from total
    // VRAM at hardware-scan time. Users who want a fixed value can still set
    // one manually in the UI — buildArgs() only omits the flag when unset.
    const assistant = {
      name: 'Assistant',
      modelPath: '',
      ctxSize: 4096,
      batchSize: 256,
      threads: inferThreads,
      port: 19080,
      host: '127.0.0.1',
      kvCache: 'balanced',
      additionalArgs: '',
      advertisedHost: 'redstart.local',
    }

    const productivity = {
      name: 'Productivity',
      modelPath: '',
      ctxSize: 16384,
      batchSize: 512,
      threads: inferThreads,
      port: 19080,
      host: '127.0.0.1',
      kvCache: 'balanced',
      additionalArgs: '',
      advertisedHost: 'redstart.local',
    }

    const data = readProfiles()
    // Remove old profile names from previous versions so users don't accidentally
    // load a stale entry with gpuLayers:99
    delete data.profiles['Agent / Productivity']
    data.profiles['Assistant']    = assistant
    data.profiles['Productivity'] = productivity
    writeProfiles(data)
    return [assistant, productivity]
  })

  // --- Tools ---

  ipcMain.handle('tools:list-all', () => {
    return {
      builtinTools:        BUILTIN_TOOLS,
      builtinGroups:       BUILTIN_GROUPS,
      builtinCapabilities: BUILTIN_CAPABILITIES,
      userTools:           getUserTools(),
      userGroups:          getUserGroups(),
    }
  })

  ipcMain.handle('tools:add-tool', (_, tool) => addUserTool(tool))
  ipcMain.handle('tools:delete-tool', (_, id) => deleteUserTool(id))
  ipcMain.handle('tools:add-group', (_, group) => addUserGroup(group))
  ipcMain.handle('tools:delete-group', (_, id) => deleteUserGroup(id))

  // Apply a live tool config change without restarting the server.
  // Called when the user saves a profile that has tools configured while the
  // server is already running.
  ipcMain.handle('tools:apply-config', (_, llamaConfig) => {
    if (!getGatewayPort(llamaConfig?.port ?? 19080)) return false
    const cfg = buildGatewayConfig(llamaConfig)
    updateGatewayConfig(cfg)
    updateMcpConfig(cfg)
    return true
  })

  // --- MCP ---

  ipcMain.handle('mcp:list-external', () => getExternalServers())

  ipcMain.handle('mcp:add-external', (_, server) => {
    const id = server.id || crypto.randomUUID()
    const s = { ...server, id, enabled: server.enabled ?? true }
    addExternalServer(s)
    return s
  })

  ipcMain.handle('mcp:remove-external', (_, id) => deleteExternalServer(id))

  ipcMain.handle('mcp:test-external', async (_, url) => {
    const sseUrl = url.endsWith('/sse') ? url : url.replace(/\/$/, '') + '/sse'
    try {
      const res = await fetch(sseUrl, {
        signal: AbortSignal.timeout(5000),
        method: 'GET',
        headers: { Accept: 'text/event-stream' },
      })
      const ct = res.headers.get('content-type') || ''
      if (res.ok && ct.includes('text/event-stream')) {
        return { ok: true, message: 'Connected' }
      }
      return { ok: false, message: `Unexpected response: ${res.status} (${ct || 'no content-type'})` }
    } catch (err) {
      return { ok: false, message: err.message }
    }
  })

  // --- Capabilities (Postgres, Documents) ---
  // Global config, per-profile activation via tools.activeToolIds (see
  // buildGatewayConfig). Secrets never round-trip to the renderer in plaintext.

  ipcMain.handle('capabilities:get', () => {
    const caps = getCapabilities()
    return {
      postgres: {
        enabled: caps.postgres.enabled,
        hasConnectionString: !!caps.postgres.connectionStringEnc,
        maxRows: caps.postgres.maxRows,
      },
      documents: {
        enabled: caps.documents.enabled,
        outputDir: caps.documents.outputDir,
      },
      sqlite: {
        enabled: caps.sqlite.enabled,
        rootDir: caps.sqlite.rootDir,
        maxRows: caps.sqlite.maxRows,
      },
      vault: {
        enabled: caps.vault.enabled,
        rootDir: caps.vault.rootDir,
      },
      git: {
        enabled: caps.git.enabled,
        rootDir: caps.git.rootDir,
      },
      file_system: {
        enabled: caps.file_system.enabled,
        rootDir: caps.file_system.rootDir,
      },
      scholar: {
        enabled: caps.scholar.enabled,
        venueFilter: caps.scholar.venueFilter,
      },
    }
  })

  ipcMain.handle('capabilities:set-postgres', (_, { connectionString, maxRows, enabled }) => {
    const patch = {}
    if (typeof enabled === 'boolean') patch.enabled = enabled
    if (typeof maxRows === 'number') patch.maxRows = maxRows
    if (connectionString) {
      try {
        patch.connectionStringEnc = encryptSecret(connectionString)
      } catch (err) {
        return { ok: false, error: err.message }
      }
    }
    setCapabilityConfig('postgres', patch)
    refreshLiveToolsConfig()
    return { ok: true }
  })

  ipcMain.handle('capabilities:test-postgres', async (_, connectionString) => {
    let target = connectionString
    if (!target) {
      const caps = getCapabilities()
      if (!caps.postgres.connectionStringEnc) return { ok: false, message: 'No connection string configured' }
      try {
        target = decryptSecret(caps.postgres.connectionStringEnc)
      } catch (err) {
        return { ok: false, message: err.message }
      }
    }
    return await testPostgresConnection(target)
  })

  ipcMain.handle('capabilities:select-documents-folder', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('capabilities:set-documents-folder', (_, { outputDir, enabled }) => {
    const patch = {}
    if (typeof enabled === 'boolean') patch.enabled = enabled
    if (outputDir) patch.outputDir = outputDir
    setCapabilityConfig('documents', patch)
    refreshLiveToolsConfig()
    return { ok: true }
  })

  // Estimates the per-request context cost of the tool set the given profile
  // config would activate — same resolution path as an actual launch.
  ipcMain.handle('tools:estimate-context', (_, llamaConfig) => {
    return estimateActiveToolTokens(buildGatewayConfig(llamaConfig))
  })

  ipcMain.handle('capabilities:select-sqlite-folder', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('capabilities:set-sqlite', (_, { rootDir, maxRows, enabled }) => {
    const patch = {}
    if (typeof enabled === 'boolean') patch.enabled = enabled
    if (typeof maxRows === 'number') patch.maxRows = maxRows
    if (rootDir) patch.rootDir = rootDir
    setCapabilityConfig('sqlite', patch)
    refreshLiveToolsConfig()
    return { ok: true }
  })

  ipcMain.handle('capabilities:set-scholar', (_, { venueFilter, enabled }) => {
    const patch = {}
    if (typeof enabled === 'boolean') patch.enabled = enabled
    if (venueFilter !== undefined) patch.venueFilter = String(venueFilter || '').trim() || null
    setCapabilityConfig('scholar', patch)
    refreshLiveToolsConfig()
    return { ok: true }
  })

  // Vault and Git share the folder-scoped capability shape: pick a folder,
  // toggle enabled. One generic pair of handlers keeps them uniform.
  for (const cap of ['vault', 'git', 'file_system']) {
    ipcMain.handle(`capabilities:select-${cap}-folder`, async () => {
      const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
      return result.canceled ? null : result.filePaths[0]
    })
    ipcMain.handle(`capabilities:set-${cap}`, (_, { rootDir, enabled }) => {
      const patch = {}
      if (typeof enabled === 'boolean') patch.enabled = enabled
      if (rootDir) patch.rootDir = rootDir
      setCapabilityConfig(cap, patch)
      refreshLiveToolsConfig()
      return { ok: true }
    })
  }

  // --- Llama command preview ---

  ipcMain.handle('llama:generate-command', (_, config) => {
    const args = buildArgs(config)
    return `llama-server.exe ${args.join(' ')}`
  })

  // --- Server launch ---

  ipcMain.handle('llama:launch', async (_, config) => {
    if (serverProcess) return { success: false, error: 'Server is already running' }

    const binaryPath = resolveBinary()
    if (!binaryPath) {
      return { success: false, error: `llama-server.exe not found.\nPlace it in llama-cpp-turboquant/build/bin/Release/, the project root, or set a custom path via Settings.` }
    }
    const binaryDir = path.dirname(binaryPath)

    const spawnArgs = buildArgs(config, true)

    try {
      // --- Piped mode (in-app log + token tracking) ---
      serverEma = 0
      // cwd = binary dir so Windows DLL search finds companion DLLs
      const child = spawn(binaryPath, spawnArgs, { stdio: ['ignore', 'pipe', 'pipe'], cwd: binaryDir })

      const forwardLines = (chunk) => {
        for (const line of chunk.toString().split('\n')) {
          const tps = parseEvalTokensPerSec(line)
          if (tps !== null) {
            serverEma = serverEma === 0 ? tps : EMA_ALPHA * tps + (1 - EMA_ALPHA) * serverEma
            mainWindow?.webContents.send('server:tpm', Math.round(serverEma * 60))
          }
          mainWindow?.webContents.send('server:log', line)
        }
      }

      child.stdout.on('data', forwardLines)
      child.stderr.on('data', forwardLines)

      child.on('error', err => {
        mainWindow?.webContents.send('server:log', `SPAWN ERROR: ${err.message}`)
        mainWindow?.webContents.send('server:stopped')
        serverProcess = null
      })

      child.on('exit', (code, signal) => {
        if (code !== 0) {
          mainWindow?.webContents.send('server:log', `Process exited with code ${code} (signal: ${signal})`)
        }
        serverProcess = null
        serverEma = 0
        lastServerConfig = null
        mainWindow?.webContents.send('server:stopped')
      })

      serverProcess = child
      lastServerConfig = config

      // Start the gateway on the public port. It injects the Redstart system
      // context into every completions request and proxies everything else
      // through to llama-server on config.port + 1 (localhost only).
      const gwConfig = buildGatewayConfig(config)
      try {
        await startGateway(config.port, gwConfig)
        const gwPort = getGatewayPort(config.port)
        if (gwPort) ensureFirewallRule(gwPort)
        startMdnsAdvertiser(config)
        // Serve the login/chat UI on plain port 80 too, so users can browse to
        // http://redstart.local without the :port suffix. Falls back silently
        // to the gateway port if 80 is unavailable.
        if (config.networkMode && config.port !== 80) {
          ensureFirewallRule(80)
          startPort80Proxy(config)
        }
      } catch (err) {
        console.warn('Tool gateway failed to start:', err.message)
        // Non-fatal — server still works, just without tool interception
      }

      // Start the built-in MCP server on port+2 so the chat-ui can call web_fetch
      // with actual whitelist enforcement (not just prompt-level advisory).
      try {
        const mcpPort = config.port + 2
        await startMcpServer(mcpPort, gwConfig)
        if (getMcpServerRunning()) ensureFirewallRule(mcpPort)
      } catch (err) {
        console.warn('MCP server failed to start:', err.message)
      }

      return { success: true, pid: child.pid }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  // --- Server stop (graceful) ---

  ipcMain.handle('server:stop', async () => {
    stopGateway()
    stopMcpServer()
    stopMdnsAdvertiser()
    stopPort80Proxy()
    if (!serverProcess) return { success: true }
    serverProcess.kill()
    serverProcess = null
    serverEma = 0
    lastServerConfig = null
    return { success: true }
  })

  // --- Server status ---

  ipcMain.handle('server:status', async (_, config) => {
    if (!serverProcess) return { running: false, health: null }
    try {
      const res = await fetch(`http://127.0.0.1:${config?.port || 19080}/health`, {
        signal: AbortSignal.timeout(1500),
      })
      const data = await res.json()
      return { running: true, health: data.status }
    } catch {
      return { running: true, health: 'unreachable' }
    }
  })

  // --- Network info ---

  ipcMain.handle('server:get-ip', () => getLocalIp())

  // --- Settings ---

  ipcMain.handle('settings:get-binary-path', () => {
    const s = readSettings()
    return s.serverBinPath || null
  })

  ipcMain.handle('settings:set-binary-path', (_, p) => {
    const s = readSettings()
    if (p) s.serverBinPath = p
    else delete s.serverBinPath
    writeSettings(s)
    return true
  })

  ipcMain.handle('settings:select-binary', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Select llama-server.exe',
      properties: ['openFile'],
      filters: [{ name: 'Executable', extensions: ['exe'] }, { name: 'All Files', extensions: ['*'] }],
      defaultPath: path.join(__dirname, '..', '..', 'llama-cpp-turboquant', 'build', 'bin', 'Release'),
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('settings:get-resolved-binary', () => resolveBinary())

  // --- Auth ---

  ipcMain.handle('auth:get-config', () => ({
    authRequired: getAuthRequired(),
    hasOwner: hasOwner(),
  }))

  ipcMain.handle('auth:set-required', (_, required) => {
    setAuthRequired(required)
    if (required) closeAllMcpSessions()
    return true
  })

  ipcMain.handle('auth:create-first-admin', (_, username, password) => {
    if (hasOwner()) return { success: false, error: 'An owner account already exists' }
    const result = createOwner({ username, password })
    if (!result.ok) return { success: false, error: result.error }
    return { success: true, apiKey: result.apiKey, id: result.account.id }
  })

  // --- GitHub releases (unchanged) ---

  ipcMain.handle('github:check-releases', async () => {
    const releases = {}
    const repos = [
      { owner: 'ggerganov', repo: 'llama.cpp' },
      { owner: 'turboderp', repo: 'llama.cpp' },
      { owner: 'tiannml', repo: 'TurboQuant' },
    ]
    for (const { owner, repo } of repos) {
      try {
        const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/latest`)
        if (res.ok) {
          const data = await res.json()
          releases[`${owner}/${repo}`] = data.tag_name
        }
      } catch {
        releases[`${owner}/${repo}`] = 'unavailable'
      }
    }
    return releases
  })
}

// ---------------------------------------------------------------------------
// Shared arg builder
// ---------------------------------------------------------------------------
// I centralize all llama-server argument construction here so the command
// preview in the UI and the actual launch use exactly the same logic.
//
// The --path argument tells llama-server to serve static files from our
// custom SvelteKit chat-ui build instead of its own built-in HTML UI. This is
// what makes the browser experience look like "Redstart" rather than the raw
// llama.cpp default interface.
//
// networkMode controls --host: 0.0.0.0 makes the server reachable from other
// devices on the LAN; 127.0.0.1 keeps it localhost-only. I default to network
// mode because the whole point of Redstart is to serve other devices at home.
// ---------------------------------------------------------------------------

// TurboQuant KV-cache quantization presets. This is the whole reason Redstart
// runs on the TurboQuant+ fork: its Walsh-Hadamard-rotated polar codec shrinks
// the KV cache ~3-4x vs the f16 default, which is what lets a 12 GB card hold a
// usable context instead of blowing VRAM at 16k tokens. The asymmetric-K/V rule
// from the fork's own papers is encoded here — K stays high-precision (q8_0),
// only V drops to a turbo tier; we never lead with a turbo K, which is where
// models break. Flash attention is already 'auto' in the binary and self-enables
// for turbo KV, so there's nothing to add on that front.
const KV_CACHE_PRESETS = {
  conservative: { k: 'q8_0', v: 'turbo4' }, // lightest turbo V; first contact
  balanced:     { k: 'q8_0', v: 'turbo3' }, // recommended default: near-lossless K, ~4.6x V
  aggressive:   { k: 'q8_0', v: 'turbo2' }, // MoE-aware; Boundary V auto-protects sensitive layers
}

function buildArgs(config, raw = false) {
  const q = raw ? (v) => v : (v) => `"${v}"`
  const chatUiPath = app.isPackaged
    ? path.join(process.resourcesPath, 'chat-ui')
    : path.join(__dirname, '..', '..', 'src', 'chat-ui', 'dist')
  const args = [
    '-m', q(config.modelPath),
    '-c', String(config.ctxSize),
    '-b', String(config.batchSize),
    '-t', String(config.threads),
    // Gateway owns the public port; llama-server runs on +1, localhost only.
    '--port', String(config.port + 1),
    '--host', '127.0.0.1',
    '--path', q(chatUiPath),
  ]
  // gpuLayers/nCpuMoe are omitted when unset rather than defaulted here —
  // llama-server's own --fit (on by default) only auto-adjusts arguments that
  // are still at their default value, so leaving these unset lets it compute
  // the GPU/CPU split live against actual free VRAM and the model's real
  // tensor sizes instead of a static guess made at hardware-scan time.
  if (config.gpuLayers !== undefined && config.gpuLayers !== null) {
    args.push('-ngl', String(config.gpuLayers))
  }
  if (config.nCpuMoe !== undefined && config.nCpuMoe !== null) {
    args.push('--n-cpu-moe', String(config.nCpuMoe))
  }
  if (config.priority === 'high') {
    args.push('--prio', '2')
  }
  if (config.noMmap) {
    args.push('--no-mmap')
  }
  // KV-cache quantization via TurboQuant. Omitted entirely when unset or 'off'
  // so legacy profiles keep the exact f16 behavior they had before.
  const kv = KV_CACHE_PRESETS[config.kvCache]
  if (kv) {
    args.push('-ctk', kv.k, '-ctv', kv.v)
  }
  if (config.additionalArgs?.trim()) {
    args.push(...config.additionalArgs.trim().split(/\s+/))
  }
  return args
}
