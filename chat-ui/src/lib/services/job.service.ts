import { resolveApiPath } from '$lib/utils/api-fetch';
import { browserTimeZone } from '$lib/utils/api-headers';
import { conversationHeaders } from './database.service';
import type { AskRequest } from '$lib/agent-core';

/**
 * JobService — the daemon's background-task routes (agent-runtime Phase 3.6,
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

export type JobStatus =
	| 'queued'
	| 'running'
	| 'waiting_user'
	| 'waiting_approval'
	| 'waiting_model'
	| 'waiting_client'
	| 'done'
	| 'failed'
	| 'cancelled';

export const TERMINAL_JOB_STATES: readonly JobStatus[] = ['done', 'failed', 'cancelled'];

/** What a waiting task waits for (task-runner.mjs). */
export type JobWaiting =
	| ({ kind: 'question'; callId?: string } & AskRequest)
	/** A record written before D43 (one flat question); read as a one-item list. */
	| {
			kind: 'question';
			callId?: string;
			question: string;
			options?: string[];
			multiSelect?: boolean;
	  }
	| { kind: 'continue'; turns?: number }
	| {
			kind: 'approval';
			callId: string;
			tool: string;
			rule: string;
			approval: { id: string; tool: string; summary: string; expiresAt?: number };
	  }
	| { kind: 'model' }
	/** A call to a tool this app runs (master plan 7.1). */
	| { kind: 'client'; callId: string; tool: string };

/**
 * Who started a task: 'chat' is a plain Send run on the server (master plan
 * Phase 7), shown as an ordinary reply with the composer's Stop; 'background'
 * is a task the user sent to the background (/background), shown with the
 * task bar. A Nest from before the field sends none: read it as background.
 */
export type JobOrigin = 'chat' | 'background';

export interface JobRecord {
	id: string;
	conversationId: string;
	origin?: JobOrigin;
	status: JobStatus;
	waiting: JobWaiting | null;
	error?: string | null;
	createdAt: number;
	updatedAt: number;
}

/** One log entry. `status` events carry the task's new status and waiting. */
export interface JobEvent {
	seq: number;
	type: string;
	status?: JobStatus;
	waiting?: JobWaiting | null;
	error?: string;
	[k: string]: unknown;
}

