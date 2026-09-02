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

import { app, BrowserWindow, nativeImage } from 'electron'
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
import { startAdminListener, stopAdminListener, getAdminListenerState, DEFAULT_ADMIN_BIND_HOST } from './admin-listener.mjs'
import { startDiscovery, stopDiscovery, lastKnownDiscovery } from './discovery.mjs'
import { ensureBootstrapToken } from './bootstrap-token.mjs'
import { buildAdminApi } from './admin/api-table.mjs'
import { setAdminApi } from './admin/api-routes.mjs'
import { ensureFirewallRule } from './firewall.mjs'
import { getPrimaryLanIp } from './net-interfaces.mjs'
import { cleanupOldConversations } from './conversations-storage.mjs'
import { initLogger, closeLogger, logEvent } from './logger.mjs'
import { initProcessLog } from './process-log.mjs'
import { subscribeToEvents } from './event-broker.mjs'
import { reapStaleProcess, deletePidFile } from './process-supervision.mjs'
import { initPaths, configDir, capabilityBaseDir } from './platform-paths.mjs'
import { fileURLToPath } from 'url'
import { buildGatewayConfig, createRefreshLiveToolsConfig } from './gateway-config.mjs'
import { buildArgs } from './llama-args.mjs'
import { binaryPathRejection } from './ipc/validate.mjs'
import { setPluginCapabilityProvider } from './tools-definitions.mjs'
import { pluginCapabilities } from './plugin-registry.mjs'
import { sweepPendingDeletions } from './plugin-install.mjs'
import { hasOwner } from './auth.mjs'
import { readBootstrapToken } from './bootstrap-token.mjs'

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

// Phase 7 §7.2: set only by a deliberate quit path — 7.3's tray "Quit
// Redstart" and 7.5's admin:shutdown route, neither of which exists yet in
// this commit. Not read anywhere yet either; it exists so those two later
// steps have one flag to set rather than inventing their own, and so that
// window-all-closed's comment below has something concrete to point at.
// Closing the window is deliberately NOT one of these paths — see
// window-all-closed.
let isQuitting = false

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
// Bound inside setupAdminApi() (after app.whenReady, when app.getPath is
// safe to call) rather than here at module scope — see below.
let refreshLiveToolsConfig

// ---------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------

