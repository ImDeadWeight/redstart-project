import { describe, expect, it, vi } from 'vitest';

// Images are scaled by a canvas helper in the browser; the shared port leaves
// that to its host. Identity here, so the two are compared on everything else.
vi.mock('$lib/utils/cap-img-size', () => ({
	capImageDataURLSize: async (url: string) => url
}));
vi.mock('$lib/stores/settings.svelte', () => ({
	settingsStore: { getConfig: () => 1024 },
	config: () => ({})
}));

const { convertDbMessageToApiChatMessageData } = await import('$lib/services/chat/chat-message-convert');
const { storedToApiMessage } = await import('../../../../../shared/agent-core/stored-messages.mjs');

/**
 * The daemon's task runner (agent-runtime Phase 3) rebuilds a conversation's
 * history from storage with shared/agent-core/stored-messages.mjs, a port of
 * chat-ui's converter. A task must see exactly what a chat sees, so every
 * kind of message and attachment is converted both ways here and must match.
 * A change to either side that is not made to the other fails this file.
 */

const base = { id: 'm1', convId: 'c1', timestamp: 0, parent: null, children: [], type: 'text' };

const CASES: Record<string, Record<string, unknown>> = {
	'plain user text': { role: 'user', content: 'hello' },
	'assistant with reasoning and tool calls': {
		role: 'assistant',
		content: 'checking',
		reasoningContent: 'think',
		toolCalls: JSON.stringify([{ id: 't1', type: 'function', function: { name: 'read_document', arguments: '{"path":"a"}' } }])
	},
	'assistant with an empty tool-call string': { role: 'assistant', content: 'done', toolCalls: '' },
	'assistant with malformed tool calls': { role: 'assistant', content: 'x', toolCalls: '{not json' },
	'tool result': { role: 'tool', content: 'result text', toolCallId: 't1' },
	'tool role without an id falls through': { role: 'tool', content: 'orphan' },
	'every attachment kind, in order': {
		role: 'user',
		content: 'see attached',
		extra: [
			{ type: 'MCP_RESOURCE', name: 'res', uri: 'u', serverName: 'srv', content: 'R' },
			{ type: 'MCP_PROMPT', name: 'wf', serverName: 'redstart-builtin', promptName: 'p', content: 'W' },
			{ type: 'MCP_PROMPT', name: 'other', serverName: 'ext', promptName: 'p', content: 'P' },
			{ type: 'PDF', name: 'a.pdf', base64Data: '', content: 'pdf text', processedAsImages: false },
			{ type: 'PDF', name: 'b.pdf', base64Data: '', content: '', processedAsImages: true, images: ['data:image/png;base64,AA', 'data:image/png;base64,BB'] },
			{ type: 'VIDEO', name: 'v', base64Data: 'VV', mimeType: 'video/mp4' },
			{ type: 'VIDEO', name: 'v2', base64Data: 'VV', mimeType: 'video/webm' },
			{ type: 'AUDIO', name: 'a', base64Data: 'AA', mimeType: 'audio/x-wav' },
			{ type: 'AUDIO', name: 'a2', base64Data: 'AA', mimeType: 'audio/mpeg' },
			{ type: 'IMAGE', name: 'i', base64Url: 'data:image/png;base64,II' },
			{ type: 'context', name: 'legacy', content: 'L' },
			{ type: 'TEXT', name: 'notes.txt', content: 'T' }
		]
	},
	'attachments with no message text': { role: 'user', content: '', extra: [{ type: 'TEXT', name: 'x.txt', content: 'only' }] },
	'assistant with reasoning and an attachment': {
		role: 'assistant',
		content: 'c',
		reasoningContent: 'r',
		extra: [{ type: 'TEXT', name: 'x', content: 'y' }]
	}
};

describe('stored-messages port matches convertDbMessageToApiChatMessageData', () => {
	for (const [name, fields] of Object.entries(CASES)) {
		it(name, async () => {
			const msg = { ...base, ...fields };
			const fromChatUi = await convertDbMessageToApiChatMessageData(msg as never);
			const fromCore = storedToApiMessage(msg);
			expect(JSON.parse(JSON.stringify(fromCore))).toEqual(JSON.parse(JSON.stringify(fromChatUi)));
		});
	}
});
