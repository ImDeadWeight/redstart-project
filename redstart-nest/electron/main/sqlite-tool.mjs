'use strict'

// =============================================================================
// Redstart Nest — MCP Provider: SQLite
// =============================================================================
// Read-only queries against local SQLite database files inside one
// admin-configured root directory (cfg.sqlite.rootDir). The model supplies a
// database path *relative to that root*; containment is enforced by the shared
// path-scope util (symlink-aware), same as Documents.
//
// Engine: sql.js (SQLite compiled to WebAssembly). Chosen deliberately over a
// native binding: zero native code (auditable, no Electron ABI rebuilds, runs
// identically under the plain-Node test scripts), and read-only is physically
// guaranteed — the file is read into memory and queried there, the file itself
// is never opened for writing. On top of that, PRAGMA query_only=1 makes the
// engine itself reject write statements with an honest error, mirroring how
// the Postgres provider uses a READ ONLY transaction: enforcement by the
// database engine, not by string-sniffing the SQL.
//
// The whole-file-in-memory model is also the size limit: files larger than
// cfg.sqlite.maxFileBytes are refused. Fine for the intended use case
// (small-org data, backup inspection) — point big warehouses at Postgres.
// =============================================================================

import * as fs from 'fs'
import * as path from 'path'
import initSqlJs from 'sql.js'
import { resolveWithinRoot } from './path-scope.mjs'

const TOOL_NAMES = ['sqlite_list_databases', 'sqlite_query', 'sqlite_list_tables', 'sqlite_describe_table']
const MAX_OUTPUT_CHARS = 8000
const DEFAULT_MAX_FILE_BYTES = 200 * 1024 * 1024 // 200 MB

// ---------------------------------------------------------------------------
// Database discovery.
//
// Every other tool here REQUIRES a database path, which meant the capability was
// unusable unless the model already knew a filename — and nothing ever told it
// one. Asked to look for databases, a model would fall back to the file-system
// tools (scoped to a different root entirely), find nothing, and report that no
// databases exist. That answer was true of everything it could see, which is
// what made it so convincing.
//
// A capability the model cannot enumerate is a capability it cannot use.
// ---------------------------------------------------------------------------
const DATABASE_EXTENSIONS = new Set(['.db', '.sqlite', '.sqlite3'])
const SKIP_DIRS = new Set(['.trash', '.git', 'node_modules'])
const MAX_DATABASES = 200

// SQLite files start with this exact 16-byte string. Checked so the listing
// reports databases rather than "things named .db" — a stray file with the
// right extension would otherwise show up and fail confusingly on first query.
const SQLITE_MAGIC = 'SQLite format 3\0'

function isSqliteFile(fullPath) {
  let fd
  try {
    fd = fs.openSync(fullPath, 'r')
    const header = Buffer.alloc(16)
    const read = fs.readSync(fd, header, 0, 16, 0)
    return read === 16 && header.toString('latin1') === SQLITE_MAGIC
  } catch {
    return false
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd) } catch { /* already gone */ }
  }
}

function listDatabases(sqliteCfg) {
  const root = path.resolve(sqliteCfg.rootDir)
  const found = []
  const stack = ['']

  while (stack.length && found.length < MAX_DATABASES) {
    const rel = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true })
    } catch {
      continue // unreadable folder — skip rather than fail the whole listing
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) stack.push(childRel)
        continue
      }
      if (!DATABASE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue
      const full = path.join(root, childRel)
      if (!isSqliteFile(full)) continue
      let size = 0
      try {
        size = fs.statSync(full).size
      } catch {
        continue
      }
      found.push({ path: childRel, size })
    }
  }

  if (found.length === 0) {
    return { content: [{ type: 'text', text: 'No SQLite databases found in the configured folder.' }] }
  }

  found.sort((a, b) => a.path.localeCompare(b.path))
  const lines = found.map((db) => {
    const kb = db.size < 1024 ? `${db.size} B` : `${(db.size / 1024).toFixed(0)} KB`
    return `${db.path}  (${kb})`
  })
  const text =
    `${found.length} database${found.length === 1 ? '' : 's'} available. ` +
    `Use these paths with sqlite_list_tables or sqlite_query:\n${lines.join('\n')}`
  return { content: [{ type: 'text', text: text.slice(0, MAX_OUTPUT_CHARS) }] }
}

