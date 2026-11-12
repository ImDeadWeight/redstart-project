import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// chat-ui as a client of the daemon's background tasks (agent-runtime Phase
// 3.9): the SSE frame parser, the wire mappings, the 409 a conversation
// write gets while a task holds the chat, and the store that follows a
// chat's task. The task routes themselves are pinned by the daemon's
// test-task-runtime.mjs; here they are mocked.

import {
	approvalDecisionFor,
	parseSseFrames,
	taskStatusLabel,
	type TaskEvent,
	type TaskRecord
} from '$lib/services/task.service';

describe('parseSseFrames', () => {
	it('returns complete frames and keeps the unfinished tail', () => {
		const buf =
			'id: 1\ndata: {"seq":1,"type":"turn"}\n\n' +
			': keep-alive\n\n' +
			'id: 2\ndata: {"seq":2,"type":"status","status":"running"}\n\n' +
			'id: 3\ndata: {"seq":3,"ty';
		const { events, rest } = parseSseFrames(buf);
		expect(events.map((e) => e.seq)).toEqual([1, 2]);
		expect(events[1].status).toBe('running');
		expect(rest).toBe('id: 3\ndata: {"seq":3,"ty');
		const next = parseSseFrames(rest + 'pe":"plan"}\n\n');
		expect(next.events).toEqual([{ seq: 3, type: 'plan' }]);
		expect(next.rest).toBe('');
	});

	it('reads CRLF frames, and skips one that is not JSON or not an event', () => {
		const { events } = parseSseFrames(
			'data: nope\r\n\r\ndata: {"x":1}\r\n\r\ndata: {"seq":4,"type":"turn"}\r\n\r\n'
		);
		expect(events).toEqual([{ seq: 4, type: 'turn' }]);
	});
});

describe('wire mappings', () => {
	it('maps the permission card to /approvals decisions', () => {
		expect(['once', 'always', 'always_server', 'deny'].map(approvalDecisionFor)).toEqual([
			'once',
			'always',
			'always',
			'deny'
		]);
	});

	it('says what the task waits for', () => {
		expect(taskStatusLabel({ status: 'waiting_user', waiting: { kind: 'continue' } })).toMatch(/turn limit/);
		expect(
			taskStatusLabel({ status: 'waiting_user', waiting: { kind: 'question', question: 'q', multiSelect: false } })
		).toMatch(/asking/);
		expect(taskStatusLabel({ status: 'waiting_approval', waiting: null })).toMatch(/approval/);
	});
});

describe('a conversation write while a task holds the chat', () => {
	beforeEach(() => {
		const data = new Map<string, string>();
		vi.stubGlobal('localStorage', {
			getItem: (k: string) => data.get(k) ?? null,
			setItem: (k: string, v: string) => void data.set(k, v),
			removeItem: (k: string) => void data.delete(k)
		});
	});
	afterEach(() => vi.unstubAllGlobals());

	it('throws TaskActiveError and tells the registered handler which chat', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				new Response(
					JSON.stringify({ error: { message: 'A background task is writing this conversation.', code: 'task_active' } }),
					{ status: 409 }
				)
			)
		);
		const db = await vi.importActual<typeof import('$lib/services/database.service')>(
			'$lib/services/database.service'
		);
		const handler = vi.fn();
		db.setTaskActiveHandler(handler);
		await expect(db.DatabaseService.updateConversation('conv-1', { currNode: 'm1' })).rejects.toBeInstanceOf(
			db.TaskActiveError
		);
		expect(handler).toHaveBeenCalledWith('conv-1');
		db.setTaskActiveHandler(null);
	});

	it('any other 409 is an ordinary error', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"type":"conflict"}}', { status: 409 })));
		const db = await vi.importActual<typeof import('$lib/services/database.service')>(
			'$lib/services/database.service'
		);
		const handler = vi.fn();
		db.setTaskActiveHandler(handler);
		const err = await db.DatabaseService.updateConversation('conv-1', { pinned: true }).catch((e) => e);
		expect(err).not.toBeInstanceOf(db.TaskActiveError);
		expect(String(err?.message)).toMatch(/API error 409/);
		expect(handler).not.toHaveBeenCalled();
		db.setTaskActiveHandler(null);
	});
});

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
	svc: {
		start: vi.fn(),
		listFor: vi.fn(),
		get: vi.fn(),
		steer: vi.fn(),
		answer: vi.fn(),
		cancel: vi.fn(),
		decideApproval: vi.fn(),
		readEvents: vi.fn()
	},
	conv: { activeConversation: null as { id: string; activeTaskId?: string } | null, reloadActiveFromServer: vi.fn() },
	toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() },
	taskActiveHandler: null as ((id: string | null) => void) | null
}));

