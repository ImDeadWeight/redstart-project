// =============================================================================
// Shared MCP Streamable HTTP test client.
// =============================================================================
// A minimal client — enough to drive tools/list + tools/call against a real
// running mcp-server.mjs over the MCP Streamable HTTP transport. Shared by
// every suite that exercises the MCP boundary (test-mcp-capabilities.mjs,
// test-provider-conformance.mjs, ...) so there is ONE implementation to keep
// correct as the transport evolves.
// =============================================================================

// `extraHeaders` (e.g. an Authorization bearer) is sent on every request, so a
// suite can drive the server as a specific account with auth on. `timeoutMs`
// bounds each request; the agent benchmark raises it, since a real run_python
// call can take longer than a test fixture's.
export async function connectMcpClient(baseUrl, { headers: extraHeaders = {}, timeoutMs = 8000 } = {}) {
  const base = baseUrl.replace(/\/$/, '')
  let sessionId = null
  let nextId = 0
  const pending = new Map()

  async function call(method, params) {
    const id = ++nextId
    // The timer is cleared however the request settles. Left running, it kept
    // the process alive for the whole timeout after a success, and after a
    // fetch that threw it fired into a promise nobody awaited any more: an
    // unhandled rejection that crashed the process minutes later.
    let timer
    const promise = new Promise((resolve, reject) => {
      pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })
      timer = setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); reject(new Error(`Timed out waiting for response to ${method}`)) }
      }, timeoutMs)
    })

    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...extraHeaders,
    }
    if (sessionId) {
      headers['Mcp-Session-Id'] = sessionId
    }

    let res
    try {
      res = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      })
    } catch (err) {
      // Nothing listening, or the connection dropped: settle this request now.
      const entry = pending.get(id)
      pending.delete(id)
      entry?.reject(err)
      return promise
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      const entry = pending.get(id)
      if (entry) {
        entry.reject(new Error(`HTTP ${res.status}: ${text || res.statusText}`))
        pending.delete(id)
      }
      return promise
    }

    const newSessionId = res.headers.get('mcp-session-id')
    if (newSessionId) sessionId = newSessionId

    const ct = res.headers.get('content-type') || ''
    if (ct.includes('application/json')) {
      try {
        const data = await res.json()
        if (data?.id !== undefined && pending.has(data.id)) {
          pending.get(data.id).resolve(data)
          pending.delete(data.id)
        }
      } catch (err) {
        const entry = pending.get(id)
        if (entry) {
          entry.reject(err)
          pending.delete(id)
        }
      }
      return promise
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

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
            const dataLine = rawEvent.split('\n').find(l => l.startsWith('data: '))
            if (!dataLine) continue
            const raw = dataLine.slice(6)
            let data
            try { data = JSON.parse(raw) } catch { continue }
            if (data?.id !== undefined && pending.has(data.id)) {
              pending.get(data.id).resolve(data)
              pending.delete(data.id)
            }
          }
        }
      } catch { /* stream closed */ }
    })()

    return promise
  }

  // The Streamable HTTP transport rejects a second `initialize` on an
  // already-initialized session (the old SSE transport did not enforce this),
  // so the handshake result is captured here and exposed rather than left for
  // a caller to unknowingly re-trigger.
  const initResponse = await call('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'redstart-test', version: '1.0.0' },
  })

  return { call, initResult: initResponse.result, close: () => {} }
}
