/**
 * agent-core/stored-messages — a stored conversation as the model receives it.
 *
 * chat-ui keeps a conversation as a tree of DatabaseMessage records and turns
 * the current branch into an API request (chat-message-convert.ts,
 * convertDbMessageToApiChatMessageData; chat.service.ts, the request body).
 * The daemon's task runner (Phase 3) resumes a conversation from storage, so
 * it needs the same transform, and a task must see the history a chat sees.
 *
 * These are ports of chat-ui's code, and chat-ui's unit test
 * stored-messages-parity.test.ts holds them to identical output for every
 * kind of message and attachment, so the two cannot drift silently.
 *
 * What a host does that this does not: chat-ui scales images down to its
 * max-resolution setting (a canvas, browser-only) and drops image parts for
 * a model without vision. Options cover the second; the first is the host's.
 *
 * Plain ESM, no Node or DOM built-ins.
 */

import { wireSafeToolCalls } from './tool-calls.mjs';

/** chat-ui constants/attachment-labels.ts and mcp.ts. */
export const ATTACHMENT_LABEL_PDF_FILE = 'PDF File';
export const ATTACHMENT_LABEL_MCP_PROMPT = 'MCP Prompt';
export const ATTACHMENT_LABEL_WORKFLOW = 'Workflow';
export const ATTACHMENT_LABEL_MCP_RESOURCE = 'MCP Resource';
export const NEST_MCP_SERVER_ID_PREFIX = 'redstart-';

/**
 * chat-ui utils/formatters.ts formatAttachmentText.
 *
 * @param {string} label
 * @param {string} name
 * @param {string} content
 * @param {string} [extra]
 */
export function formatAttachmentText(label, name, content, extra) {
	const header = extra ? `${name} (${extra})` : name;
	return `\n\n--- ${label}: ${header} ---\n${content}`;
}

/**
 * The current branch, root first: currNode, then each parent.
 *
 * @param {{ messages?: any[], currNode?: string | null } | null | undefined} conversation
 * @returns {any[]}
 */
export function currentBranch(conversation) {
	const messages = Array.isArray(conversation?.messages) ? conversation.messages : [];
	const byId = new Map(messages.map((m) => [m.id, m]));
	const path = [];
	const seen = new Set();
	let node = byId.get(conversation?.currNode);
	while (node && !seen.has(node.id)) {
		seen.add(node.id);
		path.push(node);
		node = node.parent ? byId.get(node.parent) : null;
	}
	return path.reverse();
}

/** @param {unknown} mimeType */
function audioFormat(mimeType) {
	const m = String(mimeType ?? '').trim().toLowerCase();
	return ['audio/wav', 'audio/wave', 'audio/x-wav', 'audio/x-wave', 'audio/vnd.wave', 'audio/x-pn-wav'].includes(m)
		? 'wav'
		: 'mp3';
}

/**
 * One stored message as an API message (convertDbMessageToApiChatMessageData).
 * Attachments become content parts in chat-ui's order: text files, legacy
 * context, images, audio, the message text, video, PDFs, MCP prompts, MCP
 * resources.
 *
 * @param {any} message a DatabaseMessage
 * @returns {any} an ApiChatMessageData
 */
