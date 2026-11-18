// =============================================================================
// Redstart Twig: the granted folder (model tools + the Files tab explorer)
// =============================================================================
// When the chat-ui runs inside Twig, fs_* tool calls execute HERE, against a
// folder on THIS machine that the user explicitly granted, instead of on the
// remote Redstart Nest server. The tool logic lives in ./fs/.
//
// No folder is granted by default. The model gets zero local file tools until
// the user picks one (Settings → Server, or the folder control under the chat
// composer). That keeps "the model can touch my disk" an explicit act, and
// leaves Nest's own server-side file capability reachable for users who never
// grant one.
//
// GRANTING is not a page method. `fs:set-root` is called by the shell after its
// own folder dialog returns (shell/src/bridge.rs keeps it off the page's
// allowlist), so a folder is granted only by a person choosing one, never by a
// script in the page. Moved from Electron's main.mjs in the Tauri move; the
// handlers' behaviour is unchanged.
// =============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as fsTool from './fs/fs-tool.mjs'
import { moveToTrash } from './fs/trash.mjs'
import { resolveWithinRoot } from './fs/path-scope.mjs'

const PREVIEWABLE_EXTENSIONS = new Set(['.txt', '.md', '.csv', '.json', '.log', '.py', '.js', '.ts', '.html', '.css', '.yml', '.yaml', '.xml', '.ini', '.cfg'])
const MAX_LOCAL_PREVIEW_CHARS = 20000
const MAX_LOCAL_ENTRIES = 1000

// fs-tool.mjs emits MCP-shaped defs; the chat-ui speaks OpenAI function-calling.
function toOpenAiToolDefs(defs) {
  return defs.map((d) => ({
    type: 'function',
    function: { name: d.name, description: d.description, parameters: d.inputSchema },
  }))
}

