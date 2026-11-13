/**
 * agent-core/attachment-note — the line that tells the model where the files
 * attached to a message were saved, and how each offered tool reaches them.
 *
 * chat-ui uploads a message's attachments to `chats/<conversationId>/` in the
 * caller's documents space (utils/workspace-upload.ts) and appends this note;
 * the agent bench appends the same note to a task with fixtures. One builder,
 * here, so the two cannot drift: the bench measures what a chat user gets.
 *
 * Why it names tools. The first version said only "saved to the Python
 * workspace (run_python's working directory)". In the 2026-11-11 baseline both
 * models then went looking with the File System tools, which work on a
 * different folder that never holds attachments, or called read_document with
 * the bare name, which then needed `chats/<id>/<name>` (read_document has
 * since learned to look in the conversation's workspace). About 45 of the 35B's 57
 * tool errors were that, and it cost the 4B docs-rename and multi-chain. So
 * the note now says, for each tool family that is OFFERED, how it reaches the
 * files, and says outright that the File System tools cannot. Tools that are
 * not offered are not named: a small model calls what it is told about.
 */

// The File System capability's tool names (the reference filesystem MCP
// server Nest wraps). Listed so the note can name the offered ones.
export const FILE_SYSTEM_TOOLS = [
	'read_text_file',
	'read_file',
	'list_directory',
	'move_file',
	'write_file',
	'search_files',
	'directory_tree',
	'get_file_info',
	'edit_file',
	'read_multiple_files',
	'list_directory_with_sizes',
	'create_directory',
	'read_media_file'
];

/**
 * How each block of the note opens. Exported so tool retrieval can leave the
 * note out of its query (tool-retrieval.mjs conversationQueryText): the note
 * names tools, and on attachment prompts it pulled the File System tools up
 * the ranking it then told the model not to use (tool retrieval second pass,
 * 1.2, P3). Built from the same strings attachmentNote() writes, so the two
 * cannot drift apart.
 */
export const ATTACHMENT_NOTE_MARKERS = Object.freeze([
	"[Attached file saved to this chat's workspace:",
	"[Attached files saved to this chat's workspace:",
	"[Could not save to this chat's workspace:"
]);

/**
 * A message's text without the attachment note chat-ui appended to it. Only a
 * note that runs to the end of the text, starting on a line of its own, is
 * removed: that is where chat-ui and the bench put it, and anything else is
 * the user's own words.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripAttachmentNote(text) {
	if (typeof text !== 'string' || !text.includes('[')) return text;
	let cut = -1;
	for (const marker of ATTACHMENT_NOTE_MARKERS) {
		let at = text.indexOf(marker);
		while (at >= 0) {
			if ((at === 0 || text[at - 1] === '\n') && (cut < 0 || at < cut)) {
				if (text.trimEnd().endsWith(']')) cut = at;
				break;
			}
			at = text.indexOf(marker, at + 1);
		}
	}
	return cut < 0 ? text : text.slice(0, cut).trimEnd();
}

/**
 * @param {{
 *   saved: string[],
 *   failed?: string[],
 *   conversationId: string,
 *   hasTool: (name: string) => boolean
 * }} params `saved`: workspace-relative paths that were saved; `failed`:
 *   "name (reason)" for each upload that failed
 * @returns {string | null} the text to append to the user's message, or null
 *   when there is nothing to say
 */
export function attachmentNote({ saved, failed = [], conversationId, hasTool }) {
	/** @type {string[]} */
	const parts = [];
	if (saved.length > 0) {
		const plural = saved.length > 1;
		const first = saved[0];
		const lines = [`${ATTACHMENT_NOTE_MARKERS[plural ? 1 : 0]} ${saved.join(', ')}`];
		if (hasTool('run_python')) {
			lines.push(
				// The explicit "not chats/..." is for small models: shown the
				// read_document path below, Qwen3-4B copied it into run_python
				// (agent bench, 2026-11-11).
				`- run_python runs in that folder: open ${plural ? 'them' : 'it'} by name, e.g. open(${JSON.stringify(first)}), not open(${JSON.stringify(`chats/${conversationId}/${first}`)}). To rename, move or delete ${plural ? 'them' : 'it'}, use run_python (os.rename, os.remove).`
			);
		}
		if (hasTool('read_document')) {
			// By name alone: read_document looks in the conversation's
			// workspace when the documents folder has no such path. Until
			// 2026-11-11 this line gave the full "chats/<id>/<name>" path;
			// both bench models called it with the bare name anyway.
			lines.push(`- read_document opens ${plural ? 'them' : 'it'} by name too: read_document(${JSON.stringify(first)}).`);
		}
		const fsOffered = FILE_SYSTEM_TOOLS.filter((t) => hasTool(t));
		if (fsOffered.length > 0) {
			const named = fsOffered.slice(0, 3).join(', ');
			lines.push(`- The File System tools (${named}${fsOffered.length > 3 ? ', ...' : ''}) work on a different folder and cannot see ${plural ? 'these files' : 'this file'}.`);
		}
		parts.push(`${lines.join('\n')}]`);
	}
	if (failed.length > 0) parts.push(`${ATTACHMENT_NOTE_MARKERS[2]} ${failed.join('; ')}]`);
	return parts.length > 0 ? parts.join('\n') : null;
}
