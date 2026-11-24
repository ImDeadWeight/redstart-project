// =============================================================================
// People & access — shared types, labels and loading for the three tabs.
// =============================================================================
// One Settings section (Users · Groups · Roles) replacing the separate Accounts
// and Roles tabs, 2026-11-24. The model it edits (redstart-nest auth.mjs):
//   - an account holds roles directly, plus every role of every group it is in;
//   - roles ADD UP — each grants things, and an account may do what any of its
//     roles allows, never more than the running profile has enabled;
//   - the owner holds everything and cannot be given roles;
//   - an admin may only give, or manage, access LESS than their own. The server
//     enforces it; `canEdit` on each account says what the UI should offer.
// =============================================================================

import { apiFetch } from '$lib/utils';

export type Account = {
	id: string;
	username: string;
	tier: 'owner' | 'member';
	role: 'owner' | 'admin' | 'user';
	isAdmin: boolean;
	roleIds: string[];
	groupIds: string[];
	apiKeyPrefix: string | null;
	createdAt: string;
	lastLoginAt: string | null;
	status: 'active' | 'disabled';
	canEdit: boolean;
};

export type Group = {
	id: string;
	name: string;
	description: string;
	memberIds: string[];
	roleIds: string[];
};

/** A role's grants (roles.json version 2). See permissions.mjs combineRoles. */
export type RolePermissions = {
	/** null = every capability; a list = those; absent = none. */
	capabilities?: string[] | null;
	/** Per shared capability: null/absent = every folder; a list = those. */
	grants?: Record<string, string[] | null>;
	/** null = every source; a list = those; absent = none. */
	webSourceIds?: string[] | null;
	allowWebSearchEngine?: boolean;
	allowWhitelistBypass?: boolean;
	fileSystem?: { allowWrite?: boolean; allowDestructive?: boolean };
	maxFetchTokens?: number | null;
	/** A limit: null/absent = any app; a list = only those. */
	surfaces?: string[] | null;
	admin?: Record<string, boolean>;
};

export type Role = {
	id: string;
	name: string;
	description: string;
	builtIn?: boolean;
	permissions: RolePermissions;
};

export type Vocabulary = {
	capabilityIds: string[];
	adminPermissions: string[];
	webSources: { id: string; name: string }[];
	surfaces: string[];
	grantable: string[];
	grantFolders: Record<string, string[]>;
	canEditRoles: boolean;
};

export type PeopleData = {
	accounts: Account[] | null; // null: this admin may not manage accounts
	groups: Group[] | null;
	roles: Role[];
	vocab: Vocabulary;
};

export async function loadPeople(): Promise<PeopleData> {
	const [roleResult, accountResult, groupResult] = await Promise.all([
		apiFetch<{
			roles: Role[];
			capabilityIds: string[];
			adminPermissions: string[];
			webSources: { id: string; name: string }[];
			surfaces: string[];
			canEdit: boolean;
			grantable?: string[];
			grantFolders?: Record<string, string[]>;
		}>('/auth/roles', { authOnly: true }),
		// An admin whose roles grant manageRoles but not manageAccounts gets 403
		// here; the page then shows only Roles rather than failing outright.
		apiFetch<{ accounts: Account[] }>('/auth/accounts', { authOnly: true }).catch(() => null),
		apiFetch<{ groups: Group[] }>('/auth/groups', { authOnly: true }).catch(() => null)
	]);
	return {
		accounts: accountResult?.accounts ?? null,
		groups: groupResult?.groups ?? null,
		roles: roleResult.roles,
		vocab: {
			capabilityIds: roleResult.capabilityIds,
			adminPermissions: roleResult.adminPermissions,
			webSources: roleResult.webSources,
			surfaces: roleResult.surfaces,
			grantable: roleResult.grantable ?? [],
			grantFolders: roleResult.grantFolders ?? {},
			canEditRoles: roleResult.canEdit
		}
	};
}

export const CAPABILITY_LABELS: Record<string, string> = {
	postgres: 'Postgres',
	documents: 'Documents',
	sqlite: 'SQLite',
	vault: 'Vault',
	git: 'Git',
	file_system: 'File System',
	scholar: 'Scholar',
	python: 'Python',
	memory: 'Memory',
	document_search: 'Document search',
	image_generation: 'Image generation'
};

export const GRANT_LABELS: Record<string, string> = {
	sqlite: 'SQLite',
	git: 'Git',
	vault: 'Vault',
	shared_documents: 'Shared documents'
};

/** The capability a folder grant belongs to (permissions.mjs GRANT_HOLDER). */
export const GRANT_HOLDER: Record<string, string> = {
	sqlite: 'sqlite',
	git: 'git',
	vault: 'vault',
	shared_documents: 'document_search'
};

export const ADMIN_LABELS: Record<string, string> = {
	manageAccounts: 'Manage people and groups',
	manageRoles: 'Manage roles',
	managePromptBlocks: 'Edit prompt blocks',
	manageOrgWorkflows: 'Edit organization workflows',
	manageProjects: 'Manage every project'
};

export function roleName(roles: Role[], id: string): string {
	return roles.find((r) => r.id === id)?.name ?? 'Deleted role';
}

/** One line saying what a role grants, for lists. */
export function summarizeRole(role: Role): string {
	const p = role.permissions ?? {};
	const parts: string[] = [];
	const caps = p.capabilities;
	parts.push(
		caps === null
			? 'all capabilities'
			: caps?.length
				? caps.map((c) => CAPABILITY_LABELS[c] ?? c).join(', ')
				: 'no capabilities'
	);
	const web = p.webSourceIds;
	parts.push(
		web === null ? 'all web sources' : web?.length ? `${web.length} web source(s)` : 'no web'
	);
	if (p.fileSystem?.allowWrite)
		parts.push(p.fileSystem.allowDestructive ? 'writes and deletes' : 'writes');
	if (Array.isArray(p.surfaces)) parts.push(`only ${p.surfaces.join(', ') || 'no apps'}`);
	const admin = Object.entries(p.admin ?? {}).filter(([, v]) => v).length;
	if (admin) parts.push(`${admin} kind${admin === 1 ? '' : 's'} of administration`);
	return parts.join(' · ');
}