vi.mock('$lib/services/task.service', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/services/task.service')>()),
	TaskService: h.svc
}));
vi.mock('$lib/stores/conversations.svelte', () => ({ conversationsStore: h.conv }));
vi.mock('$lib/stores/chat/chat-options', () => ({
	getApiOptions: () => ({ stream: true, temperature: 0.3, excludeReasoningFromContext: true })
}));
vi.mock('$lib/stores/settings.svelte', () => ({ config: () => ({ contextCompaction: false }) }));
vi.mock('svelte-sonner', () => ({ toast: h.toast }));
vi.mock('$lib/services/database.service', () => ({
	setTaskActiveHandler: (fn: (id: string | null) => void) => (h.taskActiveHandler = fn)
}));

const record = (over: Partial<TaskRecord> = {}): TaskRecord => ({
	id: 't1',
	conversationId: 'c1',
	status: 'running',
	waiting: null,
	createdAt: 1,
	updatedAt: 1,
	...over
});

/** readEvents as a stream the test drives: push events, then end it. */
function controllableStream() {
	let push: (e: TaskEvent) => void = () => {};
	let end: () => void = () => {};
	const calls: number[] = [];
	h.svc.readEvents.mockImplementation(
		(_id: string, after: number, onEvent: (e: TaskEvent) => void, signal: AbortSignal) => {
			calls.push(after);
			push = onEvent;
			return new Promise<void>((resolve) => {
				end = resolve;
				signal.addEventListener('abort', () => resolve());
			});
		}
	);
	return { push: (e: TaskEvent) => push(e), end: () => end(), calls };
}

async function freshStore() {
	vi.resetModules();
	return (await import('$lib/stores/tasks.svelte')).tasksStore;
}

