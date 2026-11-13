'use strict'

// =============================================================================
// Redstart Nest — the canonical retrieval metadata for every tool
// =============================================================================
// Tool retrieval second pass, Phase 2. One shape for what retrieval knows about
// a tool beyond its name and description:
//
//   category  one of TOOL_CATEGORIES: what kind of work the tool does
//   store     where it acts, in words a model can tell apart: "the File
//             System folder" and "this chat's workspace" are different places
//             holding different files, and the descriptions alone did not
//             make that plain to an embedding (P3)
//   tags      synonyms a user or a small model would use ("config",
//             "spreadsheet"), which neither the name nor the description has
//   useWhen   one line: when this tool is the right one
//
// KEYED BY NAME, deliberately. The gateway sees the OpenAI tool list the client
// composed, which carries name, description and parameters and nothing else,
// so retrieval can only ever find a tool's metadata by its name. That also
// covers the File System tools, which come from the reference server and
// cannot carry Redstart's fields. A client that sends a tool under a built-in
// name gets that tool's metadata; retrieval is a selection over what survived
// the bans, never a boundary (tool-retrieval.mjs), so that can only change an
// order.
//
// Plugin tools: optional `retrieval` fields in the manifest (plugin-registry.mjs
// validatePlugin), read through setPluginMetadataProvider. MCP tools that
// declare nothing get a category from their namespace and no tags.
//
// Pure apart from the provider seam: no I/O, no electron.
// =============================================================================

/** The categories, in one list (the lint in test-tool-metadata.mjs). */
export const TOOL_CATEGORIES = Object.freeze([
  'documents',   // the documents library and the chat workspace's files
  'files',       // the File System folder
  'code',        // running code
  'data',        // databases
  'web',         // the public web
  'research',    // academic literature
  'notes',       // the markdown notes vault
  'git',         // git repositories
  'memory',      // what the assistant remembers about the user
  'interaction', // talking to the user, planning
  'discovery',   // finding other tools
  'other',       // an MCP or client tool that declared nothing
])

const CATEGORY_SET = new Set(TOOL_CATEGORIES)

/** Field limits, for plugin manifests (publisher text) and the lint. */
export const METADATA_LIMITS = Object.freeze({ tags: 12, tagChars: 32, useWhenChars: 200, storeChars: 80 })

const S = {
  fileSystem: 'the File System folder on the Redstart server',
  workspace: "this chat's workspace",
  documents: 'the documents library (and this chat\'s attached files)',
  postgres: 'the connected Postgres database',
  sqlite: 'SQLite database files on the Redstart server',
  vault: 'the markdown notes vault',
  git: 'git repositories on the Redstart server',
  web: 'the public web',
  literature: 'open academic literature',
  memory: "the user's saved memories",
  conversation: 'this conversation',
  tools: "this server's tool catalog",
}

const FS_READ_TAGS = ['file', 'open file', 'config', 'settings', 'source code', 'text file', 'log']

/**
 * Built-in tools. Keep the names in step with each provider's definitions; the
 * lint fails on a built-in tool with no entry here.
 *
 * @type {Readonly<Record<string, { category: string, store: string, tags: string[], useWhen: string }>>}
 */
