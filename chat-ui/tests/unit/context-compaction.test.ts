import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseMessage } from '$lib/types/database';

// ---------------------------------------------------------------------------
// Module mocks — the service touches the server store (n_ctx), settings,
// the DB (summary persistence), and ChatService (the summarizer call).
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
	contextSize: 1000 as number | null,
	config: {} as Record<string, unknown>,
	storedConversation: undefined as
		| { id: string; contextSummary?: { text: string; upToMessageId: string } }
		| undefined,
	updateConversation: vi.fn(),
	sendMessage: vi.fn()
}));

vi.mock('$lib/stores/server.svelte', () => ({
	serverStore: {
		get contextSize() {
			return mocks.contextSize;
		}
	}
}));
vi.mock('$lib/stores/settings.svelte', () => ({ config: () => mocks.config }));
vi.mock('$lib/services/database.service', () => ({
	DatabaseService: {
		getConversation: vi.fn(async () => mocks.storedConversation),
		updateConversation: mocks.updateConversation
	}
}));
vi.mock('$lib/services/chat.service', () => ({
	ChatService: { sendMessage: mocks.sendMessage }
}));
vi.mock('$lib/utils/api-fetch', () => ({ resolveApiPath: (p: string) => p }));
vi.mock('$lib/utils/api-headers', () => ({ getJsonHeaders: () => ({}) }));

import { ContextCompactionService } from '$lib/services/context-compaction.service';
import { MessageRole } from '$lib/enums';

// /tokenize is fetched with the concatenated text; token count ≈ chars / 4
// keeps the numbers in the tests easy to reason about.
function stubTokenize() {
	vi.stubGlobal(
		'fetch',
		vi.fn(async (_url: string, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as { content: string };
			return {
				ok: true,
				json: async () => ({ tokens: new Array(Math.ceil(body.content.length / 4)).fill(1) })
			} as unknown as Response;
		})
	);
}

let nextId = 0;
function msg(role: MessageRole, content: string): DatabaseMessage {
	return {
		id: `m${++nextId}`,
		convId: 'conv-1',
		role,
		content,
		timestamp: nextId,
		parent: '',
		children: [],
		type: 'text'
	} as unknown as DatabaseMessage;
}

// Re-measure a payload through the service's own counting path, so budget
// assertions can't drift from how the code actually counts.
async function tokensOf(messages: DatabaseMessage[]): Promise<number> {
	const usage = await ContextCompactionService.estimateUsage('conv-1', messages);
	return usage!.usedTokens;
}

// n_ctx minus DEFAULT_RESERVE_TOKENS — the budget a send has to fit into.
function usableTokens(): number {
	return (mocks.contextSize ?? 0) - 1024;
}

