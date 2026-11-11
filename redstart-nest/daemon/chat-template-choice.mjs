'use strict'

// =============================================================================
// Redstart Nest — which chat template llama-server gets
// =============================================================================
// A profile can override the GGUF's embedded chat template (chatTemplateFile,
// or chatTemplate for a built-in name / inline string). The override belongs
// to the PROFILE, but it is only right for one model family, and picking a
// different model in the Selected model panel keeps it. Found by the agent
// bench, 2026-11-11: Qwen3-4B-Instruct-2507 ran under qwen3.6-tools.jinja (the
// Qwen 3.5/3.6 XML tool-call format), wrote a half-XML call format, and
// llama-server parsed 34 of its 109 calls. On its own template: all of them.
//
// So a bundled override is checked against the model's general.architecture
// (from the GGUF header, not the file name) before it is applied:
//
//   no override                         → embedded
//   bundled, architecture matches       → override
//   bundled, architecture differs       → skipped: embedded is used, with a warning
//   bundled, architecture unreadable    → override, with a warning (cannot check;
//                                         this is the behaviour before the check)
//   file not in BUNDLED_TEMPLATES       → user override, applied, logged as unchecked
//   chatTemplate (name or inline)       → user override, applied, logged as unchecked
//
// Applied by ipc/server.mjs to both the launch and the command preview, so the
// preview shows what will actually run. The decision is also written to the
// run's log, because until now nothing said which template was in use.
// =============================================================================

import * as path from 'path'
import { readGgufGeneral } from './gguf-meta.mjs'

/**
 * Overrides shipped in redstart-nest/chat-templates/, by file name, with the
 * general.architecture values each was written and tested for. A constant
 * here rather than a JSON file beside the templates, so packaging cannot
 * separate the two; test-chat-template-choice.mjs fails if a .jinja in that
 * folder has no entry.
 */
export const BUNDLED_TEMPLATES = {
  // Qwen3.5 / Qwen3.6 (dense qwen35, MoE qwen35moe). See chat-templates/README.md.
  'qwen3.6-tools.jinja': { architectures: ['qwen35', 'qwen35moe'] },
}

/**
 * @param {Record<string, any>} config a launch config (profile + model path)
 * @param {{ readMeta?: (p: string) => { architecture: string | null } | null }} [deps]
 * @returns {{
 *   config: Record<string, any>,
 *   decision: {
 *     source: 'embedded' | 'override' | 'skipped' | 'user-override',
 *     file: string | null,
 *     architecture: string | null,
 *     warning: string | null
 *   },
 *   logLine: string
 * }}
 */
export function chooseChatTemplate(config, deps = {}) {
  const readMeta = deps.readMeta ?? readGgufGeneral
  const file = config?.chatTemplateFile?.trim() || null
  const inline = config?.chatTemplate?.trim() || null

  /** @param {any} decision @param {Record<string, any>} effective */
  const done = (decision, effective) => ({ config: effective, decision, logLine: describe(decision) })

  if (!file) {
    if (inline) {
      return done({ source: 'user-override', file: null, architecture: null, warning: null }, config)
    }
    return done({ source: 'embedded', file: null, architecture: null, warning: null }, config)
  }

  const name = path.basename(file.replace(/\\/g, '/'))
  const bundled = Object.hasOwn(BUNDLED_TEMPLATES, name) ? BUNDLED_TEMPLATES[name] : null
  if (!bundled) {
    return done({ source: 'user-override', file, architecture: null, warning: null }, config)
  }

  const architecture = config?.modelPath ? (readMeta(config.modelPath)?.architecture ?? null) : null
  if (!architecture) {
    return done({
      source: 'override', file, architecture: null,
      warning: `could not read the model's architecture, so ${name} was applied unchecked`,
    }, config)
  }
  if (bundled.architectures.includes(architecture)) {
    return done({ source: 'override', file, architecture, warning: null }, config)
  }

  // The mismatch case: drop both override fields, so buildArgs emits neither
  // and llama-server uses the template embedded in the GGUF.
  const { chatTemplateFile: _f, chatTemplate: _t, ...rest } = config
  return done({
    source: 'skipped', file, architecture,
    warning: `${name} is for ${bundled.architectures.join(' / ')} models, and this model is ${architecture}; ` +
      `using the model's embedded template instead. Remove chatTemplateFile from the profile to silence this.`,
  }, rest)
}

/** One line for the run's log. */
function describe(d) {
  const arch = d.architecture ? ` (model architecture: ${d.architecture})` : ''
  switch (d.source) {
    case 'embedded': return `[redstart] chat template: embedded in the GGUF`
    case 'override': return `[redstart] chat template: override ${d.file}${arch}${d.warning ? ` - warning: ${d.warning}` : ''}`
    case 'skipped': return `[redstart] chat template: embedded in the GGUF - override skipped: ${d.warning}`
    default: return `[redstart] chat template: user override ${d.file ?? '(chatTemplate field)'}, not checked against the model`
  }
}
