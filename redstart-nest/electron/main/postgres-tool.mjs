'use strict'

// =============================================================================
// Redstart Nest — MCP Provider: Postgres
// =============================================================================
// Talks directly to a Postgres database the admin configures (normally
// localhost or a LAN box) — no child process, no third-party MCP server.
// Every query runs inside a READ ONLY transaction so Postgres itself rejects
// any write/DDL statement; this is defense in depth, not a substitute for
// connecting with an actually-read-only DB role. Config shape (cfg.postgres):
// { enabled, connectionString, maxRows } — already resolved (admin config AND
// profile activation both true) by buildGatewayConfig in index.mjs.
// =============================================================================

import pg from 'pg'

const TOOL_NAMES = ['postgres_query', 'postgres_list_tables', 'postgres_describe_table']
const MAX_OUTPUT_CHARS = 8000
const STATEMENT_TIMEOUT_MS = 10000

let pool = null
let poolConnectionString = null

function ensurePool(connectionString) {
  if (pool && poolConnectionString === connectionString) return pool
  if (pool) pool.end().catch(() => {})

  pool = new pg.Pool({
    connectionString,
    max: 4,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 8000,
    statement_timeout: STATEMENT_TIMEOUT_MS,
  })
  pool.on('error', err => console.warn('Postgres pool error:', err.message))
  poolConnectionString = connectionString
  return pool
}

export function closePool() {
  if (pool) {
    pool.end().catch(() => {})
    pool = null
    poolConnectionString = null
  }
}

export async function testConnection(connectionString) {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 5000, statement_timeout: 5000 })
  try {
    await client.connect()
    await client.query('SELECT 1')
    return { ok: true, message: 'Connected successfully.' }
  } catch (err) {
    return { ok: false, message: err.message }
  } finally {
    await client.end().catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

function stringifyCell(value) {
  if (value === null || value === undefined) return 'NULL'
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function formatRows(result, maxRows) {
  const rows = result.rows || []
  if (rows.length === 0) return `Query OK. ${result.rowCount ?? 0} row(s) affected, no data returned.`

  const shown = rows.slice(0, maxRows)
  const columns = Object.keys(shown[0])
  const lines = [columns.join(' | '), ...shown.map(row => columns.map(c => stringifyCell(row[c])).join(' | '))]
  let text = lines.join('\n')

  if (text.length > MAX_OUTPUT_CHARS) {
    text = text.slice(0, MAX_OUTPUT_CHARS) + '\n\n[Output truncated]'
  }
  if (rows.length > maxRows) {
    text += `\n\n[Showing first ${maxRows} of ${rows.length} rows]`
  }
  return text
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async function runReadOnlyQuery(pool, sql, maxRows) {
  if (!sql || typeof sql !== 'string') {
    return { isError: true, content: [{ type: 'text', text: 'Missing required argument: sql' }] }
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN TRANSACTION READ ONLY')
    try {
      const result = await client.query(sql)
      await client.query('ROLLBACK')
      return { content: [{ type: 'text', text: formatRows(result, maxRows) }] }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    }
  } finally {
    client.release()
  }
}

async function listTables(pool) {
  const result = await pool.query(
    `SELECT table_schema, table_name FROM information_schema.tables
     WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
     ORDER BY table_schema, table_name`
  )
  if (result.rows.length === 0) return { content: [{ type: 'text', text: 'No tables found.' }] }
  const text = result.rows.map(r => `${r.table_schema}.${r.table_name}`).join('\n')
  return { content: [{ type: 'text', text }] }
}

async function describeTable(pool, table) {
  if (!table || typeof table !== 'string') {
    return { isError: true, content: [{ type: 'text', text: 'Missing required argument: table' }] }
  }

  let schema = 'public'
  let tableName = table
  if (table.includes('.')) {
    ;[schema, tableName] = table.split('.', 2)
  }

  const result = await pool.query(
    `SELECT column_name, data_type, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2
     ORDER BY ordinal_position`,
    [schema, tableName]
  )
  if (result.rows.length === 0) {
    return { isError: true, content: [{ type: 'text', text: `Table not found: ${schema}.${tableName}` }] }
  }

  const lines = result.rows.map(r =>
    `${r.column_name} — ${r.data_type}${r.is_nullable === 'NO' ? ' NOT NULL' : ''}${r.column_default ? ` DEFAULT ${r.column_default}` : ''}`
  )
  return { content: [{ type: 'text', text: lines.join('\n') }] }
}

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

export function toolDefs(cfg) {
  if (!cfg?.postgres?.enabled) return []
  return [
    {
      name: 'postgres_query',
      description: 'Run a read-only SQL query against the connected Postgres database. Runs inside a READ ONLY transaction — write/DDL statements are rejected by the database.',
      inputSchema: {
        type: 'object',
        properties: { sql: { type: 'string', description: 'The SQL query to run' } },
        required: ['sql'],
      },
    },
    {
      name: 'postgres_list_tables',
      description: 'List all tables in the connected Postgres database, grouped by schema.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'postgres_describe_table',
      description: 'List the columns of a table (name, type, nullability, default) in the connected Postgres database.',
      inputSchema: {
        type: 'object',
        properties: { table: { type: 'string', description: 'Table name, optionally schema-qualified (e.g. "public.users" or "users")' } },
        required: ['table'],
      },
    },
  ]
}

export async function callTool(name, args, cfg) {
  if (!TOOL_NAMES.includes(name)) return null

  const pgCfg = cfg?.postgres
  if (!pgCfg?.enabled || !pgCfg?.connectionString) {
    return { isError: true, content: [{ type: 'text', text: 'Postgres is not configured or enabled.' }] }
  }

  let activePool
  try {
    activePool = ensurePool(pgCfg.connectionString)
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `Postgres connection error: ${err.message}` }] }
  }

  const maxRows = pgCfg.maxRows ?? 200

  try {
    if (name === 'postgres_query') return await runReadOnlyQuery(activePool, args?.sql, maxRows)
    if (name === 'postgres_list_tables') return await listTables(activePool)
    if (name === 'postgres_describe_table') return await describeTable(activePool, args?.table)
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `Postgres error: ${err.message}` }] }
  }
}
