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

  useEffect(() => {
    getAPI()?.mcp.listExternal().then(setExternalServers).catch(() => { /* unavailable */ })
  }, [])

  async function addExternalMcpServer() {
    const name = newExtName.trim()
    const url = newExtUrl.trim()
    if (!name || !url) return
    const server = await api().mcp.addExternal({ name, url, enabled: true })
    setExternalServers(prev => [...prev, server])
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
    addExternalMcpServer, removeExternalMcpServer, testExternalMcpServer,
  }
}
