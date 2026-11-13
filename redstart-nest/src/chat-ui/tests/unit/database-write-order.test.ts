import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * database-write-order - concurrent writes must not erase each other
 *
 * Every DatabaseService write is a read-modify-write of the WHOLE conversation:
 * GET it, change the message list, PUT the list back. Two of those in flight
 * at once lose the first one's change. Found by hand on 2026-11-10 (agent-
 * runtime plan, test 7, steering): when a steered agentic flow ends,
 * onFlowComplete saves the final timings with an un-awaited updateMessage
 * while the steering re-send immediately adds the user's new message. The
 * timings save read the conversation before the new message existed and wrote
 * it back after, erasing it; the assistant reply then failed with "Parent
 * message not found".
 *
 * The fake server here delays reads more than writes, which forces exactly
 * that interleaving every time instead of once in a while.
 */

const { DatabaseService } = await import('$lib/services/database.service');

type Msg = { id: string; parent: string | null; children: string[]; [k: string]: unknown };
type Conv = { id: string; name: string; currNode: string; messages: Msg[]; [k: string]: unknown };

let store: Map<string, Conv>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

function fakeFetch(readDelayMs: number, writeDelayMs: number) {
	return vi.fn(async (input: string | URL, init?: RequestInit) => {
		const url = new URL(String(input), 'http://x');
		const method = init?.method ?? 'GET';
		const one = /^\/conversations\/([^/]+)$/.exec(url.pathname);
		const json = (body: unknown, status = 200) =>
			new Response(body === undefined ? null : JSON.stringify(body), {
				status,
				headers: { 'Content-Type': 'application/json' }
			});

		if (method === 'GET' && url.pathname === '/conversations') {
			const snapshot = clone([...store.values()]);
			await sleep(readDelayMs);
			return json(snapshot);
		}
		if (method === 'GET' && one) {
			const snapshot = clone(store.get(one[1]));
			await sleep(readDelayMs);
			return snapshot ? json(snapshot) : json({ error: 'not found' }, 404);
		}
		if (method === 'PUT' && one) {
			const body = JSON.parse(String(init?.body));
			await sleep(writeDelayMs);
			// The real route merges the body into the record (conversations-storage).
			store.set(one[1], { ...store.get(one[1])!, ...body });
			return json(store.get(one[1]));
		}
		return json({ error: `no route ${method} ${url.pathname}` }, 404);
	});
}

beforeEach(() => {
	const ls = new Map<string, string>();
	vi.stubGlobal('localStorage', {
		getItem: (k: string) => ls.get(k) ?? null,
		setItem: (k: string, v: string) => void ls.set(k, v),
		removeItem: (k: string) => void ls.delete(k)
	});
	store = new Map([
		[
			'c1',
			{
				id: 'c1',
				name: 'chat',
				currNode: 'a1',
				messages: [
					{ id: 'root', parent: null, children: ['u1'], type: 'root' },
					{ id: 'u1', parent: 'root', children: ['a1'], role: 'user', content: 'hi' },
					{ id: 'a1', parent: 'u1', children: [], role: 'assistant', content: 'hello' }
				]
			}
		]
	]);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

const userMsg = { convId: 'c1', type: 'text', role: 'user', content: 'actually, a joke', timestamp: 1, toolCalls: '', children: [] };
const asstMsg = { convId: 'c1', type: 'text', role: 'assistant', content: '', timestamp: 2, toolCalls: '', children: [] };

describe('DatabaseService write ordering', () => {
	it('a fire-and-forget updateMessage cannot erase a message added right after it', async () => {
		// Reads slow, writes fast: the timings save reads first and writes last.
		vi.stubGlobal('fetch', fakeFetch(30, 5));

		// onFlowComplete: not awaited, exactly as chat-send.svelte.ts does it.
		const timingsSave = DatabaseService.updateMessage('a1', { timings: { predicted_n: 9 } } as never);
		// The steering re-send: the user's new message, then the assistant reply under it.
		const user = await DatabaseService.createMessageBranch(userMsg as never, 'a1');
		const reply = await DatabaseService.createMessageBranch(asstMsg as never, user.id);
		await timingsSave;

		const ids = store.get('c1')!.messages.map((m) => m.id);
		expect(ids).toContain(user.id);
		expect(ids).toContain(reply.id);
		expect(store.get('c1')!.messages.find((m) => m.id === 'a1')?.timings).toEqual({ predicted_n: 9 });
	});

	it('concurrent branches under the same parent all keep their place in its children', async () => {
		vi.stubGlobal('fetch', fakeFetch(20, 5));

		const made = await Promise.all([
			DatabaseService.createMessageBranch(userMsg as never, 'a1'),
			DatabaseService.createMessageBranch(userMsg as never, 'a1'),
			DatabaseService.createMessageBranch(userMsg as never, 'a1')
		]);

		const conv = store.get('c1')!;
		for (const m of made) expect(conv.messages.map((x) => x.id)).toContain(m.id);
		expect(conv.messages.find((m) => m.id === 'a1')!.children.sort()).toEqual(made.map((m) => m.id).sort());
	});

	it('toggleConversationPin, which writes through updateConversation, still completes', async () => {
		vi.stubGlobal('fetch', fakeFetch(5, 5));

		await expect(DatabaseService.toggleConversationPin('c1')).resolves.toBe(true);
		expect(store.get('c1')!.pinned).toBe(true);
	});

	it('a failed write does not jam the queue for the next one', async () => {
		vi.stubGlobal('fetch', fakeFetch(5, 5));

		await expect(DatabaseService.createMessageBranch(userMsg as never, 'no-such-parent')).rejects.toThrow(
			'Parent message not found'
		);
		const next = await DatabaseService.createMessageBranch(userMsg as never, 'a1');
		expect(store.get('c1')!.messages.map((m) => m.id)).toContain(next.id);
	});
});
