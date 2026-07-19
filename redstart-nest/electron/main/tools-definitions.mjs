'use strict'

// Built-in tools and groups that ship with Redstart Nest.
// These are hardcoded — users add their own via the UI on top of these.

export const BUILTIN_TOOLS = [
  {
    id: 'wikipedia',
    name: 'Wikipedia',
    baseUrl: 'https://en.wikipedia.org',
    description: 'Free encyclopedia — broad general knowledge',
  },
  {
    id: 'github',
    name: 'GitHub',
    baseUrl: 'https://github.com',
    description: 'Code repositories and README documentation',
  },
  {
    id: 'ap_news',
    name: 'AP News',
    baseUrl: 'https://apnews.com',
    description: 'Associated Press newswire — factual breaking news',
  },
  {
    id: 'bbc',
    name: 'BBC News',
    baseUrl: 'https://www.bbc.com',
    description: 'BBC international news and reporting',
  },
  {
    id: 'reuters',
    name: 'Reuters',
    baseUrl: 'https://www.reuters.com',
    description: 'Reuters international newswire',
  },
  {
    id: 'mdn',
    name: 'MDN Web Docs',
    baseUrl: 'https://developer.mozilla.org',
    description: 'Mozilla web technology reference (HTML, CSS, JS, APIs)',
  },
  {
    id: 'stackoverflow',
    name: 'Stack Overflow',
    baseUrl: 'https://stackoverflow.com',
    description: 'Programming Q&A — code solutions and explanations',
  },
  {
    id: 'cornell_law',
    name: 'Cornell LII',
    baseUrl: 'https://www.law.cornell.edu',
    description: 'Cornell Legal Information Institute — US federal law',
  },
  {
    id: 'congress',
    name: 'Congress.gov',
    baseUrl: 'https://www.congress.gov',
    description: 'US legislation, bill text, and congressional records',
  },
  {
    id: 'arxiv',
    name: 'arXiv',
    baseUrl: 'https://arxiv.org',
    description: 'Scientific preprints — physics, CS, math, biology',
  },
  {
    id: 'pubmed',
    name: 'PubMed',
    baseUrl: 'https://pubmed.ncbi.nlm.nih.gov',
    description: 'Biomedical and life science literature',
  },
]

// Built-in capability providers — unlike BUILTIN_TOOLS these have no baseUrl
// (they aren't web whitelist entries); each needs one-time global setup
// (connection string / output folder) in the Tools window before a profile
// can activate it. See tools-storage.mjs getCapabilities/setCapabilityConfig.
export const BUILTIN_CAPABILITIES = [
  {
    id: 'postgres',
    name: 'Postgres',
    kind: 'capability',
    description: 'Read-only SQL access to a configured Postgres database — query, list tables, describe columns',
  },
  {
    id: 'documents',
    name: 'Documents',
    kind: 'capability',
    description: 'Create docx/pdf/markdown documents in a configured local folder, and read/summarize documents and spreadsheets (.pdf, .docx, .txt, .md, .xlsx, .csv) stored there',
  },
  {
    id: 'sqlite',
    name: 'SQLite',
    kind: 'capability',
    description: 'Read-only SQL access to local SQLite database files in a configured folder — query, list tables, describe columns',
  },
  {
    id: 'vault',
    name: 'Vault',
    kind: 'capability',
    description: 'Read-only access to a folder of markdown notes (Obsidian vault or any markdown folder) — search, read notes, browse tags',
  },
  {
    id: 'git',
    name: 'Git',
    kind: 'capability',
    description: 'Read-only repository context (status, recent commits, uncommitted diffs) from local git repositories in a configured folder',
  },
  {
    id: 'file_system',
    name: 'File System',
    kind: 'capability',
    description: 'Read and write files within a configured local folder — read configs, write scripts, edit project files, create documents. Paths are contained to the chosen root.',
  },
  {
    id: 'scholar',
    name: 'Scholar',
    kind: 'capability',
    description: 'Search open academic literature (OpenAlex, arXiv, PubMed) — abstracts, citations, and open-access PDFs saved into the Documents folder; optional journal/category whitelist',
  },
]

