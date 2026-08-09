import { useEffect, useState } from 'react'
import { api, getAPI } from '../api/redstart'
import type { ExternalMcpServer } from '../types'

// External MCP server list (Tools tab, bottom section): CRUD + connection test.
export function useExternalMcp() {
  const [externalServers, setExternalServers] = useState<ExternalMcpServer[]>([])
  const [showAddExternal, setShowAddExternal] = useState(false)
  const [newExtName, setNewExtName] = useState('')
  const [newExtUrl, setNewExtUrl] = useState('')
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

  async function addExternalMcpServer() {
    const name = newExtName.trim()
    const url = newExtUrl.trim()
    if (!name || !url) return
    setAddExternalError(null)
    const result = await api().mcp.addExternal({ name, url, enabled: true })
    if (!result.ok) {
      setAddExternalError(result.error ?? 'That server could not be added.')
      return
    }
    setExternalServers(prev => [...prev, result.server])
    setAddExternalWarnings(result.warnings ?? [])
    setNewExtName(''); setNewExtUrl(''); setShowAddExternal(false)
  }

  async function removeExternalMcpServer(id: string) {
    await api().mcp.removeExternal(id)
    setExternalServers(prev => prev.filter(s => s.id !== id))
    setMcpTestResults(prev => { const n = { ...prev }; delete n[id]; return n })
  }

  async function testExternalMcpServer(id: string, url: string) {
    setMcpTestResults(prev => ({ ...prev, [id]: { ok: false, message: 'Testing…' } }))
    const result = await api().mcp.testExternal(url)
    setMcpTestResults(prev => ({ ...prev, [id]: result }))
  }

  return {
    externalServers, showAddExternal, setShowAddExternal,
    newExtName, setNewExtName, newExtUrl, setNewExtUrl, mcpTestResults,
    addExternalError, addExternalWarnings,
    addExternalMcpServer, removeExternalMcpServer, testExternalMcpServer,
  }
}
