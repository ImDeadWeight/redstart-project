import { describe, it, expect } from 'vitest';
import { render } from 'vitest-browser-svelte';
import SettingsChatPeopleTab from '$lib/components/app/settings/SettingsChat/SettingsChatPeopleTab.svelte';
import { setOverride, jsonResponse } from './mock-overrides';

/**
 * People & access (2026-11-24): users, groups and roles on one page. The
 * server decides what an admin may change (canEdit, and its own refusals);
 * these pin what the page offers and what it sends.
 */

const ROLES = [
	{
		id: 'administrator',
		name: 'Administrator',
		description: '',
		builtIn: true,
		permissions: { capabilities: null, webSourceIds: null, admin: { manageAccounts: true } }
	},
	{
		id: 'full-access',
		name: 'Full Access',
		description: '',
		builtIn: true,
		permissions: { capabilities: null, webSourceIds: null }
	},
	{
		id: 'restricted',
		name: 'Restricted',
		description: '',
		builtIn: true,
		permissions: { capabilities: [], webSourceIds: null }
	},
	{
		id: 'db',
		name: 'Databases',
		description: 'Postgres for analysts',
		permissions: { capabilities: ['postgres'], webSourceIds: [] }
	}
];

const ACCOUNTS = [
	{
		id: 'o',
		username: 'owner',
		tier: 'owner',
		role: 'owner',
		isAdmin: true,
		roleIds: [],
		groupIds: [],
		apiKeyPrefix: 'rst_aaaa',
		createdAt: '2026-11-01T00:00:00Z',
		lastLoginAt: null,
		status: 'active',
		canEdit: false
	},
	{
		id: 'ada',
		username: 'ada',
		tier: 'member',
		role: 'admin',
		isAdmin: true,
		roleIds: ['administrator'],
		groupIds: [],
		apiKeyPrefix: 'rst_bbbb',
		createdAt: '2026-11-02T00:00:00Z',
		lastLoginAt: null,
		status: 'active',
		canEdit: false
	},
	{
		id: 'sam',
		username: 'sam',
		tier: 'member',
		role: 'user',
		isAdmin: false,
		roleIds: ['restricted'],
		groupIds: ['g1'],
		apiKeyPrefix: 'rst_cccc',
		createdAt: '2026-11-03T00:00:00Z',
		lastLoginAt: null,
		status: 'active',
		canEdit: true
	}
];

const GROUPS = [
	{ id: 'g1', name: 'Data team', description: '', memberIds: ['sam'], roleIds: ['db'] }
];

const VOCAB = {
	capabilityIds: ['postgres', 'documents', 'git'],
	adminPermissions: [
		'manageAccounts',
		'manageRoles',
		'managePromptBlocks',
		'manageOrgWorkflows',
		'manageProjects'
	],
	webSources: [{ id: 'wikipedia', name: 'Wikipedia' }],
	surfaces: ['nest-chat', 'twig'],
	grantable: ['git'],
	grantFolders: { git: ['repos'] },
	canEdit: true
};

function serve(opts: { accounts?: boolean } = {}) {
	const sent: { url: string; method: string; body: unknown }[] = [];
	const record = (url: string) => (init?: RequestInit) => {
		sent.push({
			url,
			method: init?.method ?? 'GET',
			body: init?.body ? JSON.parse(String(init.body)) : null
		});
		return null;
	};
	setOverride(
		'/auth/roles',
		(init) => (
			record('/auth/roles')(init),
			jsonResponse(
				init?.method === 'POST'
					? { role: { id: 'new', ...JSON.parse(String(init.body)) } }
					: { roles: ROLES, ...VOCAB }
			)
		)
	);
	setOverride(
		'/auth/groups',
		(init) => (
			record('/auth/groups')(init),
			jsonResponse(
				init?.method === 'POST'
					? { group: { id: 'g2', ...JSON.parse(String(init.body)) } }
					: { groups: GROUPS }
			)
		)
	);
	setOverride('/auth/accounts', (init) =>
		opts.accounts === false
			? jsonResponse({ error: 'no' }, 403)
			: (record('/auth/accounts')(init), jsonResponse({ accounts: ACCOUNTS }))
	);
	setOverride(
		'/auth/accounts/sam/roles',
		(init) => (
			record('/auth/accounts/sam/roles')(init),
			jsonResponse({ account: ACCOUNTS[2], apiKeyRevoked: false })
		)
	);
	setOverride('/auth/accounts/sam/access', () =>
		jsonResponse({
			ok: true,
			owner: false,
			roles: [
				{ id: 'restricted', name: 'Restricted', via: null },
				{ id: 'db', name: 'Databases', via: { id: 'g1', name: 'Data team' } }
			],
			permissions: { capabilities: ['postgres'], admin: {} },
			canEdit: true
		})
	);
	setOverride('/auth/accounts/ada/access', () =>
		jsonResponse({
			ok: true,
			owner: false,
			roles: [{ id: 'administrator', name: 'Administrator', via: null }],
			permissions: { admin: { manageAccounts: true } },
			canEdit: false
		})
	);
	return sent;
}

