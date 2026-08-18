// Plugins tab — acquiring and maintaining third-party MCP plugins.
// SKELETON — see docs/notes/mcp-plugin-system-tasks.md task T20.
//
// THIS TAB IS NOT THE TOOLS TAB, AND THE SPLIT IS DELIBERATE.
//
//   Plugins tab (here) — browse the registry, install, uninstall, watch install
//     progress, health and lastError, re-probe, per-tool classification, and
//     the registry `enabled` master switch. Everything about ACQUIRING a plugin.
//
//   Tools tab — each installed+enabled plugin appears as a capability card
//     beside Postgres/Documents/Vault, activated per profile through
//     activeToolIds exactly like a built-in (T20b).
//
// A plugin has two switches by design (plan decision D-a): `enabled` means
// "installed and permitted on this server", activeToolIds means "switched on
// for this profile". Side by side in one tab they read as redundancy someone
// will try to collapse — and collapsing them breaks the model. Split across two
// tabs they read as what they are. Do not add an activeToolIds control here.
//
// Must also stay visually distinct from the Tools tab's External MCP section:
// client-executed remote servers are a different mechanism with a different
// trust boundary (plan Trap 10).

import type { usePlugins } from '../hooks/usePlugins'

type Props = {
  plugins: ReturnType<typeof usePlugins>
}

export function PluginsTab(_props: Props) {
  // TODO(T20): build out —
  //   - installed list: source, pinned version, tool count, enabled toggle
  //   - health per row: lastError / lastErrorAt, plus a Test button
  //   - per-tool classification editor (every tool starts 'destructive')
  //   - "Add tool" button opening AddToolDialog
  //   - uninstall, with a confirmation naming what is removed
  //
  // Renders a placeholder rather than throwing: this component is mounted by
  // App.tsx in step 20a, and a throwing tab would take the window down.
  return (
    <div className="p-6 text-sm text-zinc-400">
      <p className="font-medium text-zinc-200">Plugins</p>
      <p className="mt-2">Not implemented yet — see TODO(T20) in src/tabs/PluginsTab.tsx.</p>
    </div>
  )
}