function getSettingsPath() {
  return path.join(configDir(), 'settings.json')
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
// Models folder
// ---------------------------------------------------------------------------
// Where the Models tab downloads GGUF files and where the "Select .gguf File"
// picker opens. Defaults to <Documents>\Redstart\Models to match the capability
// folders provisioned above, but is user-changeable because model files are
// tens of gigabytes and Documents usually lives on the system drive.
//
// Always resolves to a real path so no caller has to handle null — the picker's
// defaultPath and the downloader's containment root must never disagree about
// which folder is "the models folder".

function defaultModelsDir() {
  return path.join(capabilityBaseDir(), 'Models')
}

function resolveModelsDir() {
  const configured = readSettings().modelsDir
  return typeof configured === 'string' && configured.trim() ? configured : defaultModelsDir()
}

// Best-effort, same contract as ensureDefaultCapabilityFolders: a folder that
// cannot be created is not fatal, the tab just reports it.
function ensureModelsDir() {
  try {
    fs.mkdirSync(resolveModelsDir(), { recursive: true })
  } catch (err) {
    console.warn('Could not provision the models folder:', err.message)
  }
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

// The value this returns becomes spawn()'s first argument in ipc/server.mjs, so
// it is checked HERE as well as at the settings:set-binary-path write. That is
// not belt-and-braces for its own sake: settings.json is an ordinary file on
// disk, and any value written by a build that predates the write-side check —
// which is every install shipped so far — is read by this function and launched.
// Validating only on the way in would leave the stored value trusted forever.
//
// A rejected override falls through to the bundled binary rather than failing
// the launch, which is the same thing that happens when the path simply does
// not exist.
function resolveBinary() {
  const settings = readSettings()
  if (settings.serverBinPath) {
    const rejection = binaryPathRejection(settings.serverBinPath)
    if (rejection) {
      logEvent('security', 'binary_override_rejected', { reason: rejection })
    } else {
      return settings.serverBinPath
    }
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
  return path.join(configDir(), 'profiles.json')
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

// Delegates to net-interfaces.mjs, which skips Hyper-V/WSL/VirtualBox/VPN
// adapters. Taking the first non-internal IPv4 (as this did) routinely handed
// back a virtual-switch address that nothing else on the LAN can reach — and
// that address is what the UI shows and what the QR code encodes.
function getLocalIp() {
  return getPrimaryLanIp()
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
// Admin listener (the control plane)
// ---------------------------------------------------------------------------
// Started HERE, beside the beacon, and not from the llama:launch handler. That
// placement is the whole argument: the control plane must be up before, and
// independently of, the thing it controls (headless-admin-plane-plan.md
// decision 3). See admin-listener.mjs for what it serves.
//
// Where it binds is a persisted setting holding an ADDRESS, not a boolean, and
// it defaults to loopback — availability is always on, exposure is opt-in (plan
// decision 4). Deliberately not `networkMode`, which is data-plane state read
// only at launch.
//
// A failure to bind is logged and swallowed rather than fatal — the daemon
// itself (gateway, MCP, discovery) still comes up. Since Phase 6 §6.2,
// though, the LAUNCHER window specifically has no fallback if this fails:
// createWindow() loads this listener's own page, so a bind failure here
// means the window loads nothing rather than a working-but-disconnected UI.
// That is the accepted shape of "the Electron UI is a client of the daemon,
// like Twig" (plan decision 6) — the alternative would be keeping a second,
// privileged way for the window to render regardless, which is the exact
// thing this phase retires.
async function startAdminPlane() {
  // Minted here, not on first use. A token that only appears at the moment
  // someone is locked out is a token they cannot get to — and an install that
  // predates this feature needs one waiting for it, not one generated by the
  // request that needed it. See bootstrap-token.mjs.
  ensureBootstrapToken()
  const bindHost = readSettings().adminBindHost || DEFAULT_ADMIN_BIND_HOST
  try {
    await startAdminListener({ bindHost })
  } catch (err) {
    console.warn('Admin listener failed to start:', err.message)
    logEvent('admin', 'listener_start_failed', { reason: err.code || 'error' })
  }
  // Discovery (the port-80 clean URL, since Phase 6.5 retired mDNS) is a
  // data-plane convenience keyed on networkMode alone — it no longer reads
  // the listener's bind state at all. Still started here rather than only
  // from `llama:launch`, so a box that was previously put in network mode
  // gets the clean URL back at boot even before the next launch. See
  // discovery.mjs.
  startDiscovery(lastKnownDiscovery(readSettings()))
}

// ---------------------------------------------------------------------------
// Redstart proxy server
// ---------------------------------------------------------------------------
// Chat UI is served directly by llama-server via --path and accessed through
// the gateway in any browser. No captive BrowserWindow or local proxy needed.
// ---------------------------------------------------------------------------

// applyCSP()/CSP retired in Phase 6 §6.2. The window now loads the admin
// listener's own served page over HTTP (see createWindow() below), and that
// response already carries its own precise, purpose-built policy —
// admin-listener.mjs's ADMIN_CSP, sent as a real header on the document
// response the way a server is supposed to send one. Stamping a second,
// broader CSP over every response in the session (what this did, for the
// old file://-loaded page which had no natural way to send one) would now
// either duplicate or fight that header instead of complementing it.

// ---------------------------------------------------------------------------
// Popup / webview containment
// ---------------------------------------------------------------------------
// Nothing in the launcher legitimately opens a second window or attaches a
// <webview> — both are flat denials. This used to be paired with strict
// same-origin navigation pinning (renderer-location.mjs) to protect the
// preload bridge a navigated-to page would otherwise inherit; Phase 6 §6.2
// deleted the bridge itself; without it there is no elevated surface a
// navigation could inherit, so the narrower containment left is exactly
// what a plain browser tab already gets from the web platform (a page can
// navigate itself, but gains no extra privilege by doing so — Electron's
// window is meaningfully no different, since it now holds nothing a browser
// tab wouldn't). Hung off `web-contents-created` rather than off
// `mainWindow` so it also covers webContents that do not exist yet — a
// popup, a <webview> — which is precisely the set a per-window handler
// would miss.
function installPopupContainment() {
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => {
      logEvent('security', 'window_open_denied', {})
      return { action: 'deny' }
    })

    contents.on('will-attach-webview', (event) => {
      logEvent('security', 'webview_attach_denied', {})
      event.preventDefault()
    })
  })
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 800,
    icon: redstartIcon,
  })

  // The window is one event-broker subscriber among others now (Phase 5
  // §5.1), not the hard-coded destination server.mjs/models.mjs/plugins.mjs
  // used to push to directly. Subscribed once, here, rather than re-derived
  // per publish() — a destroyed window is checked at delivery time, same as
  // the getMainWindow()?.webContents.send(...) guard this replaces.
  //
  // Phase 7 §7.2: the window can now close without the process quitting
  // (window-all-closed is a no-op below), so a closed-and-reopened window
  // is routine, not a one-time app-shutdown event. subscribeToEvents()
  // returns an unsubscribe handle specifically so this registration does not
  // stack a second, permanently-dead listener (still checking
  // win.isDestroyed() forever, still holding `win` alive) every time the
  // window reopens.
  const win = mainWindow
  const unsubscribeFromEvents = subscribeToEvents((channel, payload) => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  })
  win.on('closed', () => {
    unsubscribeFromEvents()
    if (mainWindow === win) mainWindow = null
  })

  // Always the admin listener's own loopback address — Electron shares the
  // daemon's machine (level 2, plan §1), so it connects to it exactly like
  // any other local HTTP client, never via whatever bind address is
  // configured for LAN exposure (which could be a wildcard Electron cannot
  // usefully "connect to" from the same box). AdminGate.tsx gates this page
  // exactly like a browser tab — sign-in, or first-run setup — see decision
  // 6: the Electron UI is a client of the daemon, like Twig.
  //
  // DEV EXCEPTION: Vite's dev server (localhost:5173) is loaded instead of
  // the admin listener directly, so UI work keeps hot-reload. It proxies
  // everything under /admin to the real listener (vite.config.ts) — this is
  // a dev-tooling convenience, not a security boundary; the packaged build
  // has no dev server to reach and always loads the listener's own page.
  const { port } = getAdminListenerState()
  let url = app.isPackaged ? `http://127.0.0.1:${port}/` : 'http://localhost:5173/'
  // The bootstrap-token handoff (plan decision 16), without IPC: no owner
  // exists yet, so this is a first-run (or post-wipe) box. Read the token
  // here, where filesystem access already lives, and hand it to the page
  // the same way any other "where should this window start" decision is
  // made — a URL. AdminGate.tsx reads it once on mount and clears it from
  // the address bar immediately after, so it does not linger anywhere a
  // screenshot or a browser history entry would catch it.
  if (!hasOwner()) {
    const token = readBootstrapToken()
    if (token) url += `?setupToken=${encodeURIComponent(token)}`
  }
  mainWindow.loadURL(url)
  if (!app.isPackaged) mainWindow.webContents.openDevTools()
}

