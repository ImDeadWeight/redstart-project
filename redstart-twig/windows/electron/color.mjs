'use strict'

// =============================================================================
// Redstart Twig — CSS colour -> #rrggbb
// =============================================================================
// The renderer reports the background colour it is actually painting so the
// Windows title-bar overlay (the strip behind minimise/maximise/close) can match
// it. `getComputedStyle` returns `rgb()` / `rgba()`, while setTitleBarOverlay
// wants `#rrggbb` — this bridges the two.
//
// It exists as its own module, rather than a helper inside main.mjs, so it can
// be tested under plain node: main.mjs imports Electron and cannot be loaded
// outside it. Same reasoning as fs/trash.mjs taking its OS implementation by
// injection.
//
// Why this parsing exists at all: the overlay colour used to be a hardcoded hex
// that had to agree with a CSS variable in a different repo folder. It drifted —
// the app painted oklch(0.12 0 0) = #060606 while the overlay said #09090b, and
// the mismatch showed up as a lighter band behind the window buttons. Reading
// the live value removes the class of bug rather than correcting one instance.
// =============================================================================

/**
 * Convert a CSS colour string to `#rrggbb`, or null when it cannot be parsed.
 *
 * Alpha is deliberately dropped: the overlay is opaque, and passing a value
 * Electron rejects would silently leave the previous colour in place — a
 * failure that looks exactly like the bug this is fixing.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function toHexColor(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()

  if (/^#[0-9a-f]{6}$/i.test(trimmed)) return trimmed.toLowerCase()
  if (/^#[0-9a-f]{3}$/i.test(trimmed)) {
    return ('#' + trimmed.slice(1).split('').map((c) => c + c).join('')).toLowerCase()
  }

  // rgb(6 6 6) and rgb(6, 6, 6) are both valid CSS; browsers emit either.
  const rgb = trimmed.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i)
  if (!rgb) return null

  const channels = rgb.slice(1, 4).map((n) => {
    const parsed = Number(n)
    if (!Number.isFinite(parsed)) return null
    const clamped = Math.max(0, Math.min(255, Math.round(parsed)))
    return clamped.toString(16).padStart(2, '0')
  })
  if (channels.some((c) => c === null)) return null
  return '#' + channels.join('')
}
