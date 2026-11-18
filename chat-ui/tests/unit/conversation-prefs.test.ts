import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const updateConversation = vi.fn(async () => {});

vi.mock('$lib/services/database.service', () => ({
	DatabaseService: {
		get updateConversation() {
			return updateConversation;
		}
	}
}));

const { conversationsStore } = await import('$lib/stores/conversations.svelte');
const { ReasoningEffort } = await import('$lib/enums');

/**
 * conversation-prefs - the three per-conversation preference pairs
 *
 * Written before deduplicating them. The plan calls the three pairs
 * "near-identical" and suggests they share their shape — but near-identical is
 * not identical, and the differences are exactly what a careless dedup would
 * normalise away:
 *
 *   | pref        | fallback WITH a conversation | WITHOUT one       |
 *   |-------------|------------------------------|-------------------|
 *   | thinking    | conv value ?? pending        | pending, persisted|
 *   | reasoning   | conv value ?? pending        | pending, persisted|
 *   | promptMode  | conv value ?? **null**       | pending, NOT persisted |
 *
 * `promptMode` differs on both halves. Those two asymmetries are pinned here so
 * the refactor has to preserve them deliberately rather than by luck.
 */

type Conversation = { id: string; name: string; currNode: null; lastModified: number } & Record<
	string,
	unknown
>;

function conversation(overrides: Record<string, unknown> = {}): Conversation {
	return {
		id: 'conv-prefs',
		name: 'Prefs',
		currNode: null,
		lastModified: 0,
		...overrides
	} as Conversation;
}

let saved: {
	active: unknown;
	list: unknown;
	thinking: boolean;
	effort: unknown;
	mode: string | null;
};

beforeEach(() => {
	updateConversation.mockClear();
	saved = {
		active: conversationsStore.core.activeConversation,
		list: conversationsStore.core.conversations,
		thinking: conversationsStore.pendingThinkingEnabled,
		effort: conversationsStore.pendingReasoningEffort,
		mode: conversationsStore.pendingPromptMode
	};
});

afterEach(() => {
	conversationsStore.core.activeConversation = saved.active as never;
	conversationsStore.core.conversations = saved.list as never;
	conversationsStore.pendingThinkingEnabled = saved.thinking;
	conversationsStore.pendingReasoningEffort = saved.effort as never;
	conversationsStore.pendingPromptMode = saved.mode;
});

describe('reading a preference with no active conversation', () => {
	beforeEach(() => {
		conversationsStore.core.activeConversation = null;
	});

	it('falls back to the pending default for all three', () => {
		conversationsStore.pendingThinkingEnabled = true;
		conversationsStore.pendingReasoningEffort = ReasoningEffort.HIGH;
		conversationsStore.pendingPromptMode = 'research';

		expect(conversationsStore.getThinkingEnabled()).toBe(true);
		expect(conversationsStore.getReasoningEffort()).toBe(ReasoningEffort.HIGH);
		expect(conversationsStore.getPromptMode()).toBe('research');
	});
});

describe('reading a preference from the active conversation', () => {
	it('prefers the conversation value over the pending default', () => {
		conversationsStore.pendingThinkingEnabled = false;
		conversationsStore.pendingReasoningEffort = ReasoningEffort.LOW;
		conversationsStore.core.activeConversation = conversation({
			thinkingEnabled: true,
			reasoningEffort: ReasoningEffort.MAX,
			promptMode: 'debug'
		}) as never;

		expect(conversationsStore.getThinkingEnabled()).toBe(true);
		expect(conversationsStore.getReasoningEffort()).toBe(ReasoningEffort.MAX);
		expect(conversationsStore.getPromptMode()).toBe('debug');
	});

	// thinking and reasoning fall through to the pending default when the
	// conversation never chose. This is the shared half of the shape.
	it('falls back to the pending default when the conversation has no value', () => {
		conversationsStore.pendingThinkingEnabled = true;
		conversationsStore.pendingReasoningEffort = ReasoningEffort.HIGH;
		conversationsStore.core.activeConversation = conversation() as never;

		expect(conversationsStore.getThinkingEnabled()).toBe(true);
		expect(conversationsStore.getReasoningEffort()).toBe(ReasoningEffort.HIGH);
	});

	// ...but promptMode does NOT. With a conversation open it reports null rather
	// than inheriting the pending mode, so a mode chosen for a *new* chat cannot
	// leak into an existing one that never selected it.
	it('reports null for an unset prompt mode instead of inheriting the pending one', () => {
		conversationsStore.pendingPromptMode = 'research';
		conversationsStore.core.activeConversation = conversation() as never;

		expect(conversationsStore.getPromptMode()).toBeNull();
	});
});

