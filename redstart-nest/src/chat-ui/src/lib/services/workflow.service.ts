import { apiFetch } from '$lib/utils';
import { getAuthHeaders } from '$lib/utils/api-headers';
import { resolveApiPath } from '$lib/utils/api-fetch';

/**
 * Client for workflows: saved instructions for one recurring task, served by
 * Nest's /workflows routes. Running one does not go through here — Nest serves
 * workflows as MCP prompts, so the composer's `/` picker runs them.
 *
 * Personal workflows belong to the signed-in account and no call names a user:
 * the server scopes them to the credential. Org workflows are visible to
 * everyone; writing them needs manageOrgWorkflows, which the server enforces
 * whatever this client shows (`canEditOrg` only decides what to render).
 */

export type WorkflowScope = 'personal' | 'org';

export interface WorkflowInput {
	name: string;
	description: string;
	required: boolean;
}

export interface Workflow {
	id: string;
	name: string;
	title: string;
	description: string;
	instructions: string;
	inputs: WorkflowInput[];
	example: { input: string; output: string } | null;
	createdAt: number;
	updatedAt: number;
	createdBy: string | null;
}

/** What a client may send: the store owns ids, timestamps and authorship. */
export type WorkflowDraft = Pick<
	Workflow,
	'name' | 'title' | 'description' | 'instructions' | 'inputs' | 'example'
>;

export interface WorkflowLimits {
	maxNameChars: number;
	maxTitleChars: number;
	maxDescriptionChars: number;
	maxInstructionsChars: number;
	maxExampleChars: number;
	maxInputs: number;
	maxPersonal: number;
	maxOrg: number;
}

export interface WorkflowListing {
	personal: Workflow[];
	org: Workflow[];
	canEditOrg: boolean;
	limits: WorkflowLimits;
}

export class WorkflowService {
	static async list(): Promise<WorkflowListing> {
		return apiFetch<WorkflowListing>('/workflows');
	}

	static async create(scope: WorkflowScope, draft: WorkflowDraft): Promise<Workflow> {
		return apiFetch<Workflow>(`/workflows/${scope}`, {
			method: 'POST',
			body: JSON.stringify(draft)
		});
	}

	static async update(scope: WorkflowScope, id: string, draft: WorkflowDraft): Promise<Workflow> {
		return apiFetch<Workflow>(`/workflows/${scope}/${encodeURIComponent(id)}`, {
			method: 'PUT',
			body: JSON.stringify(draft)
		});
	}

	/** 204 has no body, which apiFetch would try to parse; a plain fetch instead. */
	static async remove(scope: WorkflowScope, id: string): Promise<void> {
		const res = await fetch(resolveApiPath(`/workflows/${scope}/${encodeURIComponent(id)}`), {
			method: 'DELETE',
			headers: getAuthHeaders()
		});
		if (!res.ok && res.status !== 404)
			throw new Error(`Could not delete the workflow (${res.status})`);
	}

	/**
	 * Import an Agent Skill: a .zip of its folder, or a bare SKILL.md (master
	 * plan Phase 5). Nest reads and checks it; this only carries the bytes.
	 */
	static async importSkill(scope: WorkflowScope, file: File): Promise<Workflow> {
		const bytes = new Uint8Array(await file.arrayBuffer());
		let binary = '';
		for (let i = 0; i < bytes.length; i += 0x8000) {
			binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
		}
		return apiFetch<Workflow>(`/workflows/${scope}/import`, {
			method: 'POST',
			body: JSON.stringify({ file: btoa(binary) })
		});
	}

	/** Download a workflow as an Agent Skill folder (.zip) for another tool. */
	static async exportSkill(scope: WorkflowScope, w: Workflow): Promise<void> {
		const res = await fetch(
			resolveApiPath(`/workflows/${scope}/${encodeURIComponent(w.id)}/export`),
			{ headers: getAuthHeaders() }
		);
		if (!res.ok) throw new Error(`Could not export the workflow (${res.status})`);
		const url = URL.createObjectURL(await res.blob());
		const a = document.createElement('a');
		a.href = url;
		a.download = `${w.name}.zip`;
		a.click();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	}
}
