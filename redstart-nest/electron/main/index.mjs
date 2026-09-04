// =============================================================================
// Redstart Nest — the Electron entrypoint
// =============================================================================
// The overall design: Redstart Nest is a launcher and monitor for llama.cpp. It
// doesn't do any AI inference itself — it just starts the llama-server binary
// with the right arguments and then gets out of the way. The actual model
// runs in llama-server, which also serves the chat UI directly via --path.
//
// This file used to be all of it. The service itself now lives in daemon.mjs
// and this is one of two entrypoints onto it — the desktop one. What is left
// here is everything that needs Electron and nothing that does not: the
// window, the tray, the single-instance lock, the close notice, popup
// containment, the login item, and the one-time Beaver userData migration.
// bin/nestd.mjs is the other entrypoint and has no UI at all — everything
// genuinely Nest had to stop being reachable only from here, since Electron
// is what makes a headless appliance impossible.
//
// What THIS entrypoint answers that the daemon cannot answer for itself:
//   - where state lives (initPaths, from Electron's app.getPath)
//   - how secrets are encrypted (safeStorage — DPAPI on Windows)
//   - what a crash does (a shell notification, then app.exit(1))
//   - what a deliberate shutdown does (quitApp — app.quit(), deferred)
// =============================================================================

import { app, BrowserWindow, Menu, nativeImage, Notification, dialog, safeStorage, shell } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import * as zlib from 'zlib'
import { getAdminListenerState } from './admin-listener.mjs'
import { logEvent } from './logger.mjs'
import { subscribeToEvents } from './event-broker.mjs'
import { initPaths } from './platform-paths.mjs'
import {
  startDaemon, stopDaemon, installCrashHandlers, serverState, readSettings, writeSettings,
} from './daemon.mjs'
import { setRecycleBin, setLoginItems } from './desktop-integration.mjs'
import { initSecrets } from './secrets.mjs'
import { safeStorageProvider } from './secrets-safe-storage.mjs'
import { hasOwner } from './auth.mjs'
import { readBootstrapToken } from './bootstrap-token.mjs'
import { startTray } from './tray.mjs'
import { stopServer } from './ipc/server.mjs'
import { reconcileStartupSetting } from './ipc/admin.mjs'

// ---------------------------------------------------------------------------
// Redstart pixel-art icon — minimal PNG encoder + 32×32 American Redstart bust
// (placeholder design — a graphic artist will replace this). Hand-rolled
// rather than an image library dependency for a 32×32 taskbar icon; Node's
// built-in zlib handles the deflate compression PNG requires.
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

function makeRedstartIconPng(size = 32) {
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
  // Nearest-neighbour from the 32x32 grid, the same way scripts/make-icon.mjs
  // rasterizes each size in the .ico. Rendering AT the target size keeps the
  // art crisp; asking nativeImage to resize a 32px raster down to 16 would
  // interpolate it, and interpolated pixel art is mush — the eyes and beak are
  // one or two pixels wide.
  const scale = 32 / size
  return pngEncode(size, size, (x, y) => g[Math.floor(y * scale)][Math.floor(x * scale)])
}