describe('ContextCompactionService.maybeCompact', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.unstubAllGlobals();
		stubTokenize();
		nextId = 0;
		mocks.contextSize = 4096;
		mocks.config = {};
		mocks.storedConversation = undefined;
		mocks.sendMessage.mockResolvedValue('SUMMARY OF OLD TURNS');
	});

	it('passes small conversations through untouched', async () => {
		const messages = [msg(MessageRole.USER, 'hi'), msg(MessageRole.ASSISTANT, 'hello')];
		const result = await ContextCompactionService.maybeCompact('conv-1', messages);
		expect(result.compacted).toBe(false);
		expect(result.messages).toBe(messages);
		expect(mocks.sendMessage).not.toHaveBeenCalled();
	});

	it('passes through when n_ctx is unknown', async () => {
		mocks.contextSize = null;
		const messages = [msg(MessageRole.USER, 'x'.repeat(100000))];
		const result = await ContextCompactionService.maybeCompact('conv-1', messages);
		expect(result.compacted).toBe(false);
	});

	it('respects the settings toggle', async () => {
		mocks.config = { contextCompaction: false };
		const messages = Array.from({ length: 20 }, () => msg(MessageRole.USER, 'y'.repeat(2000)));
		const result = await ContextCompactionService.maybeCompact('conv-1', messages);
		expect(result.compacted).toBe(false);
	});

	it('compacts an oversized history into summary + recent tail', async () => {
		const system = msg(MessageRole.SYSTEM, 'You are a helpful assistant.');
		const old = Array.from({ length: 10 }, (_, i) =>
			msg(i % 2 ? MessageRole.ASSISTANT : MessageRole.USER, `old turn ${i} ` + 'x'.repeat(1600))
		);
		const recent = [msg(MessageRole.USER, 'latest question')];
		const result = await ContextCompactionService.maybeCompact('conv-1', [
			system,
			...old,
			...recent
		]);

		expect(result.compacted).toBe(true);
		// Leading system prompt survives verbatim at position 0.
		expect(result.messages[0]).toBe(system);
		// Summary rides as a synthetic system message right after it.
		expect(result.messages[1].role).toBe(MessageRole.SYSTEM);
		expect(String(result.messages[1].content)).toContain('SUMMARY OF OLD TURNS');
		// The latest user turn is preserved verbatim at the end.
		expect(result.messages[result.messages.length - 1].content).toBe('latest question');
		// The rewritten payload is smaller than the input.
		expect(result.messages.length).toBeLessThan(2 + old.length + recent.length);
		// The summary was persisted with a coverage boundary.
		expect(mocks.updateConversation).toHaveBeenCalledWith(
			'conv-1',
			expect.objectContaining({
				contextSummary: expect.objectContaining({ text: 'SUMMARY OF OLD TURNS' })
			})
		);
	});

	it('reuses a stored summary progressively when its boundary is on this branch', async () => {
		const old = Array.from({ length: 10 }, (_, i) =>
			msg(i % 2 ? MessageRole.ASSISTANT : MessageRole.USER, `old turn ${i} ` + 'x'.repeat(1600))
		);
		mocks.storedConversation = {
			id: 'conv-1',
			contextSummary: { text: 'EARLIER SUMMARY', upToMessageId: old[4].id }
		};
		await ContextCompactionService.maybeCompact('conv-1', [
			...old,
			msg(MessageRole.USER, 'latest')
		]);

		// The summarizer prompt must seed with the stored summary...
		const prompt = String(mocks.sendMessage.mock.calls[0][0][0].content);
		expect(prompt).toContain('EARLIER SUMMARY');
		// ...and only fold in turns AFTER the stored boundary (old[4]).
		expect(prompt).not.toContain('old turn 2');
		expect(prompt).toContain('old turn 6');
	});

	it('discards a stored summary from another branch', async () => {
		const old = Array.from({ length: 10 }, (_, i) =>
			msg(i % 2 ? MessageRole.ASSISTANT : MessageRole.USER, `old turn ${i} ` + 'x'.repeat(1600))
		);
		mocks.storedConversation = {
			id: 'conv-1',
			contextSummary: { text: 'OTHER BRANCH SUMMARY', upToMessageId: 'not-in-this-branch' }
		};
		await ContextCompactionService.maybeCompact('conv-1', [
			...old,
			msg(MessageRole.USER, 'latest')
		]);

		const prompt = String(mocks.sendMessage.mock.calls[0][0][0].content);
		expect(prompt).not.toContain('OTHER BRANCH SUMMARY');
		expect(prompt).toContain('(none)');
	});

	it('never blocks a send on summarizer failure — falls back to truncation, not the raw original', async () => {
		mocks.sendMessage.mockRejectedValue(new Error('model busy'));
		const messages = Array.from({ length: 20 }, () => msg(MessageRole.USER, 'z'.repeat(2000)));
		const result = await ContextCompactionService.maybeCompact('conv-1', messages);

		// Deliberately NOT the original array: resending an oversized payload is
		// the guaranteed-400 dead end this service exists to prevent.
		expect(result.messages).not.toBe(messages);
		expect(result.messages.length).toBeLessThan(messages.length);
		expect(result.compacted).toBe(true);
		// No summary was produced, so none may be persisted.
		expect(mocks.updateConversation).not.toHaveBeenCalled();
		// The truncated payload fits the budget it failed to summarize into.
		expect(await tokensOf(result.messages)).toBeLessThan(usableTokens());
	});

	it('elides a single oversized recent message instead of sending it whole', async () => {
		// One message that alone exceeds the whole usable budget, sitting in the
		// always-keep tail where compaction has nothing older to trade away.
		const messages = [
			msg(MessageRole.USER, 'read the file'),
			msg(MessageRole.TOOL, 'FILE HEAD ' + 'q'.repeat(60000) + ' FILE TAIL')
		];
		const result = await ContextCompactionService.maybeCompact('conv-1', messages);

		// Message count is unchanged — the turn is elided, not dropped.
		expect(result.messages).toHaveLength(2);
		const elided = String(result.messages[1].content);
		expect(elided).toContain('truncated');
		// Head and tail both survive; the middle is what goes.
		expect(elided).toContain('FILE HEAD');
		expect(elided).toContain('FILE TAIL');
		expect(await tokensOf(result.messages)).toBeLessThan(usableTokens());
	});

	it('caps an oversized message even under the automatic trigger threshold', async () => {
		// Total sits under the 85% trigger, so no summarization happens at all —
		// but the single tool result still exceeds what one turn may occupy.
		mocks.contextSize = 100000;
		const messages = [
			msg(MessageRole.USER, 'tiny'),
			msg(MessageRole.TOOL, 'x'.repeat(220000)),
			msg(MessageRole.USER, 'tiny')
		];
		const total = await tokensOf(messages);
		expect(total).toBeLessThan(usableTokens() * 0.85); // under the trigger

		const result = await ContextCompactionService.maybeCompact('conv-1', messages);
		expect(mocks.sendMessage).not.toHaveBeenCalled();
		expect(result.messages).toHaveLength(3);
		expect(String(result.messages[1].content)).toContain('truncated');
		// 0.4 is MAX_SINGLE_MESSAGE_TOKENS_RATIO; allow slack for the marker
		// and per-message template overhead the cap budgets around.
		expect(await tokensOf([result.messages[1]])).toBeLessThan(usableTokens() * 0.45);
	});

	it('under threshold, a stored summary is still applied to shrink the payload (no model call)', async () => {
		const old = Array.from({ length: 6 }, (_, i) =>
			msg(i % 2 ? MessageRole.ASSISTANT : MessageRole.USER, `old turn ${i} short`)
		);
		mocks.storedConversation = {
			id: 'conv-1',
			contextSummary: { text: 'MANUAL SUMMARY', upToMessageId: old[3].id }
		};
		const result = await ContextCompactionService.maybeCompact('conv-1', [
			...old,
			msg(MessageRole.USER, 'latest')
		]);
		expect(result.compacted).toBe(true);
		expect(String(result.messages[0].content)).toContain('MANUAL SUMMARY');
		// Covered turns are gone; later turns and the new message survive.
		expect(result.messages.some((m) => String(m.content).includes('old turn 2'))).toBe(false);
		expect(result.messages.some((m) => String(m.content).includes('old turn 4'))).toBe(true);
		expect(mocks.sendMessage).not.toHaveBeenCalled();
	});

	it('estimateUsage reports tokens vs n_ctx and reflects a stored summary', async () => {
		const messages = Array.from({ length: 4 }, () => msg(MessageRole.USER, 'x'.repeat(400)));
		const plain = await ContextCompactionService.estimateUsage('conv-1', messages);
		expect(plain).not.toBeNull();
		expect(plain!.nCtx).toBe(4096);
		expect(plain!.summarized).toBe(false);
		expect(plain!.percent).toBeGreaterThan(0);

		mocks.storedConversation = {
			id: 'conv-1',
			contextSummary: { text: 'S', upToMessageId: messages[2].id }
		};
		const summarized = await ContextCompactionService.estimateUsage('conv-1', messages);
		expect(summarized!.summarized).toBe(true);
		expect(summarized!.usedTokens).toBeLessThan(plain!.usedTokens);
	});

	it('estimateUsage returns null when n_ctx is unknown', async () => {
		mocks.contextSize = null;
		expect(await ContextCompactionService.estimateUsage('conv-1', [msg(MessageRole.USER, 'hi')])).toBeNull();
	});

	it('compactNow summarizes older messages even when under the automatic threshold', async () => {
		const old = Array.from({ length: 10 }, (_, i) =>
			msg(i % 2 ? MessageRole.ASSISTANT : MessageRole.USER, `old turn ${i} ` + 'x'.repeat(700))
		);
		const result = await ContextCompactionService.compactNow('conv-1', [
			...old,
			msg(MessageRole.USER, 'latest')
		]);
		expect(result.compacted).toBe(true);
		expect(mocks.sendMessage).toHaveBeenCalled();
		expect(mocks.updateConversation).toHaveBeenCalledWith(
			'conv-1',
			expect.objectContaining({ contextSummary: expect.objectContaining({ text: 'SUMMARY OF OLD TURNS' }) })
		);
	});

	it('compactNow on a tiny conversation reports nothing to compact', async () => {
		const result = await ContextCompactionService.compactNow('conv-1', [
			msg(MessageRole.USER, 'hi'),
			msg(MessageRole.ASSISTANT, 'hello')
		]);
		expect(result.compacted).toBe(false);
		expect(result.message).toContain('Nothing to compact');
		expect(mocks.sendMessage).not.toHaveBeenCalled();
	});

	it('compactNow twice in a row reports already compacted the second time', async () => {
		const old = Array.from({ length: 10 }, (_, i) =>
			msg(i % 2 ? MessageRole.ASSISTANT : MessageRole.USER, `old turn ${i} ` + 'x'.repeat(700))
		);
		const all = [...old, msg(MessageRole.USER, 'latest')];
		const first = await ContextCompactionService.compactNow('conv-1', all);
		expect(first.compacted).toBe(true);
		// Simulate persistence: the boundary the first call wrote.
		const boundaryId = (mocks.updateConversation.mock.calls[0][1] as { contextSummary: { upToMessageId: string } })
			.contextSummary.upToMessageId;
		mocks.storedConversation = { id: 'conv-1', contextSummary: { text: 'SUMMARY OF OLD TURNS', upToMessageId: boundaryId } };
		const second = await ContextCompactionService.compactNow('conv-1', all);
		expect(second.compacted).toBe(false);
		expect(second.message).toContain('Already compacted');
	});

	it('falls back to a char-based estimate when /tokenize is unavailable', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({ ok: false }) as unknown as Response)
		);
		const messages = Array.from({ length: 20 }, () => msg(MessageRole.USER, 'w'.repeat(2000)));
		const result = await ContextCompactionService.maybeCompact('conv-1', messages);
		expect(result.compacted).toBe(true);
	});
});
