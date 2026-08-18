// Plugins tab — acquiring and maintaining third-party MCP plugins.
// See docs/notes/mcp-plugin-system-tasks.md task T20.
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

import { useState } from 'react'
import { api } from '../api/redstart'
import type { PluginSummary, PluginToolInfo } from '../api/redstart'
import type { usePlugins } from '../hooks/usePlugins'
import { SectionTitle, TogglePill, btnCls } from '../components/ui'
import { AddToolDialog } from '../components/AddToolDialog'

type Props = {
  plugins: ReturnType<typeof usePlugins>
}

function sourceLabel(source: PluginSummary['source']): string {
  if (!source) return 'unknown source'
  if (source.kind === 'npm') return `npm · ${source.packageName}@${source.version}`
  if (source.kind === 'path') return `local · ${source.path}`
  return `command · ${source.command}`
}

export function PluginsTab({ plugins }: Props) {
  const { plugins: list, loading, uninstall, setEnabled, testPlugin, loadPlugins } = plugins
  const [showAdd, setShowAdd] = useState(false)
  const [testing, setTesting] = useState<string | null>(null)
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; message: string }>>({})
  const [expanded, setExpanded] = useState<string | null>(null)
  const [confirmUninstall, setConfirmUninstall] = useState<string | null>(null)

  async function runTest(id: string) {
    setTesting(id)
    try {
      const result = await testPlugin(id)
      setTestResults((prev) => ({ ...prev, [id]: result }))
    } finally {
      setTesting(null)
    }
  }

  return (
    <section className="bg-zinc-900 rounded-lg p-4 border border-zinc-800">
      <div className="flex items-center justify-between mb-1">
        <SectionTitle className="">Plugins</SectionTitle>
        <button onClick={() => setShowAdd(true)} className={btnCls.primary}>Add tool</button>
      </div>
      <p className="text-xs text-zinc-600 mb-4">
        Third-party MCP servers — not the External MCP Servers on the Tools tab, which are client-executed and never run on this machine.
        Installing here does not turn a plugin on for any profile; that happens on the Tools tab once it's enabled below.
      </p>

      {loading && list.length === 0 && <p className="text-xs text-zinc-600">Loading…</p>}
      {!loading && list.length === 0 && (
        <p className="text-xs text-zinc-600">No plugins installed. "Add tool" installs a third-party MCP server and lets you classify its tools before anything runs.</p>
      )}

      <div className="space-y-2">
        {list.map((p) => (
          <div key={p.id} className="bg-zinc-800/40 rounded px-3 py-2.5">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-zinc-200 truncate">{p.displayName}</span>
                  {p.lastError ? (
                    <span className="text-xs text-red-400 flex-shrink-0" title={p.lastErrorAt || undefined}>● unhealthy</span>
                  ) : (
                    <span className="text-xs text-green-400 flex-shrink-0">● healthy</span>
                  )}
                </div>
                <p className="text-xs text-zinc-600 truncate">
                  {sourceLabel(p.source)}{p.resolvedVersion ? ` (resolved ${p.resolvedVersion})` : ''} · {p.toolCount} tool{p.toolCount === 1 ? '' : 's'}
                  {p.hasSecret ? ' · holds a credential' : ''}
                </p>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <span className={`text-xs ${p.enabled ? 'text-green-400' : 'text-zinc-500'}`}>{p.enabled ? 'Enabled' : 'Disabled'}</span>
                <TogglePill checked={p.enabled} onToggle={() => setEnabled(p.id, !p.enabled)} />
              </div>
            </div>

            {p.lastError && (
              <p className="text-xs text-red-400 mt-1.5">
                {p.lastError}{p.lastErrorAt ? ` (${new Date(p.lastErrorAt).toLocaleString()})` : ''}
              </p>
            )}

            {testResults[p.id] && (
              <p className={`text-xs mt-1.5 ${testResults[p.id].ok ? 'text-green-400' : 'text-red-400'}`}>{testResults[p.id].message}</p>
            )}

            <div className="flex items-center gap-3 mt-2 pt-2 border-t border-zinc-700/50">
              <button onClick={() => runTest(p.id)} disabled={testing === p.id} className={btnCls.chip + ' disabled:opacity-50'}>
                {testing === p.id ? 'Testing…' : 'Test'}
              </button>
              <button onClick={() => setExpanded(expanded === p.id ? null : p.id)} className={btnCls.subtle}>
                {expanded === p.id ? 'Hide tools' : 'Classify tools'}
              </button>
              <button onClick={() => setConfirmUninstall(p.id)} className={btnCls.subtle + ' text-red-400 hover:text-red-300'}>
                Uninstall
              </button>
            </div>

            {expanded === p.id && <ToolClassificationEditor pluginId={p.id} plugins={plugins} />}

            {confirmUninstall === p.id && (
              <div className="mt-2 pt-2 border-t border-zinc-700/50 flex items-center justify-between gap-2">
                <p className="text-xs text-yellow-500/90">
                  Remove "{p.displayName}"? Its tools disappear from every profile immediately{p.hasSecret ? ' and its stored credential is deleted' : ''}.
                </p>
                <div className="flex gap-2 flex-shrink-0">
                  <button onClick={() => setConfirmUninstall(null)} className={btnCls.chip}>Cancel</button>
                  <button onClick={async () => { await uninstall(p.id); setConfirmUninstall(null) }} className="px-2.5 py-1 bg-red-700 hover:bg-red-600 text-white rounded text-xs">Remove</button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      <AddToolDialog open={showAdd} onClose={() => setShowAdd(false)} onInstalled={loadPlugins} plugins={plugins} />
    </section>
  )
}

function ToolClassificationEditor({ pluginId, plugins }: { pluginId: string; plugins: ReturnType<typeof usePlugins> }) {
  const [tools, setTools] = useState<PluginToolInfo[] | null>(null)

  if (tools === null) {
    api().plugins.get(pluginId).then((p) => setTools(p?.tools ?? []))
    return <p className="text-xs text-zinc-600 mt-2">Loading…</p>
  }

  return (
    <div className="mt-2 pt-2 border-t border-zinc-700/50 divide-y divide-zinc-800">
      {tools.map((t) => (
        <div key={t.name} className="flex items-center justify-between gap-2 py-1.5">
          <span className="text-xs text-zinc-300 truncate">{t.name}</span>
          <select
            className="bg-zinc-900 border border-zinc-700 rounded px-1.5 py-1 text-xs text-white flex-shrink-0"
            value={t.class}
            onChange={async (e) => {
              const cls = e.target.value as PluginToolInfo['class']
              await plugins.setToolClass(pluginId, t.name, cls)
              setTools((prev) => prev!.map((x) => (x.name === t.name ? { ...x, class: cls } : x)))
            }}>
            <option value="read">read</option>
            <option value="network">network</option>
            <option value="write">write</option>
            <option value="destructive">destructive</option>
          </select>
        </div>
      ))}
    </div>
  )
}
