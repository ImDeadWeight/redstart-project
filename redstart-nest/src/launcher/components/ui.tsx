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
// sm  = standard form field on a card
// xs  = compact field (dense lists, inline renames)
// dark = field sitting on a darker inset

const field = 'w-full bg-zinc-900 border border-zinc-700 rounded-lg text-zinc-100 hover:border-zinc-500 focus:outline-none focus:border-orange-500 transition-colors placeholder:text-zinc-500 disabled:opacity-50'
export const inputCls = {
  sm: `${field} px-3 py-2 text-sm`,
  xs: `${field} px-2 py-1.5 text-xs`,
  dark: `${field} bg-zinc-950 px-3 py-2 text-sm`,
}

// --- Button class variants --------------------------------------------------
// One primary action per screen: orange with dark text (white on orange-500
// fails contrast). Everything else is an outlined secondary or a text link.

const btnBase = 'inline-flex items-center justify-center gap-2 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed'
export const btnCls = {
  primary: `${btnBase} px-3.5 py-2 bg-orange-500 hover:bg-orange-400 text-zinc-950 text-sm font-semibold disabled:bg-zinc-800 disabled:text-zinc-500 disabled:opacity-100`,
  primaryBlock: `${btnBase} w-full px-3.5 py-2.5 bg-orange-500 hover:bg-orange-400 text-zinc-950 text-sm font-semibold disabled:bg-zinc-800 disabled:text-zinc-500 disabled:opacity-100`,
  secondary: `${btnBase} px-3 py-2 border border-zinc-700 hover:border-zinc-500 hover:bg-zinc-800 text-zinc-100 text-sm`,
  secondaryBlock: `${btnBase} w-full px-3 py-2 border border-zinc-700 hover:border-zinc-500 hover:bg-zinc-800 text-zinc-100 text-sm`,
  chip: `${btnBase} px-2.5 py-1 border border-zinc-700 hover:border-zinc-500 hover:bg-zinc-800 text-zinc-200 text-xs flex-shrink-0`,
  subtle: 'text-sm text-orange-400 hover:text-orange-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
  danger: `${btnBase} px-3.5 py-2 bg-red-800 hover:bg-red-700 border border-red-700 text-red-50 text-sm font-semibold`,
  dangerOutline: `${btnBase} px-3.5 py-2 border border-red-900 hover:bg-red-950 text-red-300 text-sm`,
  link: 'text-sm text-orange-400 hover:text-orange-300 underline-offset-2 hover:underline transition-colors',
}

// --- Section header ---------------------------------------------------------
// Sentence case, not the old all-caps tracking: a card's title is a heading
// people read, not a label they skim past.

export function SectionTitle({ children, className = 'mb-2' }: { children: React.ReactNode; className?: string }) {
  return <h2 className={`text-base font-semibold text-zinc-100 ${className}`}>{children}</h2>
}

// --- Cards and page headers -------------------------------------------------

export function Card({ children, className = '', tone = 'default', ...rest }: {
  children: React.ReactNode
  className?: string
  tone?: 'default' | 'danger' | 'attention'
} & React.HTMLAttributes<HTMLElement>) {
  const border = tone === 'danger' ? 'border-red-950' : tone === 'attention' ? 'border-amber-800/70' : 'border-zinc-800'
  return <section {...rest} className={`bg-zinc-900 border ${border} rounded-xl p-5 ${className}`}>{children}</section>
}

export function PageHeader({ title, children, actions }: {
  title: string
  children?: React.ReactNode
  actions?: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-end gap-4">
      <div className="flex-1 min-w-[16rem]">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-50">{title}</h1>
        {children && <p className="mt-1.5 text-[15px] text-zinc-400">{children}</p>}
      </div>
      {actions}
    </div>
  )
}

/** A rounded status label: On, Needs setup, Up to date. */
export function Chip({ tone = 'off', children }: { tone?: 'ok' | 'warn' | 'error' | 'off' | 'info'; children: React.ReactNode }) {
  const cls = {
    ok: 'text-green-400 bg-green-950/60',
    warn: 'text-amber-300 bg-amber-950/50',
    error: 'text-red-300 bg-red-950/60',
    off: 'text-zinc-400 bg-zinc-800',
    info: 'text-sky-300 bg-sky-950/50',
  }[tone]
  return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap ${cls}`}>{children}</span>
}

/** Segmented control for switching views inside a section. */
export function Segmented<T extends string>({ value, onChange, options, label }: {
  value: T
  onChange: (v: T) => void
  options: { id: T; label: React.ReactNode }[]
  label: string
}) {
  return (
    <div role="tablist" aria-label={label} className="inline-flex flex-wrap gap-1 rounded-xl border border-zinc-800 bg-zinc-900 p-1 self-start">
      {options.map(o => (
        <button key={o.id} type="button" role="tab" aria-selected={value === o.id}
          onClick={() => onChange(o.id)}
          className={`rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors ${value === o.id ? 'bg-zinc-700/70 text-white' : 'text-zinc-400 hover:text-zinc-200'}`}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

// --- Switch -----------------------------------------------------------------
// A real <button role="switch">, so it is reachable by keyboard and announced
// as on/off. Inside a <label>, clicking the label text toggles it too (a
// button is labelable). Callers still own the surrounding text.

export function TogglePill({ checked, onToggle, className = '', label, disabled }: {
  checked: boolean
  onToggle: () => void
  className?: string
  /** Accessible name when no visible <label> wraps the switch. */
  label?: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={(e) => { e.stopPropagation(); onToggle() }}
      className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${checked ? 'bg-orange-500' : 'bg-zinc-700'} ${className}`}>
      {/* rem-based offset, not px: it scales with the root font size along
          with the track and knob (browser zoom, OS text size). */}
      <span className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-[1.375rem]' : 'translate-x-0.5'}`} />
    </button>
  )
}
export const Switch = TogglePill

