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

import { app, BrowserWindow, nativeImage, session } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import * as path from 'path'
import * as fs from 'fs'
import { ensureDefaultCapabilityFolders } from './tools-storage.mjs'
import { stopGateway } from './tools-gateway.mjs'
import { stopMcpServer } from './mcp-server.mjs'
import * as os from 'os'
import * as zlib from 'zlib'
import * as http from 'http'
import { startBeaconServer, stopBeaconServer } from './beacon.mjs'
import { stopMdnsAdvertiser } from './mdns-advertiser.mjs'
import { stopPort80Proxy } from './port80-proxy.mjs'
import { cleanupOldConversations } from './conversations-storage.mjs'
import { initLogger, closeLogger, logEvent } from './logger.mjs'
import { fileURLToPath } from 'url'
import { registerGithubHandlers } from './ipc/github.mjs'
import { registerHardwareHandlers } from './ipc/hardware.mjs'
import { registerSettingsHandlers } from './ipc/settings.mjs'
import { registerAuthHandlers } from './ipc/auth.mjs'
import { registerProfilesHandlers } from './ipc/profiles.mjs'
import { registerToolsHandlers } from './ipc/tools.mjs'
import { registerMcpHandlers } from './ipc/mcp.mjs'
import { registerCapabilitiesHandlers } from './ipc/capabilities.mjs'
import { registerServerHandlers } from './ipc/server.mjs'
import { buildGatewayConfig, createRefreshLiveToolsConfig } from './gateway-config.mjs'

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

// Live server process state, shared by reference between the server IPC handlers
// (ipc/server.mjs, which owns launch/stop/status) and the lifecycle +
// gateway-refresh code in this file that reads it. process: the spawned
// llama-server child; ema: smoothed tokens/sec; lastConfig: set on launch,
// cleared on stop/exit.
const serverState = { process: null, ema: 0, lastConfig: null }
let beaconServerInstance = null

// Live tool-config refresh, bound to serverState. buildGatewayConfig +
// createRefreshLiveToolsConfig live in gateway-config.mjs; index.mjs only owns
// the serverState the refresh closes over.
const refreshLiveToolsConfig = createRefreshLiveToolsConfig(serverState)

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
    () => !!serverState.process,
    () => serverState.lastConfig?.port ?? 19080,
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
  // Structured logging to <userData>\redstart.log. First thing after the
  // userData migration so subsequent startup steps are captured.
  initLogger(app.getPath('userData'))
  logEvent('app', 'ready', { platform: process.platform })
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
  logEvent('app', 'quit', {})
  killOrphanedServers()
  stopGateway()
  stopMcpServer()
  stopMdnsAdvertiser()
  stopPort80Proxy()
  if (serverState.process) {
    serverState.process = null
  }
  if (beaconServerInstance) {
    stopBeaconServer(beaconServerInstance)
    beaconServerInstance = null
  }
  closeLogger()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------

// Per-namespace IPC registrars extracted from setupIpcHandlers(). Shared
// collaborators are threaded through `deps` so the modules never reach for
// index.mjs globals. Namespaces still living inline below are migrated one
// seam per commit; this dispatcher is where each lands as it moves out.
function registerIpcHandlers(deps) {
  registerGithubHandlers()
  registerHardwareHandlers(deps)
  registerSettingsHandlers(deps)
  registerAuthHandlers()
  registerProfilesHandlers(deps)
  registerToolsHandlers(deps)
  registerMcpHandlers()
  registerCapabilitiesHandlers(deps)
  registerServerHandlers(deps)
}

function setupIpcHandlers() {
  registerIpcHandlers({
    execFileAsync,
    readSettings,
    writeSettings,
    resolveBinary,
    selectBinaryDefaultPath: path.join(__dirname, '..', '..', 'llama-cpp-turboquant', 'build', 'bin', 'Release'),
    readProfiles,
    writeProfiles,
    buildGatewayConfig,
    refreshLiveToolsConfig,
    serverState,
    getMainWindow: () => mainWindow,
    buildArgs,
    parseEvalTokensPerSec,
    ensureFirewallRule,
    getLocalIp,
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
    // Enable the model's Jinja chat template so llama-server formats the request's
    // `tools` into the prompt AND runs the model-specific tool-call parser on the
    // output. Without this, a model's tool call is passed through as plain
    // assistant `content` (a raw JSON blob) instead of a structured `tool_calls`
    // field, so the chat-ui's agentic loop never sees a call to execute. Always
    // on: the gateway is built around native OpenAI tool-calling.
    '--jinja',
  ]
  // Optional chat-template override. --jinja uses the template embedded in the
  // GGUF by default; if that template doesn't render tools in a format
  // llama.cpp can parse back into tool_calls, the model's call leaks into
  // `content`. Overriding the template forces the correct tool-call format for
  // that model. chatTemplateFile (a path to a .jinja) takes precedence over
  // chatTemplate (a built-in template name, e.g. 'chatml', or an inline
  // template string). Both are passed through q() so a path with spaces is one
  // argv element on spawn and stays quoted in the copy-pasteable UI preview.
  if (config.chatTemplateFile?.trim()) {
    args.push('--chat-template-file', q(config.chatTemplateFile.trim()))
  } else if (config.chatTemplate?.trim()) {
    args.push('--chat-template', q(config.chatTemplate.trim()))
  }
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
