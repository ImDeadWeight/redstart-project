import { describe, it, expect } from 'vitest';
import { render } from 'vitest-browser-svelte';
import MyAssignmentsPage from '$lib/components/app/assignments/MyAssignmentsPage.svelte';
import ProjectAssignments from '$lib/components/app/assignments/ProjectAssignments.svelte';
import AssignmentEditor from '$lib/components/app/assignments/AssignmentEditor.svelte';
import { localToday } from '$lib/services/assignment.service';
import { setOverride, jsonResponse } from './mock-overrides';

/**
 * Tasks (tasks plan Phase 1): the pages follow `can` from the server — a tick
 * box works only where Nest says the status may change, and only editors get
 * New task — and My tasks sorts by the viewer's own date.
 */

const ALL = {
	edit: true,
	status: true,
	assign: true,
	claim: false,
	release: false,
	delete: true,
	move: true
};
const STATUS_ONLY = { ...ALL, edit: false, assign: false, delete: false, move: false };
const NOTHING = { ...STATUS_ONLY, status: false };

const offset = (days: number) => localToday(new Date(Date.now() + days * 86400000));

function task(over: Record<string, unknown>) {
	return {
		id: String(over.id),
		title: 'A task',
		notes: '',
		status: 'open',
		projectId: null,
		projectName: null,
		assignee: null,
		assigneeName: null,
		assigneeLeft: false,
		claimedFrom: null,
		claimedFromName: null,
		formerAssignee: null,
		dueDate: null,
		createdBy: 'alice',
		createdByName: 'alice',
		createdAt: 1,
		updatedAt: 1,
		completedAt: null,
		deletedAt: null,
		can: ALL,
		...over
	};
}

function record() {
	const sent: { url: string; method: string; body: unknown }[] = [];
	setOverride('/assignments/', (init) => {
		sent.push({
			url: 'item',
			method: init?.method ?? 'GET',
			body: init?.body ? JSON.parse(String(init.body)) : null
		});
		return jsonResponse(task({ id: 't1', status: 'done' }));
	});
	return sent;
}

describe('My tasks', () => {
	it("sorts by the viewer's date: overdue first, then this week, then no date", async () => {
		record();
		setOverride('/assignments/count', () => jsonResponse({ open: 3, overdue: 1 }));
		setOverride('/assignments/created', () => jsonResponse({ items: [] }));
		setOverride('/assignments/mine', () =>
			jsonResponse({
				items: [
					task({
						id: 'late',
						title: 'Return the forms',
						dueDate: offset(-2),
						assignee: { type: 'account', id: 'me' }
					}),
					task({
						id: 'soon',
						title: 'Call the family',
						dueDate: offset(2),
						assignee: { type: 'account', id: 'me' }
					}),
					task({ id: 'any', title: 'Tidy the notes', assignee: { type: 'account', id: 'me' } })
				],
				counts: { open: 3, overdue: 1 },
				limits: {}
			})
		);
		const screen = await render(MyAssignmentsPage);
		await expect.element(screen.getByText('Overdue · 1')).toBeInTheDocument();
		await expect.element(screen.getByText('Due this week · 1')).toBeInTheDocument();
		await expect.element(screen.getByText('No due date · 1')).toBeInTheDocument();
		await expect.element(screen.getByText('Return the forms')).toBeInTheDocument();
	});

	it('ticking a task sends only its status', async () => {
		const sent = record();
		setOverride('/assignments/count', () => jsonResponse({ open: 1, overdue: 0 }));
		setOverride('/assignments/created', () => jsonResponse({ items: [] }));
		setOverride('/assignments/mine', () =>
			jsonResponse({
				items: [task({ id: 't1', title: 'Book the interpreter', can: STATUS_ONLY })],
				counts: { open: 1, overdue: 0 },
				limits: {}
			})
		);
		const screen = await render(MyAssignmentsPage);
		await screen.getByRole('checkbox', { name: 'Mark "Book the interpreter" done' }).click();
		await expect
			.poll(() => sent.find((s) => s.method === 'PATCH')?.body)
			.toEqual({ status: 'done' });
	});
});