// --- Modal ------------------------------------------------------------------
// The one popup frame: title bar, a body that scrolls on its own, and a footer
// that never scrolls away. Closes on Escape, on the backdrop, and on the ×.
// Focus moves into the dialog when it opens and back to where it was after.

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export function Modal({ open, title, subtitle, onClose, children, footer, size = 'md', flush = false }: {
  open: boolean
  title: string
  subtitle?: React.ReactNode
  onClose: () => void
  children: React.ReactNode
  footer?: React.ReactNode
  size?: 'sm' | 'md' | 'lg' | 'xl'
  /** No body padding and no body scroll: the child lays out (and scrolls) its own panes. */
  flush?: boolean
}) {
  const dialogRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const before = document.activeElement as HTMLElement | null
    const first = dialogRef.current?.querySelector<HTMLElement>('[autofocus], input, select, textarea, button:not([data-modal-close])')
    ;(first ?? dialogRef.current)?.focus()
    return () => { before?.focus?.() }
  }, [open])
  if (!open) return null
  const width = size === 'sm' ? 'max-w-md' : size === 'lg' ? 'max-w-3xl' : size === 'xl' ? 'max-w-5xl' : 'max-w-xl'
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 sm:p-6"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}
        className={`flex w-full ${width} max-h-[calc(100vh-3rem)] flex-col overflow-hidden rounded-2xl border border-zinc-700 bg-zinc-900 text-zinc-100 shadow-2xl shadow-black/60 focus:outline-none`}>
        <div className="flex shrink-0 items-start gap-3 border-b border-zinc-800 px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-[17px] font-semibold">{title}</h2>
            {subtitle && <div className="mt-1 text-sm text-zinc-400">{subtitle}</div>}
          </div>
          <button type="button" data-modal-close onClick={onClose} aria-label="Close"
            className="-mr-1 rounded-md px-2 py-0.5 text-xl leading-none text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">×</button>
        </div>
        <div className={flush ? 'flex min-h-0 flex-1 flex-col' : 'min-h-0 flex-1 overflow-y-auto px-5 py-4'}>{children}</div>
        {footer && <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-zinc-800 px-5 py-3.5">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}

/** A Modal for "are you sure": a short explanation, Cancel, and one action. */
export function ConfirmDialog({ open, title, children, confirmLabel, onConfirm, onCancel, danger = true, busy = false }: {
  open: boolean
  title: string
  children: React.ReactNode
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
  danger?: boolean
  busy?: boolean
}) {
  return (
    <Modal open={open} title={title} onClose={onCancel} size="sm"
      footer={<>
        <button type="button" onClick={onCancel} className={btnCls.secondary}>Cancel</button>
        <button type="button" onClick={onConfirm} disabled={busy} className={danger ? btnCls.danger : btnCls.primary}>{confirmLabel}</button>
      </>}>
      <div className="space-y-3 text-sm leading-relaxed text-zinc-300">{children}</div>
    </Modal>
  )
}

// --- Truncated text with a Read more toggle ---------------------------------
// A plugin tool's description is the publisher's, not ours — some are one
// clause, some (a multi-action MCP tool documenting every `action` value in
// one string) run to a couple thousand characters. Collapsed by default so a
// 40-tool list stays scannable; nothing is ever hidden outright, only folded.
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
  // Over HTTPS (the bundled Caddy) the password is encrypted on the way; the
  // panel is still a sign-in page for anyone on the network, so the notice
  // stays, in a calmer form.
  if (state.viaHttps) {
    return (
      <div className="mt-3 rounded-lg border border-amber-800/70 bg-amber-950/30 p-3">
        <p className="text-sm font-semibold text-amber-300">Admin panel is reachable on the network, over HTTPS</p>
        <p className="text-[13px] text-amber-200/80 mt-1 leading-relaxed">
          Encrypted, and only through the secure address{state.httpsUrl ? <> (<span className="font-mono">{state.httpsUrl}</span>)</> : null}.
          Anyone on your network can still try to sign in as the owner. This computer keeps its own direct way in.
        </p>
      </div>
    )
  }
  const reachableAt = localIp ? `${localIp}:${state.port}` : `port ${state.port} on this machine’s LAN address`

  return (
    <div className="mt-3 rounded-lg border border-red-800 bg-red-950/40 p-3">
      <p className="text-sm font-semibold text-red-300">
        Admin panel is open to the network
      </p>
      <p className="text-[13px] text-red-200/80 mt-1 leading-relaxed">
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
export function StatusPill({ tone, label, detail, tip }: {
  tone: 'on' | 'pending' | 'off'
  label: string
  /** A quieter second part, e.g. the model's name. */
  detail?: string
  tip?: string
}) {
  const dot = tone === 'on' ? 'bg-green-400 shadow-[0_0_0_3px_rgba(74,222,128,0.15)]' : tone === 'pending' ? 'bg-amber-400 animate-pulse' : 'bg-zinc-500'
  return (
    <div role="status" tabIndex={tip ? 0 : undefined} data-tip={tip}
      className="flex min-w-0 items-center gap-2 rounded-full border border-zinc-800 bg-zinc-950/60 px-3 py-1">
      <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
      <span className="text-[13px] font-semibold text-zinc-100 whitespace-nowrap">{label}</span>
      {detail && <span className="hidden truncate text-[13px] text-zinc-400 md:inline">{detail}</span>}
    </div>
  )
}

/**
 * The window's top bar. One component for the sign-in screen and the app, so
 * the bar does not change shape at the moment someone signs in.
 *
 * In the desktop shell there is no OS title bar, so whatever occupies the top
 * 48px IS the title bar: on Windows it carries the page-drawn window buttons
 * (WindowControls below, full height), on macOS the native traffic lights sit
 * over its left end. h-12 here must stay equal to index.html's pre-mount bar
 * (test-packaging.mjs checks it).
 *
 * `children` sits beside the title (status, profile); `right` sits at the far
 * end (address, Start/Stop). The sign-in screen passes neither server status
 * nor controls: a server status is not a claim to make before the caller has
 * been authenticated.
 */
export function TopBar({ right, overlay, children }: {
  right?: React.ReactNode
  overlay: { active: boolean; rightInset: number }
  children?: React.ReactNode
}) {
  const tauri = useTauriWindow()

  // Tauri: the bar is the drag area, and the buttons are ours (see the hook).
  // A press on the bar itself moves the window and a double-click maximises,
  // as on a native title bar. A press on anything interactive is left alone.
  const onMouseDown = tauri.active
    ? (e: React.MouseEvent) => {
        if (e.button !== 0) return
        if ((e.target as HTMLElement).closest('button, a, input, select, textarea, [role="button"], [role="status"]')) return
        if (e.detail === 2) tauri.toggleMaximize()
        else tauri.startDragging()
      }
    : undefined

  return (
    <header
      className={`flex items-center gap-3 h-12 bg-[#111113] border-b border-zinc-800 shrink-0 select-none ${!tauri.active ? 'px-4' : tauri.mac ? 'pl-20 pr-4' : 'pl-4'}`}
      onMouseDown={onMouseDown}
      // Padding rather than a margin: the buttons are painted OVER the page, so
      // the space has to be inside the element they sit on top of.
      style={overlay.active
        ? { ...DRAG_REGION, paddingRight: overlay.rightInset + 16 }
        : undefined}
    >
      <div className="flex shrink-0 items-center gap-2.5">
        <img src="/redstart.svg" alt="" width={28} height={28} className="h-7 w-7 [image-rendering:pixelated]" />
        <span className="text-[15px] font-bold tracking-tight text-zinc-50">Redstart Nest</span>
      </div>
      {children && <div className="flex min-w-0 items-center gap-3">{children}</div>}
      <div className="min-w-0 flex-1" />
      <div className="flex h-full shrink-0 items-center">
        {right ? <div className={`flex items-center gap-3 ${tauri.active && !tauri.mac ? 'mr-3' : ''}`}>{right}</div> : null}
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
      <button type="button" aria-label="Minimise" data-tip="Minimise" data-tip-end=""
        className={`${base} hover:bg-zinc-800 hover:text-zinc-100`} onClick={win.minimize}>
        <svg {...glyph}><path d="M0 5.5h10" /></svg>
      </button>
      <button type="button" aria-label={win.maximized ? 'Restore' : 'Maximise'} data-tip={win.maximized ? 'Restore' : 'Maximise'} data-tip-end=""
        className={`${base} hover:bg-zinc-800 hover:text-zinc-100`} onClick={win.toggleMaximize}>
        {win.maximized
          ? <svg {...glyph}><path d="M2.5 2.5V0.5h7v7h-2" /><rect x="0.5" y="2.5" width="7" height="7" /></svg>
          : <svg {...glyph}><rect x="0.5" y="0.5" width="9" height="9" /></svg>}
      </button>
      <button type="button" aria-label="Close" data-tip="Close" data-tip-end=""
        className={`${base} hover:bg-red-600 hover:text-white`} onClick={win.close}>
        <svg {...glyph}><path d="M0.5 0.5l9 9M9.5 0.5l-9 9" /></svg>
      </button>
    </div>
  )
}
