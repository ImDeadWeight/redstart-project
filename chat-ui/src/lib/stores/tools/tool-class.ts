/**
 * Tool class, and what it means for the permission prompt.
 *
 * Redstart Nest tags every tool it serves with a class — read / write /
 * destructive / network — and carries it on `tools/list` in
 * `_meta['redstart/class']`. Redstart Twig reports the same thing for its local
 * tools over its own IPC bridge, since those never travel over MCP.
 *
 * The rule this file exists for: **a destructive tool may never be granted
 * "always allow".**
 *
 * Without it, the permission prompt undoes the gate the server so carefully
 * built. `permissionsStore.hasTool(key)` short-circuits `requestPermission` to
 * ONCE and persists across sessions, so a single click on "Always allow" makes
 * every future deletion silent — and "Always allow all tools from this server"
 * grants it across the entire File System capability at once, from a menu item
 * whose label does not mention deletion at all. A user who wanted to stop being
 * asked about `read_text_file` would be consenting, invisibly and permanently,
 * to unattended deletion.
 *
 * Deletions are recoverable (recycle bin / .trash), which is what makes the
 * tool defensible — but recovery requires noticing, and the whole point of
 * "always allow" is to stop showing you things.
 *
 * Pure functions in a plain module so the rule is testable without standing up
 * the store graph, matching `stores/mcp/mcp-config` and `stores/tools/precedence`.
 */

export const TOOL_CLASS_DESTRUCTIVE = 'destructive';

/**
 * Whether a tool of this class may be remembered as "always allowed".
 *
 * Unknown/absent classes stay eligible: most tools carry no class (third-party
 * MCP servers, custom tools, the JS sandbox), and treating every unclassified
 * tool as destructive would make the prompt useless without making anything
 * safer. The class is only ever trusted from sources Redstart controls — see
 * `mcpStore.redstartMeta` for why that boundary matters.
 */
export function canAlwaysAllow(toolClass: string | null | undefined): boolean {
	return toolClass !== TOOL_CLASS_DESTRUCTIVE;
}

/** True when a tool irreversibly removes data and must prompt every time. */
export function isDestructiveClass(toolClass: string | null | undefined): boolean {
	return toolClass === TOOL_CLASS_DESTRUCTIVE;
}

/**
 * Filter a set of permission keys down to those that may be persisted.
 *
 * Used by the "always allow all tools from this server" path, which otherwise
 * sweeps a whole capability — including its delete tool — into the persisted
 * allow-list in one click.
 */
export function retainAlwaysAllowable<T>(
	entries: T[],
	classOf: (entry: T) => string | null | undefined
): T[] {
	return entries.filter((entry) => canAlwaysAllow(classOf(entry)));
}
