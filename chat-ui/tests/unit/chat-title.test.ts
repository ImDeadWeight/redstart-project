import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseMessage } from '$lib/types/database';

const mocks = vi.hoisted(() => ({
	config: {} as Record<string, unknown>,
	sendMessage: vi.fn()
}));

vi.mock('$lib/stores/settings.svelte', () => ({ config: () => mocks.config }));
vi.mock('$lib/services/chat.service', () => ({
	ChatService: { sendMessage: mocks.sendMessage }
}));

import {
	ChatTitleService,
	cleanTitle,
	looksHandNamed,
	shouldName,
	RENAME_AFTER
} from '$lib/services/chat-title.service';
import { MessageRole } from '$lib/enums';

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

/** `n` prompts, each answered. */
function exchanges(n: number): DatabaseMessage[] {
	return Array.from({ length: n }, (_, i) => [
		msg(MessageRole.USER, `question ${i + 1}`),
		msg(MessageRole.ASSISTANT, `answer ${i + 1}`)
	]).flat();
}

describe('cleanTitle', () => {
	it('drops thinking, quotes, Markdown and a "Title:" label', () => {
		expect(cleanTitle('<think>The user asks about tax.</think>\n\nTitle: "Quarterly Tax Filing"')).toBe(
			'Quarterly Tax Filing'
		);
		expect(cleanTitle('## *Rust Borrow Checker Errors.*\nMore words')).toBe('Rust Borrow Checker Errors');
		expect(cleanTitle('<think>still going')).toBe('');
	});

	it('keeps one line, capped in length', () => {
		expect(cleanTitle('x'.repeat(200)).length).toBe(60);
	});
});

describe('shouldName', () => {
	beforeEach(() => {
		mocks.config = {};
	});

	it('names a conversation that has never been named', () => {
		expect(shouldName({}, 1)).toBe(true);
	});

	it('names it again once, after the third prompt', () => {
		expect(shouldName({ autoTitledAt: 1 }, 2)).toBe(false);
		expect(shouldName({ autoTitledAt: 1 }, RENAME_AFTER)).toBe(true);
		expect(shouldName({ autoTitledAt: RENAME_AFTER }, 10)).toBe(false);
	});

	it('names it afresh when the first prompt changed (autoTitledAt cleared)', () => {
		expect(shouldName({ autoTitledAt: null }, 5)).toBe(true);
	});

	it('never replaces a name the user typed', () => {
		expect(shouldName({ nameSetByUser: true }, 1)).toBe(false);
		expect(shouldName({ nameSetByUser: true, autoTitledAt: 1 }, RENAME_AFTER)).toBe(false);
	});

	it('respects the settings toggle', () => {
		mocks.config = { autoTitleConversations: false };
		expect(shouldName({}, 1)).toBe(false);
	});
});

describe('looksHandNamed', () => {
	const prompt = [msg(MessageRole.USER, 'How do I prune tomatoes?\nThey are getting leggy.')];

	it('treats a title that is still the first prompt as untouched, in either form', () => {
		expect(looksHandNamed({ name: 'How do I prune tomatoes?\nThey are getting leggy.' }, prompt)).toBe(false);
		expect(looksHandNamed({ name: 'How do I prune tomatoes?' }, prompt)).toBe(false);
	});

	it('treats the attachments-only default as untouched', () => {
		expect(looksHandNamed({ name: 'Chat 11/5/2026, 9:00:00 AM' }, prompt)).toBe(false);
	});

	it('spots a name someone typed before the flag existed', () => {
		expect(looksHandNamed({ name: 'Garden' }, prompt)).toBe(true);
	});

	it('never second-guesses a conversation the model has named', () => {
		expect(looksHandNamed({ name: 'Pruning Tomato Plants', autoTitledAt: 1 }, prompt)).toBe(false);
	});
});

describe('ChatTitleService.suggest', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.config = {};
		nextId = 0;
		mocks.sendMessage.mockResolvedValue('Title: "Planning a Garden"');
	});

	it('asks the model without thinking and returns the cleaned title with the prompt count', async () => {
		const result = await ChatTitleService.suggest({ name: '' }, exchanges(1), 'some-model');
		expect(result).toEqual({ title: 'Planning a Garden', titledAt: 1 });
		const [messages, options] = mocks.sendMessage.mock.calls[0];
		expect(options).toMatchObject({ stream: false, enableThinking: false, model: 'some-model' });
		expect(messages[1].content).toContain('User: question 1');
		expect(messages[1].content).toContain('Assistant: answer 1');
	});

	it('leaves tool output out of what the model sees', async () => {
		const messages = [...exchanges(1), msg(MessageRole.TOOL, 'SECRET TOOL OUTPUT')];
		await ChatTitleService.suggest({ name: '' }, messages);
		expect(mocks.sendMessage.mock.calls[0][0][1].content).not.toContain('SECRET TOOL OUTPUT');
	});

	it('waits for an answer before naming', async () => {
		const result = await ChatTitleService.suggest({ name: '' }, [msg(MessageRole.USER, 'hello')]);
		expect(result).toBeNull();
		expect(mocks.sendMessage).not.toHaveBeenCalled();
	});

	it('does not ask when no name is due', async () => {
		const result = await ChatTitleService.suggest({ name: '', autoTitledAt: 1 }, exchanges(2));
		expect(result).toBeNull();
		expect(mocks.sendMessage).not.toHaveBeenCalled();
	});

	it('leaves a hand-named conversation alone', async () => {
		expect(await ChatTitleService.suggest({ name: 'My Notes' }, exchanges(1))).toBeNull();
		expect(mocks.sendMessage).not.toHaveBeenCalled();
	});

	it('keeps the old title when the model fails or says nothing useful', async () => {
		mocks.sendMessage.mockRejectedValueOnce(new Error('busy'));
		expect(await ChatTitleService.suggest({ name: '' }, exchanges(1))).toBeNull();
		mocks.sendMessage.mockResolvedValueOnce('<think>hmm');
		expect(await ChatTitleService.suggest({ name: '' }, exchanges(1))).toBeNull();
	});
});
