// =============================================================================
// Agent bench — talking to a running Nest as an ordinary client
// =============================================================================
// Everything goes through the routes any client uses, as the account whose
// API key the bench holds (or the anonymous scope when login is off):
//
//   gateway  POST/DELETE /conversations     a real conversation per run, so
//                                           its workspace is a real one
//            POST /files/mkdir, /files/upload  seed the fixtures
//            GET  /files/list, /files/download read the workspace back
//            POST /v1/chat/completions      the model, through the gateway's
//                                           prompt, bans and tool retrieval
//   MCP      tools/list, tools/call         Nest's tools, with the run's
//                                           conversation id in _meta exactly
//                                           as chat-ui sends it
//
// No daemon module is imported: the bench must see what a client sees.
// =============================================================================

import * as crypto from 'node:crypto'
import { connectMcpClient } from '../../lib/mcp-test-client.mjs'
import { formatMcpToolResult } from '../../../../shared/agent-core/tool-result.mjs'

export const META_CONVERSATION_KEY = 'redstart/conversationId'
export const META_CLASS_KEY = 'redstart/class'
// Mirrors daemon/interaction-tools.mjs; no daemon module is imported here.
export const HOST_TOOLS_CAPABILITY = 'redstart/hostTools'
const DOCS_SPACE = 'documents'
const MAX_READBACK_BYTES = 1024 * 1024
// A bench account's File System folder holds what runs leave there: a few
// files. More than this is someone's real folder.
export const FILES_SNAPSHOT_LIMIT = 2000

/**
 * `hostTools`: the host-resolved tools this run answers itself (default
 * ask_user and update_plan); Nest offers only those.
 *
 * @param {{ gateway: string, mcp: string, apiKey?: string | null, fetch?: typeof fetch, mcpTimeoutMs?: number, hostTools?: string[] }} opts
 */
