/**
 * Filesystem precedence — which of two filesystems the model is offered.
 *
 * Redstart Twig grants a folder on the USER'S OWN machine and executes its
 * `fs_*` tools there. Redstart Nest's File System capability acts on the
 * SERVER, under an admin-configured root inside which every call is resolved
 * into the caller's own folder (`user-scope.mjs` on the server). When both are
 * live the model holds two complete filesystem APIs pointing at two different
 * computers, and nothing in either tool's name or schema distinguishes them —
 * so "save this to notes.md" resolves to whichever the model happens to pick.
 *
 * Which machine, not which account, is what this module decides. The scoping is
 * noted only because the older wording here called the server root "a single
 * folder shared by every account" — true of the capability root the MCP child
 * is spawned at, and not of the folder any call actually reaches.
 *
 * The old defence was accidental. Nest's file tools were once ALSO named
 * `fs_*`, so pushing the local ones first let a name-collision dedupe shadow
 * the remote ones. The FS MCP migration renamed Nest's side to the upstream
 * names (`read_file`, `write_file`, …); the collision vanished, the shadowing
 * stopped, and nothing failed — no error, no test, no log line. The model was
 * simply handed all 22 tools.
 *
 * Hence: keyed on capability IDENTITY, resolved from what the server actually
 * advertises on `tools/list` (`_meta['redstart/capability']`), never on
 * spelling. A rename on either side now flows through instead of silently
 * dissolving the rule.
 *
 * Kept as pure functions in a plain module — separate from the rune-based store
 * — so the rule can be tested without standing up the whole store graph. Same
 * split as `stores/mcp/mcp-config`.
 */

/**
 * The one capability Twig has a local equivalent for.
 *
 * Deliberately narrow. Documents, Vault, Git, SQLite, Postgres and Scholar have
 * no Twig counterpart and must stay server-side — `create_document` in
 * particular still writes on the server and returns its `[FILE:]` marker for
 * download, which is correct and should stay that way.
 */
export const LOCAL_OVERRIDDEN_CAPABILITY = 'file_system';

/**
 * Decide which server-side tool names to hide because this device provides its
 * own local equivalents.
 *
 * @param localToolCount     how many local (Twig) filesystem tools are present
 * @param capabilityToolNames tool names the Nest `file_system` capability is
 *                            currently advertising
 */
export function suppressedServerToolNames(
	localToolCount: number,
	capabilityToolNames: Iterable<string>
): Set<string> {
	// No local filesystem -> nothing to suppress, and the server-side capability
	// is the only filesystem there is. This is the fallback half of the rule:
	// without a granted folder, Nest's tools work exactly as they always have
	// and files come back as downloads.
	if (localToolCount <= 0) return new Set();
	return new Set(capabilityToolNames);
}
