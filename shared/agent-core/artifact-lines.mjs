/**
 * agent-core/artifact-lines — the `[artifact: …]` line in a tool result.
 *
 * Every artifacts tool result that names an artifact ends with one line
 *
 *   [artifact: <id> r<revision>]     a sealed revision
 *   [artifact: <id> draft]           the caller's unsealed draft
 *
 * (artifacts plan §6). Hosts turn it into a card (chat-ui's transcript,
 * Yellowscript's chat), the memory-chip pattern, and collect the ids a turn
 * touched so they can seal them when it ends (POST /artifacts/:id/seal).
 *
 * The line is DATA from a tool result: a host shows a card for an id and asks
 * Nest about it, which answers only for artifacts the caller can read. A
 * forged line can at worst show a card for nothing.
 *
 * Pure: no I/O. Pinned by redstart-nest/scripts/test-artifacts-tool.mjs.
 */

/** @typedef {{ id: string, revision: number | 'draft' }} ArtifactRef */

const LINE = /^\[artifact: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) (r[1-9][0-9]{0,5}|r0|draft)\]$/gm

/**
 * @param {string} id
 * @param {number | 'draft'} revision
 */
export function formatArtifactLine(id, revision) {
	return `[artifact: ${id} ${revision === 'draft' ? 'draft' : `r${revision}`}]`;
}

/**
 * Every artifact line in a text, in order, one per id (the last wins).
 * @param {string} text
 * @returns {ArtifactRef[]}
 */
export function parseArtifactLines(text) {
	/** @type {Map<string, ArtifactRef>} */
	const found = new Map();
	if (typeof text !== 'string' || !text.includes('[artifact: ')) return [];
	for (const m of text.matchAll(LINE)) {
		found.delete(m[1]);
		found.set(m[1], { id: m[1], revision: m[2] === 'draft' ? 'draft' : Number(m[2].slice(1)) });
	}
	return [...found.values()];
}

/**
 * The text without its artifact lines, for a host that shows the card
 * instead of the line.
 * @param {string} text
 */
export function stripArtifactLines(text) {
	return typeof text === 'string' ? text.replace(LINE, '').replace(/\n{3,}/g, '\n\n').trimEnd() : text;
}
