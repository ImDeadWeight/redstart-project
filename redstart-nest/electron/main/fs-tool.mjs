'use strict'

// =============================================================================
// Redstart Nest — MCP Provider: File System
// =============================================================================
// General-purpose read/write access to a user-chosen folder. This is the
// "Claude Desktop" capability: the model can read configs, write scripts,
// edit project files, and create documents — all within a root the user
// explicitly selected.
//
// Security model:
//   - Path containment via resolveWithinRoot() — model can never escape root
//   - User explicitly enables + chooses the root directory
//   - Write operations are immediate (transparent in chat); user reviews
//     results in the conversation, same as Claude Desktop
//   - No shell execution — model can write but not run files
//
// Tool naming: fs_<action> to avoid collisions with other providers.
// =============================================================================

import * as fs from 'fs'
import * as path from 'path'
import { resolveWithinRoot } from './path-scope.mjs'

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

function deleteFile(rootDir, filePath) {
  if (!filePath || typeof filePath !== 'string') {
    return mcpErr('Missing required argument: path')
  }
  const full = safeResolve(rootDir, filePath)
  if (!full) return mcpErr('Path is outside the configured file system folder')
  if (!fs.existsSync(full)) return mcpErr(`Not found: ${filePath}`)

  try {
    const isDir = fs.statSync(full).isDirectory()
    if (isDir) {
      const entries = fs.readdirSync(full)
      if (entries.length > 0) return mcpErr(`Directory not empty (${entries.length} items). Remove contents first.`)
      fs.rmdirSync(full)
      return mcpOk(`Removed empty directory: ${filePath}`)
    }
    fs.unlinkSync(full)
    return mcpOk(`Deleted: ${filePath}`)
  } catch (err) {
    return mcpErr(`Delete error: ${err.message}`)
  }
}

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

export function toolDefs(cfg) {
  if (!cfg?.fileSystem?.enabled) return []
  return [
    {
      name: 'fs_read_file',
      description: 'Read the contents of a text file within the file system root. Returns up to 8000 characters; long files are truncated with pagination instructions.',
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
      description: 'Create or overwrite a text file within the file system root. Parent directories are created automatically. Refuses binary extensions (.exe, .dll, .so).',
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
      description: 'Find-and-replace within a text file. The search string must appear exactly once. Use fs_write_file for multi-occurrence changes.',
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
      description: 'List files and folders at a path within the file system root. Shows sizes for files. Defaults to root if no path given.',
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
      description: 'Search for files by name (case-insensitive substring match) within the file system root. Returns matching paths.',
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
      description: 'Get metadata for a file or directory: size, type, timestamps, permissions.',
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
      description: 'Create a directory within the file system root. Parent directories are created automatically.',
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
      description: 'Delete a file or empty directory within the file system root. Refuses to delete non-empty directories.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File or empty directory path relative to the file system root' },
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
    if (name === 'fs_delete_file') return deleteFile(fsCfg.rootDir, args?.path)
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `File system error: ${err.message}` }] }
  }
}