// The notification-area icon. Built at native size rather than downscaled, and
// carrying a 2x representation so Windows has a crisp source at 125%/150%/200%
// DPI instead of upscaling a 16px bitmap.
function makeTrayIcon() {
  const image = nativeImage.createFromBuffer(makeRedstartIconPng(16))
  try {
    image.addRepresentation({ scaleFactor: 2, buffer: makeRedstartIconPng(32) })
  } catch (err) {
    // A missing HiDPI representation is a slightly soft icon on a scaled
    // display, not a missing tray. Never worth failing the tray over.
    console.warn('Tray icon: no 2x representation:', err.message)
  }
  return image
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

// Set only by a deliberate quit path — the tray's "Quit Redstart" (below)
// and admin:shutdown (quitApp(), below) are the only two things that set it.
// Not read anywhere yet — it exists so those two paths have one flag to set
// rather than inventing their own, and so that window-all-closed's comment
// below has something concrete to point at. Closing the window is
// deliberately NOT one of these paths — see window-all-closed.
let isQuitting = false

// Set once startTray() succeeds; before-quit calls it to
// unsubscribe from the broker and destroy the icon. Tray creation can fail
// (no shell notification area, unlikely but not impossible on a stripped-down
// Windows install) and is treated the same way the admin listener's own bind
// failure already is: logged and swallowed rather than fatal — a missing
// tray means "no tray affordance", not "no daemon".
let stopTray = null


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
// Redstart proxy server
// ---------------------------------------------------------------------------
// Chat UI is served directly by llama-server via --path and accessed through
// the gateway in any browser. No captive BrowserWindow or local proxy needed.
// ---------------------------------------------------------------------------

// applyCSP()/CSP retired. The window now loads the admin
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
// same-origin navigation pinning to protect the preload bridge a
// navigated-to page would otherwise inherit; the bridge is deleted now, so
// the narrower containment left is exactly what a plain browser tab already
// gets from the web platform. Hung off `web-contents-created` rather than
// `mainWindow` so it also covers webContents that do not exist yet — a
// popup, a <webview> — which a per-window handler would miss.
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

// "Closing the window will stop stopping the server" is a real reversal of
// user expectation, and deserves to be said plainly rather than discovered.
//
// Intercepts the window's own 'close' (the X button / Alt+F4), shown once
// ever — persisted in settings.json, not merely for this session, so it is
// a single plain explanation rather than a recurring nag. Skipped entirely
// on a deliberate quit (isQuitting true): the window is closing because the
// whole daemon is, so there is nothing misleading to correct.
//
// dialog.showMessageBox here is an informational box on THIS process's own
// window, always local to whoever is running it — no remote-vs-local
// ambiguity the way a file picker had.
function installCloseNotice(win) {
  win.on('close', (event) => {
    if (isQuitting) return
    const settings = readSettings()
    if (settings.closeNoticeShown) return
    event.preventDefault()
    dialog.showMessageBox(win, {
      type: 'info',
      title: 'Redstart keeps running',
      message: 'Redstart keeps running in the notification area.',
      detail: 'The model stays loaded. Quit from the tray icon to stop it.',
      buttons: ['Got it'],
    }).then(() => {
      const latest = readSettings()
      latest.closeNoticeShown = true
      writeSettings(latest)
      // win.close() rather than destroy() — re-fires 'close', but the
      // settings write above just made this handler's early-return above
      // fire this time, so it proceeds to the OS's normal close behavior
      // instead of looping.
      win.close()
    })
  })
}

function createWindow() {
  // No File/Edit/View/Help. Nothing in them applies to this app — there are no
  // documents to open and no preferences that are not in the UI already — and
  // with the title bar hidden the menu would have nowhere sensible to live.
  // Chromium still handles the editing shortcuts (Ctrl+C/V/X/A, undo) inside
  // inputs natively on Windows, which is where the Edit menu's roles would
  // otherwise have earned their place.
  Menu.setApplicationMenu(null)

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 800,
    icon: redstartIcon,
    // No OS title bar. The app draws its own top bar (App.tsx's header, and a
    // drag strip on the sign-in screen) and Electron paints ONLY the
    // minimise/maximise/close buttons over it, in the app's colours.
    //
    // Why the overlay rather than `frame: false` plus three HTML buttons:
    // buttons in the page would need a way to call win.minimize(), and the
    // only channel for that was the preload bridge, now deleted. Both
    // alternatives are wrong — a privileged channel for window chrome, or
    // window control on the admin HTTP API, where a browser on another
    // device could minimise someone else's window. The overlay needs
    // neither: native buttons, declarative theming, an ordinary page.
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#18181b',       // zinc-900, matching App.tsx's header
      symbolColor: '#a1a1aa', // zinc-400, matching its secondary text
      height: 48,             // must equal the header's h-12
    },
    // Paint the window zinc-950 from the first frame. Without it the window
    // shows white until the page loads, which against this theme reads as a
    // flash of broken.
    backgroundColor: '#09090b',
  })

  // The window is one event-broker subscriber among others now, not the
  // hard-coded destination server.mjs/models.mjs/plugins.mjs used to push to
  // directly. Subscribed once, here, rather than re-derived per publish() —
  // a destroyed window is checked at delivery time, same as the
  // getMainWindow()?.webContents.send(...) guard this replaces.
  //
  // The window can now close without the process quitting, so a
  // closed-and-reopened window is routine, not a one-time app-shutdown
  // event. subscribeToEvents() returns an unsubscribe handle specifically so
  // this registration does not stack a second, permanently-dead listener
  // every time the window reopens.
  const win = mainWindow
  const unsubscribeFromEvents = subscribeToEvents((channel, payload) => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  })
  win.on('closed', () => {
    unsubscribeFromEvents()
    if (mainWindow === win) mainWindow = null
  })
  installCloseNotice(win)

  // Always the admin listener's own loopback address — Electron shares the
  // daemon's machine (level 2), so it connects to it exactly like any other
  // local HTTP client, never via whatever bind address is configured for LAN
  // exposure. AdminGate.tsx gates this page exactly like a browser tab —
  // sign-in, or first-run setup.
  //
  // DEV EXCEPTION: Vite's dev server (localhost:5173) is loaded instead of
  // the admin listener directly, so UI work keeps hot-reload, proxying
  // everything under /admin to the real listener (vite.config.ts) — a
  // dev-tooling convenience, not a security boundary.
  const { port } = getAdminListenerState()
  let url = app.isPackaged ? `http://127.0.0.1:${port}/` : 'http://localhost:5173/'
  // The bootstrap-token handoff, without IPC: no owner exists yet, so this
  // is a first-run (or post-wipe) box. Read the token here and hand it to
  // the page as a URL, the same as any other "where should this window
  // start" decision. AdminGate.tsx reads it once on mount and clears it
  // from the address bar immediately after.
  if (!hasOwner()) {
    const token = readBootstrapToken()
    if (token) url += `?setupToken=${encodeURIComponent(token)}`
  }
  mainWindow.loadURL(url)
  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools()
    // Setting the application menu to null (above) also removes the
    // accelerators it carried, and the only one that mattered was
    // toggle-devtools. Rebinding it here rather than keeping a menu bar just
    // to hold it: dev-only, so a packaged build gains no shortcut into the
    // renderer's internals.
    mainWindow.webContents.on('before-input-event', (event, input) => {
      const toggle = input.control && input.shift && input.key.toLowerCase() === 'i'
      if (input.type === 'keyDown' && (toggle || input.key === 'F12')) {
        mainWindow.webContents.toggleDevTools()
        event.preventDefault()
      }
    })
  }
}

