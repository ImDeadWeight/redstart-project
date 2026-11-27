import { apiFetch } from '$lib/utils';

/**
 * Client for tasks (tasks plan Phase 1), served by Nest's /assignments routes.
 * People call them tasks; the code calls them assignments so they never meet
 * task.service.ts, which is the assistant's background work.
 *
 * Nest decides who may do what and says so on every task (`can`), so this
 * client never works the rules out itself. A task the caller may not see is a
 * 404; one they may see but not change is a 403.
 */

export type AssignmentStatus = 'open' | 'in_progress' | 'blocked' | 'done';

export const ASSIGNMENT_STATUSES: { value: AssignmentStatus; label: string }[] = [
	{ value: 'open', label: 'To do' },
	{ value: 'in_progress', label: 'In progress' },
	{ value: 'blocked', label: 'Blocked' },
	{ value: 'done', label: 'Done' }
];

export const statusLabel = (s: AssignmentStatus) =>
	ASSIGNMENT_STATUSES.find((x) => x.value === s)?.label ?? s;

/** Who a task is given to: one person or one group. */
export interface Assignee {
	type: 'account' | 'group';
	id: string;
}

/** What the signed-in account may do with this task, decided by Nest. */
export interface AssignmentCan {
	edit: boolean;
	status: boolean;
	assign: boolean;
	claim: boolean;
	release: boolean;
	delete: boolean;
	move: boolean;
}

export interface AssignmentHistoryEntry {
	at: number;
	by: string | null;
	byName: string | null;
	action:
		| 'created'
		| 'edited'
		| 'status'
		| 'assigned'
		| 'claimed'
		| 'released'
		| 'moved'
		| 'deleted'
		| 'restored'
		| 'unassigned';
	from?: unknown;
	to?: unknown;
	fromName?: string | null;
	toName?: string | null;
	fields?: string[];
	reason?: string;
	/** Set when the assistant made the change in this person's chat (Phase 2). */
	via?: 'assistant';
}

export interface Assignment {
	id: string;
	title: string;
	notes: string;
	status: AssignmentStatus;
	projectId: string | null;
	projectName: string | null;
	assignee: Assignee | null;
	assigneeName: string | null;
	/** True when the assignee can no longer open the task's project. */
	assigneeLeft: boolean;
	/** The group a person took this from, so it can be handed back. */
	claimedFrom: string | null;
	claimedFromName: string | null;
	/** Who had it before their account or group was deleted. */
	formerAssignee: { type: 'account' | 'group'; name: string | null } | null;
	dueDate: string | null;
	createdBy: string;
	createdByName: string | null;
	createdAt: number;
	updatedAt: number;
	completedAt: number | null;
	deletedAt: number | null;
	can: AssignmentCan;
	/** Only on a single task (GET /assignments/:id and the answers to writes). */
	history?: AssignmentHistoryEntry[];
}

export interface AssignmentLimits {
	maxTitleChars: number;
	maxNotesChars: number;
	maxPerProject: number;
	maxWithoutProject: number;
}

export interface AssignmentCounts {
	open: number;
	overdue: number;
}

export interface AssigneeChoices {
	accounts: { id: string; username: string }[];
	groups: { id: string; name: string }[];
}

export interface AssignmentDraft {
	title?: string;
	notes?: string;
	status?: AssignmentStatus;
	dueDate?: string | null;
	assignee?: Assignee | null;
	projectId?: string | null;
}

/** The viewer's own date as YYYY-MM-DD: "overdue" is theirs, not the server's. */
export function localToday(d = new Date()): string {
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export const isOverdue = (t: Pick<Assignment, 'dueDate' | 'status'>, today = localToday()) =>
	!!t.dueDate && t.status !== 'done' && t.dueDate < today;

const enc = encodeURIComponent;

export class AssignmentService {
	static async mine(
		includeDone = false
	): Promise<{ items: Assignment[]; counts: AssignmentCounts; limits: AssignmentLimits }> {
		const q = `today=${localToday()}${includeDone ? '&include=done' : ''}`;
		return apiFetch(`/assignments/mine?${q}`);
	}

	static async count(): Promise<AssignmentCounts> {
		return apiFetch(`/assignments/count?today=${localToday()}`);
	}

	static async created(includeDone = false): Promise<{ items: Assignment[] }> {
		return apiFetch(`/assignments/created${includeDone ? '?include=done' : ''}`);
	}

	static async forProject(
		projectId: string,
		includeDeleted = false
	): Promise<{ items: Assignment[]; limits: AssignmentLimits }> {
		return apiFetch(
			`/assignments?projectId=${enc(projectId)}${includeDeleted ? '&include=deleted' : ''}`
		);
	}

	static async assignees(projectId: string | null): Promise<AssigneeChoices> {
		return apiFetch(`/assignments/assignees${projectId ? `?projectId=${enc(projectId)}` : ''}`);
	}

	static async get(id: string): Promise<Assignment> {
		return apiFetch(`/assignments/${enc(id)}`);
	}

	static async create(draft: AssignmentDraft & { title: string }): Promise<Assignment> {
		return apiFetch('/assignments', { method: 'POST', body: JSON.stringify(draft) });
	}

	static async update(id: string, draft: AssignmentDraft): Promise<Assignment> {
		return apiFetch(`/assignments/${enc(id)}`, { method: 'PATCH', body: JSON.stringify(draft) });
	}

	static async claim(id: string): Promise<Assignment> {
		return apiFetch(`/assignments/${enc(id)}/claim`, { method: 'POST' });
	}

	static async release(id: string): Promise<Assignment> {
		return apiFetch(`/assignments/${enc(id)}/release`, { method: 'POST' });
	}

	static async remove(id: string): Promise<void> {
		await apiFetch(`/assignments/${enc(id)}`, { method: 'DELETE' });
	}

	static async restore(id: string): Promise<Assignment> {
		return apiFetch(`/assignments/${enc(id)}/restore`, { method: 'POST' });
	}
}
