import { apiFetch } from '$lib/utils';
import { getAuthHeaders } from '$lib/utils/api-headers';
import { resolveApiPath } from '$lib/utils/api-fetch';

/**
 * Client for the per-account file explorer API.
 *
 * Note what is NOT in any of these signatures: a user id. The server derives
 * whose storage to open from the authenticated credential alone, so a client
 * cannot ask for someone else's files even by trying. `space` names a
 * capability ('documents' | 'files'), never a path — the server maps it to a
 * configured root and validates it against a fixed set.
 */

export interface FileEntry {
	name: string;
	/** Path relative to the caller's own storage root. */
	path: string;
	type: 'file' | 'folder';
	size: number | null;
	modified: string;
	previewable: boolean;
}

export interface FileListing {
	space: string;
	path: string;
	truncated: boolean;
	entries: FileEntry[];
}

export interface StorageSpace {
	id: string;
	label: string;
	/** What lands here, and which tools put it there. */
	description?: string;
}

export class FilesService {
	static async spaces(): Promise<StorageSpace[]> {
		const res = await apiFetch<{ spaces: StorageSpace[] }>('/files/spaces');
		return res.spaces ?? [];
	}

	static async list(space: string, path = '.'): Promise<FileListing> {
		return apiFetch<FileListing>(
			`/files/list?space=${encodeURIComponent(space)}&path=${encodeURIComponent(path)}`
		);
	}

	static async preview(space: string, path: string): Promise<{ text: string; truncated: boolean }> {
		return apiFetch<{ text: string; truncated: boolean }>(
			`/files/preview?space=${encodeURIComponent(space)}&path=${encodeURIComponent(path)}`
		);
	}

	static async mkdir(space: string, path: string): Promise<{ path: string }> {
		return apiFetch<{ path: string }>('/files/mkdir', {
			method: 'POST',
			body: JSON.stringify({ space, path })
		});
	}

	static async rename(space: string, from: string, to: string): Promise<{ path: string }> {
		return apiFetch<{ path: string }>('/files/rename', {
			method: 'POST',
			body: JSON.stringify({ space, from, to })
		});
	}

	static async remove(
		space: string,
		path: string
	): Promise<{ path: string; recoverable: string; hint: string }> {
		return apiFetch<{ path: string; recoverable: string; hint: string }>('/files/delete', {
			method: 'POST',
			body: JSON.stringify({ space, path })
		});
	}

	/**
	 * Upload one file as a raw body.
	 *
	 * Not multipart, and not through apiFetch: the body is bytes rather than
	 * JSON, and one file per request means there is no parser to get wrong and
	 * no second part able to smuggle a second path. The server caps the size,
	 * refuses executable extensions, and will not overwrite silently — none of
	 * which is enforced here, because a client-side check is a convenience, not
	 * a control.
	 */
	static async upload(
		space: string,
		dir: string,
		file: File
	): Promise<{ path: string; size: number }> {
		const url = resolveApiPath(
			`/files/upload?space=${encodeURIComponent(space)}&path=${encodeURIComponent(dir)}&name=${encodeURIComponent(file.name)}`
		);
		const res = await fetch(url, {
			method: 'POST',
			headers: { ...getAuthHeaders(), 'Content-Type': 'application/octet-stream' },
			body: file
		});
		if (!res.ok) {
			const body = await res.json().catch(() => null);
			throw new Error(body?.error?.message ?? `Upload failed (${res.status})`);
		}
		return res.json();
	}

	/** Absolute URL for downloading a file, for use as an href. */
	static downloadUrl(path: string): string {
		return resolveApiPath(`/files/download?path=${encodeURIComponent(path)}`);
	}
}
