'use strict'

// ---------------------------------------------------------------------------
// Plugin capability injection.
//
// Installed MCP plugins are capabilities too, but they are discovered at
// runtime from plugins.json, not
// declared here. plugin-registry.mjs calls setPluginCapabilityProvider() once at
// startup to hand this module a live read of that registry.
//
// A FUNCTION, not a snapshot: installs and removals must take effect without
// restarting Nest, and several consumers of the tables below used to capture
// them at import time.
// ---------------------------------------------------------------------------

// Returns { [pluginId]: { toolNames: string[], classes: { [toolName]: string } } }
let readPluginCapabilities = () => ({})

export function setPluginCapabilityProvider(fn) {
  readPluginCapabilities = typeof fn === 'function' ? fn : () => ({})
}

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
// function name it produces (read_text_file, write_file, ...). Built-in web
// sources (web_fetch/web_search) are gated by the whitelist, not by name, so
// they're intentionally absent here.
export const BUILTIN_CAPABILITY_TOOL_NAMES = {
  postgres: ['postgres_query', 'postgres_list_tables', 'postgres_describe_table'],
  documents: ['create_document', 'read_document', 'list_documents'],
  sqlite: ['sqlite_list_databases', 'sqlite_query', 'sqlite_list_tables', 'sqlite_describe_table'],
  vault: ['vault_search', 'vault_get', 'vault_tags'],
  git: ['git_list_repos', 'git_status', 'git_log', 'git_diff'],
  // Served by @modelcontextprotocol/server-filesystem (see
  // filesystem-mcp-provider.mjs). Keep in sync with FILESYSTEM_TOOL_NAMES there.
  file_system: [
    'read_file',
    'read_text_file',
    'read_media_file',
    'read_multiple_files',
    'write_file',
    'edit_file',
    'create_directory',
    'list_directory',
    'list_directory_with_sizes',
    'directory_tree',
    'move_file',
    'search_files',
    'get_file_info',
    'list_allowed_directories',
    // Redstart-owned, NOT from the upstream server (which has no delete at all)
    // — served by fs-delete-tool.mjs. Listed here so an admin ban on
    // `file_system` strips it too, and so the permission gate's FS_TOOL_NAMES
    // (derived from this array) governs it.
    'delete_file',
  ],
  scholar: ['scholar_search', 'scholar_get', 'scholar_save_pdf'],
}

/**
 * Every capability's tool names — built-ins plus installed plugins.
 *
 * Call this; do not destructure it into a module-scope const. A const goes
 * stale the moment a plugin is installed, and the failure is silent: the
 * capability simply never gets narrowed or banned.
 */
export function capabilityToolNames() {
  const out = { ...BUILTIN_CAPABILITY_TOOL_NAMES }
  for (const [id, entry] of Object.entries(readPluginCapabilities())) {
    out[id] = entry.toolNames
  }
  return out
}

// Back-compat alias for call sites that only need the built-ins (the file-system
// policy set in mcp-server.mjs). Plugins are deliberately absent here.
export const CAPABILITY_TOOL_NAMES = BUILTIN_CAPABILITY_TOOL_NAMES

// Tools contributed by Redstart CLIENT APPLICATIONS — Twig today; Blueprints,
// Greenhouse and Yellowscript as they grow tools.
//
// These are the set tool bans actually exist for. A client app embeds its own
// tools and hands them to the model already inside POST /v1/chat/completions,
// so Nest has no provider-level control over them the way it does over its own
// capabilities (where simply not activating the capability means the tools are
// never served at all). The gateway's name-strip is the only lever Nest has.
//
// Registered here so an admin can ban an app's whole tool set by naming the app,
// exactly as `file_system` expands to the capability's tools. Every name must
// carry its app prefix and must not collide with a Nest tool name — see
// docs/tool-namespacing.md, enforced by scripts/test-tool-namespacing.mjs.
export const CLIENT_APPS = [
  {
    id: 'twig',
    name: 'Redstart Twig — local file tools',
    // Said plainly because this is the one tool set in the system that acts on
    // a machine the server does not control and cannot police.
    description: 'Read, write and delete files on the user\'s own PC, in a folder they granted inside Twig. These run on that machine, not on this server, so no server-side policy applies to them — banning is the only control.',
    toolNames: [
      'fs_read_file',
      'fs_write_file',
      'fs_edit_file',
      'fs_list_directory',
      'fs_search_files',
      'fs_get_file_info',
      'fs_create_directory',
      'fs_delete_file',
    ],
  },
]

export const CLIENT_APP_TOOL_NAMES = Object.fromEntries(
  CLIENT_APPS.map((app) => [app.id, app.toolNames]),
)

