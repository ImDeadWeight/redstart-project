import { apiFetch } from '$lib/utils';
import { getAuthHeaders } from '$lib/utils/api-headers';
import { resolveApiPath } from '$lib/utils/api-fetch';

/**
 * Client for projects (projects-plan Phase 2), served by Nest's /projects
 * routes. The server decides who may do what (owner, admin, editor, viewer —
 * `access` on each project) and answers 404 for a project the caller may not
 * read, 403 for one they may read but not change.
 *
 * A project's instructions and memories reach the model through the
 * completion's `redstart_project` id (chat.service), never as text from here.
 */

/** What the signed-in account may do with a project. */
export type ProjectAccess = 'owner' | 'admin' | 'editor' | 'viewer';

/** Someone a project is shared with: an account or a whole group. */
export interface ProjectMember {
	type: 'account' | 'group';
	id: string;
	role: 'viewer' | 'editor';
}

export interface Project {
	id: string;
	name: string;
	instructions: string;
	slug: string;
	/**
	 * The file-explorer space holding the project's files (`project-<id>`),
	 * shared by everyone in the project. List it at path '.'.
	 */
	folder: string;
	ownerKey: string;
	/** The owner's username, or null with sign-in off. */
	ownerName: string | null;
	members: ProjectMember[];
	access: ProjectAccess;
	createdAt: number;
	updatedAt: number;
}

export interface ProjectLimits {
	maxNameChars: number;
	maxInstructionsChars: number;
	maxProjects: number;
	maxMembers?: number;
}

/** Who a project can be shared with (GET /directory): names only. */
export interface Directory {
	accounts: { id: string; username: string }[];
	groups: { id: string; name: string; members: number }[];
}

/** May this access change the project (name, instructions, memory, files)? */
export const canEditProject = (p: Project | null) =>
	!!p && (!p.access || p.access === 'owner' || p.access === 'admin' || p.access === 'editor');

/** May this access share, hand over or delete the project? */
export const canManageProject = (p: Project | null) =>
	!!p && (!p.access || p.access === 'owner' || p.access === 'admin');

export interface ProjectDraft {
	name?: string;
	instructions?: string;
}

export class ProjectService {
	static async list(): Promise<{ projects: Project[]; limits: ProjectLimits }> {
		return apiFetch<{ projects: Project[]; limits: ProjectLimits }>('/projects');
	}

	/** Every project on the server, for an admin who manages them all (403 otherwise). */
	static async listAll(): Promise<Project[]> {
		return (await apiFetch<{ projects: Project[] }>('/projects?all=1')).projects;
	}

	static async setMembers(id: string, members: ProjectMember[]): Promise<Project> {
		return apiFetch<Project>(`/projects/${encodeURIComponent(id)}/members`, {
			method: 'PUT',
			body: JSON.stringify({ members })
		});
	}

	/** Hand the project to another account; the previous owner stays on as an editor. */
	static async transfer(id: string, accountId: string): Promise<Project> {
		return apiFetch<Project>(`/projects/${encodeURIComponent(id)}/transfer`, {
			method: 'POST',
			body: JSON.stringify({ accountId })
		});
	}

	static async directory(): Promise<Directory> {
		return apiFetch<Directory>('/directory');
	}

	static async get(id: string): Promise<Project> {
		return apiFetch<Project>(`/projects/${encodeURIComponent(id)}`);
	}

	static async create(draft: ProjectDraft): Promise<Project> {
		return apiFetch<Project>('/projects', { method: 'POST', body: JSON.stringify(draft) });
	}

	static async update(id: string, draft: ProjectDraft): Promise<Project> {
		return apiFetch<Project>(`/projects/${encodeURIComponent(id)}`, {
			method: 'PUT',
			body: JSON.stringify(draft)
		});
	}

	/**
	 * Download the project's instructions as an AGENTS.md file, the file other
	 * coding agents read theirs from (master plan Phase 5).
	 */
	static async exportAgentsMd(id: string): Promise<void> {
		const res = await fetch(resolveApiPath(`/projects/${encodeURIComponent(id)}/agents-md`), {
			headers: getAuthHeaders()
		});
		if (!res.ok) throw new Error(`Could not export AGENTS.md (${res.status})`);
		const url = URL.createObjectURL(await res.blob());
		const a = document.createElement('a');
		a.href = url;
		a.download = 'AGENTS.md';
		a.click();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	}

	/** Its chats move out to the ordinary list; its memories go; its files stay. */
	static async remove(id: string): Promise<{ chatsMovedOut: number; memoriesDeleted: number }> {
		const res = await fetch(resolveApiPath(`/projects/${encodeURIComponent(id)}`), {
			method: 'DELETE',
			headers: getAuthHeaders()
		});
		if (!res.ok) {
			const body = await res.json().catch(() => null);
			throw new Error(body?.error?.message ?? `Could not delete the project (${res.status})`);
		}
		return res.json();
	}
}
