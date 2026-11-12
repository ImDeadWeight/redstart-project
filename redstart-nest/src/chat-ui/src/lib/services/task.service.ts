import { resolveApiPath } from '$lib/utils/api-fetch';
import { browserTimeZone } from '$lib/utils/api-headers';
import { conversationHeaders } from './database.service';
import type { AskRequest } from '$lib/agent-core';

/**
 * TaskService — the daemon's background-task routes (agent-runtime Phase 3.6,
 * D31), as chat-ui calls them (3.9).
 *
 * A task is the daemon running the agent loop for one conversation with no
 * browser attached: it writes the conversation itself, parks for questions,
 * approvals and the turn limit, and logs numbered events. This client starts
 * one, follows its events, and answers what it waits on. Every route is
 * scoped like the conversation routes (session, or the device id with auth
 * off), so the same headers are sent.
 *
 * Events are Server-Sent Events read with fetch: EventSource cannot send
 * Authorization.
 */

export type TaskStatus =
	| 'queued'
	| 'running'
	| 'waiting_user'
	| 'waiting_approval'
	| 'waiting_model'
	| 'done'
	| 'failed'
	| 'cancelled';

export const TERMINAL_TASK_STATES: readonly TaskStatus[] = ['done', 'failed', 'cancelled'];

/** What a waiting task waits for (task-runner.mjs). */
export type TaskWaiting =
	| ({ kind: 'question'; callId?: string } & AskRequest)
	| { kind: 'continue'; turns?: number }
	| {
			kind: 'approval';
			callId: string;
			tool: string;
			rule: string;
			approval: { id: string; tool: string; summary: string; expiresAt?: number };
	  }
	| { kind: 'model' };

export interface TaskRecord {
	id: string;
	conversationId: string;
	status: TaskStatus;
	waiting: TaskWaiting | null;
	error?: string | null;
	createdAt: number;
	updatedAt: number;
}

/** One log entry. `status` events carry the task's new status and waiting. */
export interface TaskEvent {
	seq: number;
	type: string;
	status?: TaskStatus;
	waiting?: TaskWaiting | null;
	error?: string;
	[k: string]: unknown;
}

export type TaskAnswer =
	| { chosen?: string[]; text?: string }
	| { dismissed: true }
	| { continue: boolean };

export type ApprovalDecision = 'once' | 'always' | 'deny';

export class TaskRequestError extends Error {
	constructor(
		message: string,
		readonly status: number
	) {
		super(message);
		this.name = 'TaskRequestError';
	}
}

/**
 * The permission card's decision as POST /approvals takes it. "Always for
 * this server" has no server-side meaning (grants are per tool), so it is
 * "always"; the server already turns "always" on a destructive tool into once.
 */
export function approvalDecisionFor(decision: string): ApprovalDecision {
	if (decision === 'always' || decision === 'always_server') return 'always';
	if (decision === 'once') return 'once';
	return 'deny';
}

/** The status bar's words for a task's state. */
export function taskStatusLabel(record: Pick<TaskRecord, 'status' | 'waiting'>): string {
	switch (record.status) {
		case 'queued':
			return 'Background task queued';
		case 'running':
			return 'Background task running';
		case 'waiting_user':
			return record.waiting?.kind === 'continue'
				? 'Background task paused at the turn limit'
				: 'Background task is asking you something';
		case 'waiting_approval':
			return 'Background task needs your approval';
		case 'waiting_model':
			return 'Background task waiting for a model to load';
		case 'done':
			return 'Background task finished';
		case 'failed':
			return 'Background task failed';
		case 'cancelled':
			return 'Background task cancelled';
	}
}

export function isTerminal(status: TaskStatus | undefined | null): boolean {
	return !!status && TERMINAL_TASK_STATES.includes(status);
}

function headers(extra?: Record<string, string>): Record<string, string> {
	const tz = browserTimeZone();
	return { ...conversationHeaders(), ...(tz ? { 'X-Redstart-Timezone': tz } : {}), ...(extra ?? {}) };
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
	const res = await fetch(resolveApiPath(path), { ...init, headers: headers() });
	const data = await res.json().catch(() => null);
	if (!res.ok) {
		const message = data?.error?.message || `${res.status} ${res.statusText}`;
		throw new TaskRequestError(message, res.status);
	}
	return data as T;
}

const post = <T>(path: string, body?: unknown) =>
	call<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });

/**
 * Complete frames out of an SSE buffer: `{ events, rest }`, where `rest` is
 * the unfinished tail to prepend to the next chunk. Comment lines (the
 * heartbeat) and frames with no data are skipped; a frame whose data is not
 * JSON is dropped rather than ending the stream.
 */
export function parseSseFrames(buffer: string): { events: TaskEvent[]; rest: string } {
	const normalized = buffer.replace(/\r\n/g, '\n');
	const parts = normalized.split('\n\n');
	const rest = parts.pop() ?? '';
	const events: TaskEvent[] = [];
	for (const part of parts) {
		const data = part
			.split('\n')
			.filter((line) => line.startsWith('data:'))
			.map((line) => line.slice(5).replace(/^ /, ''))
			.join('\n');
		if (!data) continue;
		try {
			const event = JSON.parse(data);
			if (event && typeof event.seq === 'number' && typeof event.type === 'string') events.push(event);
		} catch {
			/* a torn or foreign frame: skip it */
		}
	}
	return { events, rest };
}

export class TaskService {
	static start(
		conversationId: string,
		content: string,
		generation: Record<string, unknown>
	): Promise<TaskRecord> {
		return post<TaskRecord>('/tasks', { conversationId, content, generation });
	}

	static async listFor(conversationId: string): Promise<TaskRecord[]> {
		const data = await call<{ tasks: TaskRecord[] }>(
			`/tasks?conversationId=${encodeURIComponent(conversationId)}`
		);
		return data?.tasks ?? [];
	}

	static get(id: string): Promise<TaskRecord> {
		return call<TaskRecord>(`/tasks/${id}`);
	}

	/** `as`: 'answer' when the task was waiting on a question and took this as the answer. */
	static steer(id: string, content: string): Promise<{ ok: true; as?: 'answer' | 'steer' }> {
		return post(`/tasks/${id}/steer`, { content });
	}

	static answer(id: string, answer: TaskAnswer): Promise<{ ok: true }> {
		return post(`/tasks/${id}/answer`, answer);
	}

	static cancel(id: string): Promise<{ ok: true }> {
		return post(`/tasks/${id}/cancel`);
	}

	/** An approval a task waits on is decided where every approval is (Phase 2). */
	static decideApproval(approvalId: string, decision: ApprovalDecision): Promise<unknown> {
		return post(`/approvals/${approvalId}`, { decision });
	}

	/**
	 * The task's events after `afterSeq`, then live, until the server closes
	 * the stream (the task ended) or `signal` aborts. Resolves when the stream
	 * ends; rejects on a failed request or a dropped connection.
	 */
	static async readEvents(
		id: string,
		afterSeq: number,
		onEvent: (event: TaskEvent) => void,
		signal: AbortSignal
	): Promise<void> {
		const res = await fetch(resolveApiPath(`/tasks/${id}/events?after=${afterSeq}`), {
			headers: headers({ Accept: 'text/event-stream' }),
			signal
		});
		if (!res.ok || !res.body) throw new TaskRequestError(`${res.status} ${res.statusText}`, res.status);
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const parsed = parseSseFrames(buffer);
			buffer = parsed.rest;
			for (const event of parsed.events) onEvent(event);
		}
		const tail = parseSseFrames(buffer + '\n\n');
		for (const event of tail.events) onEvent(event);
	}
}
