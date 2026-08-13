import { describe, expect, it, vi } from 'vitest';

// The image branch caps resolution through a setting and a canvas helper.
// Neither exists in node, and neither is what this file is testing.
vi.mock('$lib/utils/cap-img-size', () => ({
	capImageDataURLSize: async (url: string) => `capped:${url}`
}));
vi.mock('$lib/stores/settings.svelte', () => ({
	settingsStore: { getConfig: () => 1024 },
	config: () => ({})
}));

const { convertDbMessageToApiChatMessageData, stripReasoningContent } = await import(
	'$lib/services/chat/chat-message-convert'
);
const { AttachmentType, ContentPartType, MessageRole } = await import('$lib/enums');

/**
 * chat-message-convert - the DB -> API message transform
 *
 * §9 of the god-file plan lists this module by name: extracted in seam 3b and
 * still untested, "no excuse once it is its own module." This is that debt.
 *
 * It is the last thing every message passes through before it reaches the
 * model, so its failure mode is quiet — an attachment silently missing from the
 * payload looks exactly like a model that ignored it.
 */

function message(overrides: Record<string, unknown> = {}) {
	return {
		id: 'm1',
		convId: 'c1',
		timestamp: 0,
		role: MessageRole.USER,
		content: '',
		...overrides
	} as never;
}

describe('messages with no attachments', () => {
	it('passes role and content straight through', async () => {
		const result = await convertDbMessageToApiChatMessageData(
			message({ content: 'hello there' })
		);

		expect(result).toEqual({ role: MessageRole.USER, content: 'hello there' });
	});

	it('carries reasoning content when present', async () => {
		const result = await convertDbMessageToApiChatMessageData(
			message({ content: 'answer', reasoningContent: 'thinking out loud' })
		);

		expect(result.reasoning_content).toBe('thinking out loud');
	});

	it('omits reasoning_content entirely when absent', async () => {
		const result = await convertDbMessageToApiChatMessageData(message({ content: 'answer' }));

		expect('reasoning_content' in result).toBe(false);
	});
});

describe('tool messages', () => {
	// A tool result takes an early return: it must carry tool_call_id and must
	// NOT be rebuilt into content parts, whatever else is on the record.
	it('short-circuits to a tool_call_id payload', async () => {
		const result = await convertDbMessageToApiChatMessageData(
			message({
				role: MessageRole.TOOL,
				content: 'tool output',
				toolCallId: 'call_7',
				extra: [{ type: AttachmentType.TEXT, name: 'ignored.txt', content: 'ignored' }]
			})
		);

		expect(result).toEqual({
			role: MessageRole.TOOL,
			content: 'tool output',
			tool_call_id: 'call_7'
		});
	});
});

describe('assistant tool calls', () => {
	it('parses the stored JSON onto tool_calls', async () => {
		const calls = [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }];
		const result = await convertDbMessageToApiChatMessageData(
			message({ role: MessageRole.ASSISTANT, content: '', toolCalls: JSON.stringify(calls) })
		);

		expect(result.tool_calls).toEqual(calls);
	});

	// Malformed JSON is swallowed on purpose. The alternative — throwing — would
	// make one corrupt row block the whole conversation from being sent.
	it('drops malformed tool calls rather than throwing', async () => {
		const result = await convertDbMessageToApiChatMessageData(
			message({ role: MessageRole.ASSISTANT, content: 'text', toolCalls: '{not json' })
		);

		expect('tool_calls' in result).toBe(false);
		expect(result.content).toBe('text');
	});

	it('omits tool_calls when the parsed array is empty', async () => {
		const result = await convertDbMessageToApiChatMessageData(
			message({ role: MessageRole.ASSISTANT, content: 'text', toolCalls: '[]' })
		);

		expect('tool_calls' in result).toBe(false);
	});
});

