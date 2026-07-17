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
      <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${checked ? 'translate-x-[22px]' : 'translate-x-0.5'}`} />
    </div>
  )
}
