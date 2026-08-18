// "Add tool" — the five-step install wizard.
// See docs/notes/mcp-plugin-system-tasks.md task T20 and the plan's
// "The Add tool flow" / "Generating step 2 from metadata".
//
// The admin never types a shell command (unless they deliberately choose the
// Advanced source, which is the one place that's still exactly a command).

import { useState } from 'react'
import { api } from '../api/redstart'
import type { PluginToolInfo, RegistrySearchResult } from '../api/redstart'
import type { usePlugins } from '../hooks/usePlugins'
import { btnCls, inputCls, TruncatedText } from './ui'

// A fixed-width sibling of inputCls.xs for the per-tool class picker. Deliberately
// NOT built from inputCls.xs + ' w-32' — that variant's own w-full and a
// tacked-on w-32 are the same Tailwind specificity tier, and w-full wins in
// this build's generated stylesheet order regardless of source order in the
// className string.
const selectClsCompact =
  'w-32 flex-shrink-0 bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-xs text-white focus:outline-none focus:border-orange-500'

/** One generated input. Registry metadata maps onto this directly:
 *  name -> label, description -> helper text, format -> widget,
 *  isRequired -> asterisk + submit block, default -> value, placeholder -> hint. */
export type FormField = {
  name: string
  description?: string
  format: 'string' | 'filepath' | 'boolean'
  isRequired: boolean
  isSecret: boolean
  default?: string
  placeholder?: string
}

export type WizardStep = 1 | 2 | 3 | 4 | 5

type Props = {
  open: boolean
  onClose: () => void
  onInstalled: () => void
  plugins: ReturnType<typeof usePlugins>
}

/**
 * isSecret is publisher-set and present on only about a third of
 * declarations in the wild. Treat a field as secret when isSecret is true OR
 * its NAME looks like a credential.
 *
 * Over-masking costs one annoyance. Under-masking puts a live key in a
 * plaintext box AND outside the encrypted storage path, because this function
 * is what decides which values get encrypted (D-f).
 */
export const SECRET_NAME_PATTERN = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i

export function isSecretField(field: FormField): boolean {
  return field.isSecret || SECRET_NAME_PATTERN.test(field.name)
}

const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9_]{1,31}$/

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32) || 'plugin'
}

type SourceKind = 'registry' | 'npm' | 'path' | 'command'
type EnvEntry = { value: string; isSecret: boolean }
type InstallOk = Extract<Awaited<ReturnType<ReturnType<typeof api>['plugins']['install']>>, { ok: true }>

const initialState = {
  step: 1 as WizardStep,
  sourceKind: 'registry' as SourceKind,
  registryQuery: '',
  registrySearched: false,
  registrySelected: null as RegistrySearchResult | null,
  npmPackage: '',
  npmVersion: '',
  localPath: '',
  command: '',
  commandArgs: '',
  displayName: '',
  pluginId: '',
  pluginIdTouched: false,
  fields: [] as FormField[],
  freeformRows: [{ name: '', value: '', isSecret: false }] as { name: string; value: string; isSecret: boolean }[],
  values: {} as Record<string, string>,
  installing: false,
  installError: null as string | null,
  installResult: null as InstallOk | null,
  tools: [] as PluginToolInfo[],
  confirming: false,
  confirmError: null as string | null,
}

