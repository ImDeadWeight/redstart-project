/**
 * agent-core/teaching — refusals that say what to do instead.
 *
 * A small model in a tool environment often falls back on habits from
 * training: it calls `read_file` because most agent harnesses have one, starts
 * `bash` because coding agents can, or hands a tool's name to use_skill. The
 * agent bench counts these (scripts/agent-bench/lib/misuse.mjs). A model that
 * is sure of itself won't look anything up beforehand, but it does read the
 * error that comes back. So the error is where the correction goes.
 *
 * THE PATTERN. A refusal the model is meant to recover from says three things,
 * in this order, in plain words:
 *
 *   1. What happened, and that nothing ran ("there is no tool named X here,
 *      so nothing was run"). Without the second half a model may report work
 *      that never happened.
 *   2. What is true here, when it differs from what the model assumed ("the
 *      sandbox cannot start other programs").
 *   3. The call to make instead, by its real name: one this caller actually
 *      has. A remedy the caller lacks is a false claim, worse than none (see
 *      system-prompt.mjs on search_tools' two wordings).
 *
 * Keep it short. The text goes into the context on every retry.
 * DENIED_RESULT and overLimitResult (tool-calls.mjs) were already written
 * this way. This module has the cross-tool cases. Tool-specific ones (Python's
 * hints, read_document's unsupported types) stay with their tools.
 *
 * Pure: no I/O. Pinned by redstart-nest/scripts/test-agent-core.mjs.
 */

/**
 * Tool names a model brings from training, and the Redstart tools that do the
 * job, best first. Only the ones the caller has are offered. `note` is said
 * whichever tool is offered, for when the job itself works differently here.
 *
 * Keys are compared after normalizeToolName (lowercase, separators removed),
 * so "readFile", "read-file" and "Read_File" are one key.
 *
 * @type {Record<string, { tools: string[], job: string, note?: string }>}
 */
const TRAINED = (() => {
  /** @type {Array<[string[], { tools: string[], job: string, note?: string }]>} */
  const groups = [
    [
      [
        "read_file",
        "read",
        "cat",
        "open_file",
        "file_read",
        "view_file",
        "read_multiple_files",
        "read_files",
        "get_file_contents",
        "readfile",
      ],
      { tools: ["read_document", "read_text_file"], job: "read a file" },
    ],
    [
      [
        "write_file",
        "create_file",
        "save_file",
        "write_to_file",
        "file_write",
        "write",
        "new_file",
      ],
      { tools: ["write_file", "create_document"], job: "write a file" },
    ],
    [
      [
        "edit_file",
        "str_replace",
        "str_replace_editor",
        "str_replace_based_edit_tool",
        "apply_patch",
        "replace_in_file",
        "patch",
      ],
      { tools: ["edit_file"], job: "change a file" },
    ],
    [
      [
        "list_files",
        "ls",
        "list_dir",
        "list_directory",
        "directory_tree",
        "list_directory_with_sizes",
        "glob",
        "find_files",
      ],
      { tools: ["list_documents", "list_directory"], job: "list files" },
    ],
    [
      [
        "grep",
        "search_files",
        "find",
        "file_search",
        "search_in_files",
        "codebase_search",
        "search_code",
      ],
      {
        tools: ["search_documents", "search_files"],
        job: "search inside files",
      },
    ],
    [
      [
        "python",
        "execute_python",
        "run_code",
        "execute_code",
        "code_interpreter",
        "ipython",
        "exec",
        "python_repl",
        "jupyter",
      ],
      { tools: ["run_python"], job: "run code" },
    ],
    [
      [
        "bash",
        "shell",
        "sh",
        "run_shell",
        "execute_command",
        "run_command",
        "exec_command",
        "terminal",
        "run_terminal_cmd",
        "cmd",
        "powershell",
        "computer",
      ],
      {
        tools: ["run_python"],
        job: "run a command",
        note: "There is no shell here, and run_python cannot start other programs either, so write the work itself in Python.",
      },
    ],
    [
      [
        "search",
        "google_search",
        "bing_search",
        "search_web",
        "web_search_tool",
        "internet_search",
        "brave_search",
        "duckduckgo_search",
        "browser_search",
      ],
      { tools: ["web_search"], job: "search the web" },
    ],
    [
      [
        "browse",
        "browser",
        "open_url",
        "fetch",
        "fetch_url",
        "http_get",
        "get_url",
        "visit",
        "open_page",
        "read_url",
        "web_browser",
        "curl",
        "wget",
      ],
      { tools: ["web_fetch"], job: "read a web page" },
    ],
    [
      [
        "remember",
        "save_memory",
        "add_memory",
        "memory_add",
        "store_memory",
        "memory_create",
        "create_memory",
      ],
      { tools: ["memory_save"], job: "remember something" },
    ],
    [
      [
        "recall",
        "search_memory",
        "memory_get",
        "get_memory",
        "memory_recall",
        "retrieve_memory",
      ],
      { tools: ["memory_search"], job: "look up a memory" },
    ],
    [
      [
        "ask",
        "ask_human",
        "ask_question",
        "ask_followup_question",
        "request_user_input",
        "human",
        "clarify",
        "ask_the_user",
      ],
      { tools: ["ask_user"], job: "ask the user" },
    ],
    [
      [
        "todo",
        "todo_write",
        "todowrite",
        "create_plan",
        "plan",
        "set_plan",
        "update_todos",
        "task_list",
      ],
      { tools: ["update_plan"], job: "keep a plan" },
    ],
    [
      [
        "image_gen",
        "create_image",
        "dalle",
        "dall_e",
        "text_to_image",
        "image_generation",
        "draw",
        "generate_picture",
      ],
      { tools: ["generate_image"], job: "make a picture" },
    ],
    [
      [
        "sql",
        "query",
        "execute_sql",
        "run_sql",
        "sql_query",
        "database_query",
        "query_database",
      ],
      { tools: ["sqlite_query", "postgres_query"], job: "query a database" },
    ],
    [
      ["git", "git_show", "git_blame", "git_history"],
      {
        tools: ["git_log", "git_diff", "git_status"],
        job: "look at a repository",
      },
    ],
    [
      [
        "skill",
        "load_skill",
        "run_skill",
        "skills",
        "run_workflow",
        "workflow",
      ],
      { tools: ["use_skill"], job: "use a saved skill" },
    ],
  ];
  /** @type {Record<string, { tools: string[], job: string, note?: string }>} */
  const map = {};
  for (const [names, entry] of groups)
    for (const n of names) map[normalizeToolName(n)] = entry;
  return map;
})();