export const BUILTIN_TOOL_METADATA = Object.freeze({
  // web
  web_fetch: { category: 'web', store: S.web, tags: ['url', 'link', 'web page', 'article', 'website', 'read page'], useWhen: 'the user gives a URL or a search result needs reading' },
  web_search: { category: 'web', store: S.web, tags: ['search', 'look up', 'news', 'latest', 'google', 'find online', 'wikipedia'], useWhen: 'the answer is on the web and there is no URL yet' },

  // documents
  create_document: { category: 'documents', store: S.documents, tags: ['write', 'save', 'report', 'docx', 'pdf', 'spreadsheet', 'export', 'csv'], useWhen: 'the user wants a file they can download' },
  read_document: { category: 'documents', store: S.documents, tags: ['attachment', 'attached file', 'uploaded file', 'pdf', 'docx', 'xlsx', 'csv', 'spreadsheet', 'open'], useWhen: 'reading a file the user attached or a document in the library' },
  list_documents: { category: 'documents', store: S.documents, tags: ['files', 'uploads', 'attachments', 'what documents'], useWhen: 'finding which documents exist' },
  search_documents: { category: 'documents', store: S.documents, tags: ['find in documents', 'policy', 'handbook', 'look up', 'which document says'], useWhen: 'a fact is somewhere in the user\'s own documents' },

  // the File System folder
  read_file: { category: 'files', store: S.fileSystem, tags: FS_READ_TAGS, useWhen: 'deprecated; read_text_file does the same' },
  read_text_file: { category: 'files', store: S.fileSystem, tags: FS_READ_TAGS, useWhen: 'reading a text file in the File System folder, not an attachment' },
  read_media_file: { category: 'files', store: S.fileSystem, tags: ['image', 'picture', 'photo', 'audio'], useWhen: 'an image or audio file in the File System folder' },
  read_multiple_files: { category: 'files', store: S.fileSystem, tags: FS_READ_TAGS, useWhen: 'reading several files in the File System folder at once' },
  write_file: { category: 'files', store: S.fileSystem, tags: ['save', 'create file', 'overwrite'], useWhen: 'writing a file in the File System folder' },
  edit_file: { category: 'files', store: S.fileSystem, tags: ['change', 'modify', 'replace', 'patch', 'config'], useWhen: 'changing part of a file in the File System folder' },
  create_directory: { category: 'files', store: S.fileSystem, tags: ['folder', 'mkdir', 'new folder'], useWhen: 'making a folder in the File System folder' },
  list_directory: { category: 'files', store: S.fileSystem, tags: ['folder', 'ls', 'what files'], useWhen: 'seeing what is in a folder of the File System folder' },
  list_directory_with_sizes: { category: 'files', store: S.fileSystem, tags: ['folder', 'size', 'disk usage', 'largest'], useWhen: 'file sizes in a folder of the File System folder' },
  directory_tree: { category: 'files', store: S.fileSystem, tags: ['folder', 'tree', 'structure', 'project layout'], useWhen: 'the shape of a whole folder tree' },
  move_file: { category: 'files', store: S.fileSystem, tags: ['rename', 'move', 'mv'], useWhen: 'renaming or moving within the File System folder' },
  search_files: { category: 'files', store: S.fileSystem, tags: ['find file', 'by name', 'locate', 'glob'], useWhen: 'finding a file in the File System folder by its name' },
  get_file_info: { category: 'files', store: S.fileSystem, tags: ['metadata', 'size', 'modified', 'stat'], useWhen: 'a file\'s size or dates' },
  list_allowed_directories: { category: 'files', store: S.fileSystem, tags: ['root', 'which folders'], useWhen: 'which folders the File System tools can reach' },
  delete_file: { category: 'files', store: S.fileSystem, tags: ['delete', 'remove', 'rm', 'recycle bin', 'trash'], useWhen: 'deleting a file in the File System folder' },

  // code
  run_python: { category: 'code', store: S.workspace, tags: ['python', 'calculate', 'compute', 'math', 'arithmetic', 'exact number', 'chart', 'plot', 'parse', 'csv', 'script', 'unzip'], useWhen: 'computing, transforming data or working on attached files' },

  // data
  postgres_query: { category: 'data', store: S.postgres, tags: ['sql', 'database', 'select', 'query'], useWhen: 'reading data from the Postgres database' },
  postgres_list_tables: { category: 'data', store: S.postgres, tags: ['sql', 'database', 'tables', 'schema'], useWhen: 'what tables the Postgres database has' },
  postgres_describe_table: { category: 'data', store: S.postgres, tags: ['sql', 'columns', 'schema'], useWhen: 'the columns of a Postgres table' },
  sqlite_list_databases: { category: 'data', store: S.sqlite, tags: ['sql', 'database', 'db file', 'sqlite'], useWhen: 'which SQLite databases exist' },
  sqlite_query: { category: 'data', store: S.sqlite, tags: ['sql', 'database', 'select', 'query', 'sqlite'], useWhen: 'reading data from a SQLite database' },
  sqlite_list_tables: { category: 'data', store: S.sqlite, tags: ['sql', 'tables', 'schema', 'sqlite'], useWhen: 'what tables a SQLite database has' },
  sqlite_describe_table: { category: 'data', store: S.sqlite, tags: ['sql', 'columns', 'schema', 'sqlite'], useWhen: 'the columns of a SQLite table' },

  // notes
  vault_search: { category: 'notes', store: S.vault, tags: ['notes', 'obsidian', 'markdown', 'my notes', 'journal'], useWhen: 'finding something in the user\'s notes' },
  vault_get: { category: 'notes', store: S.vault, tags: ['notes', 'note', 'obsidian', 'read note'], useWhen: 'reading one note' },
  vault_tags: { category: 'notes', store: S.vault, tags: ['notes', 'tags', 'obsidian'], useWhen: 'the tags in the notes vault' },

  // git
  git_list_repos: { category: 'git', store: S.git, tags: ['repo', 'repository', 'projects'], useWhen: 'which git repositories exist' },
  git_status: { category: 'git', store: S.git, tags: ['repo', 'uncommitted', 'modified', 'staged', 'working tree', 'changes'], useWhen: 'what is uncommitted in a repository' },
  git_log: { category: 'git', store: S.git, tags: ['repo', 'commits', 'history', 'recent changes', 'who changed'], useWhen: 'recent commits of a repository' },
  git_diff: { category: 'git', store: S.git, tags: ['repo', 'diff', 'changes', 'patch', 'uncommitted'], useWhen: 'the content of uncommitted changes' },

  // research
  scholar_search: { category: 'research', store: S.literature, tags: ['papers', 'academic', 'arxiv', 'study', 'citations', 'journal'], useWhen: 'finding papers' },
  scholar_get: { category: 'research', store: S.literature, tags: ['paper', 'abstract', 'doi', 'citation'], useWhen: 'one paper\'s abstract and details' },
  scholar_save_pdf: { category: 'research', store: S.literature, tags: ['paper', 'pdf', 'download'], useWhen: 'saving an open-access paper\'s PDF' },

  // memory
  memory_save: { category: 'memory', store: S.memory, tags: ['remember', 'note that', 'my preference', 'keep in mind'], useWhen: 'the user asks to remember something about them' },
  memory_search: { category: 'memory', store: S.memory, tags: ['remember', 'recall', 'what do you know about me'], useWhen: 'recalling what was saved about the user' },
  memory_forget: { category: 'memory', store: S.memory, tags: ['forget', 'delete memory', 'remove memory'], useWhen: 'the user asks to forget something' },

  // interaction and discovery
  ask_user: { category: 'interaction', store: S.conversation, tags: ['question', 'clarify', 'choose', 'preference'], useWhen: 'the answer would change what you produce' },
  update_plan: { category: 'interaction', store: S.conversation, tags: ['plan', 'checklist', 'steps', 'todo'], useWhen: 'a task with three or more steps' },
  search_tools: { category: 'discovery', store: S.tools, tags: ['find a tool', 'capability', 'can you'], useWhen: 'a needed tool is not in the list' },
})

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

