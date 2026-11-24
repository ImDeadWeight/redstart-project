import { describe, it, expect } from 'vitest';
import { render } from 'vitest-browser-svelte';
import ProjectPage from '$lib/components/app/projects/ProjectPage.svelte';
import SettingsChatPeopleTab from '$lib/components/app/settings/SettingsChat/SettingsChatPeopleTab.svelte';
import { setOverride, jsonResponse } from './mock-overrides';

/**
 * Shared projects (2026-11-24): the page follows `access` from the server —
 * viewers get a read-only page, owners and admins a Share dialog — and an
 * admin who manages every project gets a Projects tab in People & access.
 */

const base = {
	id: 'p1',
	name: 'Billing',
	instructions: 'Use TypeScript.',
	slug: 'billing',
	folder: 'project-p1',
	ownerKey: 'alice',
	ownerName: 'alice',
	members: [{ type: 'account', id: 'bob', role: 'viewer' }],
	createdAt: 1,
	updatedAt: 1
};

function serveProject(access: string) {
	const sent: { url: string; method: string; body: unknown }[] = [];
	// Registered general-first: the newest override wins, and they match by substring.
	setOverride('/projects', () =>
		jsonResponse({
			projects: [{ ...base, access }],
			limits: { maxNameChars: 80, maxInstructionsChars: 8000, maxProjects: 100 }
		})
	);
	setOverride('/projects/p1', () => jsonResponse({ ...base, access }));
	setOverride('/projects/p1/members', (init) => {
		sent.push({
			url: 'members',
			method: init?.method ?? 'GET',
			body: JSON.parse(String(init?.body))
		});
		return jsonResponse({ ...base, access, members: JSON.parse(String(init?.body)).members });
	});
	setOverride('/memories', () =>
		jsonResponse({ memories: [{ id: 'm1', text: 'Deploys on Fridays are banned', createdAt: 1 }] })
	);
	setOverride('/files/list', () =>
		jsonResponse({ entries: [{ name: 'spec.md', path: 'spec.md', type: 'file', size: 10 }] })
	);
	setOverride('/directory', () =>
		jsonResponse({
			accounts: [
				{ id: 'alice', username: 'alice' },
				{ id: 'bob', username: 'bob' },
				{ id: 'carol', username: 'carol' }
			],
			groups: [{ id: 'g1', name: 'Finance', members: 3 }]
		})
	);
	return sent;
}

describe('A shared project', () => {
	it('a viewer sees it read-only: no Share, no Save, no adding memory or files', async () => {
		serveProject('viewer');
		const screen = await render(ProjectPage, { id: 'p1' });
		await expect.element(screen.getByText(/shared by alice/)).toBeInTheDocument();
		await expect.element(screen.getByText(/you can view/)).toBeInTheDocument();
		await expect.element(screen.getByText('Deploys on Fridays are banned')).toBeInTheDocument();
		await expect.element(screen.getByRole('button', { name: 'Share' })).not.toBeInTheDocument();
		await expect.element(screen.getByRole('button', { name: 'Save' })).not.toBeInTheDocument();
		await expect.element(screen.getByRole('button', { name: /Add files/ })).not.toBeInTheDocument();
		await expect.element(screen.getByRole('button', { name: 'Forget' })).not.toBeInTheDocument();
		await expect.element(screen.getByRole('textbox').first()).toHaveAttribute('readonly');
	});

	it('the owner shares it: add a group as editors, and Save sends the members', async () => {
		const sent = serveProject('owner');
		const screen = await render(ProjectPage, { id: 'p1' });
		await screen.getByRole('button', { name: 'Share' }).click();
		await screen.getByLabelText('Add a person or group').fill('fin');
		await screen.getByLabelText('Role for who you add').selectOptions('editor');
		await screen.getByRole('button', { name: /Finance/ }).click();
		await screen.getByRole('button', { name: 'Save sharing' }).click();
		await expect
			.poll(() => sent.find((s) => s.url === 'members')?.body)
			.toEqual({
				members: [
					{ type: 'account', id: 'bob', role: 'viewer' },
					{ type: 'group', id: 'g1', role: 'editor' }
				]
			});
	});

	it('an admin who manages every project gets a Projects tab listing them all', async () => {
		setOverride('/auth/roles', () =>
			jsonResponse({
				roles: [],
				capabilityIds: [],
				adminPermissions: [],
				webSources: [],
				surfaces: [],
				canEdit: true
			})
		);
		setOverride('/auth/accounts', () => jsonResponse({ accounts: [] }));
		setOverride('/auth/groups', () => jsonResponse({ groups: [] }));
		setOverride('/projects?all=1', () =>
			jsonResponse({ projects: [{ ...base, access: 'admin' }] })
		);
		const screen = await render(SettingsChatPeopleTab, { initialTab: 'projects' });
		await expect.element(screen.getByRole('tab', { name: /Projects/ })).toBeInTheDocument();
		await expect.element(screen.getByText(/Owner alice/)).toBeInTheDocument();
	});

	it('no Projects tab for an admin without manageProjects', async () => {
		setOverride('/auth/roles', () =>
			jsonResponse({
				roles: [],
				capabilityIds: [],
				adminPermissions: [],
				webSources: [],
				surfaces: [],
				canEdit: true
			})
		);
		setOverride('/auth/accounts', () => jsonResponse({ accounts: [] }));
		setOverride('/auth/groups', () => jsonResponse({ groups: [] }));
		setOverride('/projects?all=1', () => jsonResponse({ error: { message: 'no' } }, 403));
		const screen = await render(SettingsChatPeopleTab, {});
		await expect.element(screen.getByRole('tab', { name: /Users/ })).toBeInTheDocument();
		await expect.element(screen.getByRole('tab', { name: /Projects/ })).not.toBeInTheDocument();
	});
});
