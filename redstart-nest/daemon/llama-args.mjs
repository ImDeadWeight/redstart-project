'use strict'

import { isPackaged, resourcesDir } from './platform-paths.mjs'
import { EMBED_PORT } from './ports.mjs'
import { kvCacheTypes } from './kv-cache.mjs'
import { MMAP_OFF_ARGS } from './server-help.mjs'
import * as path from 'path'
import { fileURLToPath } from 'url'

// ---------------------------------------------------------------------------
// Shared llama-server argument builder
// ---------------------------------------------------------------------------
// Centralizes all llama-server argument construction so the command preview in
// the UI (ipc/server.mjs -> llama:generate-command) and the actual launch use
// exactly the same logic.
//
// The --path argument tells llama-server to serve static files from our custom
// SvelteKit chat-ui build instead of its own built-in HTML UI — what makes the
// browser experience look like "Redstart" rather than the raw llama.cpp UI.
//
// INVARIANT — llama-server is localhost-only. --host is hardwired to
// 127.0.0.1 and is NEVER derived from any config field, AND a --host override
// smuggled through the free-text additionalArgs field is stripped (see
// sanitizeAdditionalArgs). LAN exposure is owned exclusively by the gateway
// (tools-gateway.mjs), which proxies to llama-server on the private +1 port.
// This keeps the raw, unauthenticated inference server off the network no
// matter how the app is configured; the auth gate always sits in front of it.
// Guarded by scripts/test-llama-args.mjs.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// KV-cache presets live in kv-cache.mjs, which maps a profile's kvCache preset
// to the -ctk/-ctv types the binary that will run accepts (upstream llama.cpp
// or a TurboQuant+ build).

// A cache type is a ggml type name (q8_0, turbo3, ...). Anything else is never
// put on the command line, whatever a config file says.
const SAFE_CACHE_TYPE = /^[a-z0-9_]{1,16}$/

export function buildArgs(config, raw = false) {
  const q = raw ? (v) => v : (v) => `"${v}"`
  const chatUiPath = isPackaged()
    ? path.join(resourcesDir(), 'chat-ui')
    : path.join(__dirname, '..', '..', 'chat-ui', 'dist') // the repo's chat-ui/, a build artifact
  const args = [
    '-m', q(config.modelPath),
    '-c', String(config.ctxSize),
    '-b', String(config.batchSize),
    '-t', String(config.threads),
    // Gateway owns the public port; llama-server runs on +1, localhost only.
    '--port', String(config.port + 1),
    '--host', '127.0.0.1',
    '--path', q(chatUiPath),
    // Enable the model's Jinja chat template so llama-server formats the request's
    // `tools` into the prompt AND runs the model-specific tool-call parser on the
    // output. Without this, a model's tool call is passed through as plain
    // assistant `content` (a raw JSON blob) instead of a structured `tool_calls`
    // field, so the chat-ui's agentic loop never sees a call to execute. Always
    // on: the gateway is built around native OpenAI tool-calling.
    '--jinja',
  ]
  // Optional chat-template override. --jinja uses the template embedded in the
  // GGUF by default; if that template doesn't render tools in a format
  // llama.cpp can parse back into tool_calls, the model's call leaks into
  // `content`. Overriding the template forces the correct tool-call format for
  // that model. chatTemplateFile (a path to a .jinja) takes precedence over
  // chatTemplate (a built-in template name, e.g. 'chatml', or an inline
  // template string). Both are passed through q() so a path with spaces is one
  // argv element on spawn and stays quoted in the copy-pasteable UI preview.
  if (config.chatTemplateFile?.trim()) {
    args.push('--chat-template-file', q(config.chatTemplateFile.trim()))
  } else if (config.chatTemplate?.trim()) {
    args.push('--chat-template', q(config.chatTemplate.trim()))
  }
  // Vision projector. Set only by projector.mjs's resolveProjector(), which
  // ipc/server.mjs applies before calling this — so the preview and the launch
  // agree. With it, llama-server reports modalities.vision in /props and the
  // chat UI starts sending images.
  if (config.mmprojPath?.trim()) {
    args.push('--mmproj', q(config.mmprojPath.trim()))
  }
  // gpuLayers/nCpuMoe are omitted when unset rather than defaulted here —
  // llama-server's own --fit (on by default) only auto-adjusts arguments that
  // are still at their default value, so leaving these unset lets it compute
  // the GPU/CPU split live against actual free VRAM and the model's real
  // tensor sizes instead of a static guess made at hardware-scan time.
  if (config.gpuLayers !== undefined && config.gpuLayers !== null) {
    args.push('-ngl', String(config.gpuLayers))
  }
  if (config.nCpuMoe !== undefined && config.nCpuMoe !== null) {
    args.push('--n-cpu-moe', String(config.nCpuMoe))
  }
  if (config.priority === 'high') {
    args.push('--prio', '2')
  }
  // Memory-mapping off. Upstream llama.cpp spells it --load-mode none and
  // rejects --no-mmap; older and TurboQuant+ builds only know --no-mmap.
  // mmapOffFlag is set by server-help.mjs's resolveMmap() from the binary's
  // own --help (null = it could not be asked, so no flag). A config that never
  // went through it gets the bundled engine's form. Only MMAP_OFF_ARGS' fixed
  // lists are ever emitted.
  if (config.noMmap) {
    const form = config.mmapOffFlag !== undefined ? config.mmapOffFlag : 'load-mode'
    if (typeof form === 'string' && Object.hasOwn(MMAP_OFF_ARGS, form)) args.push(...MMAP_OFF_ARGS[form])
  }
  // KV-cache quantization. kvCacheTypes is set by kv-cache.mjs's
  // resolveKvCache(), which the launch and the preview both apply, from the
  // preset and what the binary accepts ({ k, v }, or null for none). A config
  // that never went through it (a direct caller, a test) gets the upstream
  // mapping, which every build accepts. Omitted entirely when unset or 'off',
  // so those profiles keep the f16 default.
  const kv = config.kvCacheTypes !== undefined ? config.kvCacheTypes : kvCacheTypes(config.kvCache, null)
  if (kv?.k && kv?.v && SAFE_CACHE_TYPE.test(kv.k) && SAFE_CACHE_TYPE.test(kv.v)) {
    args.push('-ctk', kv.k, '-ctv', kv.v)
  }
  if (config.additionalArgs?.trim()) {
    args.push(...sanitizeAdditionalArgs(config.additionalArgs.trim().split(/\s+/)))
  }
  return args
}

