import { describe, expect, it } from 'vitest';
import { pickQuestionSource, type OpenQuestion } from '$lib/utils/agentic';

// The composer shows one question card, chosen here (ChatFormQuestion.svelte).
// The bug this pins (found clicking 3.9, 2026-11-12): a background task's
// question showed twice, in the task bar and in the message, and the copy in
// the message sent its answer to a browser loop that was not running.

const stored: OpenQuestion = {
	assistantId: 'a1',
	toolCallId: 'call-1',
	request: { question: 'Stored?', multiSelect: false },
	unanswered: [{ id: 'call-1', name: 'ask_user' }],
	anchorId: 'a1'
};

const base = { task: null, activeTaskId: undefined, live: null, flowBusy: false, open: () => stored };

describe('pickQuestionSource', () => {
	it('a task waiting on a question: the task\'s, never the stored copy of the same call', () => {
		const s = pickQuestionSource({
			...base,
			task: { id: 't1', waiting: { kind: 'question', callId: 'call-1', question: 'Which?', options: ['a', 'b'], multiSelect: true } }
		});
		expect(s).toEqual({
			kind: 'task',
			key: 'task:t1:call-1',
			request: { question: 'Which?', options: ['a', 'b'], multiSelect: true }
		});
	});

	it('a task waiting on something else, or not yet loaded, shows no question at all', () => {
		expect(pickQuestionSource({ ...base, task: { id: 't1', waiting: { kind: 'continue' } } })).toBeNull();
		expect(pickQuestionSource({ ...base, task: { id: 't1', waiting: null } })).toBeNull();
		expect(pickQuestionSource({ ...base, activeTaskId: 't1' })).toBeNull();
	});

	it('an ordinary chat: the live question first, then a reloaded one once nothing runs', () => {
		const live = { question: 'Live?', multiSelect: false };
		expect(pickQuestionSource({ ...base, live })).toEqual({ kind: 'live', key: live, request: live });
		expect(pickQuestionSource({ ...base, flowBusy: true })).toBeNull();
		expect(pickQuestionSource(base)).toEqual({ kind: 'reloaded', key: 'reloaded:call-1', request: stored.request });
		expect(pickQuestionSource({ ...base, open: () => null })).toBeNull();
	});
});