// The WASM runtime is stateless and ~a few MB — initialize once, share forever.
let sqlJsPromise = null
function getSqlJs() {
  if (!sqlJsPromise) sqlJsPromise = initSqlJs()
  return sqlJsPromise
}

// ---------------------------------------------------------------------------
// Database loading — scoped, size-capped, read-only
// ---------------------------------------------------------------------------

async function openDatabase(sqliteCfg, database) {
  if (!database || typeof database !== 'string') {
    throw new Error('Missing required argument: database (path to a .sqlite/.db file, relative to the configured folder)')
  }

  let filePath
  try {
    filePath = resolveWithinRoot(sqliteCfg.rootDir, database)
  } catch {
    throw new Error('Database path is outside the configured SQLite folder')
  }
  if (!fs.existsSync(filePath)) {
    throw new Error(`Database file not found: ${database}`)
  }

  const maxBytes = sqliteCfg.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
  const { size } = fs.statSync(filePath)
  if (size > maxBytes) {
    throw new Error(`Database file is ${(size / 1048576).toFixed(0)} MB — larger than the ${(maxBytes / 1048576).toFixed(0)} MB limit for in-memory querying`)
  }

  const SQL = await getSqlJs()
  const db = new SQL.Database(fs.readFileSync(filePath))
  db.run('PRAGMA query_only = 1') // engine-level write rejection (honest errors; the on-disk file is never writable regardless)
  return db
}

// ---------------------------------------------------------------------------
// Output formatting — mirrors postgres-tool.mjs so the model sees one style
// ---------------------------------------------------------------------------

function stringifyCell(value) {
  if (value === null || value === undefined) return 'NULL'
  if (value instanceof Uint8Array) return `<blob ${value.length} bytes>`
  return String(value)
}

function formatExecResult(results, maxRows) {
  // sql.js exec() returns one {columns, values} block per result-bearing statement.
  if (!results || results.length === 0) return 'Query OK, no data returned.'

  const parts = []
  for (const result of results) {
    const shown = result.values.slice(0, maxRows)
    const lines = [result.columns.join(' | '), ...shown.map(row => row.map(stringifyCell).join(' | '))]
    let text = lines.join('\n')
    if (result.values.length > maxRows) {
      text += `\n\n[Showing first ${maxRows} of ${result.values.length} rows]`
    }
    parts.push(text)
  }
  let out = parts.join('\n\n---\n\n')
  if (out.length > MAX_OUTPUT_CHARS) {
    out = out.slice(0, MAX_OUTPUT_CHARS) + '\n\n[Output truncated]'
  }
  return out
}

