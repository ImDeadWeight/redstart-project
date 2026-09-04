'use strict'

import { isPackaged } from './platform-paths.mjs'
import { EMBED_PORT } from './ports.mjs'
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

// TurboQuant KV-cache quantization presets. This is the whole reason Redstart
// runs on the TurboQuant+ fork: its Walsh-Hadamard-rotated polar codec shrinks
// the KV cache ~3-4x vs the f16 default, which is what lets a 12 GB card hold a
// usable context instead of blowing VRAM at 16k tokens. The asymmetric-K/V rule
// from the fork's own papers is encoded here — K stays high-precision (q8_0),
// only V drops to a turbo tier; we never lead with a turbo K, which is where
// models break. Flash attention is already 'auto' in the binary and self-enables
// for turbo KV, so there's nothing to add on that front.
export const KV_CACHE_PRESETS = {
  conservative: { k: 'q8_0', v: 'turbo4' }, // lightest turbo V; first contact
  balanced:     { k: 'q8_0', v: 'turbo3' }, // recommended default: near-lossless K, ~4.6x V
  aggressive:   { k: 'q8_0', v: 'turbo2' }, // MoE-aware; Boundary V auto-protects sensitive layers
}

export function buildArgs(config, raw = false) {
  const q = raw ? (v) => v : (v) => `"${v}"`
  const chatUiPath = isPackaged()
    ? path.join(process.resourcesPath, 'chat-ui')
    : path.join(__dirname, '..', '..', 'src', 'chat-ui', 'dist')
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
  if (config.noMmap) {
    args.push('--no-mmap')
  }
  // KV-cache quantization via TurboQuant. Omitted entirely when unset or 'off'
  // so legacy profiles keep the exact f16 behavior they had before.
  const kv = KV_CACHE_PRESETS[config.kvCache]
  if (kv) {
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
