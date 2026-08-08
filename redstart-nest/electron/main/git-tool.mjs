'use strict'

// =============================================================================
// Redstart Nest — MCP Provider: Git (repository context, read-only)
// =============================================================================
// Gives coding-agent conversations awareness of local repositories: recent
// commits, working-tree status, and uncommitted diffs. Admin configures a
// root folder; the model addresses repos by path relative to it (or uses the
// root itself when it is a repo). Containment via the shared path-scope util.
//
// Read-only is enforced by construction: git is invoked via execFile (no
// shell, args as an array — nothing to inject into) and only the fixed
// subcommands below are ever run. There is no argument path through which
// the model can name a different subcommand or pass extra flags.
// =============================================================================

import * as fs from 'fs'
import * as path from 'path'
import { execFile } from 'child_process'
import { resolveWithinRoot } from './path-scope.mjs'

const TOOL_NAMES = ['git_list_repos', 'git_status', 'git_log', 'git_diff']
const MAX_OUTPUT_CHARS = 8000
const GIT_TIMEOUT_MS = 10000
const MAX_LOG_COUNT = 50

function runGit(repoPath, args) {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', repoPath, ...args],
      { timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          if (err.code === 'ENOENT') {
            resolve({ ok: false, out: 'git is not installed or not on PATH on the server machine.' })
          } else {
            resolve({ ok: false, out: (stderr || err.message || 'git failed').trim() })
          }
          return
        }
        resolve({ ok: true, out: stdout })
      }
    )
  })
}

function clip(text) {
  if (text.length > MAX_OUTPUT_CHARS) return text.slice(0, MAX_OUTPUT_CHARS) + '\n\n[Output truncated]'
  return text
}

// Resolve the repo the model asked about: cfg root itself, or a subfolder of
// it. Must contain a .git directory (or file, for worktrees/submodules).
function resolveRepo(gitCfg, repo) {
  let repoPath
  if (repo && typeof repo === 'string' && repo.trim() && repo.trim() !== '.') {
    repoPath = resolveWithinRoot(gitCfg.rootDir, repo.trim())
  } else {
    repoPath = path.resolve(gitCfg.rootDir)
  }
  if (!fs.existsSync(repoPath) || !fs.statSync(repoPath).isDirectory()) {
    throw new Error(`Folder not found: ${repo || '.'}`)
  }
  if (!fs.existsSync(path.join(repoPath, '.git'))) {
    throw new Error(`Not a git repository: ${repo || 'the configured folder'} (no .git found)`)
  }
  return repoPath
}

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

const REPO_ARG = {
  repo: {
    type: 'string',
    description: 'Repository folder relative to the configured git root. Omit if the configured root is itself the repository.',
  },
}

// ---------------------------------------------------------------------------
// Repository discovery.
//
// `repo` defaults to the configured root, so a root that is itself a repo works
// without discovery. A root holding SEVERAL repos in subfolders does not: the
// model has to name one, and nothing tells it the names. Same shape of gap as
// SQLite had — a capability you cannot enumerate is one you cannot use.
// ---------------------------------------------------------------------------
const MAX_REPOS = 100

function listRepos(gitCfg) {
  const root = path.resolve(gitCfg.rootDir)
  const found = []

  const isRepo = (dir) => {
    try {
      return fs.existsSync(path.join(dir, '.git'))
    } catch {
      return false
    }
  }

  if (isRepo(root)) found.push('.')

  let entries = []
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return { isError: true, content: [{ type: 'text', text: 'Could not read the configured git folder.' }] }
  }
  // One level deep only: repos are conventionally direct children of a projects
  // folder, and descending further would walk every node_modules on the disk.
  for (const entry of entries) {
    if (found.length >= MAX_REPOS) break
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    if (isRepo(path.join(root, entry.name))) found.push(entry.name)
  }

  if (found.length === 0) {
    return { content: [{ type: 'text', text: 'No git repositories found in the configured folder.' }] }
  }
  const heading = `${found.length} repositor${found.length === 1 ? 'y' : 'ies'} available. ` +
    'Pass one of these as the "repo" argument:'
  return {
    content: [{ type: 'text', text: [heading, ...found].join('\n') }],
  }
}