// The launcher and chat windows are plain UI (no WebGL/canvas-heavy work) —
// disabling GPU compositing frees the CUDA device from competing with
// llama-server's own inference workload for the same GPU.
app.disableHardwareAcceleration()

// ---------------------------------------------------------------------------
// Single-instance guard (Phase 7 §7.1)
// ---------------------------------------------------------------------------
// Every later Phase 7 step assumes exactly one process owns the daemon —
// the admin listener's port, the pid file, the tray icon. Before this guard,
// a second launch raced the 19083 bind and lost into
// `console.warn('Admin listener failed to start')`, leaving a window with no
// working daemon behind it: the worst outcome available, and silent. Must be
// requested before `whenReady` — the lock itself is what decides whether this
// process gets to proceed to path/listener setup at all.
const gotSingleInstanceLock = app.requestSingleInstanceLock()

if (!gotSingleInstanceLock) {
  // Do not touch paths, the logger, or any listener — another process
  // already owns them. Quit immediately and let that process's
  // 'second-instance' handler bring its window forward.
  app.quit()
} else {
  app.on('second-instance', () => {
    // A user clicked the Start-menu shortcut, or double-clicked the exe,
    // while the daemon (with or without a window) is already running.
    // logEvent runs safely here even before initLogger() has necessarily
    // been called on a very fast second launch — logEvent no-ops until the
    // logger is initialized rather than throwing (see logger.mjs).
    logEvent('app', 'second_instance', {})
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    } else {
      createWindow()
    }
  })

  app.whenReady().then(main)
}