// Shared by the single-instance guard's 'second-instance' handler and the
// tray's "Open Redstart" / left-click — both answer the same question,
// "bring the UI in front of the user right now," and mainWindow may
// legitimately be null in either case now that closing it no longer quits
// the process.
function openOrFocusWindow() {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  } else {
    createWindow()
  }
}

// The ONE deliberate-quit path admin:shutdown gets (the tray's
// "Quit Redstart" sets isQuitting inline itself since it already has app in
// scope there too — this is the other caller). Deferred
// with setImmediate rather than calling app.quit() synchronously: the
// caller is admin:shutdown's HTTP handler, and its 200 response must
// actually leave the socket before before-quit's teardown begins, or the
// caller sees a connection reset and cannot tell success from crash.
function quitApp() {
  isQuitting = true
  setImmediate(() => app.quit())
}

// The launcher and chat windows are plain UI (no WebGL/canvas-heavy work) —
// disabling GPU compositing frees the CUDA device from competing with
// llama-server's own inference workload for the same GPU.
app.disableHardwareAcceleration()

// ---------------------------------------------------------------------------
// Single-instance guard
// ---------------------------------------------------------------------------
// Everything downstream assumes exactly one process owns the daemon — the
// admin listener's port, the pid file, the tray icon. Before this guard, a
// second launch raced the 19083 bind and lost into
// `console.warn('Admin listener failed to start')`, leaving a window with no
// working daemon behind it: the worst outcome available, and silent. Must
// be requested before `whenReady`.
// A login-triggered start passes this so the daemon comes up windowless
// (tray-only): set on the OS login item below in reconcileStartupSetting(),
// read here rather than trusted blindly, since `--background` typed on an
// ordinary Start-menu launch should behave the same way.
const isBackgroundLaunch = process.argv.includes('--background')

const gotSingleInstanceLock = app.requestSingleInstanceLock()

if (!gotSingleInstanceLock) {
  // Do not touch paths, the logger, or any listener — another process
  // already owns them. Quit immediately and let that process's
  // 'second-instance' handler bring its window forward.
  app.quit()
} else {
  app.on('second-instance', () => {
    // A user clicked the Start-menu shortcut, or double-clicked the exe,
    // while the daemon is already running. logEvent no-ops safely even if
    // initLogger() hasn't run yet on a very fast second launch (logger.mjs).
    logEvent('app', 'second_instance', {})
    openOrFocusWindow()
  })

  app.whenReady().then(main)
}