export function AddToolDialog({ open, onClose, onInstalled, plugins }: Props) {
  const installProgress = plugins.installProgress
  const [s, setState] = useState(initialState)
  const set = <K extends keyof typeof initialState>(key: K, value: (typeof initialState)[K]) =>
    setState((prev) => ({ ...prev, [key]: value }))

  if (!open) return null

  function reset() {
    setState(initialState)
  }
  function close() {
    reset()
    onClose()
  }

  async function runSearch() {
    set('registrySearched', true)
    await plugins.search(s.registryQuery)
  }

  function pickRegistryResult(entry: RegistrySearchResult) {
    setState((prev) => ({
      ...prev,
      registrySelected: entry,
      npmPackage: entry.packageName || '',
      npmVersion: entry.version || '',
      displayName: entry.name,
      pluginId: prev.pluginIdTouched ? prev.pluginId : slugify(entry.name),
      fields: entry.fields.map((f) => ({
        name: f.name,
        description: f.description,
        format: (f.format === 'filepath' || f.format === 'boolean' ? f.format : 'string') as FormField['format'],
        isRequired: f.isRequired,
        isSecret: f.isSecret,
        default: typeof f.default === 'string' ? f.default : undefined,
        placeholder: f.placeholder,
      })),
    }))
  }

  function goToStep2() {
    if (s.sourceKind === 'registry' && !s.registrySelected) return
    if (!s.pluginIdTouched) {
      // BUG (found via a real install): this ternary had no 'registry' case,
      // so it fell through to the 'path' branch's s.localPath — empty for a
      // registry pick — and silently OVERWROTE the good id pickRegistryResult
      // had just derived from entry.name with the literal fallback "plugin".
      // Every registry-sourced install got the same meaningless id unless the
      // admin happened to hand-edit the id field first.
      const seed =
        s.sourceKind === 'registry' ? s.displayName
        : s.sourceKind === 'npm' ? s.npmPackage
        : s.sourceKind === 'command' ? s.command
        : s.localPath
      set('pluginId', slugify(seed || 'plugin'))
    }
    set('step', 2)
  }

  async function pickFolder(fieldName: string) {
    const dir = await api().plugins.pickFolder()
    if (dir) setState((prev) => ({ ...prev, values: { ...prev.values, [fieldName]: dir } }))
  }

  function buildEnvPayload(): Record<string, EnvEntry> {
    const env: Record<string, EnvEntry> = {}
    if (s.fields.length > 0) {
      for (const f of s.fields) {
        const value = s.values[f.name]
        if (value) env[f.name] = { value, isSecret: isSecretField(f) }
      }
    } else {
      for (const row of s.freeformRows) {
        if (row.name && row.value) env[row.name] = { value: row.value, isSecret: row.isSecret || SECRET_NAME_PATTERN.test(row.name) }
      }
    }
    return env
  }

  async function runInstall() {
    set('installing', true)
    set('installError', null)
    set('step', 3)

    const source =
      s.sourceKind === 'path'
        ? ({ kind: 'path', path: s.localPath } as const)
        : s.sourceKind === 'command'
        ? ({ kind: 'command', command: s.command, args: s.commandArgs.split(/\s+/).filter(Boolean) } as const)
        : ({ kind: 'npm', packageName: s.npmPackage, version: s.npmVersion } as const)

    const result = await api().plugins.install({ id: s.pluginId, source, env: buildEnvPayload() })
    setState((prev) => ({ ...prev, installing: false }))
    if (!result.ok) {
      // plugins:install returns two different failure shapes: the npm/probe
      // pipeline reports { reason, detail }, but the up-front validation
      // checks (bad id, id already installed, malformed source, ...) go
      // through ipc/plugins.mjs's shared refuse() helper and report { error }
      // instead — same shape confirmInstall() below already handles. Reading
      // only `reason`/`detail` left every one of those early refusals
      // rendering as the literal string "undefined".
      set('installError', 'reason' in result
        ? `${result.reason}${result.detail ? `: ${result.detail}` : ''}`
        : result.error || 'Install failed.')
      return
    }
    setState((prev) => ({
      ...prev,
      installResult: result,
      // Every discovered tool starts at the most restrictive class (D3/D-b) —
      // the install probe already does this, kept here as the admin's editable copy.
      tools: result.tools,
    }))
  }

  function setToolClass(name: string, cls: PluginToolInfo['class']) {
    setState((prev) => ({ ...prev, tools: prev.tools.map((t) => (t.name === name ? { ...t, class: cls } : t)) }))
  }

  async function confirmInstall() {
    if (!s.installResult) return
    set('confirming', true)
    set('confirmError', null)
    const result = await api().plugins.confirmInstall({
      id: s.pluginId,
      displayName: s.displayName || s.pluginId,
      source:
        s.sourceKind === 'path'
          ? { kind: 'path', path: s.localPath }
          : s.sourceKind === 'command'
          ? { kind: 'command', command: s.command, args: s.commandArgs.split(/\s+/).filter(Boolean) }
          : { kind: 'npm', packageName: s.npmPackage, version: s.npmVersion },
      resolvedCommand: s.installResult.resolvedCommand,
      resolvedArgs: s.installResult.resolvedArgs,
      resolvedVersion: s.installResult.resolvedVersion,
      integrity: s.installResult.integrity,
      installDir: s.installResult.installDir,
      runAsNode: s.installResult.runAsNode,
      tools: s.tools,
      env: buildEnvPayload(),
    })
    set('confirming', false)
    if (!result.ok) {
      set('confirmError', result.error || 'Failed to save.')
      return
    }
    onInstalled()
    close()
  }

  const hasSecretValue = Object.values(buildEnvPayload()).some((e) => e.isSecret)

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-zinc-900 border border-zinc-700 rounded-lg w-full max-w-3xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-800 sticky top-0 bg-zinc-900">
          <p className="font-medium text-zinc-200">Add tool</p>
          <button onClick={close} className={btnCls.subtle}>Cancel</button>
        </div>

        <div className="p-5">
          <p className="text-xs text-zinc-500 mb-4">Step {s.step} of 5</p>

          {/* Step 1 — Source */}
          {s.step === 1 && (
            <div className="space-y-4">
              <div className="flex gap-2 text-xs">
                {(['registry', 'npm', 'path', 'command'] as SourceKind[]).map((kind) => (
                  <button key={kind}
                    onClick={() => set('sourceKind', kind)}
                    className={`px-2.5 py-1 rounded ${s.sourceKind === kind ? 'bg-orange-500 text-white' : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'}`}>
                    {kind === 'registry' ? 'Browse registry' : kind === 'npm' ? 'npm package' : kind === 'path' ? 'Local folder' : 'Advanced'}
                  </button>
                ))}
              </div>

              {s.sourceKind === 'registry' && (
                <div>
                  <div className="flex gap-2 mb-3">
                    <input className={inputCls.sm} placeholder="Search the MCP registry…" value={s.registryQuery}
                      onChange={(e) => set('registryQuery', e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && runSearch()} />
                    <button onClick={runSearch} className={btnCls.secondary}>Search</button>
                  </div>
                  <RegistryResults
                    results={plugins.searchResults}
                    error={plugins.searchError}
                    onPick={pickRegistryResult}
                    selected={s.registrySelected}
                    searched={s.registrySearched}
                  />
                </div>
              )}

              {s.sourceKind === 'npm' && (
                <div className="space-y-2">
                  <label className="block text-xs text-zinc-400">Package name</label>
                  <input className={inputCls.sm} placeholder="@modelcontextprotocol/server-memory" value={s.npmPackage}
                    onChange={(e) => set('npmPackage', e.target.value)} />
                  <label className="block text-xs text-zinc-400">Version (pinned — no ranges, no "latest")</label>
                  <input className={inputCls.sm} placeholder="2026.7.4" value={s.npmVersion}
                    onChange={(e) => set('npmVersion', e.target.value)} />
                </div>
              )}

              {s.sourceKind === 'path' && (
                <div className="space-y-2">
                  <label className="block text-xs text-zinc-400">Local folder or entry script, already on this machine</label>
                  <div className="flex gap-2">
                    <input className={inputCls.sm} placeholder="C:\path\to\server" value={s.localPath}
                      onChange={(e) => set('localPath', e.target.value)} />
                    <button onClick={async () => { const dir = await api().plugins.pickFolder(); if (dir) set('localPath', dir) }} className={btnCls.secondary}>Browse…</button>
                  </div>
                </div>
              )}

              {s.sourceKind === 'command' && (
                <div className="space-y-2">
                  <p className="text-xs text-yellow-500/90">Advanced. Redstart runs this exactly as typed — only use a command you trust.</p>
                  <label className="block text-xs text-zinc-400">Command</label>
                  <input className={inputCls.sm} placeholder="C:\path\to\server.exe" value={s.command}
                    onChange={(e) => set('command', e.target.value)} />
                  <label className="block text-xs text-zinc-400">Arguments (space-separated)</label>
                  <input className={inputCls.sm} value={s.commandArgs} onChange={(e) => set('commandArgs', e.target.value)} />
                </div>
              )}

              <div className="space-y-2 pt-2 border-t border-zinc-800">
                <label className="block text-xs text-zinc-400">Display name</label>
                <input className={inputCls.sm} value={s.displayName} onChange={(e) => set('displayName', e.target.value)} placeholder="Shown on the Plugins and Tools tabs" />
                <label className="block text-xs text-zinc-400">Plugin id (lowercase, used as the tool namespace)</label>
                <input className={inputCls.sm} value={s.pluginId}
                  onChange={(e) => setState((prev) => ({ ...prev, pluginId: e.target.value, pluginIdTouched: true }))} />
                {s.pluginId && !PLUGIN_ID_PATTERN.test(s.pluginId) && (
                  <p className="text-xs text-red-400">Must start with a letter and contain only lowercase letters, digits, and underscores.</p>
                )}
              </div>

              <div className="flex justify-end pt-2">
                <button
                  onClick={goToStep2}
                  disabled={
                    !PLUGIN_ID_PATTERN.test(s.pluginId || slugify(s.displayName || s.npmPackage || s.command || s.localPath || '')) ||
                    (s.sourceKind === 'registry' && !s.registrySelected) ||
                    (s.sourceKind === 'npm' && (!s.npmPackage || !s.npmVersion)) ||
                    (s.sourceKind === 'path' && !s.localPath) ||
                    (s.sourceKind === 'command' && !s.command)
                  }
                  className={btnCls.primary + ' disabled:opacity-40'}>
                  Next
                </button>
              </div>
            </div>
          )}

          {/* Step 2 — Settings & keys */}
          {s.step === 2 && (
            <div className="space-y-4">
              {s.fields.length > 0 ? (
                <div className="space-y-3">
                  {s.fields.map((f) => (
                    <div key={f.name}>
                      <label className="block text-xs text-zinc-300 mb-1">
                        {f.name}{f.isRequired && <span className="text-red-400"> *</span>}
                      </label>
                      {f.description && <p className="text-xs text-zinc-600 mb-1">{f.description}</p>}
                      {f.format === 'boolean' ? (
                        <select className={inputCls.sm} value={s.values[f.name] ?? f.default ?? 'false'}
                          onChange={(e) => setState((prev) => ({ ...prev, values: { ...prev.values, [f.name]: e.target.value } }))}>
                          <option value="true">true</option>
                          <option value="false">false</option>
                        </select>
                      ) : f.format === 'filepath' ? (
                        <div className="flex gap-2">
                          <input className={inputCls.sm} value={s.values[f.name] ?? f.default ?? ''} placeholder={f.placeholder}
                            onChange={(e) => setState((prev) => ({ ...prev, values: { ...prev.values, [f.name]: e.target.value } }))} />
                          <button onClick={() => pickFolder(f.name)} className={btnCls.secondary}>Browse…</button>
                        </div>
                      ) : (
                        <input
                          className={inputCls.sm}
                          type={isSecretField(f) ? 'password' : 'text'}
                          autoComplete="off"
                          value={s.values[f.name] ?? f.default ?? ''}
                          placeholder={f.placeholder}
                          onChange={(e) => setState((prev) => ({ ...prev, values: { ...prev.values, [f.name]: e.target.value } }))}
                        />
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="space-y-2">
                  <p className="text-xs text-zinc-500">No registry metadata for this source. Add any environment values the server needs — one row per credential.</p>
                  {s.freeformRows.map((row, i) => (
                    <div key={i} className="flex gap-2 items-center">
                      <input className={inputCls.sm + ' flex-1'} placeholder="NAME" value={row.name}
                        onChange={(e) => setState((prev) => ({ ...prev, freeformRows: prev.freeformRows.map((r, j) => j === i ? { ...r, name: e.target.value } : r) }))} />
                      <input className={inputCls.sm + ' flex-1'} placeholder="value" type={row.isSecret || SECRET_NAME_PATTERN.test(row.name) ? 'password' : 'text'} autoComplete="off" value={row.value}
                        onChange={(e) => setState((prev) => ({ ...prev, freeformRows: prev.freeformRows.map((r, j) => j === i ? { ...r, value: e.target.value } : r) }))} />
                      <label className="flex items-center gap-1 text-xs text-zinc-400 flex-shrink-0">
                        <input type="checkbox" checked={row.isSecret} onChange={(e) => setState((prev) => ({ ...prev, freeformRows: prev.freeformRows.map((r, j) => j === i ? { ...r, isSecret: e.target.checked } : r) }))} />
                        secret
                      </label>
                    </div>
                  ))}
                  <button className={btnCls.subtle}
                    onClick={() => setState((prev) => ({ ...prev, freeformRows: [...prev.freeformRows, { name: '', value: '', isSecret: false }] }))}>
                    + add another
                  </button>
                </div>
              )}

              <div className="flex justify-between pt-2">
                <button onClick={() => set('step', 1)} className={btnCls.secondary}>Back</button>
                <button onClick={runInstall} className={btnCls.primary}>Install &amp; test</button>
              </div>
            </div>
          )}

          {/* Step 3 — Install & test */}
          {s.step === 3 && (
            <div className="space-y-3">
              {s.installing && (
                <div className="text-sm text-zinc-300">
                  <p>{installProgress?.message || 'Working…'}</p>
                  <div className="mt-2 h-1.5 bg-zinc-800 rounded overflow-hidden">
                    <div className="h-full bg-orange-500 animate-pulse w-2/3" />
                  </div>
                </div>
              )}
              {!s.installing && s.installError && (
                <div className="text-sm text-red-400 whitespace-pre-wrap">
                  <p className="font-medium">Install failed.</p>
                  <p className="mt-1 text-xs">{s.installError}</p>
                </div>
              )}
              {!s.installing && s.installResult && (
                <p className="text-sm text-green-400">
                  Connected — {s.installResult.tools.length} tool{s.installResult.tools.length === 1 ? '' : 's'}. Credentials aren't verified until first use.
                </p>
              )}
              <div className="flex justify-between pt-2">
                <button onClick={() => set('step', 2)} className={btnCls.secondary}>Back</button>
                {s.installError && <button onClick={runInstall} className={btnCls.primary}>Retry</button>}
                {s.installResult && <button onClick={() => set('step', 4)} className={btnCls.primary}>Next</button>}
              </div>
            </div>
          )}

          {/* Step 4 — Classify */}
          {s.step === 4 && (
            <div className="space-y-3">
              <p className="text-xs text-zinc-500">
                Every tool starts at the most restrictive class — read the description before promoting any of them.
                A server with dozens of tools ("list X", "get Y") is usually mostly reads with a handful of real writes; don't leave all {s.tools.length} at destructive by default, but don't promote past what you've actually read either.
              </p>
              <div className="divide-y divide-zinc-800 border border-zinc-800 rounded max-h-[28rem] overflow-y-auto">
                {s.tools.map((t) => (
                  <div key={t.name} className="flex items-start justify-between gap-3 px-3 py-2">
                    <div className="min-w-0">
                      <p className="text-sm text-zinc-200">{t.name}</p>
                      {/* Collapsed past a line or two with a Read more toggle —
                          nothing hidden outright, just folded. A bare-truncated
                          description is exactly what makes "destructive"
                          meaningless on a 40-tool plugin; a multi-paragraph one
                          (a comfy-cli-style tool documenting a dozen `action`
                          values) is exactly what makes an unfolded list unusable. */}
                      <TruncatedText text={t.description || '(no description provided by the plugin)'} className="text-xs text-zinc-500 mt-0.5" />
                    </div>
                    {/* NOT inputCls.xs — that variant bakes in w-full, which is
                        the same Tailwind specificity tier as w-32 below and, in
                        this build's generated stylesheet order, wins regardless
                        of appearing first in the className string. That's what
                        stretched the class picker across the whole card. */}
                    <select className={selectClsCompact} value={t.class}
                      onChange={(e) => setToolClass(t.name, e.target.value as PluginToolInfo['class'])}>
                      <option value="read">read</option>
                      <option value="network">network</option>
                      <option value="write">write</option>
                      <option value="destructive">destructive</option>
                    </select>
                  </div>
                ))}
              </div>
              <div className="flex justify-between pt-2">
                <button onClick={() => set('step', 3)} className={btnCls.secondary}>Back</button>
                <button onClick={() => set('step', 5)} className={btnCls.primary}>Next</button>
              </div>
            </div>
          )}

          {/* Step 5 — Confirm */}
          {s.step === 5 && (
            <div className="space-y-3">
              <div className="text-xs text-zinc-400 space-y-2 bg-zinc-800/40 rounded p-3">
                <p>• This plugin's data — and any key you set — are shared by every account on this server.</p>
                <p>• Plugin code runs with the same OS permissions as Redstart itself.</p>
                {hasSecretValue && (
                  <p className="text-yellow-500/90">• A credential is configured. This plugin will be declared as a data path to users and to the model — its queries can leave this machine.</p>
                )}
                <p>• Saved disabled. Enable it on the Plugins tab, then activate it per profile on the Tools tab.</p>
              </div>
              {s.confirmError && <p className="text-xs text-red-400">{s.confirmError}</p>}
              <div className="flex justify-between pt-2">
                <button onClick={() => set('step', 4)} className={btnCls.secondary}>Back</button>
                <button onClick={confirmInstall} disabled={s.confirming} className={btnCls.primary + ' disabled:opacity-50'}>
                  {s.confirming ? 'Saving…' : 'Save plugin'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// Verdicts are shown, never used to filter (Phase 4b "Compatibility
// verdicts") — every result renders, including ones the admin cannot install
// from here, each with the reason stated.
function verdictLabel(v: RegistrySearchResult['verdict']): { text: string; installable: boolean } {
  switch (v.state) {
    case 'installable': return { text: 'Install', installable: true }
    case 'needs-setup': return { text: 'Install — needs setup', installable: true }
    case 'needs-runtime': return { text: v.reason === 'python' ? 'Needs Python (not yet supported)' : 'Needs runtime', installable: false }
    default: return { text: `Not supported: ${v.reason || 'unsupported'}`, installable: false }
  }
}

function RegistryResults({ results, error, onPick, selected, searched }: {
  results: RegistrySearchResult[]
  error: string | null
  onPick: (e: RegistrySearchResult) => void
  selected: RegistrySearchResult | null
  searched: boolean
}) {
  if (error) return <p className="text-xs text-red-400">Registry unavailable ({error}) — install by package name instead.</p>
  if (!searched) return <p className="text-xs text-zinc-600">Search above, or switch to "npm package" / "Local folder" / "Advanced".</p>
  if (results.length === 0) return <p className="text-xs text-zinc-600">No results.</p>
  return (
    <div className="max-h-56 overflow-y-auto divide-y divide-zinc-800 border border-zinc-800 rounded">
      {results.map((r, i) => {
        const v = verdictLabel(r.verdict)
        const isSelected = selected?.name === r.name && selected?.packageName === r.packageName
        return (
          <button key={`${r.name}-${i}`} disabled={!v.installable}
            onClick={() => onPick(r)}
            className={`w-full text-left px-3 py-2 text-xs flex items-center justify-between gap-3 ${
              isSelected ? 'bg-orange-500/10' : v.installable ? 'hover:bg-zinc-800' : 'opacity-50 cursor-not-allowed'
            }`}>
            <span className="min-w-0">
              <span className="block text-zinc-200 truncate">{r.name}</span>
              <span className="block text-zinc-600 truncate">{r.description}</span>
            </span>
            <span className={`flex-shrink-0 ${v.installable ? 'text-green-400' : 'text-zinc-500'}`}>{v.text}</span>
          </button>
        )
      })}
    </div>
  )
}
