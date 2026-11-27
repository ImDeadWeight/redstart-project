import { describe, it, expect } from 'vitest';
import { render } from 'vitest-browser-svelte';
import ProgramPage from '$lib/components/app/projects/ProgramPage.svelte';
import { setOverride, jsonResponse } from './mock-overrides';

/**
 * Programs (tasks plan Phase 4): the page shows what Nest sends, which is
 * only the projects the viewer can open; viewers change nothing, editors add
 * projects they manage, the owner shares and deletes.
 */

const base = {
	id: 'pg1',
	name: 'Family services',
	description: 'The county contract',
	ownerKey: 'm',
	ownerName: 'manager',
	members: [],
	projects: [{ id: 'p1', name: 'Housing', access: 'viewer', canRemove: false }],
	createdAt: 1,
	updatedAt: 1
};

function serve(access: string, projects: unknown[] = []) {
	setOverride('/assignments/count', () => jsonResponse({ open: 0, overdue: 0 }));
	setOverride('/programs/pg1', () => jsonResponse({ ...base, access }));
	setOverride('/assignments?programId=pg1', () =>
		jsonResponse({
			items: [
				{
					id: 't1',
					title: 'Book the interpreter',
					notes: '',
					status: 'open',
					projectId: 'p1',
					projectName: 'Housing',
					assignee: null,
					assigneeName: null,
					assigneeLeft: false,
					claimedFrom: null,
					claimedFromName: null,
					formerAssignee: null,
					dueDate: null,
					createdBy: 'a',
					createdByName: 'ana',
					createdAt: 1,
					updatedAt: 1,
					completedAt: null,
					deletedAt: null,
					can: {
						edit: false,
						status: false,
						assign: false,
						claim: false,
						release: false,
						delete: false,
						move: false
					}
				}
			],
			limits: {}
		})
	);
	setOverride('/projects', () => jsonResponse({ projects, limits: {} }));
}

describe('A program', () => {
	it('a viewer sees its projects and their tasks, and can change nothing', async () => {
		serve('viewer');
		const screen = await render(ProgramPage, { id: 'pg1' });
		await expect
			.element(screen.getByRole('heading', { name: 'Family services' }))
			.toBeInTheDocument();
		await expect.element(screen.getByRole('link', { name: 'Housing' })).toBeInTheDocument();
		await expect.element(screen.getByText('Book the interpreter')).toBeInTheDocument();
		await expect.element(screen.getByText('The county contract')).toBeInTheDocument();
		await expect.element(screen.getByRole('button', { name: /Share/ })).not.toBeInTheDocument();
		await expect.element(screen.getByLabelText('Program name')).not.toBeInTheDocument();
		await expect.element(screen.getByLabelText('Project to add')).not.toBeInTheDocument();
	});

	it('an editor can add only the projects they manage', async () => {
		serve('editor', [
			{ id: 'p9', name: 'Outreach', access: 'owner', members: [], instructions: '' },
			{ id: 'p8', name: 'Someone else’s', access: 'viewer', members: [], instructions: '' }
		]);
		const screen = await render(ProgramPage, { id: 'pg1' });
		const select = screen.getByLabelText('Project to add');
		await expect.element(select).toBeInTheDocument();
		await expect.element(screen.getByRole('option', { name: 'Outreach' })).toBeInTheDocument();
		await expect
			.element(screen.getByRole('option', { name: 'Someone else’s' }))
			.not.toBeInTheDocument();
		await expect.element(screen.getByRole('button', { name: /Share/ })).not.toBeInTheDocument();
	});
});
