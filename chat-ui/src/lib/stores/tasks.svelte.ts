import { toast } from 'svelte-sonner';
import { conversationsStore } from '$lib/stores/conversations.svelte';
import { config } from '$lib/stores/settings.svelte';
import { getApiOptions } from '$lib/stores/chat/chat-options';
import { setTaskActiveHandler } from '$lib/services/database.service';
import { agenticStore } from '$lib/stores/agentic.svelte';
import { toolsStore } from '$lib/stores/tools.svelte';
import { MessageRole, MessageType } from '$lib/enums';
import {
	TaskService,
	isTerminal,
	isChatRun,
	type ApprovalDecision,
	type ClientToolSpec,
	type TaskToolLimits,
	type TaskOrigin,
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
 * Since master plan Phase 7 a plain Send starts a task too (setting "Run
 * chats on the server"). The stream then also carries live events: `delta`
 * tokens, shown in a placeholder reply until the stored message replaces it,
 * and `client_request`, a call to a tool this app runs (Twig's files, the
 * sandbox, a browser-reached MCP server), run here with its own approval
 * card and posted back.
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
	/** This app runs the task's client tools (7.1). */
	asClient: boolean;
	/** Register this app's tools on the first connect (a task picked up after a reload). */
	registerOnConnect: boolean;
	/** The reply being written, from live tokens, until it is stored. */
	live: { messageId: string; content: string; reasoning: string } | null;
}

/** Is a plain Send a run on the server? (Settings: "Run chats on the server".) */
export function serverRunsOn(): boolean {
	return config().serverRuns !== false;
}

class TasksStore {
	/** The followed task per conversation id; only live (not ended) tasks. */
	private records = $state<Record<string, TaskRecord>>({});
	private follower: Follower | null = null;
	private reloadTimer: ReturnType<typeof setTimeout> | null = null;

	constructor() {
		setTaskActiveHandler((conversationId) => {
			toast.info(
				'A background task is writing this chat, so it was reloaded. Cancel the task to edit it.'
			);
			const id = conversationId ?? conversationsStore.activeConversation?.id;
			if (!id) return;
			if (this.follower?.conversationId === id) void conversationsStore.reloadActiveFromServer(id);
			else void this.watch(id, { force: true });
		});
	}

	/**
	 * A run is writing a reply in this conversation right now (running, not
	 * waiting on anyone). The message UI treats this like its own streaming:
	 * without it an open reasoning block read "Cancelled" while it was still
	 * filling, because only the browser loop set the streaming flag
	 * (found 2026-11-19).
	 */
	isRunningIn(conversationId: string | null | undefined): boolean {
		if (!conversationId) return false;
		return this.records[conversationId]?.status === 'running';
	}

	/**
	 * Hooks the chat store sets (tasks cannot import it: chat-send imports
	 * this store). onLiveTimings: llama-server's timings from a delta, for the
	 * live context / speed readout. onChatRunFinished: a chat-origin run
	 * ended, so the conversation can be named as the browser loop does.
	 */
	onLiveTimings: ((conversationId: string, timings: Record<string, number>) => void) | null = null;
	onChatRunFinished: ((conversationId: string, record: TaskRecord) => void) | null = null;

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
	async start(
		conversationId: string,
		content: string,
		clientTools?: ClientToolSpec[],
		opts: { quiet?: boolean; toolLimits?: TaskToolLimits; origin?: TaskOrigin } = {}
	): Promise<TaskRecord | null> {
		try {
			const record = await TaskService.start(
				conversationId,
				content,
				taskGeneration(),
				clientTools,
				opts.toolLimits,
				opts.origin
			);
			this.follow(record, { registered: true });
			await conversationsStore.reloadActiveFromServer(conversationId);
			return record;
		} catch (error) {
			// quiet: the caller falls back to the browser loop (a plain Send).
			if (opts.quiet) console.warn('[tasks] a run on the server did not start:', error);
			else toast.error(error instanceof Error ? error.message : 'The task could not be started.');
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

	/** True when the task took the answer. */
	async answer(conversationId: string, answer: TaskAnswer): Promise<boolean> {
		const record = this.activeFor(conversationId);
		if (!record) return false;
		return this.act(
			() => TaskService.answer(record.id, answer),
			'The answer did not reach the task.'
		);
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

	private async act(fn: () => Promise<unknown>, failure: string): Promise<boolean> {
		try {
			await fn();
			return true;
		} catch (error) {
			toast.error(error instanceof Error && error.message ? error.message : failure);
			return false;
		}
	}

	private follow(record: TaskRecord, opts: { registered?: boolean } = {}): void {
		if (this.follower?.taskId === record.id) return;
		this.stopFollowing();
		this.records = { ...this.records, [record.conversationId]: record };
		const asClient = serverRunsOn();
		const follower: Follower = {
			taskId: record.id,
			conversationId: record.conversationId,
			controller: new AbortController(),
			lastSeq: 0,
			asClient,
			registerOnConnect: asClient && !opts.registered,
			live: null
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
				if (f.registerOnConnect) {
					f.registerOnConnect = false;
					const tools = toolsStore.getClientToolsForServerRun();
					try {
						if (tools.length) await TaskService.registerClient(f.taskId, tools);
					} catch {
						/* the run goes on with the tools it had; a call to one is answered unavailable */
					}
				}
				await TaskService.readEvents(
					f.taskId,
					f.lastSeq,
					(e) => this.onEvent(f, e),
					f.controller.signal,
					f.asClient
				);
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
		if (e.live === true) {
			if (e.type === 'delta') this.onDelta(f, e);
			else if (e.type === 'client_request') void this.onClientRequest(f, e);
			return;
		}
		if (e.seq > f.lastSeq) f.lastSeq = e.seq;
		// The stored message replaces the live one at the next reload.
		if (e.type === 'message') f.live = null;
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

	/**
	 * Tokens of the reply being written. They go into a placeholder message
	 * with the id the stored one will have, so the reload that brings the
	 * finished message replaces it in place.
	 */
	private onDelta(f: Follower, e: TaskEvent): void {
		if (conversationsStore.activeConversation?.id !== f.conversationId) return;
		const messageId = typeof e.messageId === 'string' ? e.messageId : '';
		if (!messageId) return;
		if (f.live?.messageId !== messageId) f.live = { messageId, content: '', reasoning: '' };
		if (typeof e.content === 'string') f.live.content += e.content;
		if (typeof e.reasoning === 'string') f.live.reasoning += e.reasoning;
		if (e.timings && typeof e.timings === 'object') {
			try {
				this.onLiveTimings?.(f.conversationId, e.timings as Record<string, number>);
			} catch {
				/* a readout is not worth breaking the stream for */
			}
		}
		this.showLive(f);
	}

	/**
	 * Put the reply so far into its placeholder, adding it if a reload took
	 * it away. The text is held here, not in the message, so a reload in the
	 * middle of a turn loses nothing.
	 */
	private showLive(f: Follower): void {
		const live = f.live;
		if (!live || conversationsStore.activeConversation?.id !== f.conversationId) return;
		const { messageId } = live;
		let index = conversationsStore.findMessageIndex(messageId);
		if (index === -1) {
			const last = conversationsStore.activeMessages.at(-1);
			conversationsStore.addMessageToActive({
				id: messageId,
				convId: f.conversationId,
				type: MessageType.TEXT,
				role: MessageRole.ASSISTANT,
				content: '',
				timestamp: Date.now(),
				parent: last?.id ?? null,
				children: [],
				model: null
			});
			index = conversationsStore.findMessageIndex(messageId);
			if (index === -1) return;
		}
		conversationsStore.updateMessageAtIndex(index, {
			content: live.content,
			...(live.reasoning ? { reasoningContent: live.reasoning } : {})
		});
	}

	/** A call to a tool this app runs: its own card, its executor, the result back. */
	private async onClientRequest(f: Follower, e: TaskEvent): Promise<void> {
		const callId = typeof e.callId === 'string' ? e.callId : '';
		const name = typeof e.name === 'string' ? e.name : '';
		if (!callId || !name) return;
		const args = typeof e.arguments === 'string' ? e.arguments : '';
		const result = await agenticStore.runClientCall(
			f.conversationId,
			{ id: callId, name, arguments: args },
			f.controller.signal
		);
		if (f.controller.signal.aborted) return;
		try {
			await TaskService.clientResult(f.taskId, callId, result.text, result.isError);
		} catch {
			/* the run moved on (cancelled, or the call was closed as unavailable) */
		}
	}

	private setRecord(f: Follower, record: TaskRecord): void {
		if (this.follower !== f) return;
		this.records = { ...this.records, [f.conversationId]: record };
	}

	private finish(f: Follower, record: TaskRecord | null): void {
		if (this.follower !== f) return;
		if (record?.status === 'failed')
			toast.error(`The background task failed: ${record.error || 'no reason given'}`);
		this.stopFollowing();
		if (this.reloadTimer) clearTimeout(this.reloadTimer);
		this.reloadTimer = null;
		const reloaded = conversationsStore.reloadActiveFromServer(f.conversationId);
		// After the reload, so the namer reads the finished conversation.
		if (record && isChatRun(record)) {
			void Promise.resolve(reloaded)
				.catch(() => undefined)
				.then(() => this.onChatRunFinished?.(f.conversationId, record));
		}
	}

	private scheduleReload(conversationId: string): void {
		if (this.reloadTimer) return;
		this.reloadTimer = setTimeout(() => {
			this.reloadTimer = null;
			void conversationsStore
				.reloadActiveFromServer(conversationId)
				.then(() => {
					// A reload mid-turn drops the placeholder: put the reply back.
					const f = this.follower;
					if (f?.conversationId === conversationId) this.showLive(f);
				})
				.catch(() => undefined);
		}, RELOAD_THROTTLE_MS);
	}
}

export const tasksStore = new TasksStore();
