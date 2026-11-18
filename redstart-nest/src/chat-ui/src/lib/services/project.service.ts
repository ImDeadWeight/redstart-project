import { apiFetch } from '$lib/utils';
import { getAuthHeaders } from '$lib/utils/api-headers';
import { resolveApiPath } from '$lib/utils/api-fetch';

/**
 * Client for projects (projects-plan Phase 2), served by Nest's /projects
 * routes. Like the other per-account clients, no call names a user: the
 * server scopes everything to the credential, and answers 404 for a project
 * the caller may not read.
 *
 * A project's instructions and memories reach the model through the
 * completion's `redstart_project` id (chat.service), never as text from here.
 */

export interface Project {
	id: string;
	name: string;
	instructions: string;
	/** Fixed at creation; the files folder is named after it. */
	slug: string;
	/** The files folder, relative to the user's Documents space: `Projects/<slug>/`. */
	folder: string;
	ownerKey: string;
	/** Sharing is not built yet (plan D7); always empty today. */
	members: unknown[];
	createdAt: number;
	updatedAt: number;
}

export interface ProjectLimits {
	maxNameChars: number;
	maxInstructionsChars: number;
	maxProjects: number;
}

export interface ProjectDraft {
	name?: string;
	instructions?: string;
}

/** The space the files folder lives in (FilesService). */
export const PROJECT_FILES_SPACE = 'documents';

export class ProjectService {
	static async list(): Promise<{ projects: Project[]; limits: ProjectLimits }> {
		return apiFetch<{ projects: Project[]; limits: ProjectLimits }>('/projects');
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