async function main() {
  // Installed before anything else, including initPaths(), so
  // a crash during startup itself is caught too. The wiring lives in
  // daemon.mjs; what a DESKTOP does about a crash — raise a shell
  // notification, leave through Electron's own app.exit() — is this
  // entrypoint's half of the answer, and is passed in.
  installCrashHandlers({
    notifyCrash: (notification) => {
      if (Notification.isSupported()) {
        new Notification({ title: notification.title, body: notification.body }).show()
      }
    },
    // app.exit(1), not app.quit(): process state is suspect here, so this
    // deliberately skips before-quit's ordinary teardown and exits directly.
    // The 1 is also what a supervisor reads as "restart me".
    exitCrashed: () => app.exit(1),
  })
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
  // secrets.mjs is fail-closed and holds no crypto of its own; wire the
  // provider before anything can read or write a credential. This is the
  // desktop (level 2) entrypoint, so it gets safeStorage — the same DPAPI
  // that wrote every secret on every install shipped so far. The headless
  // daemon wires the key file provider instead, and that difference is the
  // whole reason this seam exists.
  initSecrets(safeStorageProvider(safeStorage))
  // The two things a desktop can do that a headless daemon
  // cannot. Registered rather than imported, because a module that imports
  // these from 'electron' cannot be loaded under plain Node at all; see
  // desktop-integration.mjs.
  setRecycleBin((fullPath) => shell.trashItem(fullPath))
  setLoginItems({
    get: () => app.getLoginItemSettings(),
    set: (settings) => app.setLoginItemSettings(settings),
  })
  installPopupContainment()
  // Everything that is Nest-the-service: the logger, the process log, the
  // capability folders, stale-process reaping, the control-plane API table,
  // the beacon and the admin listener. One call now — the same one
  // bin/nestd.mjs makes, in the same order, because the daemon is not
  // supposed to be able to tell which entrypoint started it.
  //
  // quitApp is the one thing it cannot answer for itself: admin:shutdown
  // has to leave the way this platform leaves.
  await startDaemon({ quitApp })
  // Pure decision logic lives in ipc/admin.mjs (resolveStartupReconciliation),
  // testable without Electron; this is just the one untestable line
  // (app.setLoginItemSettings) plus the settings read/write it needs.
  reconcileStartupSetting({ readSettings, writeSettings })
  startTrayIcon()
  if (!app.isPackaged) await installReactDevTools()
  // A login-triggered start is windowless — tray-only until the admin
  // opens it. This never starts a model, only the daemon (admin listener,
  // beacon, gateway config, MCP), all of which are already up by this line.
  if (!isBackgroundLaunch) createWindow()
}

// A missing icon (redstartIcon failed to generate, logged at
// module load above) or a Tray constructor failure (no shell notification
// area) is swallowed the same way a admin-listener bind failure already is —
// logged, non-fatal, daemon still comes up. No tray means no tray
// affordance, not no daemon.
function startTrayIcon() {
  if (!redstartIcon) {
    console.warn('Tray not started: icon generation failed at startup')
    return
  }
  try {
    stopTray = startTray({
      icon: makeTrayIcon(),
      onOpen: openOrFocusWindow,
      onStopModel: () => {
        logEvent('app', 'tray_stop_model', {})
        stopServer({ serverState }).catch((err) => console.warn('Tray stop-model failed:', err.message))
      },
      onQuit: () => {
        logEvent('app', 'tray_quit', {})
        isQuitting = true
        app.quit()
      },
      initiallyRunning: !!serverState.process,
    })
  } catch (err) {
    console.warn('Tray failed to start:', err.message)
    logEvent('app', 'tray_start_failed', { reason: err.message })
  }
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

// The client's teardown, then the daemon's. The daemon half moved into
// stopDaemon() — the goal was to move the before-quit teardown out of the
// client and into the daemon, which could not be done while a single
// process was the only caller. There are two now, and a second copy that
// drifts is how a llama-server child gets left running past quit.
//
// The tray goes first, where it used to sit mid-teardown: a client affordance
// should stop before the thing it is an affordance for, so a broker event
// published during the daemon's own teardown cannot reach a destroyed icon.
app.on('before-quit', () => {
  if (stopTray) {
    stopTray()
    stopTray = null
  }
  stopDaemon()
})

// Closing the window closes a VIEW, not the daemon — the admin listener,
// the beacon, and a loaded model all keep running with no window open. An
// explicit empty handler is required, not merely "delete the listener":
// Electron's baked-in default behavior for window-all-closed IS to quit, so
// doing nothing means registering a no-op, not omitting the registration.
//
// The daemon still stops on a deliberate quit — the tray's "Quit Redstart"
// and the admin UI's shutdown route call app.quit() directly, which fires
// before-quit below regardless of any window state.
app.on('window-all-closed', () => {
  logEvent('app', 'window_closed', {})
})