async function main() {
  // Before anything else touches a path. migrateUserDataFromBeaver() below is
  // exempt — it is one-time glue tied specifically to Electron's app-name
  // userData scheme, not a "where does data live" question the daemon will
  // ever need to answer, so it keeps using app.getPath directly.
  initPaths({
    config: app.getPath('userData'),
    capabilityBase: path.join(app.getPath('documents'), 'Redstart'),
    isPackaged: app.isPackaged,
  })
  migrateUserDataFromBeaver()
  // Structured logging to <userData>\redstart.log. First thing after the
  // userData migration so subsequent startup steps are captured.
  initLogger(configDir())
  logEvent('app', 'ready', { platform: process.platform })
  // llama-server's own output (Phase 5 §5.2) — a separate stream from the
  // structured event log above, see process-log.mjs's header for why.
  initProcessLog(configDir())
  // Pre-provision default capability folders (<Documents>\Redstart\...) so
  // Documents/SQLite/Vault/Git are one-click enable out of the box. Fills
  // only unset paths — a user-chosen folder is never overridden — and leaves
  // every capability disabled.
  ensureDefaultCapabilityFolders(capabilityBaseDir())
  // Same idea for the models folder — see resolveModelsDir().
  ensureModelsDir()
  installPopupContainment()
  // Reaps a llama-server left running by a previous session that never got
  // to run its own exit handler (Task Manager kill, power loss). Verifies the
  // recorded pid is still that same binary before touching it — never a
  // by-name sweep. See process-supervision.mjs for why this replaced
  // killOrphanedServers().
  await reapStaleProcess(configDir())
  const cleanedConversations = cleanupOldConversations()
  if (cleanedConversations > 0) console.log(`Cleaned ${cleanedConversations} conversations older than 30 days`)
  // Retries any plugin folder an uninstall couldn't delete last session (a
  // Windows file lock, most likely) — best-effort, never blocks startup (P4-4).
  sweepPendingDeletions()
  // Before the admin listener binds, not after: a control-plane request that
  // arrives before this table is assembled gets a 503 rather than the
  // method it asked for.
  setupAdminApi()
  startDiscoveryBeacon()
  startAdminPlane()
  if (!app.isPackaged) await installReactDevTools()
  createWindow()
}

// Dev-only: adds the Components/Profiler panels to Chromium DevTools so the
// React tree is inspectable. Never runs in a packaged build — an extension
// downloaded from the Chrome Web Store has no place in a shipped binary, and
// the install is a network call that would just fail offline anyway, hence
// the try/catch rather than letting a flaky download block startup.
async function installReactDevTools() {
  try {
    const { default: installExtension, REACT_DEVELOPER_TOOLS } = await import('electron-devtools-installer')
    const name = await installExtension(REACT_DEVELOPER_TOOLS)
    console.log(`[devtools] installed ${name}`)
  } catch (err) {
    console.warn('[devtools] React DevTools install failed (dev-only, non-fatal):', err.message)
  }
}