describe("A project's tasks", () => {
	function serve(items: unknown[]) {
		setOverride('/assignments/count', () => jsonResponse({ open: 0, overdue: 0 }));
		setOverride('/assignments?projectId=p1', () => jsonResponse({ items, limits: {} }));
	}

	it('a viewer gets no New task and no add line, and can tick only what Nest allows', async () => {
		serve([
			task({ id: 'a', title: 'Mine to finish', projectId: 'p1', can: STATUS_ONLY }),
			task({ id: 'b', title: "Someone else's", projectId: 'p1', can: NOTHING })
		]);
		const screen = await render(ProjectAssignments, { projectId: 'p1', canAdd: false });
		await expect.element(screen.getByText('Mine to finish')).toBeInTheDocument();
		await expect.element(screen.getByRole('button', { name: /New task/ })).not.toBeInTheDocument();
		await expect
			.element(screen.getByPlaceholder('Add a task and press Enter'))
			.not.toBeInTheDocument();
		await expect
			.element(screen.getByRole('checkbox', { name: 'Mark "Mine to finish" done' }))
			.toBeEnabled();
		await expect
			.element(screen.getByRole('checkbox', { name: 'Mark "Someone else\'s" done' }))
			.toBeDisabled();
	});

	it('an editor adds one from the line, in this project', async () => {
		const sent: unknown[] = [];
		serve([]);
		setOverride('/assignments', (init) => {
			if (init?.method === 'POST') sent.push(JSON.parse(String(init.body)));
			return jsonResponse(task({ id: 'n', projectId: 'p1' }), 201);
		});
		setOverride('/assignments?projectId=p1', () => jsonResponse({ items: [], limits: {} }));
		const screen = await render(ProjectAssignments, { projectId: 'p1', canAdd: true });
		const line = screen.getByPlaceholder('Add a task and press Enter');
		await line.fill('Draft the letter');
		await line
			.element()
			.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		await expect.poll(() => sent[0]).toEqual({ title: 'Draft the letter', projectId: 'p1' });
	});

	it('shows who left the project and who had a task before they were removed', async () => {
		serve([
			task({
				id: 'l',
				title: 'Left behind',
				projectId: 'p1',
				assignee: { type: 'account', id: 'bob' },
				assigneeName: 'bob',
				assigneeLeft: true
			}),
			task({
				id: 'r',
				title: 'Orphaned',
				projectId: 'p1',
				formerAssignee: { type: 'group', name: 'Intake' }
			})
		]);
		const screen = await render(ProjectAssignments, { projectId: 'p1', canAdd: true });
		await expect.element(screen.getByText('left the project')).toBeInTheDocument();
		await expect.element(screen.getByText('Unassigned (was Intake)')).toBeInTheDocument();
	});
});

describe('The task editor', () => {
	it('marks what the assistant changed, and offers a chat about the task', async () => {
		setOverride('/assignments/count', () => jsonResponse({ open: 0, overdue: 0 }));
		setOverride('/assignments/assignees', () => jsonResponse({ accounts: [], groups: [] }));
		setOverride('/assignments/h1', () =>
			jsonResponse(
				task({
					id: 'h1',
					title: 'Call the school',
					history: [
						{ at: 1, by: 'carol', byName: 'carol', action: 'created', via: 'assistant' },
						{ at: 2, by: 'bob', byName: 'bob', action: 'status', from: 'open', to: 'done' }
					]
				})
			)
		);
		const screen = await render(AssignmentEditor, { open: true, taskId: 'h1' });
		await expect
			.element(screen.getByText('carol (through the assistant) created this'))
			.toBeInTheDocument();
		await expect.element(screen.getByText('bob moved it from To do to Done')).toBeInTheDocument();
		await expect.element(screen.getByRole('button', { name: /Start a chat/ })).toBeInTheDocument();
	});
});

describe('Comments and reminders (Phase 3)', () => {
	it('shows comments, lets the author delete theirs, and posts a new one', async () => {
		const sent: unknown[] = [];
		setOverride('/assignments/count', () => jsonResponse({ open: 0, overdue: 0 }));
		setOverride('/assignments/assignees', () => jsonResponse({ accounts: [], groups: [] }));
		const withComments = (extra: unknown[] = []) =>
			task({
				id: 'c1',
				title: 'Talk it over',
				history: [],
				commentCount: 1 + extra.length,
				comments: [
					{
						id: 'k1',
						at: 1,
						by: 'bob',
						byName: 'bob',
						text: 'I can take this Friday.',
						canDelete: false
					},
					...extra
				]
			});
		setOverride('/assignments/c1', () => jsonResponse(withComments()));
		setOverride('/assignments/c1/comments', (init) => {
			sent.push(JSON.parse(String(init?.body)));
			return jsonResponse(
				withComments([
					{ id: 'k2', at: 2, by: 'me', byName: 'me', text: 'Thanks!', canDelete: true }
				]),
				201
			);
		});
		const screen = await render(AssignmentEditor, { open: true, taskId: 'c1' });
		await expect.element(screen.getByText('I can take this Friday.')).toBeInTheDocument();
		await expect
			.element(screen.getByRole('button', { name: 'Delete comment' }))
			.not.toBeInTheDocument();
		await screen.getByRole('textbox', { name: 'Add a comment' }).fill('Thanks!');
		await screen.getByRole('button', { name: 'Comment' }).click();
		await expect.poll(() => sent[0]).toEqual({ text: 'Thanks!' });
		await expect.element(screen.getByText('Thanks!')).toBeInTheDocument();
		await expect
			.element(screen.getByRole('button', { name: 'Delete comment' }))
			.toBeInTheDocument();
	});

	it('marks what came to you since your last visit as New, and not what you gave yourself', async () => {
		localStorage.setItem('redstart.myTasks.seenAt', String(1000));
		setOverride('/assignments/count', () => jsonResponse({ open: 3, overdue: 0 }));
		setOverride('/assignments/created', () => jsonResponse({ items: [] }));
		setOverride('/assignments/mine', () =>
			jsonResponse({
				items: [
					task({ id: 'n1', title: 'Given to you lately', assignedAt: 5000, createdBy: 'sam' }),
					task({ id: 'n2', title: 'An old one', assignedAt: 500, createdBy: 'sam' })
				],
				counts: { open: 2, overdue: 0 },
				limits: {}
			})
		);
		const screen = await render(MyAssignmentsPage);
		await expect.element(screen.getByText('Given to you lately')).toBeInTheDocument();
		await expect.element(screen.getByText('New')).toBeInTheDocument();
		expect(screen.getByText('New').elements().length).toBe(1);
		localStorage.removeItem('redstart.myTasks.seenAt');
	});
});
