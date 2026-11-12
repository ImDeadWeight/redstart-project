import { toast } from 'svelte-sonner';
import { conversationsStore } from '$lib/stores/conversations.svelte';
import { config } from '$lib/stores/settings.svelte';
import { getApiOptions } from '$lib/stores/chat/chat-options';
import { setTaskActiveHandler } from '$lib/services/database.service';
import {
	TaskService,
	isTerminal,
	type ApprovalDecision,
	type TaskAnswer,
	type TaskEvent,
	type TaskRecord
} from '$lib/services/task.service';

/**
 * tasksStore — chat-ui as a client of the daemon's background tasks
 * (agent-runtime Phase 3.9, U-b: in the chat itself).
 *
 * A task holds one conversation and writes it on the server; this store
 * follows the ACTIVE chat's task. Opening a chat whose record carries
 * `activeTaskId` (or that has a live task) follows its event stream. A
 * `status` event updates the record, so the status bar and the cards render
 * from `waiting`; an event that changes the conversation (a message, the
 * plan, a turn) reloads it from the server, throttled. A dropped stream
 * reconnects from the last seq while the task has not ended. At the end the
 * conversation is reloaded once more and the record is dropped.
 *
 * The browser loop is not involved: an ordinary chat never touches this.
 */

/** Events after which the stored conversation has changed. */
const RELOADING_EVENTS = new Set(['message', 'plan', 'turn', 'status', 'compacted', 'resumed']);
const RELOAD_THROTTLE_MS = 400;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 10_000;

/** The sampling settings the task runs every turn with, in the runner's names. */
export function taskGeneration(): Record<string, unknown> {
	const options = getApiOptions();
	const out: Record<string, unknown> = { ...options };
	if (options.excludeReasoningFromContext) out.excludeReasoning = true;
	const compaction = config().contextCompaction;
	if (typeof compaction === 'boolean') out.contextCompaction = compaction;
	return out;
}

interface Follower {
	taskId: string;
	conversationId: string;
	controller: AbortController;
	lastSeq: number;
}

class TasksStore {
	/** The followed task per conversation id; only live (not ended) tasks. */
	private records = $state<Record<string, TaskRecord>>({});
	private follower: Follower | null = null;
	private reloadTimer: ReturnType<typeof setTimeout> | null = null;

	constructor() {
		setTaskActiveHandler((conversationId) => {
			toast.info('A background task is writing this chat, so it was reloaded. Cancel the task to edit it.');
			const id = conversationId ?? conversationsStore.activeConversation?.id;
			if (!id) return;
			if (this.follower?.conversationId === id) void conversationsStore.reloadActiveFromServer(id);
			else void this.watch(id, { force: true });
		});
	}

	/** The live task holding this conversation, or null. */
	activeFor(conversationId: string | null | undefined): TaskRecord | null {
		if (!conversationId) return null;
		const record = this.records[conversationId];
		return record && !isTerminal(record.status) ? record : null;
	}

	/**
	 * Follow the task holding this conversation, if any; stop following any
	 * other. Called whenever the active chat changes. `force` re-reads even
	 * when the record says no task (after a 409, the record is the stale part).
	 */
	async watch(conversationId: string | null, opts: { force?: boolean } = {}): Promise<void> {
		if (this.follower && this.follower.conversationId !== conversationId) this.stopFollowing();
		if (!conversationId) return;
		if (this.follower?.conversationId === conversationId) return;

		const conv = conversationsStore.activeConversation;
		const hinted = conv?.id === conversationId ? conv.activeTaskId : undefined;
		if (!hinted && !opts.force) return;
		try {
			const record = hinted
				? await TaskService.get(hinted)
				: (await TaskService.listFor(conversationId)).find((t) => !isTerminal(t.status));
			if (!record || isTerminal(record.status)) {
				if (opts.force) await conversationsStore.reloadActiveFromServer(conversationId);
				return;
			}
			this.follow(record);
			if (opts.force) await conversationsStore.reloadActiveFromServer(conversationId);
		} catch {
			/* no task routes (an older Nest), or the task is gone: an ordinary chat */
		}
	}

	/**
	 * Start a task in this conversation with `content` as the user's message.
	 * The daemon writes the message itself; the chat is reloaded to show it.
	 */
	async start(conversationId: string, content: string): Promise<TaskRecord | null> {
		try {
			const record = await TaskService.start(conversationId, content, taskGeneration());
			this.follow(record);
			await conversationsStore.reloadActiveFromServer(conversationId);
			return record;
		} catch (error) {
			toast.error(error instanceof Error ? error.message : 'The task could not be started.');
			return null;
		}
	}

