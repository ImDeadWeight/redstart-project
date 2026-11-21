// =============================================================================
// The section list down the left (a row of buttons on a narrow window).
// =============================================================================

export type SectionId = 'overview' | 'model' | 'images' | 'tools' | 'network' | 'activity' | 'terminal' | 'system'

const ICONS: Record<SectionId, React.ReactNode> = {
  overview: <><path d="M3 11l9-7 9 7" /><path d="M5 10v10h14V10" /></>,
  model: <><rect x="6" y="6" width="12" height="12" rx="2" /><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" /></>,
  images: <><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="2" /><path d="M21 16l-5-5-9 9" /></>,
  tools: <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z" />,
  network: <><path d="M2 9a16 16 0 0 1 20 0" /><path d="M5 13a11 11 0 0 1 14 0" /><path d="M8.5 16.5a6 6 0 0 1 7 0" /><circle cx="12" cy="20" r="1" /></>,
  activity: <path d="M3 12h4l3-8 4 16 3-8h4" />,
  terminal: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 9l3 3-3 3M13 15h4" /></>,
  system: <><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" /></>,
}

export const SECTIONS: { id: SectionId; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'model', label: 'Model' },
  { id: 'images', label: 'Images' },
  { id: 'tools', label: 'Tools' },
  { id: 'network', label: 'Network & access' },
  { id: 'activity', label: 'Activity' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'system', label: 'System' },
]

export function Sidebar({ active, onSelect, badges = {} }: {
  active: SectionId
  onSelect: (id: SectionId) => void
  /** A small dot beside a section that wants attention (an update, a running model's log). */
  badges?: Partial<Record<SectionId, 'warn' | 'live'>>
}) {
  return (
    <nav aria-label="Sections"
      className="flex shrink-0 flex-row flex-wrap gap-1 border-b border-zinc-800 bg-[#0f0f11] px-3 py-2 md:w-60 md:flex-col md:flex-nowrap md:overflow-y-auto md:border-b-0 md:border-r md:px-3 md:py-5">
      {SECTIONS.map(({ id, label }) => {
        const on = id === active
        const badge = badges[id]
        return (
          <button key={id} type="button" onClick={() => onSelect(id)} aria-current={on ? 'page' : undefined}
            className={`flex items-center gap-3 rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors md:w-full ${
              on ? 'bg-zinc-800 text-white shadow-[inset_3px_0_0_#f97316]' : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'}`}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
              {ICONS[id]}
            </svg>
            <span className="flex-1">{label}</span>
            {badge && <span aria-hidden="true" className={`h-2 w-2 rounded-full ${badge === 'warn' ? 'bg-amber-400' : 'bg-green-400'}`} />}
          </button>
        )
      })}
    </nav>
  )
}
