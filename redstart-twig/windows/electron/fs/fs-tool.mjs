'use strict'

// =============================================================================
// Redstart Twig — Local file-system tools (the user's own machine)
// =============================================================================
// General-purpose read/write access to a folder ON THE TWIG PC that the user
// explicitly granted. This is the "Claude Desktop" capability: the model can
// read configs, write scripts, edit project files — all within that root.
//
// THIS IS TWIG'S CODE. It began life as redstart-nest/electron/main/fs-tool.mjs
// and Twig loaded it across the source tree; Nest deleted that module during the
// FS MCP migration (it now runs @modelcontextprotocol/server-filesystem instead),
// which broke both Twig's dev import and its packaging step. Vendored here on
// 2026-08-07. Nest has no counterpart to sync with any more — only path-scope.mjs
// is shared, and that one is kept in step by hand.
//
// Twig deliberately keeps the fs_* prefix rather than adopting the upstream
// server's names (read_file, write_file, ...). Twig acts on the USER'S machine
// and Nest acts on the SERVER; the two tool sets are offered to the same model
// and must never be confusable, by the model or by an admin writing a tool ban.
// See docs/tool-namespacing.md.
//
// Security model:
//   - Path containment via resolveWithinRoot() — model can never escape root
//   - User explicitly chooses the root directory; none is granted by default
//   - Deletes are recoverable (recycle bin / .trash/), never permanent
//   - Write operations are immediate (transparent in chat); user reviews
//     results in the conversation, same as Claude Desktop
//   - No shell execution — model can write but not run files
// =============================================================================

import * as fs from 'fs'
import * as path from 'path'
import { resolveWithinRoot } from './path-scope.mjs'
import { moveToTrash } from './trash.mjs'

const TOOL_NAMES = [
  'fs_read_file',
  'fs_write_file',
  'fs_edit_file',
  'fs_list_directory',
  'fs_search_files',
  'fs_get_file_info',
  'fs_create_directory',
  'fs_delete_file',
]

// Class of each tool, in the same vocabulary Redstart Nest uses
// ('read' | 'write' | 'destructive'). Reported to the chat-ui alongside the
// definitions, because these tools reach the model as plain OpenAI function
// definitions and never travel over MCP — there is nowhere in that wire format
// to carry an annotation.
//
// It is load-bearing for exactly one entry. The chat-ui refuses to remember an
// "always allow" grant for a destructive tool, so every deletion prompts. Twig's
// delete is the one in the whole system that Nest's server-side policy gate
// cannot reach — it runs on the user's own machine — so this manifest is the
// only thing standing between one convenience click and permanently unattended
// deletion on that machine.
export const TOOL_CLASSES = {
  fs_read_file: 'read',
  fs_list_directory: 'read',
  fs_search_files: 'read',
  fs_get_file_info: 'read',
  fs_write_file: 'write',
  fs_edit_file: 'write',
  fs_create_directory: 'write',
  fs_delete_file: 'destructive',
}

const MAX_OUTPUT_CHARS = 8000
const MAX_READ_CHARS = 7500
const MAX_FILE_BYTES = 50 * 1024 * 1024  // 50 MB
const MAX_SEARCH_RESULTS = 50
const MAX_DIR_ENTRIES = 200

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mcpOk(text) {
  return { content: [{ type: 'text', text: text.slice(0, MAX_OUTPUT_CHARS) }] }
}

function mcpErr(text) {
  return { isError: true, content: [{ type: 'text', text: text.slice(0, MAX_OUTPUT_CHARS) }] }
}

function safeResolve(root, userPath) {
  try {
    return resolveWithinRoot(root, userPath)
  } catch {
    return null
  }
}

function readTextFile(filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return { isError: true, content: [{ type: 'text', text: `File not found: ${filePath}` }] }
  }
  const size = fs.statSync(filePath).size
  if (size > MAX_FILE_BYTES) {
    return { isError: true, content: [{ type: 'text', text: `File exceeds ${(MAX_FILE_BYTES / 1048576).toFixed(0)} MB limit (${(size / 1048576).toFixed(1)} MB)` }] }
  }
  try {
    const text = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n')
    let out = text
    if (out.length > MAX_READ_CHARS) {
      out = out.slice(0, MAX_READ_CHARS) + `\n\n[Truncated — showing first ${MAX_READ_CHARS.toLocaleString()} of ${out.length.toLocaleString()} characters. Use fs_read_file again with a more specific path or read a smaller section.]`
    }
    return mcpOk(out || '[Empty file]')
  } catch (err) {
    return mcpErr(`Read error: ${err.message}`)
  }
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

function readFile(rootDir, filePath) {
  if (!filePath || typeof filePath !== 'string') {
    return mcpErr('Missing required argument: path')
  }
  const full = safeResolve(rootDir, filePath)
  if (!full) return mcpErr('Path is outside the configured file system folder')
  return readTextFile(full)
}

