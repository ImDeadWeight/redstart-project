import { apiFetch } from '$lib/utils';
import type { ProjectAccess, ProjectMember } from '$lib/services/project.service';

/**
 * Client for programs (tasks plan Phase 4): groups of projects, served by
 * Nest's /programs routes. A program gives no access: `projects` lists only
 * the ones the signed-in account can already open.
 */

export interface ProgramProject {
	id: string;
	name: string;
	access: ProjectAccess;
	/** May this account take it out of the program? */
	canRemove: boolean;
}

export interface Program {
	id: string;
	name: string;
	description: string;
	ownerKey: string;
	ownerName: string | null;
	/** The whole list for its owner or an admin; otherwise only the caller's own entry. */
	members: ProjectMember[];
	access: ProjectAccess;
	projects: ProgramProject[];
	createdAt: number;
	updatedAt: number;
}

export const canEditProgram = (p: Program | null) =>
	!!p && (p.access === 'owner' || p.access === 'admin' || p.access === 'editor');
export const canManageProgram = (p: Program | null) =>
	!!p && (p.access === 'owner' || p.access === 'admin');

const enc = encodeURIComponent;

export class ProgramService {
	static async list(): Promise<Program[]> {
		return (await apiFetch<{ programs: Program[] }>('/programs')).programs;
	}

	static async get(id: string): Promise<Program> {
		return apiFetch(`/programs/${enc(id)}`);
	}

	static async create(name: string, description = ''): Promise<Program> {
		return apiFetch('/programs', { method: 'POST', body: JSON.stringify({ name, description }) });
	}

	static async update(
		id: string,
		draft: { name?: string; description?: string }
	): Promise<Program> {
		return apiFetch(`/programs/${enc(id)}`, { method: 'PUT', body: JSON.stringify(draft) });
	}

	static async remove(id: string): Promise<void> {
		await apiFetch(`/programs/${enc(id)}`, { method: 'DELETE' });
	}

	static async setMembers(id: string, members: ProjectMember[]): Promise<Program> {
		return apiFetch(`/programs/${enc(id)}/members`, {
			method: 'PUT',
			body: JSON.stringify({ members })
		});
	}

	/** The whole list of the projects the caller can see; ones it cannot see are kept by Nest. */
	static async setProjects(id: string, projectIds: string[]): Promise<Program> {
		return apiFetch(`/programs/${enc(id)}/projects`, {
			method: 'PUT',
			body: JSON.stringify({ projectIds })
		});
	}
}
