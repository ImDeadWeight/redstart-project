import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ask-user - the question card's logic and the reload-resume path
 *
 * Plan §4, 1.1: "It survives a refresh without new storage ... answering it
 * writes the tool result and resumes through the existing continue path. Test
 * that path explicitly." This file is that test, plus the pure helpers the
 * card and the path are built from. The live path (the ask port while a flow
 * runs, steering as the answer) is in agentic-loop.test.ts.
 */

// --- the stores ChatMessageOps reaches, faked -------------------------------

type Msg = {
	id: string;
	convId: string;
	parent: string | null;
	children: string[];
	role: string;
	content: string;
	type: string;
	timestamp: number;
	toolCalls?: string;
	toolCallId?: string;
};

const db = vi.hoisted(() => ({ messages: [] as Msg[], nextTs: 1000 }));
const active = vi.hoisted(() => ({ list: [] as Msg[], currNode: '' }));

vi.mock('$lib/services/database.service', () => ({
	DatabaseService: {
		createMessageBranch: vi.fn(async (message: Omit<Msg, 'id' | 'parent'>, parentId: string | null) => {
			const created: Msg = {
				...(message as Msg),
				id: `m${db.messages.length}`,
				parent: parentId,
				children: [],
				timestamp: db.nextTs++
			};
			const parent = db.messages.find((m) => m.id === parentId);
			if (!parent) throw new Error('Parent message not found');
			parent.children.push(created.id);
			db.messages.push(created);
			return created;
		}),
		updateMessage: vi.fn()
	}
}));

vi.mock('$lib/stores/conversations.svelte', () => ({
	conversationsStore: {
		get activeConversation() {
			return { id: 'c1', currNode: active.currNode };
		},
		get activeMessages() {
			return active.list;
		},
		addMessageToActive: (m: Msg) => void active.list.push(m),
		updateCurrentNode: async (id: string) => void (active.currNode = id),
		findMessageIndex: (id: string) => active.list.findIndex((m) => m.id === id),
		getConversationMessages: async () => db.messages,
		updateConversationTimestamp: () => {},
		refreshActiveMessages: async () => {}
	}
}));

const { ChatMessageOps } = await import('$lib/stores/chat/chat-message-ops.svelte');
const { findOpenQuestion, resultsForAnsweredQuestion, buildAskAnswer, buildAskAnswers, NOT_RUN_AFTER_RELOAD_RESULT } =
	await import('$lib/utils/agentic');
const { DISMISSED_RESULT } = await import('$lib/agent-core');

function msg(id: string, parent: string | null, role: string, extra: Partial<Msg> = {}): Msg {
	return { id, convId: 'c1', parent, children: [], role, content: '', type: 'text', timestamp: db.nextTs++, ...extra };
}

const calls = (...c: Array<[string, string, unknown]>) =>
	JSON.stringify(
		c.map(([id, name, args]) => ({
			id,
			type: 'function',
			function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) }
		}))
	);

/** root → user → assistant(calls) [→ trailing results], as saved before the pause. */
function seed(toolCalls: string, trailing: Msg[] = []) {
	const root = msg('root', null, 'system', { type: 'root' });
	const user = msg('u1', 'root', 'user', { content: 'fix the typos' });
	const asst = msg('a1', 'u1', 'assistant', { toolCalls });
	root.children = ['u1'];
	user.children = ['a1'];
	db.messages = [root, user, asst, ...trailing];
	active.list = [user, asst, ...trailing];
	active.currNode = (trailing.at(-1) ?? asst).id;
}

beforeEach(() => {
	db.messages = [];
	active.list = [];
});

describe('findOpenQuestion', () => {
	it('finds an unanswered ask_user call on the last assistant turn', () => {
		seed(calls(['q1', 'ask_user', { question: 'Which draft?', options: ['a.md', 'b.md'] }]));
		const open = findOpenQuestion(active.list as never);
		expect(open).toMatchObject({
			assistantId: 'a1',
			toolCallId: 'q1',
			request: { questions: [{ question: 'Which draft?', options: ['a.md', 'b.md'], multiSelect: false }] },
			anchorId: 'a1'
		});
	});

	it('anchors after the results that already exist, and lists only the calls without one', () => {
		const done = msg('t1', 'a1', 'tool', { toolCallId: 'r1', content: 'read ok' });
		seed(
			calls(['r1', 'read_file', { path: 'x' }], ['q1', 'ask_user', { question: 'Which?' }], ['r2', 'read_file', { path: 'y' }]),
			[done]
		);
		const open = findOpenQuestion(active.list as never)!;
		expect(open.anchorId).toBe('t1');
		expect(open.unanswered.map((c) => c.id)).toEqual(['q1', 'r2']);
	});

	it('is null once the question has a result, for a malformed call, and when a user spoke last', () => {
		seed(calls(['q1', 'ask_user', { question: 'Which?' }]), [
			msg('t1', 'a1', 'tool', { toolCallId: 'q1', content: 'The user answered: b' })
		]);
		expect(findOpenQuestion(active.list as never)).toBeNull();

		seed(calls(['q1', 'ask_user', '{"question": ""}']));
		expect(findOpenQuestion(active.list as never)).toBeNull();

		seed(calls(['q1', 'ask_user', { question: 'Which?' }]));
		active.list.push(msg('u2', 'a1', 'user', { content: 'never mind' }));
		expect(findOpenQuestion(active.list as never)).toBeNull();
	});

	it('closes the turn: the answer for the question, not-run for the rest', () => {
		seed(calls(['q1', 'ask_user', { question: 'Which?' }], ['r2', 'read_file', { path: 'y' }]));
		const open = findOpenQuestion(active.list as never)!;
		expect(resultsForAnsweredQuestion(open, { chosen: ['b.md'] })).toEqual([
			{ toolCallId: 'q1', content: 'The user chose: b.md' },
			{ toolCallId: 'r2', content: NOT_RUN_AFTER_RELOAD_RESULT }
		]);
		expect(resultsForAnsweredQuestion(open, null)[0].content).toBe(DISMISSED_RESULT);
	});

	it('several questions (D43): reloaded as one card, answered one line per question', () => {
		seed(calls(['q1', 'ask_user', { questions: [{ question: 'Which?', options: ['a', 'b'] }, 'When?'] }]));
		const open = findOpenQuestion(active.list as never)!;
		expect(open.request.questions.map((q) => q.question)).toEqual(['Which?', 'When?']);
		expect(resultsForAnsweredQuestion(open, { answers: [{ chosen: ['b'] }, { text: 'Friday' }] })[0].content).toBe(
			'The user answered your questions:\n1. Which?\n   The user chose: b\n2. When?\n   The user answered: Friday'
		);
	});
});