// Expand a list of banned IDs into the concrete tool function names the gateway
// should strip. An ID resolves in three steps:
//
//   1. a Nest capability     ('file_system' -> its 14 tool names)
//   2. a client app          ('twig'        -> its 8 fs_* names)
//   3. otherwise, a LITERAL tool function name, passed straight through
//
// Step 3 matters: the gateway bans by function name, and the things most worth
// banning are individual client-app tools that Nest has no other control over.
// Dropping unknown IDs — the old behaviour — meant putting `fs_delete_file` in
// disabledToolIds expanded to nothing at all, silently, so the mechanism built
// to moderate client apps could not name a single client-app tool.
//
// The trade-off is that a typo'd capability id ('file_sistem') now becomes a
// ban on a tool nobody has, instead of being ignored. That is inert — banning a
// name no tool uses strips nothing — and it fails safe in the direction of
// restriction rather than permission.
export function expandDisabledToolIds(ids = []) {
  const names = new Set()
  for (const id of ids) {
    if (typeof id !== 'string' || !id) continue
    const toolNames = capabilityToolNames()[id] ?? CLIENT_APP_TOOL_NAMES[id]
    if (toolNames) toolNames.forEach((n) => names.add(n))
    else names.add(id)
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
  // Retrieval's own tool. It reads a catalog of names and descriptions the
  // policy gate has already filtered, touches nothing, and leaves the machine
  // it runs on alone — 'read' is the honest class, stated rather than defaulted.
  search_tools: 'read',
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
  sqlite_list_databases: 'read',
  sqlite_query: 'read',
  sqlite_list_tables: 'read',
  sqlite_describe_table: 'read',
  // Vault / Git — read-only local context
  vault_search: 'read',
  vault_get: 'read',
  vault_tags: 'read',
  git_list_repos: 'read',
  git_status: 'read',
  git_log: 'read',
  git_diff: 'read',
  // File System — @modelcontextprotocol/server-filesystem. Reads are read;
  // create/overwrite/edit/move are writes. The upstream server exposes no
  // delete tool, so deletion is Redstart-owned (fs-delete-tool.mjs) and is the
  // one 'destructive'-class tool in the system — which is what makes the
  // allowDestructive policy load-bearing. move_file removes its source but
  // cannot overwrite an existing destination (upstream fails the op), so it's a
  // write, not destructive.
  read_file: 'read',
  read_text_file: 'read',
  read_media_file: 'read',
  read_multiple_files: 'read',
  list_directory: 'read',
  list_directory_with_sizes: 'read',
  directory_tree: 'read',
  search_files: 'read',
  get_file_info: 'read',
  list_allowed_directories: 'read',
  write_file: 'write',
  edit_file: 'write',
  create_directory: 'write',
  move_file: 'write',
  // The only destructive-class tool in Redstart. THIS LINE is what activates
  // the allowDestructive gate: evaluateToolPolicy refuses a destructive call
  // unless the admin has explicitly enabled it, at both tools/list and
  // tools/call. Deletion is recoverable (recycle bin / .trash) — see
  // fs-delete-tool.mjs.
  delete_file: 'destructive',
  // Scholar — searches are network; saving a PDF writes to the Documents folder
  scholar_search: 'network',
  scholar_get: 'network',
  scholar_save_pdf: 'write',
}

// Classify a tool by its function name. Unknown names default to 'read' — see
// the note above TOOL_CLASSES for why that is the safe default for the gate.
export function classifyTool(name) {
  const builtin = TOOL_CLASSES[name]
  if (builtin) return builtin
  // Plugin tools carry an admin-assigned class from the registry. Looked up
  // BEFORE the fallback below, which stays exactly as it was: 'read' is the
  // correct default for a BUILT-IN whose entry someone forgot, because the gate
  // only ever restricts. Plugins fail closed at install time instead — every
  // discovered tool is written as 'destructive' until an admin promotes it.
  const capability = capabilityForTool(name)
  if (capability) {
    const cls = readPluginCapabilities()[capability]?.classes?.[name]
    if (cls) return cls
  }
  return TOOL_CLASSES[name] ?? 'read'
}

// ---------------------------------------------------------------------------
// Tool provenance — which capability produced a given tool.
//
// The gateway is provenance-blind by construction: it sees a flat list of
// function names in the completions payload with nothing saying which app or
// server contributed each one. Every control built on it is therefore name-
// based, and any safety property expressed as "these names win over those
// names" survives exactly until someone renames a tool.
//
// That is not hypothetical. Nest's File System capability used to use fs_*
// names, the same as Twig's local tools, and the chat-ui relied on the
// resulting name collision to shadow the remote tools with the local ones. The
// FS MCP migration renamed Nest's side to the upstream names; the collision
// disappeared, the shadowing silently stopped happening, and the model was left
// holding two complete filesystem APIs pointing at two different computers.
//
// So provenance travels as DATA on tools/list (see mcp-server.mjs), keyed on
// capability identity rather than spelling, and this map is where identity is
// resolved. Renaming a tool now breaks a lookup loudly instead of dissolving a
// safety property quietly.
// ---------------------------------------------------------------------------

// Namespaced _meta keys on tools/list entries. MCP treats _meta as an
// implementation-defined channel, so a prefix keeps these from colliding with
// another server's fields.
export const META_CAPABILITY_KEY = 'redstart/capability'
export const META_CLASS_KEY = 'redstart/class'
// A HUMAN LABEL for where a tool came from — "ComfyUI", not "comfyui_mcp".
// Display only, and deliberately separate from META_CAPABILITY_KEY, which is
// the id every policy decision keys on. A label is allowed to be ambiguous or
// to change; an identity is not, and merging them would put a publisher's
// display string on the path that resolves bans.
export const META_SOURCE_KEY = 'redstart/source'

const BUILTIN_CAPABILITY_BY_TOOL_NAME = new Map()
for (const [capability, names] of Object.entries(BUILTIN_CAPABILITY_TOOL_NAMES)) {
  for (const name of names) BUILTIN_CAPABILITY_BY_TOOL_NAME.set(name, capability)
}

/**
 * The capability id that produced a tool, or null for tools that belong to no
 * capability (the web tools, which the whitelist governs instead).
 */
export function capabilityForTool(name) {
  const builtin = BUILTIN_CAPABILITY_BY_TOOL_NAME.get(name)
  if (builtin) return builtin
  // Plugin tools are namespaced "<pluginId>__<toolName>" (see T5). Resolving by
  // prefix rather than by a rebuilt Map means an install takes effect
  // immediately and there is no cache to invalidate.
  if (typeof name === 'string') {
    const sep = name.indexOf('__')
    if (sep > 0) {
      const id = name.slice(0, sep)
      if (readPluginCapabilities()[id]) return id
    }
  }
  return null
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