export function storedToApiMessage(message) {
	if (message.role === 'tool' && message.toolCallId) {
		return { role: 'tool', content: message.content, tool_call_id: message.toolCallId };
	}

	let toolCalls;
	if (message.toolCalls) {
		try {
			toolCalls = JSON.parse(message.toolCalls);
		} catch {
			// as chat-ui: a malformed stored list is dropped
		}
	}

	const extra = Array.isArray(message.extra) ? message.extra : [];
	if (extra.length === 0) {
		/** @type {any} */
		const result = { role: message.role, content: message.content };
		if (message.reasoningContent) result.reasoning_content = message.reasoningContent;
		if (toolCalls && toolCalls.length > 0) result.tool_calls = toolCalls;
		return result;
	}

	/** @type {any[]} */
	const parts = [];
	/** @param {string} t @returns {any[]} */
	const ofType = (t) => extra.filter((/** @type {any} */ e) => e?.type === t);
	for (const f of ofType('TEXT')) parts.push({ type: 'text', text: formatAttachmentText('File', f.name, f.content) });
	for (const f of ofType('context')) parts.push({ type: 'text', text: formatAttachmentText('File', f.name, f.content) });
	for (const img of ofType('IMAGE')) parts.push({ type: 'image_url', image_url: { url: img.base64Url } });
	for (const a of ofType('AUDIO')) parts.push({ type: 'input_audio', input_audio: { data: a.base64Data, format: audioFormat(a.mimeType) } });
	if (message.content) parts.push({ type: 'text', text: message.content });
	for (const v of ofType('VIDEO')) {
		const mt = String(v.mimeType ?? '');
		parts.push({ type: 'input_video', input_video: { data: v.base64Data, format: mt.includes('mp4') ? 'mp4' : mt.includes('ogg') ? 'ogg' : 'auto' } });
	}
	for (const pdf of ofType('PDF')) {
		if (pdf.processedAsImages && pdf.images) {
			for (const url of pdf.images) parts.push({ type: 'image_url', image_url: { url } });
		} else {
			parts.push({ type: 'text', text: formatAttachmentText(ATTACHMENT_LABEL_PDF_FILE, pdf.name, pdf.content) });
		}
	}
	for (const p of ofType('MCP_PROMPT')) {
		const isWorkflow = p.serverName?.startsWith(NEST_MCP_SERVER_ID_PREFIX) === true;
		parts.push({
			type: 'text',
			text: formatAttachmentText(isWorkflow ? ATTACHMENT_LABEL_WORKFLOW : ATTACHMENT_LABEL_MCP_PROMPT, p.name, p.content, isWorkflow ? undefined : p.serverName)
		});
	}
	for (const r of ofType('MCP_RESOURCE')) {
		parts.push({ type: 'text', text: formatAttachmentText(ATTACHMENT_LABEL_MCP_RESOURCE, r.name, r.content, r.serverName) });
	}

	/** @type {any} */
	const result = { role: message.role, content: parts };
	if (message.reasoningContent) result.reasoning_content = message.reasoningContent;
	if (toolCalls && toolCalls.length > 0) result.tool_calls = toolCalls;
	return result;
}

/**
 * A branch as the request's `messages` (ChatService.sendMessage): converted,
 * empty system messages dropped, image parts dropped for a model without
 * vision (a lone text part then becomes a string), malformed earlier calls
 * made wire-safe, reasoning sent back unless excluded. The root record
 * (type 'root') is never sent.
 *
 * @param {any[]} branch DatabaseMessages, root first
 * @param {{ vision?: boolean, excludeReasoning?: boolean }} [opts]
 */
export function branchToWire(branch, { vision = true, excludeReasoning = false } = {}) {
	/** @type {any[]} */
	const out = [];
	for (const stored of branch) {
		if (stored?.type === 'root') continue;
		const msg = storedToApiMessage(stored);
		if (msg.role === 'system') {
			const text = typeof msg.content === 'string' ? msg.content : '';
			if (text.trim().length === 0) continue;
		}
		if (!vision && Array.isArray(msg.content)) {
			msg.content = msg.content.filter((/** @type {any} */ p) => p.type !== 'image_url');
			if (msg.content.length === 1 && msg.content[0].type === 'text' && typeof msg.content[0].text === 'string') {
				msg.content = msg.content[0].text;
			}
		}
		/** @type {any} */
		const mapped = { role: msg.role, content: msg.content, tool_calls: wireSafeToolCalls(msg.tool_calls), tool_call_id: msg.tool_call_id };
		if (!excludeReasoning && msg.reasoning_content) mapped.reasoning_content = msg.reasoning_content;
		out.push(mapped);
	}
	return out;
}
