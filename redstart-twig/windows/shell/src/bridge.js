// =============================================================================
// Redstart Twig: window.redstartTwigAPI, on Tauri
// =============================================================================
// Injected by the shell (bridge.rs) before the page's own scripts on every
// load. It is Electron's preload, rebuilt over Tauri's IPC: the same object
// shape, so the chat-ui's feature detection and call sites are unchanged
// (redstart-nest/src/chat-ui/src/lib/utils/twig.ts). New since Electron:
// `window` (the page draws its own title bar buttons) and `updates`.
//
// Tauri's internals are read lazily, inside each call, never at the top level:
// this script makes no assumption about running after Tauri's own.
// =============================================================================
;(() => {
  if (window.redstartTwigAPI) return

  const internals = () => window.__TAURI_INTERNALS__
  const invoke = (cmd, args) => internals().invoke(cmd, args)
  const call = (method, params) => invoke('twig', { method, params: params ?? {} })

  // One Tauri listener per event name, fanned out to the page's subscribers.
  const subscribers = new Map()
  function subscribe(event, fn) {
    let set = subscribers.get(event)
    if (!set) {
      set = new Set()
      subscribers.set(event, set)
      const handler = internals().transformCallback((e) => {
        for (const cb of subscribers.get(event) ?? []) {
          try { cb(e.payload) } catch (err) { console.error(err) }
        }
      })
      invoke('plugin:event|listen', { event, target: { kind: 'Any' }, handler }).catch((err) =>
        console.error(`[twig] could not listen for ${event}:`, err))
    }
    set.add(fn)
    return () => set.delete(fn)
  }

  const mac = /Mac/.test(navigator.platform)

  window.redstartTwigAPI = Object.freeze({
    network: {
      getLocalNetworkInfo: () => call('network:get-info'),
      scanForServers: (options) => call('network:scan', options),
    },
    // fs_* tool calls run on THIS machine, in the folder the user granted.
    fs: {
      getTools: () => call('fs:get-tools'),
      execute: (name, args) => call('fs:execute', { name, args }),
      // The shell's own folder dialog; the page cannot name a folder itself.
      pickRoot: () => invoke('twig_pick_root'),
      getRoot: () => call('fs:get-root'),
      browse: (path) => call('fs:browse', { path }),
      preview: (path) => call('fs:preview', { path }),
      mkdir: (path) => call('fs:mkdir', { path }),
      move: (from, to) => call('fs:move', { from, to }),
      trash: (path) => call('fs:trash', { path }),
    },
    shell: {
      // There is no OS overlay to colour any more: the page paints the whole
      // title bar. Kept so the chat-ui's call still resolves.
      setTheme: () => Promise.resolve(),
      platform: mac ? 'macos' : 'windows',
    },
    // The title bar the page draws. macOS keeps its native traffic lights, so
    // the page draws no buttons there (only the drag area).
    window: {
      drawsControls: !mac,
      minimize: () => invoke('twig_window', { action: 'minimize' }),
      toggleMaximize: () => invoke('twig_window', { action: 'toggle-maximize' }),
      close: () => invoke('twig_window', { action: 'close' }),
      startDragging: () => invoke('twig_window', { action: 'start-dragging' }),
      isMaximized: () => invoke('twig_window', { action: 'is-maximized' }),
    },
    // Settings → Updates. status: { supported, auto, state, version, error, checkedAt }
    updates: {
      status: () => invoke('twig_update', { action: 'status' }),
      checkNow: () => invoke('twig_update', { action: 'check' }),
      setAuto: (on) => invoke('twig_update', { action: 'set-auto', value: !!on }),
      install: () => invoke('twig_update', { action: 'install' }),
      onStatus: (cb) => subscribe('twig://update-status', cb),
    },
    // Local stdio MCP servers. twigd spawns them from twig-mcp.json and pipes
    // newline-framed JSON-RPC; the chat-ui's MCP SDK client speaks the protocol.
    mcp: {
      list: () => call('mcp-local:list'),
      start: (id) => call('mcp-local:start', { id }),
      stop: (id) => call('mcp-local:stop', { id }),
      send: (id, line) => call('mcp-local:send', { id, line }),
      add: (id, config) => call('mcp-local:add', { id, ...config }),
      remove: (id) => call('mcp-local:remove', { id }),
      onMessage: (id, callback) => subscribe('twig://mcp-message', (p) => { if (p.id === id) callback(p.line) }),
      onExit: (id, callback) => subscribe('twig://mcp-exit', (p) => { if (p.id === id) callback(p.info) }),
    },
  })

  // F12, as in Electron Twig.
  window.addEventListener('keydown', (e) => {
    if (e.key === 'F12') invoke('twig_window', { action: 'toggle-devtools' }).catch(() => {})
  })
})()
