import { useEffect, useState } from 'react'

// The Electron window has no OS title bar (`titleBarStyle: 'hidden'`), so the
// app draws its own and Electron paints only the minimise/maximise/close
// buttons on top, themed to match. Two things follow that the page has to
// handle, and this hook is how it knows to:
//
//   1. SOMETHING MUST BE DRAGGABLE. With the native bar gone, a window with no
//      `-webkit-app-region: drag` region cannot be moved at all. Every screen
//      needs one — including the sign-in screen, which is a completely
//      different tree from the main app.
//   2. THE BUTTONS OVERLAP THE PAGE. They float above the top-right corner, so
//      whatever the app puts there needs to be pushed left by exactly their
//      width — which is not a constant: it changes with display scaling, and
//      on some systems with the language.
//
// The SAME BUNDLE is served to ordinary browsers (that is the whole point of
// the control plane), where `navigator.windowControlsOverlay` does not exist.
// There the hook reports inactive, no drag region or inset is applied, and the
// page renders exactly as it always has. That is why this is feature-detected
// rather than keyed on "am I in Electron" — the question being asked really is
// "is there an overlay to make room for", and a browser's answer is no.
interface WindowControlsOverlayLike {
  visible: boolean
  getTitlebarAreaRect(): DOMRect
  addEventListener(type: 'geometrychange', listener: () => void): void
  removeEventListener(type: 'geometrychange', listener: () => void): void
}

export function useWindowControlsOverlay() {
  const [state, setState] = useState({ active: false, rightInset: 0 })

  useEffect(() => {
    const wco = (navigator as Navigator & { windowControlsOverlay?: WindowControlsOverlayLike })
      .windowControlsOverlay
    if (!wco) return

    const read = () => {
      // `visible` is false when the window is full-screened — the overlay is
      // gone then, and reserving space for absent buttons would leave a gap.
      if (!wco.visible) return setState({ active: false, rightInset: 0 })
      const rect = wco.getTitlebarAreaRect()
      // The draggable area ends where the buttons begin; everything to the
      // right of it is theirs. Measured rather than assumed, because the width
      // is not a constant across DPI settings.
      setState({ active: true, rightInset: Math.max(0, window.innerWidth - rect.right) })
    }

    read()
    wco.addEventListener('geometrychange', read)
    // geometrychange covers the overlay's own changes; a plain resize can move
    // innerWidth without firing it.
    window.addEventListener('resize', read)
    return () => {
      wco.removeEventListener('geometrychange', read)
      window.removeEventListener('resize', read)
    }
  }, [])

  return state
}

/** `-webkit-app-region`, which React's CSSProperties does not know about. */
export const DRAG_REGION = { WebkitAppRegion: 'drag' } as React.CSSProperties
export const NO_DRAG_REGION = { WebkitAppRegion: 'no-drag' } as React.CSSProperties