describe('People & access', () => {
	it('a person shows their roles, their groups, and what that adds up to; saving sends the new role list', async () => {
		const sent = serve();
		const screen = await render(SettingsChatPeopleTab, {});
		await screen.getByRole('button', { name: /^sam/ }).click();
		await expect.element(screen.getByRole('checkbox', { name: 'Restricted' })).toBeChecked();
		await expect.element(screen.getByRole('checkbox', { name: /^Data team/ })).toBeChecked();
		await expect.element(screen.getByText(/· through/)).toBeInTheDocument();
		await expect.element(screen.getByText(/Capabilities:.*Postgres/)).toBeInTheDocument();
		await screen.getByRole('checkbox', { name: 'Full Access' }).click();
		await screen.getByRole('button', { name: 'Save access' }).click();
		await expect
			.poll(() => sent.find((s) => s.url.endsWith('/sam/roles'))?.body)
			.toEqual({ roleIds: ['restricted', 'full-access'] });
	});

	it('someone with as much access as the viewer is shown, read-only', async () => {
		serve();
		const screen = await render(SettingsChatPeopleTab, {});
		await screen.getByRole('button', { name: /^ada/ }).click();
		await expect.element(screen.getByText(/as much access as you, or more/)).toBeInTheDocument();
		await expect.element(screen.getByRole('checkbox', { name: 'Administrator' })).toBeDisabled();
		await expect
			.element(screen.getByRole('button', { name: 'Save access' }))
			.not.toBeInTheDocument();
	});

	it('a new group is sent with its members and roles', async () => {
		const sent = serve();
		const screen = await render(SettingsChatPeopleTab, {});
		await screen.getByRole('tab', { name: /Groups/ }).click();
		await screen.getByRole('button', { name: 'New group' }).click();
		await screen.getByLabelText('Group name').fill('Legal');
		await screen.getByRole('checkbox', { name: /^Databases/ }).click();
		await screen.getByRole('checkbox', { name: 'sam' }).click();
		await screen.getByRole('button', { name: 'Create group' }).click();
		await expect
			.poll(() => sent.find((s) => s.url === '/auth/groups' && s.method === 'POST')?.body)
			.toMatchObject({ name: 'Legal', memberIds: ['sam'], roleIds: ['db'] });
	});

	it('a new role gives nothing until something is ticked, and is sent as grants', async () => {
		const sent = serve();
		const screen = await render(SettingsChatPeopleTab, { initialTab: 'roles' });
		await screen.getByRole('button', { name: 'New role' }).click();
		await screen.getByLabelText('Role name').fill('Analysts');
		await expect.element(screen.getByRole('checkbox', { name: 'Postgres' })).not.toBeChecked();
		await screen.getByRole('checkbox', { name: 'Postgres' }).click();
		await screen.getByRole('checkbox', { name: 'Manage every project' }).click();
		await screen.getByRole('button', { name: 'Create role' }).click();
		await expect
			.poll(() => sent.find((s) => s.url === '/auth/roles' && s.method === 'POST')?.body)
			.toMatchObject({
				name: 'Analysts',
				permissions: { capabilities: ['postgres'], admin: { manageProjects: true } }
			});
	});

	it('a built-in role opens read-only, with Clone offered', async () => {
		serve();
		const screen = await render(SettingsChatPeopleTab, { initialTab: 'roles' });
		await screen.getByRole('button', { name: /Full Access/ }).click();
		await expect.element(screen.getByText(/Built-in roles can't be changed/)).toBeInTheDocument();
		await expect.element(screen.getByRole('button', { name: 'Save role' })).not.toBeInTheDocument();
		await expect.element(screen.getByRole('button', { name: 'Clone' })).toBeInTheDocument();
	});

	it('an admin who cannot manage people sees Roles only', async () => {
		serve({ accounts: false });
		const screen = await render(SettingsChatPeopleTab, {});
		await expect.element(screen.getByRole('tab', { name: /Roles/ })).toBeInTheDocument();
		await expect.element(screen.getByRole('tab', { name: /Users/ })).not.toBeInTheDocument();
	});
});