describe('attachments become content parts', () => {
	function partsOf(result: { content: unknown }) {
		return result.content as { type: string; text?: string }[];
	}

	it('renders a text file as a labelled text part', async () => {
		const result = await convertDbMessageToApiChatMessageData(
			message({
				content: '',
				extra: [{ type: AttachmentType.TEXT, name: 'notes.txt', content: 'body text' }]
			})
		);

		const parts = partsOf(result);
		expect(parts).toHaveLength(1);
		expect(parts[0].type).toBe(ContentPartType.TEXT);
		expect(parts[0].text).toContain('notes.txt');
		expect(parts[0].text).toContain('body text');
	});

	it('caps an image through the resolution setting', async () => {
		const result = await convertDbMessageToApiChatMessageData(
			message({
				content: '',
				extra: [{ type: AttachmentType.IMAGE, name: 'p.png', base64Url: 'data:image/png;base64,AA' }]
			})
		);

		expect(partsOf(result)[0]).toEqual({
			type: ContentPartType.IMAGE_URL,
			image_url: { url: 'capped:data:image/png;base64,AA' }
		});
	});

	it('maps an audio mime type to an input format', async () => {
		const result = await convertDbMessageToApiChatMessageData(
			message({
				content: '',
				extra: [
					{
						type: AttachmentType.AUDIO,
						name: 'clip.mp3',
						base64Data: 'AAAA',
						mimeType: 'audio/mpeg'
					}
				]
			})
		);

		const audio = partsOf(result)[0] as unknown as {
			type: string;
			input_audio: { data: string; format: string };
		};
		expect(audio.type).toBe(ContentPartType.INPUT_AUDIO);
		expect(audio.input_audio.data).toBe('AAAA');
		expect(audio.input_audio.format).toBeTruthy();
	});

	it('labels MCP prompt and resource extras with their server', async () => {
		const result = await convertDbMessageToApiChatMessageData(
			message({
				content: '',
				extra: [
					{
						type: AttachmentType.MCP_PROMPT,
						name: 'review',
						content: 'prompt body',
						serverName: 'srv-a'
					},
					{
						type: AttachmentType.MCP_RESOURCE,
						name: 'file://x',
						content: 'resource body',
						serverName: 'srv-b'
					}
				]
			})
		);

		const texts = partsOf(result).map((p) => p.text ?? '');
		expect(texts.some((t) => t.includes('srv-a') && t.includes('prompt body'))).toBe(true);
		expect(texts.some((t) => t.includes('srv-b') && t.includes('resource body'))).toBe(true);
	});

	// Ordering is load-bearing and easy to break: the user's own text is placed
	// *after* text/image/audio attachments but *before* video, PDF and MCP
	// extras. Anything that reads the payload positionally depends on it.
	it('places the user text between the two attachment groups', async () => {
		const result = await convertDbMessageToApiChatMessageData(
			message({
				content: 'my question',
				extra: [
					{ type: AttachmentType.TEXT, name: 'a.txt', content: 'first' },
					{
						type: AttachmentType.MCP_RESOURCE,
						name: 'r',
						content: 'last',
						serverName: 's'
					}
				]
			})
		);

		const texts = partsOf(result).map((p) => p.text ?? '');
		const attachmentIdx = texts.findIndex((t) => t.includes('first'));
		const contentIdx = texts.findIndex((t) => t === 'my question');
		const mcpIdx = texts.findIndex((t) => t.includes('last'));

		expect(attachmentIdx).toBeLessThan(contentIdx);
		expect(contentIdx).toBeLessThan(mcpIdx);
	});

	it('keeps reasoning and tool calls alongside content parts', async () => {
		const calls = [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }];
		const result = await convertDbMessageToApiChatMessageData(
			message({
				role: MessageRole.ASSISTANT,
				content: 'text',
				reasoningContent: 'why',
				toolCalls: JSON.stringify(calls),
				extra: [{ type: AttachmentType.TEXT, name: 'a.txt', content: 'body' }]
			})
		);

		expect(Array.isArray(result.content)).toBe(true);
		expect(result.reasoning_content).toBe('why');
		expect(result.tool_calls).toEqual(calls);
	});

	// An empty `extra` array is not the same as attachments: it must take the
	// plain-string path, or every message would become a content-part array.
	it('treats an empty extra array as no attachments', async () => {
		const result = await convertDbMessageToApiChatMessageData(
			message({ content: 'plain', extra: [] })
		);

		expect(result.content).toBe('plain');
	});
});

describe('stripReasoningContent', () => {
	// The legacy agentic marker, not a model's <think> tag — see
	// LEGACY_AGENTIC_REGEX.REASONING_BLOCK in constants/agentic.ts.
	const wrapped =
		'<<<reasoning_content_start>>>hidden<<<reasoning_content_end>>>visible answer';

	it('removes a legacy reasoning block from a string', () => {
		expect(stripReasoningContent(wrapped)).toBe('visible answer');
	});

	it('leaves ordinary text untouched', () => {
		expect(stripReasoningContent('nothing to strip')).toBe('nothing to strip');
	});

	it('strips inside text parts and leaves other parts alone', () => {
		const parts = [
			{ type: ContentPartType.TEXT, text: wrapped },
			{ type: ContentPartType.IMAGE_URL, image_url: { url: 'data:image/png;base64,AA' } }
		];

		const result = stripReasoningContent(parts as never) as typeof parts;

		expect((result[0] as { text: string }).text).toBe('visible answer');
		expect(result[1]).toEqual(parts[1]);
	});

	it('does not mutate the parts it was given', () => {
		const parts = [{ type: ContentPartType.TEXT, text: wrapped }];

		stripReasoningContent(parts as never);

		expect(parts[0].text).toBe(wrapped);
	});
});
