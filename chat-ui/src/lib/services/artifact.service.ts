import { apiFetch } from '$lib/utils';
import { getAuthHeaders } from '$lib/utils/api-headers';
import { resolveApiPath } from '$lib/utils/api-fetch';

/**
 * Client for artifacts (artifacts plan §12), served by Nest's /artifacts
 * routes. Nest decides who may do what (`role` on each artifact) and answers
 * 404 for one the caller may not read, 403 for one they may read but not
 * change. Nest builds every link (D13): `url` is this app's page for the
 * artifact, and a view's `url` is on the separate content origin.
 *
 * Artifact content NEVER loads on this origin: the viewer frames the view URL
 * in a sandboxed iframe, and the source view reads files as text/plain.
 */

export type ArtifactRole = 'owner' | 'admin' | 'editor' | 'viewer';
export type ArtifactKind = 'web' | 'document' | 'svg';
export type ProjectAccess = 'inherit' | 'view' | 'none';

export interface ArtifactMember {
	type: 'account' | 'group';
	id: string;
	role: 'editor' | 'viewer' | 'none';
}

export interface Artifact {
	id: string;
	title: string;
	description: string;
	kind: ArtifactKind;
	ownerKey: string;
	ownerName: string | null;
	projectId: string | null;
	projectAccess: ProjectAccess;
	members: ArtifactMember[];
	/** The newest sealed revision; 0 when nothing is saved yet. */
	head: number;
	createdAt: number;
	updatedAt: number;
	role: ArtifactRole;
	/** An unsealed draft, if there is one; `mine` when this account holds it. */
	draft: { mine: boolean; conversationId: string | null; touchedAt: number; base: number } | null;
	/** This app's page for it, built by Nest. */
	url: string;
}

export interface ArtifactFile {
	path: string;
	size: number;
}

export interface ArtifactDetail extends Artifact {
	files: ArtifactFile[];
	entry: string | null;
	/** What `files` lists: a revision number, 'draft' (yours), or 0 (empty). */
	source: number | 'draft';
}

export interface ArtifactRevision {
	n: number;
	sealedAt: number;
	by: string | null;
	byName: string | null;
	conversationId: string | null;
	restoredFrom?: number;
}

export interface ArtifactView {
	url: string;
	expiresAt: number;
	revision: number | 'draft';
}

export const canEditArtifact = (a: Pick<Artifact, 'role'> | null) =>
	!!a && (a.role === 'owner' || a.role === 'admin' || a.role === 'editor');
export const canManageArtifact = (a: Pick<Artifact, 'role'> | null) =>
	!!a && (a.role === 'owner' || a.role === 'admin');

/** Viewer widths (§10). */
export const VIEWPORTS = { desktop: 1280, tablet: 820, phone: 390 } as const;
export type Viewport = keyof typeof VIEWPORTS;

const enc = encodeURIComponent;

export class ArtifactService {
	static async list(opts: { scope?: 'mine' | 'shared' | 'project'; projectId?: string; query?: string } = {}): Promise<Artifact[]> {
		const q = new URLSearchParams();
		if (opts.scope) q.set('scope', opts.scope);
		if (opts.projectId) q.set('projectId', opts.projectId);
		if (opts.query) q.set('query', opts.query);
		const s = q.toString();
		return (await apiFetch<{ artifacts: Artifact[] }>(`/artifacts${s ? `?${s}` : ''}`)).artifacts;
	}

	static async get(id: string): Promise<ArtifactDetail> {
		return apiFetch<ArtifactDetail>(`/artifacts/${enc(id)}`);
	}

	static async create(body: { title: string; kind?: ArtifactKind; projectId?: string | null; from?: string; files?: { path: string; content: string }[] }): Promise<Artifact & { placedIn: 'own' | 'project'; projectRefused: string | null }> {
		return apiFetch(`/artifacts`, { method: 'POST', body: JSON.stringify(body) });
	}

	static async rename(id: string, body: { title?: string; description?: string }): Promise<Artifact> {
		return apiFetch<Artifact>(`/artifacts/${enc(id)}`, { method: 'PATCH', body: JSON.stringify(body) });
	}

	static async setAccess(id: string, body: { projectAccess?: ProjectAccess; members?: ArtifactMember[] }): Promise<Artifact> {
		return apiFetch<Artifact>(`/artifacts/${enc(id)}/access`, { method: 'PUT', body: JSON.stringify(body) });
	}

	static async transfer(id: string, accountId: string): Promise<Artifact> {
		return apiFetch<Artifact>(`/artifacts/${enc(id)}/transfer`, { method: 'POST', body: JSON.stringify({ accountId }) });
	}

	static async revisions(id: string): Promise<{ revisions: ArtifactRevision[]; head: number }> {
		return apiFetch(`/artifacts/${enc(id)}/revisions`);
	}

	static async restore(id: string, n: number): Promise<Artifact & { revision: number }> {
		return apiFetch(`/artifacts/${enc(id)}/revisions/${n}/restore`, { method: 'POST' });
	}

	/** The turn ended: seal this conversation's draft into a revision. Never throws. */
	static async seal(id: string, conversationId: string | null): Promise<{ sealed: boolean; revision: number } | null> {
		try {
			return await apiFetch(`/artifacts/${enc(id)}/seal`, { method: 'POST', body: JSON.stringify({ conversationId }) });
		} catch {
			return null;
		}
	}

	/**
	 * A view token's URL on the content origin. `report` asks Nest to inject
	 * the artifact_check reporter (§9). Default revision: your live draft when
	 * you hold one, else the newest.
	 */
	static async view(id: string, opts: { revision?: number | 'draft'; report?: boolean } = {}): Promise<ArtifactView> {
		return apiFetch<ArtifactView>(`/artifacts/${enc(id)}/view`, { method: 'POST', body: JSON.stringify(opts) });
	}

	/** One file's text, for the source view. Served as text/plain, never rendered. */
	static async source(id: string, path: string, revision?: number | 'draft'): Promise<string> {
		const q = revision === undefined ? '' : `?revision=${enc(String(revision))}`;
		const res = await fetch(resolveApiPath(`/artifacts/${enc(id)}/source/${path.split('/').map(enc).join('/')}${q}`), { headers: getAuthHeaders() });
		if (!res.ok) throw new Error(`Could not read ${path} (${res.status})`);
		return res.text();
	}

	static async downloadZip(id: string, revision?: number | 'draft'): Promise<void> {
		const q = revision === undefined ? '' : `?revision=${enc(String(revision))}`;
		const res = await fetch(resolveApiPath(`/artifacts/${enc(id)}/export.zip${q}`), { headers: getAuthHeaders() });
		if (!res.ok) throw new Error(`Could not download it (${res.status})`);
		const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'artifact.zip';
		const url = URL.createObjectURL(await res.blob());
		const a = document.createElement('a');
		a.href = url;
		a.download = name;
		a.click();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	}

	static async remove(id: string): Promise<void> {
		const res = await fetch(resolveApiPath(`/artifacts/${enc(id)}`), { method: 'DELETE', headers: getAuthHeaders() });
		if (!res.ok) {
			const body = await res.json().catch(() => null);
			throw new Error(body?.error?.message ?? `Could not delete it (${res.status})`);
		}
	}
}