	/** A message typed while the task runs: steering, or the answer to an open question. */
	async steer(conversationId: string, content: string): Promise<boolean> {
		const record = this.activeFor(conversationId);
		if (!record) return false;
		try {
			await TaskService.steer(record.id, content);
			return true;
		} catch (error) {
			toast.error(error instanceof Error ? error.message : 'The message did not reach the task.');
			return false;
		}
	}

	async answer(conversationId: string, answer: TaskAnswer): Promise<void> {
		const record = this.activeFor(conversationId);
		if (!record) return;
		await this.act(() => TaskService.answer(record.id, answer), 'The answer did not reach the task.');
	}

	async decideApproval(conversationId: string, decision: ApprovalDecision): Promise<void> {
		const record = this.activeFor(conversationId);
		const waiting = record?.waiting;
		if (!record || waiting?.kind !== 'approval') return;
		await this.act(
			() => TaskService.decideApproval(waiting.approval.id, decision),
			'The decision did not reach the task.'
		);
	}

	async cancel(conversationId: string): Promise<void> {
		const record = this.activeFor(conversationId);
		if (!record) return;
		await this.act(() => TaskService.cancel(record.id), 'The task could not be cancelled.');
	}

	private async act(fn: () => Promise<unknown>, failure: string): Promise<void> {
		try {
			await fn();
		} catch (error) {
			toast.error(error instanceof Error && error.message ? error.message : failure);
		}
	}

	private follow(record: TaskRecord): void {
		if (this.follower?.taskId === record.id) return;
		this.stopFollowing();
		this.records = { ...this.records, [record.conversationId]: record };
		const follower: Follower = {
			taskId: record.id,
			conversationId: record.conversationId,
			controller: new AbortController(),
			lastSeq: 0
		};
		this.follower = follower;
		void this.run(follower);
	}

	private stopFollowing(): void {
		if (!this.follower) return;
		this.follower.controller.abort();
		const { conversationId } = this.follower;
		this.follower = null;
		const { [conversationId]: _dropped, ...rest } = this.records;
		this.records = rest;
	}

	/** Read the stream until the task ends, reconnecting from the last seq. */
	private async run(f: Follower): Promise<void> {
		let delay = RECONNECT_MIN_MS;
		while (!f.controller.signal.aborted) {
			try {
				await TaskService.readEvents(f.taskId, f.lastSeq, (e) => this.onEvent(f, e), f.controller.signal);
				delay = RECONNECT_MIN_MS;
			} catch {
				if (f.controller.signal.aborted) return;
			}
			if (f.controller.signal.aborted) return;
			// The stream ended: either the task did, or the connection dropped.
			try {
				const record = await TaskService.get(f.taskId);
				this.setRecord(f, record);
				if (isTerminal(record.status)) return this.finish(f, record);
			} catch (error) {
				if ((error as { status?: number })?.status === 404) return this.finish(f, null);
			}
			await new Promise((r) => setTimeout(r, delay));
			delay = Math.min(delay * 2, RECONNECT_MAX_MS);
		}
	}

	private onEvent(f: Follower, e: TaskEvent): void {
		if (this.follower !== f) return;
		if (e.seq > f.lastSeq) f.lastSeq = e.seq;
		if (e.type === 'status' && e.status) {
			const current = this.records[f.conversationId];
			if (current) {
				this.setRecord(f, {
					...current,
					status: e.status,
					waiting: e.waiting ?? null,
					error: e.error ?? null
				});
			}
		}
		if (RELOADING_EVENTS.has(e.type)) this.scheduleReload(f.conversationId);
	}

	private setRecord(f: Follower, record: TaskRecord): void {
		if (this.follower !== f) return;
		this.records = { ...this.records, [f.conversationId]: record };
	}

	private finish(f: Follower, record: TaskRecord | null): void {
		if (this.follower !== f) return;
		if (record?.status === 'failed') toast.error(`The background task failed: ${record.error || 'no reason given'}`);
		this.stopFollowing();
		if (this.reloadTimer) clearTimeout(this.reloadTimer);
		this.reloadTimer = null;
		void conversationsStore.reloadActiveFromServer(f.conversationId);
	}

	private scheduleReload(conversationId: string): void {
		if (this.reloadTimer) return;
		this.reloadTimer = setTimeout(() => {
			this.reloadTimer = null;
			void conversationsStore.reloadActiveFromServer(conversationId).catch(() => undefined);
		}, RELOAD_THROTTLE_MS);
	}
}

export const tasksStore = new TasksStore();