// Inbound firewall rules now live in firewall.mjs so the mDNS advertiser can
// reuse the same elevate.exe path for its UDP 5353 rule. `ensureFirewallRule`
// is imported above and re-exported through the deps object below unchanged.

app.on('before-quit', () => {
  logEvent('app', 'quit', {})
  stopGateway()
  stopMcpServer()
  stopDiscovery()
  if (serverState.process) {
    // killOrphanedServers() used to do this job as a side effect of its
    // by-name sweep — this line never actually killed the child itself, only
    // dropped the reference. Kill by pid explicitly now that the sweep is
    // gone, or Nest's own llama-server would leak past quit.
    serverState.process.kill()
    serverState.process = null
    deletePidFile(configDir())
  }
  if (beaconServerInstance) {
    stopBeaconServer(beaconServerInstance)
    beaconServerInstance = null
  }
  stopAdminListener()
  closeLogger()
})

// Phase 7 §7.2: closing the window closes a VIEW, not the daemon — the
// admin listener, the beacon, and a loaded model all keep running with no
// window open. This is the single line that used to make that untrue
// (`app.quit()` on every platform but darwin, which is Electron's own
// default there too). An explicit empty handler is required, not merely
// "delete the listener": Electron's baked-in default behavior for
// window-all-closed IS to quit, so doing nothing means registering a
// no-op, not omitting the registration.
//
// The daemon still stops on a deliberate quit — the tray's "Quit Redstart"
// (§7.3) and the admin UI's shutdown route (§7.5) call app.quit() directly,
// which fires before-quit below regardless of any window state.
app.on('window-all-closed', () => {
  logEvent('app', 'window_closed', {})
})

// ---------------------------------------------------------------------------
// The control-plane API table
// ---------------------------------------------------------------------------
// Phase 6 §6.2 retired IPC — this used to also register every namespace's
// handlers with ipcMain (registerIpcHandlers(), deleted along with
// ipc/guard.mjs). buildAdminApi(deps) below is the only consumer of the
// handler tables left, and it was always the design's real source of truth
// (ipc/transport.mjs's header explains why: a route table derived from IPC
// registration would be empty on a platform with no Electron, which is the
// platform HTTP-only exists for).
function setupAdminApi() {
  const userDataDir = configDir()
  refreshLiveToolsConfig = createRefreshLiveToolsConfig(serverState, userDataDir)
  // Hands tools-definitions.mjs a live read of the plugin registry. Must run
  // before any tools/list or config build, or plugin tools resolve to no
  // capability and are neither classified nor bannable.
  setPluginCapabilityProvider(pluginCapabilities)
  const deps = {
    execFileAsync,
    readSettings,
    writeSettings,
    resolveBinary,
    // Resolved lazily on every call — the user can repoint the models folder at
    // runtime, so a value captured here would go stale.
    resolveModelsDir,
    getModelsDir: resolveModelsDir,
    ensureModelsDir,
    readProfiles,
    writeProfiles,
    buildGatewayConfig,
    refreshLiveToolsConfig,
    serverState,
    buildArgs,
    parseEvalTokensPerSec,
    ensureFirewallRule,
    getLocalIp,
    // So the external-MCP validator knows which ports are ours and can refuse a
    // server pointed at Nest itself. Falls back to the documented default when
    // no profile has been started yet, since the ports are derived from it.
    getConfiguredPort: () => serverState.lastConfig?.port ?? 19080,
    userDataDir,
  }

  setAdminApi(buildAdminApi(deps))
}

// ---------------------------------------------------------------------------
// buildArgs + KV_CACHE_PRESETS live in ./llama-args.mjs (imported above) so the
// llama-server localhost-only invariant can be unit-tested in isolation without
// booting Electron. See scripts/test-llama-args.mjs.
// ---------------------------------------------------------------------------