function writeFile(rootDir, filePath, content) {
  if (!filePath || typeof filePath !== 'string') {
    return mcpErr('Missing required argument: path')
  }
  if (content === undefined || content === null) {
    return mcpErr('Missing required argument: content')
  }
  const full = safeResolve(rootDir, filePath)
  if (!full) return mcpErr('Path is outside the configured file system folder')

  // Prevent writing to paths that look like binary/non-text targets for safety
  const ext = path.extname(full).toLowerCase()
  const binaryExts = new Set(['.exe', '.dll', '.so', '.dylib', '.bin', '.dat'])
  if (binaryExts.has(ext)) {
    return mcpErr(`Refusing to write binary file type: ${ext}. Use a text-based format.`)
  }

  try {
    const dir = path.dirname(full)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2)
    fs.writeFileSync(full, text, 'utf8')
    const rel = filePath
    const preview = text.slice(0, 2000)
    const suffix = text.length > 2000 ? '\n\n[Showing first 2000 chars of written content]' : ''
    return { content: [{ type: 'text', text: `[FILE: ${rel}]\nWritten to: ${rel}\n\n${preview}${suffix}` }] }
  } catch (err) {
    return mcpErr(`Write error: ${err.message}`)
  }
}

function editFile(rootDir, filePath, find, replace) {
  if (!filePath || typeof filePath !== 'string') {
    return mcpErr('Missing required argument: path')
  }
  if (typeof find !== 'string' || typeof replace !== 'string') {
    return mcpErr('Missing required arguments: find and replace (both strings)')
  }
  const full = safeResolve(rootDir, filePath)
  if (!full) return mcpErr('Path is outside the configured file system folder')

  const readResult = readTextFile(full)
  if (readResult.isError) return readResult

  const text = readResult.content[0].text
  if (!text.includes(find)) {
    return mcpErr(`String not found in file. Searched for: "${find.slice(0, 100)}${find.length > 100 ? '...' : ''}"`)
  }

  const count = (text.match(new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length
  if (count > 1) {
    return mcpErr(`String appears ${count} times in the file. Use fs_write_file to rewrite the entire file, or make the search string more specific so it matches exactly once.`)
  }

  const newText = text.replace(find, replace)
  try {
    fs.writeFileSync(full, newText, 'utf8')
    const diff = `--- ${filePath}\n+++ ${filePath}\n@@\n-${find}\n+${replace}\n`
    return mcpOk(`Edited 1 occurrence in ${filePath}.\n\n${diff}\n\nResult:\n${newText.slice(0, 4000)}${newText.length > 4000 ? '\n[Truncated]' : ''}`)
  } catch (err) {
    return mcpErr(`Write error: ${err.message}`)
  }
}

function listDirectory(rootDir, dirPath) {
  const target = dirPath ? safeResolve(rootDir, dirPath) : rootDir
  if (!target) return mcpErr('Path is outside the configured file system folder')
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
    return mcpErr(`Not a directory: ${dirPath || '/'}`)
  }

  let entries
  try {
    entries = fs.readdirSync(target, { withFileTypes: true })
  } catch (err) {
    return mcpErr(`Cannot read directory: ${err.message}`)
  }

  entries = entries.slice(0, MAX_DIR_ENTRIES)
  const items = entries.map(e => {
    const rel = path.join(target, e.name).replace(rootDir, '').replace(/^[\\/]/, '')
    if (e.isDirectory()) return `[DIR]  ${rel}/`
    const size = fs.statSync(path.join(target, e.name)).size
    const sizeStr = size < 1024 ? `${size}B` : size < 1048576 ? `${(size / 1024).toFixed(1)}KB` : `${(size / 1048576).toFixed(1)}MB`
    return `[FILE] ${rel}  (${sizeStr})`
  })

  let text = `Directory: ${dirPath || '/'}\n${items.join('\n')}`
  if (entries.length >= MAX_DIR_ENTRIES) text += `\n\n[Showing first ${MAX_DIR_ENTRIES} entries]`
  return mcpOk(text)
}

function searchFiles(rootDir, pattern) {
  if (!pattern || typeof pattern !== 'string') {
    return mcpErr('Missing required argument: pattern (glob or substring)')
  }

  const results = []
  const stack = [rootDir]
  let scanned = 0

  while (stack.length && results.length < MAX_SEARCH_RESULTS) {
    const dir = stack.pop()
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }

    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      const rel = full.replace(rootDir, '').replace(/^[\\/]/, '')
      if (entry.isDirectory()) {
        // Skip hidden and common noise dirs
        if (!entry.name.startsWith('.') && entry.name !== 'node_modules' && entry.name !== '__pycache__') {
          stack.push(full)
        }
        continue
      }
      if (++scanned > 5000) break
      if (entry.name.toLowerCase().includes(pattern.toLowerCase()) ||
          rel.toLowerCase().includes(pattern.toLowerCase())) {
        results.push(rel)
      }
    }
  }

  if (results.length === 0) {
    return mcpOk(`No files matching "${pattern}".`)
  }
  let text = results.join('\n')
  if (results.length >= MAX_SEARCH_RESULTS) text += `\n\n[Showing first ${MAX_SEARCH_RESULTS} of ${scanned} files scanned]`
  return mcpOk(text)
}

