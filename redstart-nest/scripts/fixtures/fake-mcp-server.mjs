'use strict'

// =============================================================================
// Test fixture — a controllable stdio MCP server
// =============================================================================
// Speaks just enough MCP (initialize / tools/list / tools/call) to drive
// mcp-plugin-client.mjs over a real child process, and can be told to
// misbehave in the specific ways the plugin client must survive.
//
// Used by scripts/test-plugin-client.mjs (task T6). Not shipped — this lives
// under scripts/ and is never imported by the app.
//
// Usage:  node fake-mcp-server.mjs <mode>
//
//   normal        answer everything correctly
//   silent        complete the handshake, then never answer a tools/call
//                 (drives the per-plugin timeout)
//   exit-on-call  exit(1) as soon as a tools/call arrives, mid-request
//                 (drives "reject in-flight requests on child exit")
//   no-tools      handshake fine, but report an empty tools list
//                 (drives the "server returned no tools" install error)
//   auth-fail     handshake and tools/list succeed, EVERY tools/call returns an
//                 auth error — the false-green case. An install-time probe that
//                 passes this fixture is broken by definition: it is exactly
//                 what a plugin with a wrong API key looks like.
//   env-echo      return the values of REDSTART_SECRET_CANARY and PATH as text,
//                 so the env-allowlist test can assert the canary is absent
//                 while PATH survives
//
// Every mode fails LOUDLY rather than hanging, except `silent`, whose entire
// job is to hang.
// =============================================================================

const mode = process.argv[2] || 'normal'

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo the supplied text back.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
  {
    name: 'write_thing',
    description: 'Pretends to write something. Never touches disk.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    // Deliberately claims to be read-only. Redstart must IGNORE this: the
    // plugin's own annotations are never trusted for policy (plan decision D3),
    // and test-plugin-client.mjs asserts the Redstart-assigned class wins.
    annotations: { readOnlyHint: true },
  },
]

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function ok(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function textResult(id, text) {
  ok(id, { content: [{ type: 'text', text }] })
}

function handle(msg) {
  const { id, method } = msg

  if (method === 'initialize') {
    ok(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: `fake-mcp-server(${mode})`, version: '1.0.0' },
    })
    return
  }

  // Notifications carry no id and get no response.
  if (id === undefined || id === null) return

  if (method === 'ping') return ok(id, {})

  if (method === 'tools/list') {
    return ok(id, { tools: mode === 'no-tools' ? [] : TOOLS })
  }

  if (method === 'tools/call') {
    if (mode === 'silent') return                 // never answer — drives the timeout
    if (mode === 'exit-on-call') process.exit(1)  // die mid-request

    if (mode === 'auth-fail') {
      return ok(id, {
        isError: true,
        content: [{ type: 'text', text: '401 Unauthorized: invalid API key' }],
      })
    }

    if (mode === 'env-echo') {
      return textResult(id, JSON.stringify({
        REDSTART_SECRET_CANARY: process.env.REDSTART_SECRET_CANARY ?? null,
        PATH: process.env.PATH ? 'present' : null,
      }))
    }

    const name = msg.params?.name
    const args = msg.params?.arguments ?? {}
    if (name === 'echo') return textResult(id, String(args.text ?? ''))
    if (name === 'write_thing') return textResult(id, `wrote ${args.name ?? 'nothing'}`)

    return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${name}` } })
  }

  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } })
}

// Frame stdin by newline, exactly as the supervisor frames our stdout — a chunk
// may carry a partial line or several messages.
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).replace(/\r$/, '')
    buf = buf.slice(nl + 1)
    if (!line.trim()) continue
    try {
      handle(JSON.parse(line))
    } catch (err) {
      process.stderr.write(`fake-mcp-server: bad line: ${err.message}\n`)
    }
  }
})

process.stdin.on('end', () => process.exit(0))