describe('tasksStore', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		for (const f of Object.values(h.svc)) f.mockReset();
		for (const f of Object.values(h.toast)) f.mockReset();
		h.conv.reloadActiveFromServer.mockReset().mockResolvedValue(undefined);
		h.conv.activeConversation = null;
	});
	afterEach(() => vi.useRealTimers());

	it('an ordinary chat is never asked about tasks', async () => {
		const store = await freshStore();
		h.conv.activeConversation = { id: 'c1' };
		await store.watch('c1');
		expect(h.svc.get).not.toHaveBeenCalled();
		expect(h.svc.listFor).not.toHaveBeenCalled();
		expect(store.activeFor('c1')).toBeNull();
	});

	it('follows the task a chat names; a status event drives the cards; changes reload the chat, throttled', async () => {
		const stream = controllableStream();
		const store = await freshStore();
		h.conv.activeConversation = { id: 'c1', activeTaskId: 't1' };
		h.svc.get.mockResolvedValue(record());
		await store.watch('c1');
		expect(store.activeFor('c1')?.status).toBe('running');
		expect(stream.calls).toEqual([0]);

		const waiting = { kind: 'question' as const, question: 'Which file?', options: ['a', 'b'], multiSelect: false };
		stream.push({ seq: 1, type: 'message' });
		stream.push({ seq: 2, type: 'status', status: 'waiting_user', waiting });
		expect(store.activeFor('c1')?.waiting).toEqual(waiting);

		await vi.advanceTimersByTimeAsync(400);
		expect(h.conv.reloadActiveFromServer).toHaveBeenCalledTimes(1);

		h.svc.answer.mockResolvedValue({ ok: true });
		await store.answer('c1', { chosen: ['a'] });
		expect(h.svc.answer).toHaveBeenCalledWith('t1', { chosen: ['a'] });
	});

	it('a dropped stream reconnects from the last seq; the end reloads and drops the task', async () => {
		const stream = controllableStream();
		const store = await freshStore();
		h.conv.activeConversation = { id: 'c1', activeTaskId: 't1' };
		h.svc.get.mockResolvedValue(record());
		await store.watch('c1');
		stream.push({ seq: 5, type: 'turn' });
		stream.end(); // the connection dropped; the task is still running
		await vi.advanceTimersByTimeAsync(1000);
		expect(stream.calls).toEqual([0, 5]);

		h.svc.get.mockResolvedValue(record({ status: 'done' }));
		stream.push({ seq: 6, type: 'status', status: 'done' });
		expect(store.activeFor('c1')).toBeNull();
		h.conv.reloadActiveFromServer.mockClear();
		stream.end();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.conv.reloadActiveFromServer).toHaveBeenCalledWith('c1');
		await vi.advanceTimersByTimeAsync(5000);
		expect(stream.calls).toEqual([0, 5]); // no further reconnect
	});

	it('a failed task says why', async () => {
		const stream = controllableStream();
		const store = await freshStore();
		h.conv.activeConversation = { id: 'c1', activeTaskId: 't1' };
		h.svc.get.mockResolvedValue(record());
		await store.watch('c1');
		h.svc.get.mockResolvedValue(record({ status: 'failed', error: 'The account was disabled.' }));
		stream.end();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.toast.error).toHaveBeenCalledWith(expect.stringContaining('The account was disabled.'));
	});

	it('start sends the settings in the runner\'s names, then follows and reloads', async () => {
		controllableStream();
		const store = await freshStore();
		h.conv.activeConversation = { id: 'c1' };
		h.svc.start.mockResolvedValue(record());
		await store.start('c1', 'tidy the folder');
		expect(h.svc.start).toHaveBeenCalledWith('c1', 'tidy the folder', expect.objectContaining({
			temperature: 0.3,
			excludeReasoning: true,
			contextCompaction: false
		}));
		expect(store.activeFor('c1')?.id).toBe('t1');
		expect(h.conv.reloadActiveFromServer).toHaveBeenCalledWith('c1');
	});

	it('an approval is decided on /approvals with the pending id; cancel goes to the task', async () => {
		const stream = controllableStream();
		const store = await freshStore();
		h.conv.activeConversation = { id: 'c1', activeTaskId: 't1' };
		h.svc.get.mockResolvedValue(record());
		await store.watch('c1');
		stream.push({
			seq: 1,
			type: 'status',
			status: 'waiting_approval',
			waiting: { kind: 'approval', callId: 'x', tool: 'write_file', rule: 'prompt', approval: { id: 'ap-9', tool: 'write_file', summary: 's' } }
		});
		h.svc.decideApproval.mockResolvedValue({});
		await store.decideApproval('c1', 'once');
		expect(h.svc.decideApproval).toHaveBeenCalledWith('ap-9', 'once');
		h.svc.cancel.mockResolvedValue({ ok: true });
		await store.cancel('c1');
		expect(h.svc.cancel).toHaveBeenCalledWith('t1');
	});

	it('leaving the chat stops following it', async () => {
		const stream = controllableStream();
		const store = await freshStore();
		h.conv.activeConversation = { id: 'c1', activeTaskId: 't1' };
		h.svc.get.mockResolvedValue(record());
		await store.watch('c1');
		h.conv.activeConversation = { id: 'c2' };
		await store.watch('c2');
		expect(store.activeFor('c1')).toBeNull();
		await vi.advanceTimersByTimeAsync(5000);
		expect(stream.calls).toEqual([0]);
	});

	it('steer with no task is refused locally; a 409 on a chat with no followed task re-reads it', async () => {
		const store = await freshStore();
		expect(await store.steer('c1', 'hi')).toBe(false);
		controllableStream();
		h.conv.activeConversation = { id: 'c1' };
		h.svc.listFor.mockResolvedValue([record()]);
		h.taskActiveHandler?.('c1');
		await vi.advanceTimersByTimeAsync(0);
		expect(h.toast.info).toHaveBeenCalled();
		expect(h.svc.listFor).toHaveBeenCalledWith('c1');
		expect(store.activeFor('c1')?.id).toBe('t1');
	});
});
