import {
	MemoryService,
	type AutoMemoryMode,
	type MemorySuggestion,
	type ReviewedMemory
} from '$lib/services/memory.service';

/**
 * Automatic memory, client side (projects-plan Phase 3).
 *
 * Nest does the review (it reads only the user's own messages, and decides
 * what to propose); this store decides WHEN to ask, and holds what came back
 * so the chat can show it:
 *
 *  - a chat is reviewed once it has been quiet for QUIET_MS after a reply,
 *    or straight away when the user leaves it for another chat. Not after
 *    every reply: on a single-slot server the review's request replaces the
 *    chat's cached prompt, and the next reply would have to re-read it.
 *  - Nest answers `busy` while any reply is being generated; that chat is
 *    then tried once more after another quiet period. Unreviewed messages are
 *    never lost: Nest only marks what it actually reviewed.
 *  - suggestions (Suggest mode) are kept server-side, so they are reloaded
 *    whenever a chat opens; memories saved in Automatic mode are shown in the
 *    chat they came from until the user moves on.
 */

export const QUIET_MS = 90_000;

class MemoryReviewStore {
	mode = $state<AutoMemoryMode>('suggest');
	available = $state(false);
	settingsLoaded = $state(false);

	/** Pending suggestions for the open chat. */
	suggestions = $state<MemorySuggestion[]>([]);
	/** Memories the review saved (Automatic), with the chat they came from. */
	saved = $state<{ conversationId: string; item: ReviewedMemory }[]>([]);

	private timers = new Map<string, ReturnType<typeof setTimeout>>();
	private retried = new Set<string>();
	private openChat: string | null = null;
	private settingsInFlight: Promise<void> | null = null;

	ensureSettings(): Promise<void> {
		if (this.settingsLoaded) return Promise.resolve();
		if (this.settingsInFlight) return this.settingsInFlight;
		this.settingsInFlight = MemoryService.getSettings()
			.then((s) => {
				this.mode = s.mode;
				this.available = s.available;
			})
			.catch(() => {
				// An older Nest has no /memories/settings: nothing to schedule.
				this.available = false;
			})
			.finally(() => {
				this.settingsLoaded = true;
				this.settingsInFlight = null;
			});
		return this.settingsInFlight;
	}

	async setMode(mode: AutoMemoryMode): Promise<void> {
		const s = await MemoryService.setMode(mode);
		this.mode = s.mode;
		this.available = s.available;
		if (mode === 'off') this.cancelAll();
	}

	private get active(): boolean {
		return this.available && this.mode !== 'off';
	}

	/** After a reply finishes: review this chat once it has been quiet a while. */
	async scheduleReview(conversationId: string): Promise<void> {
		await this.ensureSettings();
		if (!this.active) return;
		clearTimeout(this.timers.get(conversationId));
		this.timers.set(
			conversationId,
			setTimeout(() => void this.run(conversationId), QUIET_MS)
		);
	}

	/**
	 * The open chat changed. Any other chat waiting for its quiet period is
	 * reviewed now (the user has left it), and the new chat's pending
	 * suggestions are loaded.
	 */
	async chatOpened(conversationId: string | null): Promise<void> {
		if (conversationId === this.openChat) return;
		this.openChat = conversationId;
		this.saved = this.saved.filter((s) => s.conversationId === conversationId);
		for (const id of [...this.timers.keys()]) {
			if (id !== conversationId) {
				clearTimeout(this.timers.get(id));
				this.timers.delete(id);
				void this.run(id);
			}
		}
		this.suggestions = [];
		if (!conversationId) return;
		await this.ensureSettings();
		if (!this.available) return;
		try {
			const list = await MemoryService.suggestions(conversationId);
			if (this.openChat === conversationId) this.suggestions = list;
		} catch {
			// Not worth interrupting the chat for.
		}
	}

	private async run(conversationId: string): Promise<void> {
		this.timers.delete(conversationId);
		if (!this.active) return;
		let result;
		try {
			result = await MemoryService.review(conversationId);
		} catch {
			return;
		}
		if (result.status === 'busy' && !this.retried.has(conversationId)) {
			this.retried.add(conversationId);
			this.timers.set(
				conversationId,
				setTimeout(() => void this.run(conversationId), QUIET_MS)
			);
			return;
		}
		this.retried.delete(conversationId);
		if (result.status !== 'done') return;
		if ('suggestions' in result && this.openChat === conversationId) {
			const known = new Set(this.suggestions.map((s) => s.id));
			this.suggestions = [
				...this.suggestions,
				...result.suggestions.filter((s) => !known.has(s.id))
			];
		}
		if ('saved' in result && result.saved.length > 0) {
			this.saved = [...this.saved, ...result.saved.map((item) => ({ conversationId, item }))];
		}
	}

	async accept(s: MemorySuggestion): Promise<ReviewedMemory> {
		try {
			return await MemoryService.acceptSuggestion(s.id);
		} finally {
			this.suggestions = this.suggestions.filter((x) => x.id !== s.id);
		}
	}

	async dismiss(s: MemorySuggestion): Promise<void> {
		await MemoryService.dismissSuggestion(s.id);
		this.suggestions = this.suggestions.filter((x) => x.id !== s.id);
	}

	/**
	 * Undo a memory the review saved. An addition is deleted; an update gets
	 * its previous text back, since the memory existed before the review.
	 */
	async undo(entry: { conversationId: string; item: ReviewedMemory }): Promise<void> {
		const { item } = entry;
		const projectId = item.projectId ?? null;
		if (item.op === 'update' && item.previousText) {
			await MemoryService.update(item.memory.id, item.previousText, projectId);
		} else {
			await MemoryService.remove(item.memory.id, projectId);
		}
		this.saved = this.saved.filter((s) => s !== entry);
	}

	/** Hide a saved memory's notice without undoing it. */
	acknowledge(entry: { conversationId: string; item: ReviewedMemory }): void {
		this.saved = this.saved.filter((s) => s !== entry);
	}

	private cancelAll(): void {
		for (const t of this.timers.values()) clearTimeout(t);
		this.timers.clear();
		this.suggestions = [];
	}
}

export const memoryReviewStore = new MemoryReviewStore();