/**
 * Arguments for the SECOND llama-server: the embedding model behind tool
 * retrieval.
 *
 * Same binary, entirely different job, so it shares nothing with buildArgs()
 * except the localhost invariant and the quoting helper. In particular it takes
 * a model path rather than a config: none of the user's chat settings apply to
 * it, and letting a config through would be the first step toward one of them
 * (--host, most obviously) reaching a process that has no business on the
 * network.
 *
 * INVARIANT — --host is hardwired to 127.0.0.1 here for exactly the reason it
 * is in buildArgs(), and the port is the fixed EMBED_PORT, never derived from
 * config.port. There is no additionalArgs equivalent: this process is internal
 * plumbing, not something a user configures.
 *
 * -ngl 0 keeps it on the CPU. A 33M-parameter model is a few tens of
 * milliseconds per batch there, and the alternative is taking VRAM away from
 * the chat model the user actually came for.
 *
 * No --path: this server has no UI, and nothing should be able to reach one.
 *
 * --pooling is deliberately NOT passed. llama.cpp reads a default from the
 * GGUF, and bge and MiniLM disagree about what it should be; pinning a flag
 * before the model is chosen would be guessing at the one parameter that
 * silently changes what every vector means.
 *
 * @param {string} modelPath path to the embedding GGUF
 * @param {boolean} [raw] false quotes paths for the copy-pasteable UI preview
 * @returns {string[]}
 */
export function buildEmbedArgs(modelPath, raw = false) {
  const q = raw ? (v) => v : (v) => `"${v}"`
  return [
    '-m', q(modelPath),
    '--embeddings',
    // Localhost only, always. See the invariant above.
    '--host', '127.0.0.1',
    '--port', String(EMBED_PORT),
    // CPU only — never compete with the chat model for VRAM.
    '-ngl', '0',
    // Embedding models cap out at a few hundred positions anyway; a large
    // context here would reserve memory nothing can use.
    '-c', '512',
  ]
}

// additionalArgs is a free-text advanced-user field appended to the launch
// command. It must NOT be able to defeat the localhost-only invariant: a
// hand-typed `--host 0.0.0.0` would otherwise override the hardwired
// `--host 127.0.0.1` above (llama.cpp honors the last --host it sees) and
// expose the raw, unauthenticated inference server to the LAN. So we strip any
// --host override (both `--host X` and `--host=X` forms) here. Everything else
// passes through untouched. The stripping is visible in the UI command preview,
// which uses this same builder, so the user sees that their --host was dropped.
function sanitizeAdditionalArgs(tokens) {
  const out = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t === '--host') {
      i++ // also skip the value token that follows the bare flag
      continue
    }
    if (t.startsWith('--host=')) continue
    out.push(t)
  }
  return out
}
