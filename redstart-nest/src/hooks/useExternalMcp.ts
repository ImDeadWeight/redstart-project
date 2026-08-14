import { useEffect, useState } from 'react'
import { api, getAPI } from '../api/redstart'
import type { ExternalMcpServer } from '../types'

// External MCP server list (Tools tab, bottom section): CRUD + connection test.
export function useExternalMcp() {
  const [externalServers, setExternalServers] = useState<ExternalMcpServer[]>([])
  const [showAddExternal, setShowAddExternal] = useState(false)
  const [newExtName, setNewExtName] = useState('')
  const [newExtUrl, setNewExtUrl] = useState('')
  const [newExtApiKey, setNewExtApiKey] = useState('')
  // Set while the add-server form is editing an existing entry rather than
  // creating a new one. Holds that server's id so the save keeps writing to
  // it — mcp:add-external upserts by id, same as the tool registry.
  const [editingServerId, setEditingServerId] = useState<string | null>(null)
  const [mcpTestResults, setMcpTestResults] = useState<Record<string, { ok: boolean; message: string }>>({})
  // Refusal reason for the URL just typed, and non-blocking cautions about the
  // one just added (plaintext to a remote host, egress, an odd path). The main
  // process owns both — it is the only thing that can write the registry, so a
  // check here would be advisory. See electron/main/external-mcp-url.mjs.
  const [addExternalError, setAddExternalError] = useState<string | null>(null)
  const [addExternalWarnings, setAddExternalWarnings] = useState<string[]>([])

  useEffect(() => {
    getAPI()?.mcp.listExternal().then(setExternalServers).catch(() => { /* unavailable */ })
  }, [])

  function startEditServer(server: ExternalMcpServer) {
    setEditingServerId(server.id)
    setNewExtName(server.name)
    setNewExtUrl(server.url)
    // The stored key never reaches the renderer (see hasApiKey on
    // ExternalMcpServer) — the field starts blank, and the form's placeholder
    // tells the user blank means "keep the current key".
    setNewExtApiKey('')
    setAddExternalError(null)
    setShowAddExternal(true)
  }

  function cancelServerForm() {
    setShowAddExternal(false); setEditingServerId(null)
    setNewExtName(''); setNewExtUrl(''); setNewExtApiKey('')
    setAddExternalError(null)
  }

  async function addExternalMcpServer() {
    const name = newExtName.trim()
    const url = newExtUrl.trim()
    if (!name || !url) return
    setAddExternalError(null)
    const result = await api().mcp.addExternal({
      id: editingServerId ?? undefined,
      name, url, enabled: true,
      apiKey: newExtApiKey.trim() || null,
    })
    if (!result.ok) {
      setAddExternalError(result.error ?? 'That server could not be added.')
      return
    }
    setExternalServers(prev => editingServerId
      ? prev.map(s => s.id === result.server.id ? result.server : s)
      : [...prev, result.server])
    setAddExternalWarnings(result.warnings ?? [])
    cancelServerForm()
  }

  async function removeExternalMcpServer(id: string) {
    await api().mcp.removeExternal(id)
    setExternalServers(prev => prev.filter(s => s.id !== id))
    setMcpTestResults(prev => { const n = { ...prev }; delete n[id]; return n })
    if (editingServerId === id) cancelServerForm()
  }

  async function testExternalMcpServer(id: string, url: string) {
    setMcpTestResults(prev => ({ ...prev, [id]: { ok: false, message: 'Testing…' } }))
    // No apiKey here — a saved server's key is decrypted server-side from its
    // id (see mcp:test-external), never round-tripped to the renderer.
    const result = await api().mcp.testExternal({ id, url })
    setMcpTestResults(prev => ({ ...prev, [id]: result }))
  }

  return {
    externalServers, showAddExternal, setShowAddExternal,
    newExtName, setNewExtName, newExtUrl, setNewExtUrl,
    newExtApiKey, setNewExtApiKey, editingServerId, startEditServer, cancelServerForm,
    mcpTestResults,
    addExternalError, addExternalWarnings,
    addExternalMcpServer, removeExternalMcpServer, testExternalMcpServer,
  }
}