export function toolDefs(cfg) {
  if (!cfg?.git?.enabled) return []
  return [
    {
      name: 'git_list_repos',
      description: 'List the git repositories available on the Redstart server. Start here when the folder holds more than one repository — the other git tools address a repository by name.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'git_status',
      description: 'Show the working-tree status of a git repository stored on the Redstart server, not on the machine the user is sitting at: current branch and modified/added/deleted/untracked files.',
      inputSchema: { type: 'object', properties: { ...REPO_ARG } },
    },
    {
      name: 'git_log',
      description: 'Show recent commits of a git repository stored on the Redstart server (hash, author, date, message).',
      inputSchema: {
        type: 'object',
        properties: {
          ...REPO_ARG,
          count: { type: 'number', description: `Number of commits to show (default 15, max ${MAX_LOG_COUNT})` },
        },
      },
    },
    {
      name: 'git_diff',
      description: 'Show uncommitted changes (working tree + staged) of a git repository stored on the Redstart server. Optionally limited to one file path.',
      inputSchema: {
        type: 'object',
        properties: {
          ...REPO_ARG,
          file: { type: 'string', description: 'Optional file path (relative to the repository) to limit the diff to' },
        },
      },
    },
  ]
}

// Provider interface: callTool(name, args, cfg, ctx). `ctx.account` is the
// authenticated caller (null when auth is off). Unused here — this capability
// is shared reference material and is the same for every account.
export async function callTool(name, args, cfg, _ctx) {
  if (!TOOL_NAMES.includes(name)) return null

  const gitCfg = cfg?.git
  if (!gitCfg?.enabled || !gitCfg?.rootDir) {
    return { isError: true, content: [{ type: 'text', text: 'Git is not configured or enabled.' }] }
  }

  // Before resolveRepo: discovery is what the model calls when it does not yet
  // know a repo name, so it cannot be made to supply one.
  if (name === 'git_list_repos') return listRepos(gitCfg)

  let repoPath
  try {
    repoPath = resolveRepo(gitCfg, args?.repo)
  } catch (err) {
    const outside = err.message.includes('escapes')
    return { isError: true, content: [{ type: 'text', text: outside ? 'Repository path is outside the configured git folder' : `Git error: ${err.message}` }] }
  }

  let result
  if (name === 'git_status') {
    result = await runGit(repoPath, ['status', '--short', '--branch'])
    if (result.ok && !result.out.trim()) result.out = '(clean working tree)'
  } else if (name === 'git_log') {
    const n = Math.min(MAX_LOG_COUNT, Math.max(1, Math.trunc(+(args?.count ?? 15)) || 15))
    result = await runGit(repoPath, ['log', `--max-count=${n}`, '--date=short', '--format=%h %ad %an — %s'])
    if (result.ok && !result.out.trim()) result.out = '(no commits yet)'
  } else {
    // git_diff — HEAD includes both staged and unstaged; falls back to plain
    // diff for repos with no commits yet (no HEAD to diff against).
    const fileArgs = []
    if (args?.file && typeof args.file === 'string' && args.file.trim()) {
      // "--" terminates option parsing, so a file value can never be read as a flag.
      fileArgs.push('--', args.file.trim())
    }
    result = await runGit(repoPath, ['diff', 'HEAD', ...fileArgs])
    if (!result.ok && /bad revision|unknown revision/i.test(result.out)) {
      result = await runGit(repoPath, ['diff', ...fileArgs])
    }
    if (result.ok && !result.out.trim()) result.out = '(no uncommitted changes)'
  }

  if (!result.ok) {
    return { isError: true, content: [{ type: 'text', text: `Git error: ${result.out}` }] }
  }
  return { content: [{ type: 'text', text: clip(result.out) }] }
}