describe('writing a preference with no active conversation', () => {
	beforeEach(() => {
		conversationsStore.core.activeConversation = null;
	});

	it('stores the pending default and touches no conversation', async () => {
		await conversationsStore.setThinkingEnabled(true);
		await conversationsStore.setReasoningEffort(ReasoningEffort.MAX);
		await conversationsStore.setPromptMode('research');

		expect(conversationsStore.pendingThinkingEnabled).toBe(true);
		expect(conversationsStore.pendingReasoningEffort).toBe(ReasoningEffort.MAX);
		expect(conversationsStore.pendingPromptMode).toBe('research');
		expect(updateConversation).not.toHaveBeenCalled();
	});

	// The other asymmetry: thinking and reasoning persist their default so a new
	// browser session inherits it; prompt mode deliberately does not.
	//
	// The `unit` project runs in node, where there is no localStorage and the
	// save methods early-return — so a spy alone would observe nothing and pass
	// whatever the code did. A stub is required for this to mean anything.
	it('persists the thinking and reasoning defaults but not the prompt mode', async () => {
		const writes: string[] = [];
		const store = new Map<string, string>();
		vi.stubGlobal('localStorage', {
			getItem: (k: string) => store.get(k) ?? null,
			setItem: (k: string, v: string) => {
				writes.push(k);
				store.set(k, v);
			},
			removeItem: (k: string) => store.delete(k)
		});

		try {
			await conversationsStore.setThinkingEnabled(true);
			await conversationsStore.setReasoningEffort(ReasoningEffort.MAX);
			expect(writes).toHaveLength(2);

			await conversationsStore.setPromptMode('research');
			expect(writes).toHaveLength(2);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

describe('writing a preference to the active conversation', () => {
	beforeEach(() => {
		const conv = conversation();
		conversationsStore.core.activeConversation = conv as never;
		conversationsStore.core.conversations = [conv] as never;
	});

	it.each([
		['setThinkingEnabled', 'thinkingEnabled', true],
		['setReasoningEffort', 'reasoningEffort', ReasoningEffort.MAX],
		['setPromptMode', 'promptMode', 'debug']
	] as const)('%s writes through to the conversation, the DB and the list', async (
		method,
		field,
		value
	) => {
		await (
			conversationsStore as unknown as Record<string, (v: unknown) => Promise<void>>
		)[method](value);

		// the active conversation object
		expect(
			(conversationsStore.core.activeConversation as unknown as Record<string, unknown>)[field]
		).toBe(value);
		// persisted
		expect(updateConversation).toHaveBeenCalledWith('conv-prefs', { [field]: value });
		// and the list entry, so the sidebar reflects it
		expect(
			(conversationsStore.core.conversations[0] as unknown as Record<string, unknown>)[field]
		).toBe(value);
	});

	// The list is reassigned rather than mutated in place, which is what makes
	// the change visible to a `$derived` over the conversation list.
	it('replaces the conversation array so readers re-run', async () => {
		const before = conversationsStore.core.conversations;

		await conversationsStore.setThinkingEnabled(true);

		expect(conversationsStore.core.conversations).not.toBe(before);
	});

	it('leaves the pending defaults alone when a conversation is open', async () => {
		conversationsStore.pendingThinkingEnabled = false;

		await conversationsStore.setThinkingEnabled(true);

		expect(conversationsStore.pendingThinkingEnabled).toBe(false);
	});
});