describe('buildAskAnswer (the card)', () => {
	it('nothing picked or typed is nothing to send; picks and text combine; blanks are ignored', () => {
		expect(buildAskAnswer([], '   ')).toBeNull();
		expect(buildAskAnswer(['b.md'], '')).toEqual({ chosen: ['b.md'] });
		expect(buildAskAnswer([], ' Celsius ')).toEqual({ text: 'Celsius' });
		expect(buildAskAnswer(['A', 'B'], 'keep the title')).toEqual({ chosen: ['A', 'B'], text: 'keep the title' });
	});

	it('buildAskAnswers: one question answers flat; several give one reply each, null when all are blank', () => {
		expect(buildAskAnswers([{ selected: ['x'], text: '' }])).toEqual({ chosen: ['x'] });
		expect(
			buildAskAnswers([
				{ selected: [], text: ' ' },
				{ selected: [], text: 'Friday' }
			])
		).toEqual({ answers: [null, { text: 'Friday' }] });
		expect(
			buildAskAnswers([
				{ selected: [], text: '' },
				{ selected: [], text: '' }
			])
		).toBeNull();
	});
});

describe('answerOpenQuestion (reload, then answer)', () => {
	function ops() {
		const runtime = {
			isChatLoadingInternal: () => false,
			setChatLoading: vi.fn(),
			clearChatStreaming: vi.fn()
		};
		const send = { cancelPreEncode: vi.fn(), streamChatCompletion: vi.fn(async () => {}) };
		return { o: new ChatMessageOps(runtime as never, {} as never, send as never), send, runtime };
	}

	it('writes the results after the saved turn and resumes through the next-turn path', async () => {
		seed(calls(['q1', 'ask_user', { question: 'Which draft?', options: ['a.md', 'b.md'] }], ['r2', 'read_file', { path: 'y' }]));
		const { o, send } = ops();

		expect(await o.answerOpenQuestion({ chosen: ['b.md'], text: 'the newer one' })).toBe(true);

		// Chained, so the path the next request is built from carries both.
		const results = db.messages.filter((m) => m.role === 'tool');
		expect(results.map((m) => [m.parent, m.toolCallId, m.content])).toEqual([
			['a1', 'q1', 'The user chose: b.md. They added: the newer one'],
			[results[0].id, 'r2', NOT_RUN_AFTER_RELOAD_RESULT]
		]);

		expect(send.streamChatCompletion).toHaveBeenCalledTimes(1);
		const [path, assistant] = send.streamChatCompletion.mock.calls[0] as unknown as [Msg[], Msg];
		expect(path.map((m) => m.id)).toEqual(['u1', 'a1', results[0].id, results[1].id]);
		// A fresh assistant turn hangs off the last result, as Continue makes it.
		expect([assistant.role, assistant.parent]).toEqual(['assistant', results[1].id]);
		expect(findOpenQuestion(active.list as never)).toBeNull();
	});

	it('Skip writes the dismissal and still resumes', async () => {
		seed(calls(['q1', 'ask_user', { question: 'Which?' }]));
		const { o, send } = ops();
		expect(await o.answerOpenQuestion(null)).toBe(true);
		expect(db.messages.find((m) => m.role === 'tool')?.content).toBe(DISMISSED_RESULT);
		expect(send.streamChatCompletion).toHaveBeenCalledTimes(1);
	});

	it('does nothing when there is no open question, or while a reply is generating', async () => {
		seed(calls(['r1', 'read_file', { path: 'x' }]));
		const { o, send } = ops();
		expect(await o.answerOpenQuestion({ text: 'x' })).toBe(false);

		seed(calls(['q1', 'ask_user', { question: 'Which?' }]));
		const busy = ops();
		busy.runtime.isChatLoadingInternal = () => true;
		expect(await busy.o.answerOpenQuestion({ text: 'x' })).toBe(false);
		expect(db.messages.some((m) => m.role === 'tool')).toBe(false);
		expect(send.streamChatCompletion).not.toHaveBeenCalled();
	});
});

describe('planProgress (the checklist summary)', () => {
	it('counts done of all while steps are open; says done, with skips, when none are', async () => {
		const { planProgress } = await import('$lib/utils/agentic');
		expect(planProgress([{ text: 'a', status: 'done' }, { text: 'b', status: 'in_progress' }, { text: 'c', status: 'pending' }])).toEqual({ open: 2, label: '1 of 3 done' });
		expect(planProgress([{ text: 'a', status: 'done' }, { text: 'b', status: 'skipped' }])).toEqual({ open: 0, label: 'done (1 skipped)' });
		expect(planProgress([{ text: 'a', status: 'done' }])).toEqual({ open: 0, label: 'done' });
	});
});