function getFileInfo(rootDir, filePath) {
  if (!filePath || typeof filePath !== 'string') {
    return mcpErr('Missing required argument: path')
  }
  const full = safeResolve(rootDir, filePath)
  if (!full) return mcpErr('Path is outside the configured file system folder')
  if (!fs.existsSync(full)) return mcpErr(`Path not found: ${filePath}`)

  const stat = fs.statSync(full)
  const rel = full.replace(rootDir, '').replace(/^[\\/]/, '')
  const info = {
    path: rel,
    type: stat.isDirectory() ? 'directory' : 'file',
    size: stat.size,
    sizeHuman: stat.size < 1024 ? `${stat.size} B` : stat.size < 1048576 ? `${(stat.size / 1024).toFixed(1)} KB` : `${(stat.size / 1048576).toFixed(1)} MB`,
    modified: stat.mtime.toISOString(),
    created: stat.birthtime.toISOString(),
    readable: fs.accessSync(full, fs.constants.R_OK) === undefined,
    writable: fs.accessSync(full, fs.constants.W_OK) === undefined,
  }
  return mcpOk(JSON.stringify(info, null, 2))
}

function createDirectory(rootDir, dirPath) {
  if (!dirPath || typeof dirPath !== 'string') {
    return mcpErr('Missing required argument: path')
  }
  const full = safeResolve(rootDir, dirPath)
  if (!full) return mcpErr('Path is outside the configured file system folder')
  if (fs.existsSync(full)) return mcpErr(`Already exists: ${dirPath}`)

  try {
    fs.mkdirSync(full, { recursive: true })
    return mcpOk(`Created directory: ${dirPath}`)
  } catch (err) {
    return mcpErr(`Create error: ${err.message}`)
  }
}

// Deletion is RECOVERABLE — see trash.mjs. Nothing in this function removes
// bytes; the worst case is a failed move that leaves the file where it was.
async function deleteFile(rootDir, filePath) {
  if (!filePath || typeof filePath !== 'string') {
    return mcpErr('Missing required argument: path')
  }

  // Containment gate first. resolveWithinRoot follows symlinks, so this also
  // refuses a link inside the root that points outside it — including one the
  // model planted itself with fs_write_file moments earlier.
  const resolved = safeResolve(rootDir, filePath)
  if (!resolved) return mcpErr('Path is outside the configured file system folder')

  // Guard: never delete the granted folder itself. path.relative() returns ''
  // for "these are the same path" — compared against the CANONICAL root (via
  // the same audited helper) so a symlinked or differently-cased root still
  // matches. Without this, path "." or "" would trash the user's whole folder.
  const canonicalRoot = safeResolve(rootDir, '.')
  if (canonicalRoot && path.relative(canonicalRoot, resolved) === '') {
    return mcpErr('Refusing to delete the granted folder itself. Delete its contents individually if that is what you want.')
  }

  // Operate on the LEXICAL path, not the symlink-resolved one: deleting a
  // symlink must remove the link, never the file it points at. For an ordinary
  // path the two are the same; they differ only when a link is involved, which
  // is exactly the case worth getting right.
  const target = path.resolve(rootDir, filePath)

  let stat
  try {
    stat = fs.lstatSync(target)
  } catch {
    return mcpErr(`Not found: ${filePath}`)
  }

  const isSymlink = stat.isSymbolicLink()

  // Directory contents are never deleted implicitly. There is deliberately no
  // `recursive` option on this tool — a model that wants a tree gone has to ask
  // for each item, and the user sees every one of those calls.
  if (stat.isDirectory() && !isSymlink) {
    let entries
    try {
      entries = fs.readdirSync(target)
    } catch (err) {
      return mcpErr(`Cannot read directory: ${err.message}`)
    }
    if (entries.length > 0) {
      return mcpErr(`Directory not empty (${entries.length} items). Remove the contents first — this tool will not delete a folder's contents implicitly.`)
    }
  }

  const outcome = await moveToTrash(rootDir, target)
  if (!outcome.ok) return mcpErr(`Delete failed: ${outcome.error}`)

  const what = isSymlink ? 'symlink (the link itself, not its target)'
    : stat.isDirectory() ? 'empty directory'
    : 'file'
  return mcpOk(`Deleted ${what}: ${filePath}\n\nThis is recoverable — ${outcome.restoreHint}.`)
}

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

