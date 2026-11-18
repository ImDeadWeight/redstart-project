/**
 * tool-display — what a tool is CALLED versus what it is NAMED.
 *
 * Pure, and deliberately its own module rather than a helper inside
 * tools.svelte.ts: this is the one place that decides which string a person
 * reads, and the distinction it draws is a safety property, not a formatting
 * preference.
 *
 * The wire name is the identity. Redstart's gateway is provenance-blind — it
 * sees `tools[].function.name` and nothing else — so a server-side ban is a
 * flat name match across every source at once, and the namespace prefix
 * (`<pluginId>__tool`, `fs_*`, `ys_*`) is the only thing that makes a ban
 * targetable at all. See docs/tool-namespacing.md. Nothing here may change,
 * shorten, or normalise a name that is going to be sent, matched or banned.
 *
 * Everything here is display, and display alone.
 */

/** MCP's namespace separator for plugin tools. Double underscore; see the doc. */
const NAMESPACE_SEPARATOR = '__';

/**
 * The label to show for a tool.
 *
 * Order of preference:
 *   1. the server's own MCP `title`, when it published one — a publisher
 *      naming its tool for humans beats anything derived here;
 *   2. the wire name with its namespace prefix removed, but ONLY when the row
 *      already sits under a header naming the source, because the prefix is
 *      the only other thing that said where the tool came from;
 *   3. the wire name, unchanged.
 *
 * Not an identity. Two plugins may each expose a `search`, and after stripping
 * both rows read "search" — they stay distinct entries with distinct keys under
 * different headers, and both are still banned, called and matched by their
 * full names.
 */
export function toolDisplayName(
	name: string,
	title: string | undefined,
	hasSourceHeader: boolean
): string {
	if (title) return title;
	if (!hasSourceHeader) return name;
	const sep = name.indexOf(NAMESPACE_SEPARATOR);
	// `> 0`, not `>= 0`: a name that merely STARTS with the separator has no
	// namespace in front of it, and slicing it would leave a different tool's
	// name behind.
	if (sep <= 0) return name;
	const bare = name.slice(sep + NAMESPACE_SEPARATOR.length);
	// A prefix with nothing after it is not a namespace. Fall back rather than
	// render an empty row.
	return bare || name;
}