export async function connectNest(opts) {
  const gateway = opts.gateway.replace(/\/$/, '')
  const doFetch = opts.fetch ?? fetch
  const auth = opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}

  async function req(method, route, { json, body, headers = {}, ok = [200, 201, 204] } = {}) {
    const res = await doFetch(`${gateway}${route}`, {
      method,
      headers: { ...auth, ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: json !== undefined ? JSON.stringify(json) : body,
    })
    if (!ok.includes(res.status)) {
      const text = await res.text().catch(() => '')
      throw new Error(`${method} ${route}: HTTP ${res.status} ${text.slice(0, 300)}`)
    }
    return res
  }

  // The bench answers ask_user (lib/ask.mjs) and keeps the plan itself, as
  // chat-ui does, so it declares so and Nest offers the tools
  // (daemon/interaction-tools.mjs). --plan off leaves update_plan out.
  const mcp = await connectMcpClient(opts.mcp, {
    headers: auth,
    timeoutMs: opts.mcpTimeoutMs ?? 300_000,
    capabilities: { experimental: { [HOST_TOOLS_CAPABILITY]: { names: opts.hostTools ?? ['ask_user', 'update_plan'] } } },
  })

  return {
    /** The account's tools, as MCP lists them (bans and role narrowing already applied). */
    async listTools() {
      const r = await mcp.call('tools/list', {})
      if (r.error) throw new Error(`tools/list: ${r.error.message}`)
      return r.result?.tools ?? []
    },

    /**
     * One tools/call, as chat-ui makes it, and its result as the text
     * chat-ui gives the model.
     */
    async callTool(name, args, conversationId) {
      const r = await mcp.call('tools/call', {
        name,
        arguments: args,
        _meta: { [META_CONVERSATION_KEY]: conversationId },
      })
      if (r.error) return { text: `Error: ${r.error.message}`, isError: true }
      return { text: formatMcpToolResult(r.result), isError: !!r.result?.isError }
    },

    async createConversation(id, name) {
      await req('POST', '/conversations', { json: { id, name } })
    },

    async deleteConversation(id) {
      await req('DELETE', `/conversations/${encodeURIComponent(id)}`, { ok: [200, 204, 404] })
    },

    /** Write one file into the run's workspace, creating folders as needed. */
    async seedFile(conversationId, relPath, content) {
      const parts = relPath.split('/')
      const name = parts.pop()
      const dir = ['chats', conversationId, ...parts].join('/')
      const q = new URLSearchParams({ space: DOCS_SPACE, path: dir, name })
      await req('POST', `/files/upload?${q}`, { body: content, headers: { 'Content-Type': 'application/octet-stream' } })
    },

    /** Make sure the workspace folder exists even with no fixtures. */
    async ensureWorkspace(conversationId) {
      await req('POST', '/files/mkdir', { json: { space: DOCS_SPACE, path: `chats/${conversationId}` }, ok: [200, 201, 409] })
    },

    /**
     * Every file in the workspace, recursively: workspace-relative path →
     * UTF-8 text (files over 1 MB are listed with content null).
     */
    async readWorkspace(conversationId) {
      const root = `chats/${conversationId}`
      const out = {}
      const walk = async (dir) => {
        const q = new URLSearchParams({ space: DOCS_SPACE, path: dir })
        const res = await req('GET', `/files/list?${q}`, { ok: [200, 404] })
        if (res.status === 404) return
        const { entries } = await res.json()
        for (const e of entries) {
          if (e.type === 'folder') {
            await walk(e.path)
            continue
          }
          const rel = e.path.slice(root.length + 1)
          if (e.size > MAX_READBACK_BYTES) {
            out[rel] = null
            continue
          }
          const dl = await req('GET', `/files/download?${new URLSearchParams({ path: e.path })}`)
          out[rel] = await dl.text()
        }
      }
      await walk(root)
      return out
    },

    /** One file by its documents-relative path (what a [file: ...] line names), as text; null if gone or too big. */
    async readDocument(relPath) {
      const res = await req('GET', `/files/download?${new URLSearchParams({ path: relPath })}`, { ok: [200, 404] })
      if (res.status === 404) return null
      const buf = Buffer.from(await res.arrayBuffer())
      return buf.length > MAX_READBACK_BYTES ? null : buf.toString('utf8')
    },

    /** Move one documents-relative file to the account's trash (recoverable). */
    async deleteDocument(relPath) {
      await this.deleteFile(DOCS_SPACE, relPath)
    },

    /** Move one file in a storage space to the account's trash (recoverable). */
    async deleteFile(space, relPath) {
      await req('POST', '/files/delete', { json: { space, path: relPath }, ok: [200, 204, 404] })
    },

    /**
     * Every file in a storage space, recursively: path → "size|modified".
     * null when the space is not configured for this account; false when it
     * holds more than `limit` entries (a real folder, too big to walk before
     * every task: the caller says so once rather than slowing every run).
     *
     * @param {string} space 'files' is the File System tools' folder
     * @param {number} [limit]
     * @param {string[]} [skip] folders (space-relative paths) not walked
     * @returns {Promise<Map<string, string> | null | false>}
     */
    async snapshotFiles(space, limit = FILES_SNAPSHOT_LIMIT, skip = []) {
      const out = new Map()
      let seen = 0
      let tooBig = false
      /** @returns {Promise<boolean>} false: stop (root unavailable, or too big) */
      const walk = async (dir) => {
        const q = new URLSearchParams({ space, path: dir })
        const res = await req('GET', `/files/list?${q}`, { ok: [200, 400, 403, 404] })
        if (res.status !== 200) return dir !== '.'
        const { entries } = await res.json()
        for (const e of entries) {
          if (++seen > limit) { tooBig = true; return false }
          if (e.type === 'folder') {
            if (skip.includes(e.path)) continue
            if (!(await walk(e.path))) return false
            continue
          }
          out.set(e.path, `${e.size}|${e.modified}`)
        }
        return true
      }
      if (await walk('.')) return out
      return tooBig ? false : null
    },

    /** Who the API key belongs to: { authRequired, user: { username, role } | null }, or null. */
    async whoami() {
      try {
        const res = await req('GET', '/auth/me')
        return await res.json()
      } catch {
        return null
      }
    },

    /**
     * What llama-server says about the loaded model (the gateway passes
     * /props through): the model file and its chat template. The bench
     * records these because a --model-label is only what someone typed, and
     * a template override can survive a model swap (2026-11-11: the 4B ran
     * under the 35B's template, labelled with the wrong quantization). Null
     * when unavailable: diagnostics must never stop a run.
     *
     * @returns {Promise<{ modelFile: string | null, chatTemplateSha: string | null, chatTemplateChars: number | null } | null>}
     */
    async modelInfo() {
      try {
        const res = await req('GET', '/props')
        const props = await res.json()
        const modelPath = typeof props?.model_path === 'string' ? props.model_path : null
        const template = typeof props?.chat_template === 'string' ? props.chat_template : null
        return {
          modelFile: modelPath ? modelPath.split(/[\\/]/).pop() : null,
          chatTemplateSha: template ? crypto.createHash('sha256').update(template).digest('hex').slice(0, 12) : null,
          chatTemplateChars: template ? template.length : null,
        }
      } catch {
        return null
      }
    },

    /** The raw completions call; the model port reads the stream. */
    async completion(body, signal) {
      return doFetch(`${gateway}/v1/chat/completions`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      })
    },
  }
}