// SQLite identifiers can't be bound as parameters (e.g. in PRAGMA); quote them.
function quoteIdentifier(name) {
  return `"${String(name).replace(/"/g, '""')}"`
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

function runQuery(db, sql, maxRows) {
  if (!sql || typeof sql !== 'string') {
    return { isError: true, content: [{ type: 'text', text: 'Missing required argument: sql' }] }
  }
  const results = db.exec(sql)
  return { content: [{ type: 'text', text: formatExecResult(results, maxRows) }] }
}

function listTables(db) {
  const results = db.exec(
    `SELECT name, type FROM sqlite_master
     WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
     ORDER BY name`
  )
  if (!results.length || results[0].values.length === 0) {
    return { content: [{ type: 'text', text: 'No tables found.' }] }
  }
  const text = results[0].values.map(([name, type]) => (type === 'view' ? `${name} (view)` : name)).join('\n')
  return { content: [{ type: 'text', text }] }
}

function describeTable(db, table) {
  if (!table || typeof table !== 'string') {
    return { isError: true, content: [{ type: 'text', text: 'Missing required argument: table' }] }
  }
  const results = db.exec(`PRAGMA table_info(${quoteIdentifier(table)})`)
  if (!results.length || results[0].values.length === 0) {
    return { isError: true, content: [{ type: 'text', text: `Table not found: ${table}` }] }
  }
  // PRAGMA table_info columns: cid, name, type, notnull, dflt_value, pk
  const lines = results[0].values.map(([, name, type, notnull, dflt, pk]) =>
    `${name} — ${type || 'ANY'}${notnull ? ' NOT NULL' : ''}${dflt !== null ? ` DEFAULT ${dflt}` : ''}${pk ? ' PRIMARY KEY' : ''}`
  )
  return { content: [{ type: 'text', text: lines.join('\n') }] }
}

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

export function toolDefs(cfg) {
  if (!cfg?.sqlite?.enabled) return []
  return [
    {
      name: 'sqlite_list_databases',
      description: 'List the SQLite database files available on the Redstart server, with their sizes. Start here — the other SQLite tools need a database path, and this is the only way to discover what exists.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'sqlite_query',
      description: 'Run a read-only SQL query against a SQLite database file stored on the Redstart server, not on the machine the user is sitting at. The database is opened read-only — write/DDL statements are rejected by the engine.',
      inputSchema: {
        type: 'object',
        properties: {
          database: { type: 'string', description: 'Path to the database file, relative to the configured SQLite folder (e.g. "cases.db" or "backups/2026-06.sqlite")' },
          sql: { type: 'string', description: 'The SQL query to run' },
        },
        required: ['database', 'sql'],
      },
    },
    {
      name: 'sqlite_list_tables',
      description: 'List all tables and views in a SQLite database file stored on the Redstart server.',
      inputSchema: {
        type: 'object',
        properties: {
          database: { type: 'string', description: 'Path to the database file, relative to the configured SQLite folder' },
        },
        required: ['database'],
      },
    },
    {
      name: 'sqlite_describe_table',
      description: 'List the columns of a table (name, type, nullability, default, primary key) in a SQLite database file stored on the Redstart server.',
      inputSchema: {
        type: 'object',
        properties: {
          database: { type: 'string', description: 'Path to the database file, relative to the configured SQLite folder' },
          table: { type: 'string', description: 'Table name' },
        },
        required: ['database', 'table'],
      },
    },
  ]
}

// Provider interface: callTool(name, args, cfg, ctx). `ctx.account` is the
// authenticated caller (null when auth is off). Unused here — this capability
// is shared reference material and is the same for every account.
export async function callTool(name, args, cfg, _ctx) {
  if (!TOOL_NAMES.includes(name)) return null

  const sqliteCfg = cfg?.sqlite
  if (!sqliteCfg?.enabled || !sqliteCfg?.rootDir) {
    return { isError: true, content: [{ type: 'text', text: 'SQLite is not configured or enabled.' }] }
  }

  // Handled before openDatabase: discovery is the one tool that does NOT take a
  // database path, and routing it through the opener would demand the very
  // argument the model is calling this to find out.
  if (name === 'sqlite_list_databases') {
    try {
      return listDatabases(sqliteCfg)
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: `SQLite error: ${err.message}` }] }
    }
  }

  let db
  try {
    db = await openDatabase(sqliteCfg, args?.database)
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `SQLite error: ${err.message}` }] }
  }

  const maxRows = sqliteCfg.maxRows ?? 200
  try {
    if (name === 'sqlite_query') return runQuery(db, args?.sql, maxRows)
    if (name === 'sqlite_list_tables') return listTables(db)
    if (name === 'sqlite_describe_table') return describeTable(db, args?.table)
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `SQLite error: ${err.message}` }] }
  } finally {
    db.close() // frees the WASM heap copy; the on-disk file was never held open
  }
}
