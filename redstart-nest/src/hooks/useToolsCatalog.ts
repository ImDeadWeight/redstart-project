import { useEffect, useState } from 'react'
import { api, getAPI } from '../api/redstart'
import type { LlamaConfig, ProfileTools, ToolGroup, WebFetchTool } from '../types'

// Tool/group catalog (built-in + user-defined web sources) and the per-profile
// tool selection stored under config.tools. Owns the add-tool / add-group form
// state; mutations to the profile's selection go through setToolsField so the
// tools object is always fully populated with defaults.
export function useToolsCatalog(
  config: LlamaConfig,
  setConfig: React.Dispatch<React.SetStateAction<LlamaConfig>>,
) {
  const [allTools, setAllTools] = useState<WebFetchTool[]>([])
  const [allGroups, setAllGroups] = useState<ToolGroup[]>([])
  const [showAddTool, setShowAddTool] = useState(false)
  const [newToolName, setNewToolName] = useState('')
  const [newToolUrl, setNewToolUrl] = useState('')
  const [newToolDesc, setNewToolDesc] = useState('')
  const [showAddGroup, setShowAddGroup] = useState(false)
  const [newGroupName, setNewGroupName] = useState('')
  const [newGroupDesc, setNewGroupDesc] = useState('')
  const [newGroupToolIds, setNewGroupToolIds] = useState<string[]>([])

  async function loadToolDefs() {
    try {
      const data = await api().tools.listAll()
      setAllTools([
        ...data.builtinTools.map(t => ({ ...t, builtIn: true, kind: 'web' as const })),
        ...(data.builtinCapabilities ?? []).map(c => ({ ...c, builtIn: true, kind: 'capability' as const })),
        ...data.userTools.map(t => ({ ...t, builtIn: false, kind: 'web' as const })),
      ])
      setAllGroups([
        ...data.builtinGroups.map(g => ({ ...g, builtIn: true })),
        ...data.userGroups.map(g => ({ ...g, builtIn: false })),
      ])
    } catch { /* tools unavailable */ }
  }

  useEffect(() => {
    if (getAPI()) loadToolDefs()
  }, [])

  function setToolsField<K extends keyof ProfileTools>(key: K, value: ProfileTools[K]) {
    setConfig(prev => ({
      ...prev,
      tools: {
        enabled: false,
        activeGroupIds: [],
        activeToolIds: [],
        maxFetchTokens: 2000,
        disabledToolIds: [],
        ...(prev.tools || {}),
        [key]: value,
      },
    }))
  }

  // Server-enforced tool bans. Banning a capability/tool ID removes every tool
  // it produces from the model's vocabulary for all clients (gateway strips
  // them); users cannot re-enable a banned tool client-side.
  function toggleDisabledTool(toolId: string) {
    const current = config.tools?.disabledToolIds ?? []
    const next = current.includes(toolId)
      ? current.filter(id => id !== toolId)
      : [...current, toolId]
    setToolsField('disabledToolIds', next)
  }

  function toggleGroup(groupId: string) {
    const current = config.tools?.activeGroupIds ?? []
    const next = current.includes(groupId)
      ? current.filter(id => id !== groupId)
      : [...current, groupId]
    setToolsField('activeGroupIds', next)
  }

  function toggleTool(toolId: string) {
    const current = config.tools?.activeToolIds ?? []
    const next = current.includes(toolId)
      ? current.filter(id => id !== toolId)
      : [...current, toolId]
    setToolsField('activeToolIds', next)
  }

  async function addCustomTool() {
    const name = newToolName.trim()
    const url  = newToolUrl.trim()
    if (!name || !url) return
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '_')
    await api().tools.addTool({ id, name, baseUrl: url, description: newToolDesc.trim() })
    setNewToolName(''); setNewToolUrl(''); setNewToolDesc(''); setShowAddTool(false)
    await loadToolDefs()
  }

  async function deleteCustomTool(id: string) {
    await api().tools.deleteTool(id)
    setToolsField('activeToolIds', (config.tools?.activeToolIds ?? []).filter(t => t !== id))
    await loadToolDefs()
  }

  async function addCustomGroup() {
    const name = newGroupName.trim()
    if (!name || newGroupToolIds.length === 0) return
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '_')
    await api().tools.addGroup({ id, name, description: newGroupDesc.trim(), toolIds: newGroupToolIds })
    setNewGroupName(''); setNewGroupDesc(''); setNewGroupToolIds([]); setShowAddGroup(false)
    await loadToolDefs()
  }

  async function deleteCustomGroup(id: string) {
    await api().tools.deleteGroup(id)
    setToolsField('activeGroupIds', (config.tools?.activeGroupIds ?? []).filter(g => g !== id))
    await loadToolDefs()
  }

  return {
    allTools, allGroups,
    showAddTool, setShowAddTool, newToolName, setNewToolName,
    newToolUrl, setNewToolUrl, newToolDesc, setNewToolDesc,
    showAddGroup, setShowAddGroup, newGroupName, setNewGroupName,
    newGroupDesc, setNewGroupDesc, newGroupToolIds, setNewGroupToolIds,
    setToolsField, toggleGroup, toggleTool, toggleDisabledTool,
    addCustomTool, deleteCustomTool, addCustomGroup, deleteCustomGroup,
  }
}
