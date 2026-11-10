import { beforeEach, describe, expect, it, vi } from 'vitest';

// Automatic memory's client half (projects-plan Phase 3): WHEN a chat is
// reviewed, and what Undo does. Nest decides what is proposed; it is mocked.

const svc = vi.hoisted(() => ({
	getSettings: vi.fn(),
	setMode: vi.fn(),
	suggestions: vi.fn(),
	review: vi.fn(),
	acceptSuggestion: vi.fn(),
	dismissSuggestion: vi.fn(),
	remove: vi.fn(),
	update: vi.fn()
}));
vi.mock('$lib/services/memory.service', () => ({ MemoryService: svc }));

async function freshStore() {
	vi.resetModules();
	const mod = await import('$lib/stores/memory-review.svelte');
	return { store: mod.memoryReviewStore, QUIET_MS: mod.QUIET_MS };
}

beforeEach(() => {
	vi.useFakeTimers();
	for (const f of Object.values(svc)) f.mockReset();
	svc.getSettings.mockResolvedValue({ mode: 'suggest', available: true });
	svc.suggestions.mockResolvedValue([]);
	svc.review.mockResolvedValue({ status: 'nothing' });
});

describe('memory review scheduling', () => {
	it('reviews a chat only after it has been quiet, and restarts the wait on each reply', async () => {
		const { store, QUIET_MS } = await freshStore();
		await store.scheduleReview('c1');
		await vi.advanceTimersByTimeAsync(QUIET_MS - 1000);
		await store.scheduleReview('c1');
		await vi.advanceTimersByTimeAsync(QUIET_MS - 1000);
		expect(svc.review).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1000);
		expect(svc.review).toHaveBeenCalledTimes(1);
		expect(svc.review).toHaveBeenCalledWith('c1');
	});

	it('reviews a chat straight away when the user leaves it', async () => {
		const { store } = await freshStore();
		await store.chatOpened('c1');
		await store.scheduleReview('c1');
		await store.chatOpened('c2');
		expect(svc.review).toHaveBeenCalledWith('c1');
		expect(svc.suggestions).toHaveBeenLastCalledWith('c2');
	});

	it('tries once more after a busy answer, then stops', async () => {
		const { store, QUIET_MS } = await freshStore();
		svc.review.mockResolvedValue({ status: 'busy' });
		await store.scheduleReview('c1');
		await vi.advanceTimersByTimeAsync(QUIET_MS);
		await vi.advanceTimersByTimeAsync(QUIET_MS);
		await vi.advanceTimersByTimeAsync(QUIET_MS * 3);
		expect(svc.review).toHaveBeenCalledTimes(2);
	});

	it('does nothing when the mode is off or memory is unavailable', async () => {
		svc.getSettings.mockResolvedValue({ mode: 'off', available: true });
		let { store, QUIET_MS } = await freshStore();
		await store.scheduleReview('c1');
		await vi.advanceTimersByTimeAsync(QUIET_MS * 2);
		svc.getSettings.mockResolvedValue({ mode: 'suggest', available: false });
		({ store, QUIET_MS } = await freshStore());
		await store.scheduleReview('c1');
		await vi.advanceTimersByTimeAsync(QUIET_MS * 2);
		expect(svc.review).not.toHaveBeenCalled();
	});

	it('shows new suggestions in the open chat only', async () => {
		const { store, QUIET_MS } = await freshStore();
		const s = {
			id: 's1',
			op: 'add',
			text: 'Uses vim',
			scope: 'user',
			conversationId: 'c1',
			createdAt: 1
		};
		svc.review.mockResolvedValue({ status: 'done', mode: 'suggest', suggestions: [s] });
		await store.chatOpened('c1');
		await store.scheduleReview('c1');
		await vi.advanceTimersByTimeAsync(QUIET_MS);
		expect(store.suggestions.map((x) => x.id)).toEqual(['s1']);
		await store.chatOpened('c2');
		expect(store.suggestions).toEqual([]);
	});
});

describe('undo of an automatic save', () => {
	it('deletes an added memory, from its project when it has one', async () => {
		const { store } = await freshStore();
		const entry = {
			conversationId: 'c1',
			item: {
				op: 'add' as const,
				scope: 'project' as const,
				projectId: 'p1',
				memory: { id: 'm1' } as never
			}
		};
		store.saved = [entry];
		await store.undo(entry);
		expect(svc.remove).toHaveBeenCalledWith('m1', 'p1');
		expect(store.saved).toEqual([]);
	});

	it('puts an updated memory back the way it was, instead of deleting it', async () => {
		const { store } = await freshStore();
		const entry = {
			conversationId: 'c1',
			item: {
				op: 'update' as const,
				scope: 'user' as const,
				previousText: 'Uses Postgres 15',
				memory: { id: 'm2', text: 'Uses Postgres 16' } as never
			}
		};
		store.saved = [entry];
		await store.undo(entry);
		expect(svc.update).toHaveBeenCalledWith('m2', 'Uses Postgres 15', null);
		expect(svc.remove).not.toHaveBeenCalled();
	});
});