/** @param {{ configDir: string }} opts */
export function createLocalFiles({ configDir }) {
  const configPath = path.join(configDir, 'twig-fs-config.json')

  function loadRoot() {
    try {
      return JSON.parse(fs.readFileSync(configPath, 'utf8')).rootDir || null
    } catch {
      return null
    }
  }

  function saveRoot(rootDir) {
    try {
      fs.mkdirSync(configDir, { recursive: true })
      fs.writeFileSync(configPath, JSON.stringify({ rootDir }, null, 2))
    } catch (err) {
      console.warn('Could not persist fs root:', err.message)
    }
  }

  // Existing installs keep whatever they already granted: the persisted value
  // is read here and nothing clears it.
  let rootDir = loadRoot()

  // Shape expected by fs-tool.mjs. Default-deny: no granted folder → disabled.
  const toolCfg = () => ({ fileSystem: { enabled: !!rootDir, rootDir } })

  /** Resolve a page-supplied path inside the granted folder, or throw. */
  function resolveLocal(relPath) {
    if (!rootDir) throw new Error('No folder has been granted yet.')
    return resolveWithinRoot(rootDir, relPath && relPath !== '.' ? relPath : '.')
  }

  const toRelative = (full) => path.relative(rootDir, full).split(path.sep).join('/')

  /** Page-callable. Explorer methods resolve with `{ error }` rather than rejecting. */
  const handlers = {
    // { tools, classes }: `classes` tells the chat-ui which tools are
    // destructive, which is what keeps fs_delete_file out of "always allow".
    // Nest's server-side policy gate has no reach over tools that run here,
    // so this manifest is the only control.
    'fs:get-tools': () => (rootDir
      ? { tools: toOpenAiToolDefs(fsTool.toolDefs(toolCfg())), classes: fsTool.TOOL_CLASSES }
      : { tools: [], classes: {} }),

    'fs:execute': ({ name, args } = {}) => fsTool.callTool(name, args, toolCfg()),

    'fs:get-root': () => ({ rootDir }),

    // Structured counterparts to the model-facing tools, for the Files tab.
    // Deliberately separate from fs:execute: those return MCP text shaped for a
    // model to read, and parsing it back in the UI would break the moment the
    // wording changed. NOT advertised to the model. Shapes mirror Nest's
    // /files/* API so one explorer component can browse either machine.
    'fs:browse': ({ path: relPath } = {}) => {
      try {
        const full = resolveLocal(relPath)
        const stat = fs.statSync(full)
        if (!stat.isDirectory()) return { error: 'Not a folder' }

        const entries = []
        for (const entry of fs.readdirSync(full, { withFileTypes: true }).slice(0, MAX_LOCAL_ENTRIES)) {
          const childFull = path.join(full, entry.name)
          // The trash folder backs recoverable deletion. Browsing it would
          // invite deleting already-deleted things, the one path that could
          // destroy data.
          if (entry.isDirectory() && entry.name === '.trash') continue
          let childStat
          try {
            childStat = fs.statSync(childFull)
          } catch {
            continue
          }
          entries.push({
            name: entry.name,
            path: toRelative(childFull),
            type: childStat.isDirectory() ? 'folder' : 'file',
            size: childStat.isDirectory() ? null : childStat.size,
            modified: childStat.mtime.toISOString(),
            previewable: !childStat.isDirectory() && PREVIEWABLE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()),
          })
        }
        entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'folder' ? -1 : 1))
        return { path: toRelative(full) || '.', entries }
      } catch (err) {
        return { error: err.message }
      }
    },

    'fs:preview': ({ path: relPath } = {}) => {
      try {
        const full = resolveLocal(relPath)
        if (!PREVIEWABLE_EXTENSIONS.has(path.extname(full).toLowerCase())) {
          return { error: 'No preview is available for this file type' }
        }
        const text = fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n')
        return { text: text.slice(0, MAX_LOCAL_PREVIEW_CHARS), truncated: text.length > MAX_LOCAL_PREVIEW_CHARS }
      } catch (err) {
        return { error: err.message }
      }
    },

    'fs:mkdir': ({ path: relPath } = {}) => {
      try {
        const full = resolveLocal(relPath)
        if (path.relative(rootDir, full) === '') return { error: 'A folder needs a name' }
        if (fs.existsSync(full)) return { error: 'Something with that name already exists' }
        fs.mkdirSync(full, { recursive: true })
        return { path: toRelative(full) }
      } catch (err) {
        return { error: err.message }
      }
    },

    'fs:move': ({ from, to } = {}) => {
      try {
        // BOTH paths go through containment. Checking only the source would
        // let the destination write anywhere on the user's disk.
        const fromFull = resolveLocal(from)
        const toFull = resolveLocal(to)
        if (path.relative(rootDir, fromFull) === '') return { error: 'Cannot move the granted folder itself' }
        if (path.relative(rootDir, toFull) === '') return { error: 'The new name cannot be empty' }
        if (!fs.existsSync(fromFull)) return { error: 'Not found' }
        if (fs.existsSync(toFull)) return { error: 'Something with that name already exists' }
        // A folder cannot be moved inside itself; renameSync answers that with
        // a bare EINVAL that would surface as an unexplained failure.
        const inner = path.relative(fromFull, toFull)
        if (inner !== '' && !inner.startsWith('..') && !path.isAbsolute(inner)) {
          return { error: 'A folder cannot be moved inside itself' }
        }
        fs.mkdirSync(path.dirname(toFull), { recursive: true })
        fs.renameSync(fromFull, toFull)
        return { path: toRelative(toFull) }
      } catch (err) {
        return { error: err.message }
      }
    },

    'fs:trash': async ({ path: relPath } = {}) => {
      try {
        const full = resolveLocal(relPath)
        if (path.relative(rootDir, full) === '') return { error: 'Cannot delete the granted folder itself' }
        if (!fs.existsSync(full)) return { error: 'Not found' }
        const stat = fs.lstatSync(full)
        if (stat.isDirectory() && !stat.isSymbolicLink() && fs.readdirSync(full).length > 0) {
          return { error: 'That folder is not empty. Remove its contents first.' }
        }
        // The same recoverable deletion the model's fs_delete_file uses: a
        // user-driven delete is exactly as undoable as a model-driven one.
        const outcome = await moveToTrash(rootDir, full)
        if (!outcome.ok) return { error: outcome.error }
        // restoreHint: Electron's handler read `outcome.hint`, which moveToTrash
        // never set, so the Files tab never showed where a delete went.
        return { path: toRelative(full), recoverable: outcome.method, hint: outcome.restoreHint }
      } catch (err) {
        return { error: err.message }
      }
    },
  }

  /** Shell-only: the folder a person just chose in the shell's dialog. */
  function setRoot({ rootDir: chosen } = {}) {
    if (typeof chosen !== 'string' || !path.isAbsolute(chosen)) throw new Error('fs:set-root needs an absolute folder path')
    let stat
    try {
      stat = fs.statSync(chosen)
    } catch {
      throw new Error(`No such folder: ${chosen}`)
    }
    if (!stat.isDirectory()) throw new Error(`Not a folder: ${chosen}`)
    rootDir = chosen
    saveRoot(rootDir)
    return { rootDir }
  }

  return { handlers, setRoot, getRoot: () => rootDir }
}