// Maps a capability/tool ID to the actual MCP tool function names it exposes.
// The gateway enforces tool bans by function name (that's what the model sees),
// so an admin banning a capability ID (e.g. 'file_system') must expand to every
// function name it produces (fs_read_file, fs_write_file, ...). Built-in web
// sources (web_fetch/web_search) are gated by the whitelist, not by name, so
// they're intentionally absent here.
export const CAPABILITY_TOOL_NAMES = {
  postgres: ['postgres_query', 'postgres_list_tables', 'postgres_describe_table'],
  documents: ['create_document', 'read_document', 'list_documents'],
  sqlite: ['sqlite_query', 'sqlite_list_tables', 'sqlite_describe_table'],
  vault: ['vault_search', 'vault_get', 'vault_tags'],
  git: ['git_status', 'git_log', 'git_diff'],
  file_system: [
    'fs_read_file',
    'fs_write_file',
    'fs_edit_file',
    'fs_list_directory',
    'fs_search_files',
    'fs_get_file_info',
    'fs_create_directory',
    'fs_delete_file',
  ],
  scholar: ['scholar_search', 'scholar_get', 'scholar_save_pdf'],
}

// Expand a list of banned capability/tool IDs into the concrete tool function
// names the gateway should strip. Unknown IDs are ignored (defensive against
// stale profiles referencing removed capabilities).
export function expandDisabledToolIds(ids = []) {
  const names = new Set()
  for (const id of ids) {
    const toolNames = CAPABILITY_TOOL_NAMES[id]
    if (toolNames) toolNames.forEach((n) => names.add(n))
  }
  return [...names]
}

// ---------------------------------------------------------------------------
// Tool classification — the permission model's foundation.
//
// Every built-in MCP tool is tagged by the kind of access it grants, so the
// server can apply per-class policy (e.g. block destructive ops unless the admin
// explicitly opts in). This is a static, exhaustive map keyed by the concrete
// function name the model calls:
//   read        — reads local data, no mutation, no network egress
//   write       — creates or modifies local files
//   destructive — deletes / irreversibly removes local data
//   network     — makes an outbound request (whitelist/SSRF-governed separately)
//
// New tools MUST be classified here; classifyTool() defaults an unknown name to
// 'read', which is intentionally the least-privileged bucket for the gate (it
// only ever *restricts* write/destructive), so a forgotten entry fails open on
// capability but never silently grants a destructive op a class it lacks.
// ---------------------------------------------------------------------------
export const TOOL_CLASS = {
  read: 'read',
  write: 'write',
  destructive: 'destructive',
  network: 'network',
}

export const TOOL_CLASSES = {
  // Web (egress governed by the whitelist/SSRF guard, tagged network here)
  web_fetch: 'network',
  web_search: 'network',
  // Postgres — read-only SQL (READ ONLY txn enforced by the DB)
  postgres_query: 'read',
  postgres_list_tables: 'read',
  postgres_describe_table: 'read',
  // Documents — create is a write; read/list are reads
  create_document: 'write',
  read_document: 'read',
  list_documents: 'read',
  // SQLite — read-only SQL
  sqlite_query: 'read',
  sqlite_list_tables: 'read',
  sqlite_describe_table: 'read',
  // Vault / Git — read-only local context
  vault_search: 'read',
  vault_get: 'read',
  vault_tags: 'read',
  git_status: 'read',
  git_log: 'read',
  git_diff: 'read',
  // File System — the one read/write/delete capability
  fs_read_file: 'read',
  fs_list_directory: 'read',
  fs_search_files: 'read',
  fs_get_file_info: 'read',
  fs_write_file: 'write',
  fs_edit_file: 'write',
  fs_create_directory: 'write',
  fs_delete_file: 'destructive',
  // Scholar — searches are network; saving a PDF writes to the Documents folder
  scholar_search: 'network',
  scholar_get: 'network',
  scholar_save_pdf: 'write',
}

// Classify a tool by its function name. Unknown names default to 'read' — see
// the note above TOOL_CLASSES for why that is the safe default for the gate.
export function classifyTool(name) {
  return TOOL_CLASSES[name] ?? 'read'
}

export const BUILTIN_GROUPS = [
  {
    id: 'general',
    name: 'General Knowledge',
    description: 'Wikipedia and AP News — good all-purpose default',
    toolIds: ['wikipedia', 'ap_news'],
  },
  {
    id: 'developer',
    name: 'Developer',
    description: 'GitHub repos, MDN Web Docs, and Stack Overflow',
    toolIds: ['github', 'mdn', 'stackoverflow'],
  },
  {
    id: 'news',
    name: 'News',
    description: 'AP News, BBC, and Reuters',
    toolIds: ['ap_news', 'bbc', 'reuters'],
  },
  {
    id: 'legal_us',
    name: 'Legal (US)',
    description: 'Cornell LII, Congress.gov, and Wikipedia',
    toolIds: ['cornell_law', 'congress', 'wikipedia'],
  },
  {
    id: 'research',
    name: 'Research',
    description: 'arXiv preprints, PubMed, and Wikipedia',
    toolIds: ['arxiv', 'pubmed', 'wikipedia'],
  },
]