/** A tool this app runs itself, as a task start registers it (master plan 7.1). */
export interface ClientToolSpec {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

/** Nest's tools this app switched off for the chat (master plan 7.1). */
export interface JobToolLimits {
	nest: boolean;
	exclude: string[];
}

export type JobAnswer =
	| { chosen?: string[]; text?: string }
	| { answers: Array<{ chosen?: string[]; text?: string } | null> }
	| { dismissed: true }
	| { continue: boolean };

export type ApprovalDecision = 'once' | 'always' | 'deny';

export class JobRequestError extends Error {
	constructor(
		message: string,
		readonly status: number
	) {
		super(message);
		this.name = 'JobRequestError';
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
export function jobStatusLabel(record: Pick<JobRecord, 'status' | 'waiting'>): string {
	switch (record.status) {
		case 'queued':
			return 'Background job queued';
		case 'running':
			return 'Background job running';
		case 'waiting_user':
			return record.waiting?.kind === 'continue'
				? 'Background job paused at the turn limit'
				: 'Background job is asking you something';
		case 'waiting_approval':
			return 'Background job needs your approval';
		case 'waiting_model':
			return 'Background job waiting for a model to load';
		case 'waiting_client':
			return 'Running a tool in this app';
		case 'done':
			return 'Background job finished';
		case 'failed':
			return 'Background job failed';
		case 'cancelled':
			return 'Background job cancelled';
	}
}

/** A plain Send's run: no task bar, the composer shows it as a reply in progress. */
export function isChatRun(record: Pick<JobRecord, 'origin'> | null | undefined): boolean {
	return record?.origin === 'chat';
}

export function isTerminal(status: JobStatus | undefined | null): boolean {
	return !!status && TERMINAL_JOB_STATES.includes(status);
}

function headers(extra?: Record<string, string>): Record<string, string> {
	const tz = browserTimeZone();
	return {
		...conversationHeaders(),
		...(tz ? { 'X-Redstart-Timezone': tz } : {}),
		...(extra ?? {})
	};
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
	const res = await fetch(resolveApiPath(path), { ...init, headers: headers() });
	const data = await res.json().catch(() => null);
	if (!res.ok) {
		const message = data?.error?.message || `${res.status} ${res.statusText}`;
		throw new JobRequestError(message, res.status);
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
export function parseSseFrames(buffer: string): { events: JobEvent[]; rest: string } {
	const normalized = buffer.replace(/\r\n/g, '\n');
	const parts = normalized.split('\n\n');
	const rest = parts.pop() ?? '';
	const events: JobEvent[] = [];
	for (const part of parts) {
		const data = part
			.split('\n')
			.filter((line) => line.startsWith('data:'))
			.map((line) => line.slice(5).replace(/^ /, ''))
			.join('\n');
		if (!data) continue;
		try {
			const event = JSON.parse(data);
			// A live event (tokens, a request for this client) has no seq: it is
			// never replayed, so it takes -1 and never moves the reconnect point.
			if (event && event.live === true && typeof event.type === 'string')
				events.push({ ...event, seq: -1 });
			else if (event && typeof event.seq === 'number' && typeof event.type === 'string')
				events.push(event);
		} catch {
			/* a torn or foreign frame: skip it */
		}
	}
	return { events, rest };
}

export class JobService {
	static start(
		conversationId: string,
		content: string,
		generation: Record<string, unknown>,
		clientTools?: ClientToolSpec[],
		toolLimits?: JobToolLimits,
		origin?: JobOrigin
	): Promise<JobRecord> {
		return post<JobRecord>('/jobs', {
			conversationId,
			content,
			generation,
			...(clientTools?.length ? { clientTools } : {}),
			...(toolLimits ? { toolLimits } : {}),
			...(origin ? { origin } : {})
		});
	}

	/** The tools this app runs for the task, after a reload or a reconnect. */
	static registerClient(id: string, tools: ClientToolSpec[]): Promise<{ ok: true }> {
		return post(`/jobs/${id}/client`, { tools });
	}

	/** This app's result for a client_request. */
	static clientResult(
		id: string,
		callId: string,
		text: string,
		isError: boolean
	): Promise<{ ok: true }> {
		return post(`/jobs/${id}/client-result`, { callId, text, isError });
	}

	static async listFor(conversationId: string): Promise<JobRecord[]> {
		const data = await call<{ tasks: JobRecord[] }>(
			`/jobs?conversationId=${encodeURIComponent(conversationId)}`
		);
		return data?.tasks ?? [];
	}

	static get(id: string): Promise<JobRecord> {
		return call<JobRecord>(`/jobs/${id}`);
	}

	/** `as`: 'answer' when the task was waiting on a question and took this as the answer. */
	static steer(id: string, content: string): Promise<{ ok: true; as?: 'answer' | 'steer' }> {
		return post(`/jobs/${id}/steer`, { content });
	}

	static answer(id: string, answer: JobAnswer): Promise<{ ok: true }> {
		return post(`/jobs/${id}/answer`, answer);
	}

	static cancel(id: string): Promise<{ ok: true }> {
		return post(`/jobs/${id}/cancel`);
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
		onEvent: (event: JobEvent) => void,
		signal: AbortSignal,
		asClient = false
	): Promise<void> {
		// asClient: this app is the run's executor for its own tools (7.1).
		const res = await fetch(
			resolveApiPath(`/jobs/${id}/events?after=${afterSeq}${asClient ? '&client=1' : ''}`),
			{
				headers: headers({ Accept: 'text/event-stream' }),
				signal
			}
		);
		if (!res.ok || !res.body)
			throw new JobRequestError(`${res.status} ${res.statusText}`, res.status);
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