/** @type {(name: string) => any} */
let readPluginMetadata = () => null

/**
 * plugin-registry.mjs hands this a lookup from a namespaced plugin tool name
 * to its manifest's validated `retrieval` fields. A function, as for
 * setPluginCapabilityProvider: installs take effect without a restart.
 *
 * @param {(name: string) => any} fn
 */
export function setPluginMetadataProvider(fn) {
  readPluginMetadata = typeof fn === 'function' ? fn : () => null
}

/**
 * Validate a manifest's optional `retrieval` block for one plugin tool.
 * Publisher text: anything malformed is dropped, field by field, rather than
 * failing the plugin; a category outside TOOL_CATEGORIES is dropped too.
 *
 * @param {any} raw
 * @returns {{ category?: string, tags?: string[], useWhen?: string } | null}
 */
export function sanitizeRetrievalMetadata(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  /** @type {{ category?: string, tags?: string[], useWhen?: string }} */
  const out = {}
  if (typeof raw.category === 'string' && CATEGORY_SET.has(raw.category)) out.category = raw.category
  if (Array.isArray(raw.tags)) {
    const tags = [...new Set(raw.tags
      .filter((t) => typeof t === 'string')
      .map((t) => oneLine(t).toLowerCase())
      .filter((t) => t && t.length <= METADATA_LIMITS.tagChars))].slice(0, METADATA_LIMITS.tags)
    if (tags.length) out.tags = tags
  }
  if (typeof raw.useWhen === 'string') {
    const line = oneLine(raw.useWhen).slice(0, METADATA_LIMITS.useWhenChars)
    if (line) out.useWhen = line
  }
  return Object.keys(out).length ? out : null
}

function oneLine(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/**
 * A tool's retrieval metadata, by name. Never null: a tool nobody described
 * gets category 'other' (or a category from its namespace), no store, no tags.
 *
 * @param {string} name
 * @returns {{ category: string, store: string, tags: string[], useWhen: string, declared: boolean }}
 */
export function toolMetadata(name) {
  const builtin = typeof name === 'string' ? BUILTIN_TOOL_METADATA[name] : undefined
  if (builtin && Object.prototype.hasOwnProperty.call(BUILTIN_TOOL_METADATA, name)) {
    return { ...builtin, tags: [...builtin.tags], declared: true }
  }
  let plugin = null
  try { plugin = readPluginMetadata(name) } catch { plugin = null }
  const fromPlugin = sanitizeRetrievalMetadata(plugin)
  return {
    category: fromPlugin?.category ?? namespaceCategory(name),
    store: '',
    tags: fromPlugin?.tags ?? [],
    useWhen: fromPlugin?.useWhen ?? '',
    declared: !!fromPlugin,
  }
}

/**
 * A category for a tool that declared none, from its name's namespace
 * (docs/tool-namespacing.md): a plugin's `<id>__tool` and a client app's
 * `fs_` both say where it came from, but not what it does, so this only
 * recognises the one client prefix whose meaning is fixed.
 *
 * @param {string} name
 */
function namespaceCategory(name) {
  if (typeof name === 'string' && name.startsWith('fs_')) return 'files'
  return 'other'
}

/**
 * The words a tool's metadata contributes to retrieval text, in one line:
 * category, store, tags and useWhen. Empty for a tool with nothing declared.
 *
 * @param {string} name
 */
export function metadataText(name) {
  const m = toolMetadata(name)
  const parts = []
  if (m.category !== 'other') parts.push(`category: ${m.category}`)
  if (m.store) parts.push(`acts on: ${m.store}`)
  if (m.tags.length) parts.push(`also: ${m.tags.join(', ')}`)
  if (m.useWhen) parts.push(`use when: ${m.useWhen}`)
  return parts.join('. ')
}
