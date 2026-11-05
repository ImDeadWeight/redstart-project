// =============================================================================
// Redstart Nest — shared UI atoms
// =============================================================================
// The handful of visual primitives the launcher repeats everywhere, extracted
// so panels/tabs don't each carry their own copy of the Tailwind strings.
// Class constants are exported for elements (inputs, buttons) where a full
// component wrapper would obscure more than it saves; components are provided
// where the markup is multi-element (toggle pill, section header).
// =============================================================================

// --- Input class variants ---------------------------------------------------
// sm  = standard form field on a zinc-900 card
// xs  = compact sidebar field
// dark = field sitting on a zinc-800 inset (uses the darker zinc-900 fill)

export const inputCls = {
  sm: 'w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-orange-500 transition-colors placeholder:text-zinc-600',
  xs: 'w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-xs text-white focus:outline-none focus:border-orange-500 placeholder:text-zinc-600',
  dark: 'w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-orange-500 placeholder:text-zinc-600',
}

// --- Button class variants --------------------------------------------------

export const btnCls = {
  primary: 'px-3 py-1.5 bg-orange-500 hover:bg-orange-400 rounded text-xs font-medium transition-colors',
  primaryBlock: 'w-full px-3 py-2 bg-orange-500 hover:bg-orange-400 text-white rounded text-xs font-semibold transition-colors',
  secondary: 'px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 rounded text-xs transition-colors',
  secondaryBlock: 'w-full px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded text-xs transition-colors',
  chip: 'px-2.5 py-1 bg-zinc-700 hover:bg-zinc-600 rounded text-xs transition-colors flex-shrink-0',
  subtle: 'text-xs text-zinc-500 hover:text-zinc-300 transition-colors',
  danger: 'px-3 py-1.5 bg-red-700 hover:bg-red-600 text-white rounded text-xs font-semibold transition-colors',
  link: 'text-xs text-zinc-600 hover:text-zinc-400 transition-colors underline',
}

// --- Section header ---------------------------------------------------------

export function SectionTitle({ children, className = 'mb-2' }: { children: React.ReactNode; className?: string }) {
  return <h2 className={`text-xs uppercase tracking-widest text-zinc-500 ${className}`}>{children}</h2>
}

// --- Toggle pill ------------------------------------------------------------
// The w-10 h-5 sliding pill used for network mode, auth, tools on/off, and
// the whitelist switch. Renders only the pill — callers own the surrounding
// <label> and caption so each site keeps its exact layout.

