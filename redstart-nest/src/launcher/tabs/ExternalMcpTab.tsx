// External MCP tab — tool servers on other computers.
//
// Its own view beside "For this profile" and "Plugins" because it is a
// different mechanism with a different trust boundary: a plugin is installed
// and run by this server; an external MCP server runs somewhere else and is
// only reached over the network. See external-mcp-url.mjs for what the main
// process accepts and warns about.

import type { LlamaConfig } from '../types'
import type { useExternalMcp } from '../hooks/useExternalMcp'
import { Card, SectionTitle, btnCls, inputCls } from '../components/ui'

export function ExternalMcpTab({ config, mcp }: {
  config: LlamaConfig
  mcp: ReturnType<typeof useExternalMcp>
}) {
  const {
    externalServers, showAddExternal, setShowAddExternal,
    newExtName, setNewExtName, newExtUrl, setNewExtUrl, mcpTestResults,
    newExtApiKey, setNewExtApiKey, editingServerId, startEditServer, cancelServerForm,
    addExternalError, addExternalWarnings,
    addExternalMcpServer, removeExternalMcpServer, testExternalMcpServer,
  } = mcp

  return (
    <div className="flex flex-col gap-5">
      <Card className="min-w-0">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <SectionTitle className="">Tool servers on other computers</SectionTitle>
          {!showAddExternal && (
            <button onClick={() => setShowAddExternal(true)} className={btnCls.secondary}>Add a server</button>
          )}
        </div>
        <p className="mb-3 text-[13px] text-zinc-500">
          MCP servers running on another device. Redstart connects to them over the network; it does not install or run them.
        </p>

        <div className="mb-3 break-all rounded-lg bg-zinc-950/50 px-3 py-2 text-[13px] text-zinc-400">
          <span className="text-zinc-300 font-medium">Built-in Redstart MCP:</span>{' '}
          {config.tools?.enabled
            ? <span className="text-green-400">http://localhost:{(config.port ?? 19080) + 2}/mcp</span>
            : <span className="text-zinc-500">Starts with server (turn tools on under For this profile)</span>
          }
        </div>

        {externalServers.length === 0 && !showAddExternal && (
          <p className="text-xs text-zinc-500">No external MCP servers configured. Add a server URL to connect to an MCP server on another device.</p>
        )}

        <div className="space-y-2">
          {externalServers.map(server => (
            <div key={server.id} className="flex items-start gap-2 rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2">
              <div className="flex-1 min-w-0">
                <span className="text-sm text-zinc-200">{server.name}</span>
                <span className="text-xs text-zinc-500 ml-2 break-all">{server.url}</span>
                {server.hasApiKey && (
                  <span className="text-xs text-zinc-500 ml-2" tabIndex={0} role="img" aria-label="An API key is stored for this server" data-tip="An API key is stored for this server">🔑</span>
                )}
                {mcpTestResults[server.id] && (
                  <span className={`block text-xs mt-0.5 break-words ${mcpTestResults[server.id].ok ? 'text-green-400' : 'text-red-400'}`}>
                    {mcpTestResults[server.id].message}
                  </span>
                )}
              </div>
              <button
                onClick={() => testExternalMcpServer(server.id, server.url)}
                className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors px-1 flex-shrink-0">
                Test
              </button>
              <button
                onClick={() => startEditServer(server)}
                className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors px-1 flex-shrink-0">
                Edit
              </button>
              <button
                onClick={() => removeExternalMcpServer(server.id)}
                aria-label={`Remove ${server.name}`}
                className="text-xs text-zinc-500 hover:text-red-400 transition-colors px-1 flex-shrink-0">
                ✕
              </button>
            </div>
          ))}
        </div>

        {/* Cautions about the server that was just added — plaintext to a remote
            host, egress, an endpoint that doesn't look like /sse. Non-blocking
            by design: the main process accepted it, and an admin at the console
            is allowed to make these choices. See external-mcp-url.mjs. */}
        {addExternalWarnings.length > 0 && (
          <div className="mt-2 text-xs text-amber-300/90 bg-amber-950/30 border border-amber-900/60 rounded p-2 space-y-1">
            {addExternalWarnings.map((w, i) => <p key={i}>⚠ {w}</p>)}
          </div>
        )}

        {showAddExternal && (
          <div className="mt-3 max-w-xl space-y-2 rounded-lg border border-zinc-700 bg-zinc-950/40 p-3">
            <input
              value={newExtName} onChange={e => setNewExtName(e.target.value)}
              placeholder="Server name (e.g. Legal DB Server)"
              aria-label="Server name"
              className={inputCls.dark} />
            <input
              value={newExtUrl} onChange={e => setNewExtUrl(e.target.value)}
              placeholder="Address (e.g. http://10.0.0.5:9000/mcp)"
              aria-label="Server address"
              className={inputCls.dark} />
            <input
              type="password"
              value={newExtApiKey} onChange={e => setNewExtApiKey(e.target.value)}
              aria-label="API key"
              placeholder={
                editingServerId && externalServers.find(s => s.id === editingServerId)?.hasApiKey
                  ? 'API key (leave blank to keep the current one)'
                  : 'API key (optional — sent as Authorization: Bearer …)'
              }
              className={inputCls.dark} />
            {/* A refusal from the main process. Without this the Add button
                would simply do nothing on a rejected URL, which reads as a
                broken button rather than a policy decision. */}
            {addExternalError && (
              <p className="text-xs text-red-400 bg-red-950/30 border border-red-900/60 rounded p-2">
                {addExternalError}
              </p>
            )}
            <div className="flex gap-2 pt-1">
              <button onClick={addExternalMcpServer} className={btnCls.primary}>
                {editingServerId ? 'Save changes' : 'Add server'}
              </button>
              <button onClick={cancelServerForm} className={btnCls.secondary}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </Card>
    </div>
  )
}
