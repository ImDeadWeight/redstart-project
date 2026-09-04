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
