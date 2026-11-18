import { useEffect, useState } from 'react'
import { isTauri } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'

// The Tauri desktop shell (redstart-nest/shell) opens this page in a window
// with no OS title bar (`decorations: false`), so the page draws the whole
// bar: TopBar is the drag area, and these are its minimise / maximise /
// close. Unlike Electron's titleBarOverlay, Tauri on Windows has no native
// buttons to lay over the page.
//
// The calls go through Tauri's IPC, which shell/capabilities/window-controls.json
// allows for exactly these window operations, only for the shell's main
// window, and only at the admin listener's own origin. The SAME bundle is
// served to ordinary browsers, where isTauri() is false: no controls are
// drawn and nothing here runs. A browser on another device can never move
// someone else's window.
//
// Close does not quit. The shell intercepts it (first-close notice, then
// the window goes and Redstart keeps running in the tray).

export function useTauriWindow() {
  const [active] = useState(() => isTauri())
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    if (!active) return
    const win = getCurrentWindow()
    let unlisten: (() => void) | null = null
    let disposed = false
    const read = () => { win.isMaximized().then(setMaximized).catch(() => {}) }
    read()
    win.onResized(read).then((fn) => {
      if (disposed) fn()
      else unlisten = fn
    }).catch(() => {})
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [active])

  if (!active) return { active: false as const }
  const win = getCurrentWindow()
  return {
    active: true as const,
    // macOS keeps its native traffic lights (the shell's Overlay title bar):
    // the page leaves room for them at the left and draws no buttons.
    mac: /Macintosh|Mac OS X/.test(navigator.userAgent),
    maximized,
    minimize: () => { win.minimize().catch(() => {}) },
    toggleMaximize: () => { win.toggleMaximize().catch(() => {}) },
    close: () => { win.close().catch(() => {}) },
    startDragging: () => { win.startDragging().catch(() => {}) },
  }
}

export type TauriWindow = ReturnType<typeof useTauriWindow>
