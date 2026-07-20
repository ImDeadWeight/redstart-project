// =============================================================================
// Shared MCP SSE/JSON-RPC test client.
// =============================================================================
// A minimal client — enough to drive tools/list + tools/call against a real
// running mcp-server.mjs over the actual SSE transport, the same way the
// chat-ui's MCP client does. Shared by every suite that exercises the MCP
// boundary (test-mcp-capabilities.mjs, test-provider-conformance.mjs, ...) so
// there is ONE implementation to keep correct as the transport evolves.
// =============================================================================

export async function connectMcpClient(baseUrl) {
  const sseRes = await fetch(`${baseUrl}/sse`)
  if (!sseRes.ok || !sseRes.body) throw new Error(`SSE connect failed: ${sseRes.status}`)

  const reader = sseRes.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let endpointPath = null
  const pending = new Map()
  let nextId = 0

  ;(async function pump() {
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let idx
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const rawEvent = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          const lines = rawEvent.split('\n')
          const eventLine = lines.find(l => l.startsWith('event: '))
          const dataLine = lines.find(l => l.startsWith('data: '))
          if (!dataLine) continue
          const data = JSON.parse(dataLine.slice(6))
          const eventType = eventLine ? eventLine.slice(7) : 'message'
          if (eventType === 'endpoint') {
            endpointPath = data
          } else if (data?.id !== undefined && pending.has(data.id)) {
            pending.get(data.id).resolve(data)
            pending.delete(data.id)
          }
        }
      }
    } catch { /* stream closed */ }
  })()

  const start = Date.now()
  while (!endpointPath) {
    if (Date.now() - start > 5000) throw new Error('Timed out waiting for SSE endpoint event')
    await new Promise(r => setTimeout(r, 20))
  }

  async function call(method, params) {
    const id = ++nextId
    const promise = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); reject(new Error(`Timed out waiting for response to ${method}`)) }
      }, 8000)
    })
    await fetch(`${baseUrl}${endpointPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    })
    return promise
  }

  return { call, close: () => reader.cancel().catch(() => {}) }
}