// Every description names the machine. This is load-bearing, not politeness:
// the model may also be holding Nest's server-side file tools, the granted
// folder can appear or change mid-conversation (so earlier turns describe a
// different tool set), and "write this file" is ambiguous between two computers
// in a way the model cannot resolve from the tool name alone. The contrast with
// the server is spelled out on the mutating tools, where picking the wrong
// machine actually costs something.
export function toolDefs(cfg) {
  if (!cfg?.fileSystem?.enabled) return []
  return [
    {
      name: 'fs_read_file',
      description: 'Read a text file from the granted folder on the user\'s own computer (Redstart Twig). Returns up to 8000 characters; long files are truncated with pagination instructions.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the file system root' },
        },
        required: ['path'],
      },
    },
    {
      name: 'fs_write_file',
      description: 'Create or overwrite a text file in the granted folder on the user\'s own computer (Redstart Twig) — not on the Redstart server. Parent directories are created automatically. Refuses binary extensions (.exe, .dll, .so).',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the file system root' },
          content: { type: 'string', description: 'Text content to write' },
        },
        required: ['path', 'content'],
      },
    },
    {
      name: 'fs_edit_file',
      description: 'Find-and-replace within a text file in the granted folder on the user\'s own computer (Redstart Twig) — not on the Redstart server. The search string must appear exactly once. Use fs_write_file for multi-occurrence changes.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the file system root' },
          find: { type: 'string', description: 'Exact string to find (must appear exactly once)' },
          replace: { type: 'string', description: 'Replacement string' },
        },
        required: ['path', 'find', 'replace'],
      },
    },
    {
      name: 'fs_list_directory',
      description: 'List files and folders in the granted folder on the user\'s own computer (Redstart Twig). Shows sizes for files. Defaults to the root of the granted folder if no path given.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path relative to root (default: root itself)' },
        },
        required: [],
      },
    },
    {
      name: 'fs_search_files',
      description: 'Search for files by name (case-insensitive substring match) in the granted folder on the user\'s own computer (Redstart Twig). Returns matching paths.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Substring to match against filenames' },
        },
        required: ['pattern'],
      },
    },
    {
      name: 'fs_get_file_info',
      description: 'Get metadata for a file or directory in the granted folder on the user\'s own computer (Redstart Twig): size, type, timestamps, permissions.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File or directory path relative to the file system root' },
        },
        required: ['path'],
      },
    },
    {
      name: 'fs_create_directory',
      description: 'Create a directory in the granted folder on the user\'s own computer (Redstart Twig) — not on the Redstart server. Parent directories are created automatically.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path relative to the file system root' },
        },
        required: ['path'],
      },
    },
    {
      name: 'fs_delete_file',
      description: 'Delete a file or empty directory in the granted folder on the user\'s own computer (Redstart Twig) — not on the Redstart server. Moves it to the Recycle Bin, so it can be recovered. Refuses non-empty directories and the granted folder itself.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File or empty directory path relative to the granted folder' },
        },
        required: ['path'],
      },
    },
  ]
}

export async function callTool(name, args, cfg) {
  if (!TOOL_NAMES.includes(name)) return null

  const fsCfg = cfg?.fileSystem
  if (!fsCfg?.enabled || !fsCfg?.rootDir) {
    return { isError: true, content: [{ type: 'text', text: 'File system is not configured or enabled.' }] }
  }
  if (!fs.existsSync(fsCfg.rootDir)) {
    return { isError: true, content: [{ type: 'text', text: 'The configured file system folder does not exist.' }] }
  }

  try {
    if (name === 'fs_read_file') return readFile(fsCfg.rootDir, args?.path)
    if (name === 'fs_write_file') return writeFile(fsCfg.rootDir, args?.path, args?.content)
    if (name === 'fs_edit_file') return editFile(fsCfg.rootDir, args?.path, args?.find, args?.replace)
    if (name === 'fs_list_directory') return listDirectory(fsCfg.rootDir, args?.path)
    if (name === 'fs_search_files') return searchFiles(fsCfg.rootDir, args?.pattern)
    if (name === 'fs_get_file_info') return getFileInfo(fsCfg.rootDir, args?.path)
    if (name === 'fs_create_directory') return createDirectory(fsCfg.rootDir, args?.path)
    // Awaited, not returned bare: a returned promise rejects OUTSIDE this
    // try/catch and would surface as an unhandled rejection instead of an
    // isError result.
    if (name === 'fs_delete_file') return await deleteFile(fsCfg.rootDir, args?.path)
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `File system error: ${err.message}` }] }
  }
}
