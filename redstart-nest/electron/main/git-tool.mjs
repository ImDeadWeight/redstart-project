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

const TOOL_NAMES = ['git_status', 'git_log', 'git_diff']
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

export function toolDefs(cfg) {
  if (!cfg?.git?.enabled) return []
  return [
    {
      name: 'git_status',
      description: 'Show the working-tree status of a local git repository: current branch and modified/added/deleted/untracked files.',
      inputSchema: { type: 'object', properties: { ...REPO_ARG } },
    },
    {
      name: 'git_log',
      description: 'Show recent commits of a local git repository (hash, author, date, message).',
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
      description: 'Show uncommitted changes (working tree + staged) of a local git repository. Optionally limited to one file path.',
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

export async function callTool(name, args, cfg) {
  if (!TOOL_NAMES.includes(name)) return null

  const gitCfg = cfg?.git
  if (!gitCfg?.enabled || !gitCfg?.rootDir) {
    return { isError: true, content: [{ type: 'text', text: 'Git is not configured or enabled.' }] }
  }

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