/** Namespaces a model puts in front of a tool's name: "functions.read_document", "default_api:x". */
const PREFIX_RE =
  /^(?:functions|function|tools|tool|default_api|api|mcp)[.:/]+/i;

const GENERIC_WORDS = new Set([
  "file",
  "files",
  "text",
  "data",
  "tool",
  "tools",
  "info",
  "list",
  "item",
  "items",
  "name",
  "path",
  "make",
  "create",
  "delete",
  "remove",
  "update",
]);

/**
 * Lowercase with separators removed, so spellings of one name compare equal.
 * @param {string} name
 */
export function normalizeToolName(name) {
  return String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Edit distance, capped: anything past `cap` returns cap + 1.
 * @param {string} a @param {string} b @param {number} cap
 */
function distance(a, b, cap) {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      if (cur[j] < best) best = cur[j];
    }
    if (best > cap) return cap + 1;
    prev = cur;
  }
  return prev[b.length];
}

/**
 * The tools the caller has that the model most likely meant, best first, and
 * why. Exported for the suite.
 *
 * @param {string} name what the model called
 * @param {Iterable<string>} available every tool name this caller may call
 * @returns {{ kind: 'prefixed' | 'trained' | 'similar' | 'none', tools: string[], job?: string, note?: string }}
 */
export function suggestTools(name, available) {
  const have = [
    ...new Set(
      [...(available ?? [])].filter((n) => typeof n === "string" && n),
    ),
  ];
  const raw = String(name ?? "").trim();

  // "functions.read_document": the right tool behind a namespace.
  const bare = raw.replace(PREFIX_RE, "");
  if (bare !== raw) {
    const exact =
      have.find((n) => n === bare) ??
      have.find((n) => normalizeToolName(n) === normalizeToolName(bare));
    if (exact) return { kind: "prefixed", tools: [exact] };
  }
  // "Read_Document", "read-document": a spelling of a real name.
  const key = normalizeToolName(bare);
  const spelled = have.find((n) => normalizeToolName(n) === key);
  if (spelled) return { kind: "prefixed", tools: [spelled] };

  const trained = TRAINED[key];
  if (trained) {
    const tools = trained.tools.filter((t) => have.includes(t));
    if (tools.length > 0)
      return { kind: "trained", tools, job: trained.job, note: trained.note };
  }

  // A near-miss: "read_documents", "web_serach", or a name sharing a word.
  const cap = Math.max(1, Math.floor(key.length / 4));
  // Words too common to mean anything: "move_file" shares "file" with
  // delete_file, and suggesting a delete for a move would be worse than
  // saying nothing.
  const words = new Set(
    bare
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4 && !GENERIC_WORDS.has(w)),
  );
  const scored = have
    .filter((n) => n !== "call_tool" && n !== "search_tools")
    .map((n) => {
      const d = distance(key, normalizeToolName(n), cap);
      const shared = n
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => words.has(w)).length;
      return { n, d, shared };
    })
    .filter((s) => s.d <= cap || s.shared > 0)
    .sort((a, b) => a.d - b.d || b.shared - a.shared || a.n.localeCompare(b.n));
  if (scored.length > 0)
    return { kind: "similar", tools: scored.slice(0, 3).map((s) => s.n) };

  return { kind: "none", tools: [] };
}

/** @param {string[]} names */
function orList(names) {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;
}

/** How many of the caller's tools a last-resort answer lists by name. */
const LIST_LIMIT = 15;

/**
 * The result text for a call to a tool that does not exist here.
 *
 * @param {string} name what the model called
 * @param {Iterable<string>} available every tool name this caller may call
 */
export function unknownToolText(name, available) {
  const shown = String(name ?? "").slice(0, 80) || "(no name)";
  const have = [
    ...new Set(
      [...(available ?? [])].filter((n) => typeof n === "string" && n),
    ),
  ];
  const head = `Error: there is no tool named "${shown}" here, so nothing was run.`;
  const s = suggestTools(name, have);

  if (s.kind === "prefixed")
    return `${head} Call it by its plain name: ${s.tools[0]}.`;
  if (s.kind === "trained") {
    const which =
      s.tools.length === 1 ? `use ${s.tools[0]}` : `use ${orList(s.tools)}`;
    return [head, `To ${s.job} here, ${which}.`, s.note]
      .filter(Boolean)
      .join(" ");
  }
  if (s.kind === "similar") return `${head} Did you mean ${orList(s.tools)}?`;

  if (have.includes("search_tools")) {
    return `${head} If a tool for this exists, search_tools finds it; otherwise use one of the tools you were given.`;
  }
  if (have.length === 0)
    return `${head} No tools are available in this chat, so answer without one.`;
  const list = have.slice(0, LIST_LIMIT).join(", ");
  return `${head} The tools you have: ${list}${have.length > LIST_LIMIT ? ", and others in your tool list" : ""}.`;
}