export function TogglePill({ checked, onToggle, className = '' }: {
  checked: boolean
  onToggle: () => void
  className?: string
}) {
  return (
    <div
      onClick={onToggle}
      className={`w-10 h-5 rounded-full transition-colors relative cursor-pointer ${checked ? 'bg-orange-500' : 'bg-zinc-700'} ${className}`}>
      {/* translate-x-[1.375rem] (not `22px`): every other measurement here —
          track, knob, both margins — is a rem-based Tailwind spacing class,
          so they all scale together with the root font size (browser zoom,
          OS text-size accessibility settings). A hardcoded px offset does
          not scale with them, and at any root size other than the default
          16px the ratio breaks — this is what made the knob visibly
          overshoot the track's right edge. */}
      <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${checked ? 'translate-x-[1.375rem]' : 'translate-x-0.5'}`} />
    </div>
  )
}

// --- Truncated text with a Read more toggle ---------------------------------
// A plugin tool's description is the publisher's, not ours — some are one
// clause, some (a multi-action MCP tool documenting every `action` value in
// one string) run to a couple thousand characters. Collapsed by default so a
// 40-tool list stays scannable; nothing is ever hidden outright, only folded.
import { useState } from 'react'

export function TruncatedText({ text, limit = 160, className = '' }: {
  text: string
  limit?: number
  className?: string
}) {
  const [expanded, setExpanded] = useState(false)
  if (text.length <= limit) return <p className={className}>{text}</p>

  return (
    <p className={className}>
      {expanded ? text : text.slice(0, limit).trimEnd() + '…'}{' '}
      <button
        onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v) }}
        className="text-zinc-400 hover:text-zinc-200 underline underline-offset-2 whitespace-nowrap">
        {expanded ? 'Show less' : 'Read more'}
      </button>
    </p>
  )
}

// --- Control-plane exposure warning -----------------------------------------
// The single act that turns a low-risk deployment into a high-risk one is
// forwarding the control plane through a router, at which point the box joins
// the population the internet scans continuously. That is a bigger real-world
// risk than any certificate decision, and a visible warning costs almost
// nothing. Lives in NetworkPanel.tsx
// (the Configuration tab), alongside the exposure toggle itself — the old
// sidebar's separate Accounts panel merged in here (2026-09-02) since both
// showed the same fact from the same state shape and were on screen together.
import type { ControlPlaneState } from '../types'

// localIp is what the warning SHOWS; state.bindHost is what the listener is
// actually bound to. They are deliberately different: bindHost is the wildcard
// 0.0.0.0, which is a correct answer to "where is it bound" and a useless one
// to "what do I type on the other machine" — nobody can reach 0.0.0.0. The
// warning exists to make the reachable surface concrete, so it names the
// address someone could actually connect to.
export function ControlPlaneNotice({ state, localIp }: {
  state: ControlPlaneState | null
  localIp?: string
}) {
  if (!state?.exposed) return null
  const reachableAt = localIp ? `${localIp}:${state.port}` : `port ${state.port} on this machine’s LAN address`

  return (
    <div className="mt-3 rounded border border-red-800 bg-red-950/40 p-3">
      <p className="text-xs font-semibold text-red-300">
        Admin panel is open to the network
      </p>
      <p className="text-[11px] text-red-200/80 mt-1 leading-relaxed">
        Anyone who can reach <span className="font-mono">{reachableAt}</span> can try to sign
        in as the owner. Never forward this port through a router.
      </p>
    </div>
  )
}

import { DRAG_REGION } from '../hooks/useWindowControlsOverlay'
import { useTauriWindow, type TauriWindow } from '../hooks/useTauriWindow'

// ---------------------------------------------------------------------------
// The window's top bar — and, in Electron, its title bar.
// ---------------------------------------------------------------------------
// ONE component for both screens. In the desktop shell there is no OS title
// bar, so whatever occupies the top 48px IS the title bar: on Windows it
// carries the page-drawn window buttons (WindowControls below, full height),
// on macOS the native traffic lights sit over its left end. h-12 here must
// stay equal to index.html's pre-mount bar (test-packaging.mjs checks it).
//
// It exists because the sign-in screen used to draw its own invisible drag
// strip instead, which left the window buttons floating over a bare background
// with nothing beside them — the bar the rest of the app has was simply not
// there until you signed in. A real bar on both screens is one less thing that
// changes shape at the moment a user is trying to work out where they are.
//
// `right` is whatever belongs opposite the title; the sign-in screen passes
// nothing, since a server status is not a claim to make before the caller has
// been authenticated.

/**
 * The status readout that sits at the right of the top bar.
 *
 * Shared so the sign-in screen and the running app produce the same pixels
 * rather than two near-identical copies of the same three Tailwind strings —
 * which is what "the bar should look the same on both" actually requires.
 */
export function StatusPill({ tone, label }: {
  tone: 'on' | 'pending' | 'off'
  label: string
}) {
  const dot = tone === 'on' ? 'bg-orange-500' : tone === 'pending' ? 'bg-amber-400' : 'bg-zinc-600'
  return (
    <div className="flex items-center gap-2">
      <span className={`w-2 h-2 rounded-full ${dot}`} />
      <span className="text-xs uppercase tracking-widest text-zinc-400">{label}</span>
    </div>
  )
}

export function TopBar({ right, overlay }: {
  right?: React.ReactNode
  overlay: { active: boolean; rightInset: number }
}) {
  const tauri = useTauriWindow()

  // Tauri: the bar is the drag area, and the buttons are ours (see the hook).
  // A press on the bar itself moves the window and a double-click maximises,
  // as on a native title bar. A press on anything interactive in it is left
  // alone.
  const onMouseDown = tauri.active
    ? (e: React.MouseEvent) => {
        if (e.button !== 0) return
        if ((e.target as HTMLElement).closest('button, a, input, select, textarea, [role="button"]')) return
        if (e.detail === 2) tauri.toggleMaximize()
        else tauri.startDragging()
      }
    : undefined

  return (
    <header
      className={`flex items-center justify-between h-12 bg-zinc-900 border-b border-zinc-800 shrink-0 select-none ${!tauri.active ? 'px-5' : tauri.mac ? 'pl-20 pr-5' : 'pl-5'}`}
      onMouseDown={onMouseDown}
      // Padding rather than a margin: the buttons are painted OVER the page, so
      // the space has to be inside the element they sit on top of.
      style={overlay.active
        ? { ...DRAG_REGION, paddingRight: overlay.rightInset + 20 }
        : undefined}
    >
      <h1 className="text-lg font-bold tracking-wide">
        <span className="text-orange-500">Redstart Nest</span>
      </h1>
      <div className="flex items-center h-full">
        {right ? <div className={`flex items-center gap-5 ${tauri.active && !tauri.mac ? 'mr-4' : ''}`}>{right}</div> : null}
        {tauri.active && !tauri.mac ? <WindowControls win={tauri} /> : null}
      </div>
    </header>
  )
}

// Minimise / maximise-restore / close, sized and drawn like Windows' own
// (46 px wide, the full bar height, 10 px glyphs), in the bar's colours.
// Close turns red on hover, as Windows' does.
function WindowControls({ win }: { win: Extract<TauriWindow, { active: true }> }) {
  const base = 'w-[46px] h-full flex items-center justify-center text-zinc-400 transition-colors focus:outline-none'
  const glyph = { width: 10, height: 10, viewBox: '0 0 10 10', fill: 'none', stroke: 'currentColor', strokeWidth: 1 }
  return (
    <div className="flex h-full">
      <button type="button" aria-label="Minimise" title="Minimise"
        className={`${base} hover:bg-zinc-800 hover:text-zinc-100`} onClick={win.minimize}>
        <svg {...glyph}><path d="M0 5.5h10" /></svg>
      </button>
      <button type="button" aria-label={win.maximized ? 'Restore' : 'Maximise'} title={win.maximized ? 'Restore' : 'Maximise'}
        className={`${base} hover:bg-zinc-800 hover:text-zinc-100`} onClick={win.toggleMaximize}>
        {win.maximized
          ? <svg {...glyph}><path d="M2.5 2.5V0.5h7v7h-2" /><rect x="0.5" y="2.5" width="7" height="7" /></svg>
          : <svg {...glyph}><rect x="0.5" y="0.5" width="9" height="9" /></svg>}
      </button>
      <button type="button" aria-label="Close" title="Close"
        className={`${base} hover:bg-red-600 hover:text-white`} onClick={win.close}>
        <svg {...glyph}><path d="M0.5 0.5l9 9M9.5 0.5l-9 9" /></svg>
      </button>
    </div>
  )
}
