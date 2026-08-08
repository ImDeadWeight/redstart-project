'use strict'

// =============================================================================
// Redstart Nest — MCP Provider: File System delete (destructive class)
// =============================================================================
// The one destructive tool in Redstart. @modelcontextprotocol/server-filesystem
// exposes no delete at all (grep the pinned 2026.7.10 bundle for
// delete|unlink|rmdir — zero matches), so there is no upstream flag to turn on:
// a delete has to be Redstart-owned code, and this is it.
//
// Deliberately a SIBLING of filesystem-mcp-provider.mjs rather than an addition
// to it. That module's stated job is "lifecycle wiring for the upstream server;
// nothing here interprets tool semantics", and a bespoke tool breaks that
// contract. Concretely: this tool's name must NOT appear in
// FILESYSTEM_TOOL_NAMES, or callTool would try to proxy it to a child process
// that has no such tool.
//
// EVERYTHING THAT GATES THIS ALREADY EXISTED AND WAS INERT:
//   - evaluateToolPolicy (mcp-server.mjs) refuses cls === 'destructive' unless
//     fileSystem.allowDestructive is true, at BOTH tools/list (so the model is
//     never even offered it) and tools/call (so a client bypassing the filtered
//     list is still refused).
//   - buildGatewayConfig already emits allowDestructive.
//   - DEFAULT_CAPABILITIES.file_system already defaults it to false.
//   - ToolsTab already renders the toggle and its warning.
// Classifying DELETE_TOOL_NAME as 'destructive' in tools-definitions.mjs is
// what finally makes all of that load-bearing.
//
// DELETION IS RECOVERABLE. It moves the target to the OS recycle bin, falling
// back to a .trash/ folder inside the caller's own storage. That recoverability
// is what makes exposing a destructive tool to a local model defensible at all;
// an irreversible fs.rm driven by a 35B model's judgement is a different risk
// category, and one this codebase deliberately does not take. Nothing in this
// module removes bytes — the worst case is a failed move that leaves the file
// exactly where it was.
//
// Guards, all of which have a matching test:
//   - per-account scoping: you can only delete inside your own storage
//   - containment: no escape via .., absolute paths, or symlinks
//   - never the storage root itself
//   - never a non-empty directory (there is no `recursive` option, on purpose)
//   - a symlink is deleted as a LINK, never followed to its target
//   - nothing already in .trash/ (emptying the bin is not this tool's job)
// =============================================================================

import * as fs from 'fs'
import * as path from 'path'
import { resolveWithinRoot } from './path-scope.mjs'
import { resolveUserRoot } from './user-scope.mjs'
import { logAudit } from './logger.mjs'
// Shared with the web file explorer so a user-driven delete is exactly as
// recoverable as a model-driven one.
import { moveToTrash, isInTrash, TRASH_DIR_NAME } from './trash.mjs'

export const DELETE_TOOL_NAME = 'delete_file'

function mcpErr(text) {
  return { isError: true, content: [{ type: 'text', text }] }
}

export function toolDefs(cfg) {
  if (!cfg?.fileSystem?.enabled) return []
  return [
    {
      name: DELETE_TOOL_NAME,
      description:
        'Delete a file or empty directory from your storage on the Redstart server. ' +
        'The item is moved to the recycle bin, so it can be recovered. ' +
        'Refuses non-empty directories and the storage root itself.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File or empty directory path, relative to your storage root' },
        },
        required: ['path'],
      },
    },
  ]
}

// Provider interface: callTool(name, args, cfg, ctx). `ctx.account` is the
// authenticated caller (null when auth is off) — a delete is confined to that
// account's own folder, which is what shrinks the blast radius of this tool
// from "everyone's work" to "your own work".
export async function callTool(name, args, cfg, ctx) {
  if (name !== DELETE_TOOL_NAME) return null // not ours — let the next provider try

  const fsCfg = cfg?.fileSystem
  if (!fsCfg?.enabled || !fsCfg?.rootDir) {
    return mcpErr('File system is not configured or enabled.')
  }

  const requested = args?.path
  if (!requested || typeof requested !== 'string') {
    return mcpErr('Missing required argument: path')
  }

  let userRoot
  try {
    userRoot = resolveUserRoot(fsCfg.rootDir, ctx?.account, { create: true })
  } catch (err) {
    return mcpErr(`Could not open your file storage: ${err.message}`)
  }

  // Containment first. resolveWithinRoot follows symlinks, so this also refuses
  // a link inside the storage that points outside it — including one the model
  // planted with write_file moments earlier.
  let resolved
  try {
    resolved = resolveWithinRoot(userRoot, requested)
  } catch {
    return mcpErr('Path is outside your file storage.')
  }

  // Never the storage root itself. path.relative() returns '' for "these are
  // the same path"; without this, a path of "." or "" would trash everything
  // the account owns in one call.
  if (path.relative(userRoot, resolved) === '') {
    return mcpErr('Refusing to delete your storage root. Delete individual items inside it instead.')
  }

  if (isInTrash(userRoot, resolved)) {
    return mcpErr(`That is already in ${TRASH_DIR_NAME}/. Items there are kept so deletions can be undone.`)
  }

  // Operate on the LEXICAL path, not the symlink-resolved one: deleting a
  // symlink must remove the link, never the file it points at. For an ordinary
  // path the two are identical; they diverge only when a link is involved,
  // which is exactly the case worth getting right.
  const target = path.resolve(userRoot, requested)

  let stat
  try {
    stat = fs.lstatSync(target)
  } catch {
    return mcpErr(`Not found: ${requested}`)
  }
  const isSymlink = stat.isSymbolicLink()

  // Directory contents are never removed implicitly. There is deliberately no
  // `recursive` option — a model that wants a tree gone has to ask for each
  // item, and the user sees (and approves) every one of those calls.
  if (stat.isDirectory() && !isSymlink) {
    let entries
    try {
      entries = fs.readdirSync(target)
    } catch (err) {
      return mcpErr(`Cannot read directory: ${err.message}`)
    }
    if (entries.length > 0) {
      return mcpErr(`Directory is not empty (${entries.length} items). Remove the contents first — this tool will not delete a folder's contents implicitly.`)
    }
  }

  const outcome = await moveToTrash(userRoot, target)
  if (!outcome.ok) return mcpErr(`Delete failed: ${outcome.error}`)

  const relative = path.relative(userRoot, target).split(path.sep).join('/')
  const kind = isSymlink ? 'symlink' : stat.isDirectory() ? 'directory' : 'file'

  // The privacy contract's one exception — see logAudit in logger.mjs. A
  // deletion nobody can name is a deletion nobody can undo.
  logAudit('deleted', { tool: DELETE_TOOL_NAME, path: relative, kind, recoverable: outcome.method })

  const what = isSymlink ? 'symlink (the link itself, not its target)' : kind
  return {
    content: [{ type: 'text', text: `Deleted ${what}: ${relative}\n\nThis is recoverable — ${outcome.hint}.` }],
  }
}
