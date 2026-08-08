import { FilesService, type FileEntry, type StorageSpace } from '$lib/services/files.service';
import { twigFsApi } from '$lib/utils/twig';

/**
 * One interface over the two places a user's files can live.
 *
 * Redstart stores files on the **server** (per account, reached over
 * `/files/*`), and Redstart Twig can also act on a folder on the **user's own
 * computer** (reached over the desktop bridge). Those are genuinely different
 * machines with different trust models — but from the explorer's point of view
 * they are the same handful of operations, so the component takes a browser
 * rather than knowing about either.
 *
 * Capabilities differ honestly rather than being faked:
 *   - the local folder has no upload (the files are already on that machine)
 *     and no download URL (nothing to fetch over HTTP)
 *   - both support browse, preview, mkdir, move and recoverable delete
 *
 * The UI hides what a browser does not provide, so a missing capability is an
 * absent button rather than one that fails when clicked.
 */

export interface FileListing {
	path: string;
	entries: FileEntry[];
}

export interface FileBrowser {
	/** Stable id, used as the tab key. */
	id: string;
	label: string;
	description?: string;
	list(path: string): Promise<FileListing>;
	preview(path: string): Promise<{ text: string; truncated: boolean }>;
	mkdir(path: string): Promise<unknown>;
	/** Rename and move are the same operation with a different parent. */
	move(from: string, to: string): Promise<unknown>;
	remove(path: string): Promise<{ hint?: string }>;
	/** Absent when the backend has no upload concept. */
	upload?(dir: string, file: File): Promise<unknown>;
	/** Absent when there is nothing to download over HTTP. */
	downloadUrl?(path: string): string;
}

/** Server-side storage, scoped to the signed-in account. */
export function serverBrowser(space: StorageSpace): FileBrowser {
	return {
		id: space.id,
		label: space.label,
		description: space.description,
		list: (path) => FilesService.list(space.id, path),
		preview: (path) => FilesService.preview(space.id, path),
		mkdir: (path) => FilesService.mkdir(space.id, path),
		move: (from, to) => FilesService.rename(space.id, from, to),
		remove: (path) => FilesService.remove(space.id, path),
		upload: (dir, file) => FilesService.upload(space.id, dir, file),
		downloadUrl: (path) => FilesService.downloadUrl(path)
	};
}

/**
 * The folder the user granted to Redstart Twig, on their own machine.
 *
 * The bridge returns `{ error }` rather than rejecting, so each call converts
 * that into a thrown Error — the explorer's batch handling reports failures per
 * item, and a silently-resolved error would look like success.
 */
export function localBrowser(): FileBrowser | null {
	const api = twigFsApi();
	// All five or none: the explorer needs the whole set, and offering a partial
	// view whose buttons fail on click is worse than not offering it. Absent on
	// web/Android, and on a Twig build older than these channels.
	const { browse, preview, mkdir, move, trash } = api ?? {};
	if (!browse || !preview || !mkdir || !move || !trash) return null;

	// The bridge resolves with `{ error }` rather than rejecting — an Error
	// cannot cross IPC — so failures become throws here. Left as a resolved
	// value they would read as success and the explorer would show nothing
	// with no explanation.
	const unwrap = <T>(result: T & { error?: string }): T => {
		if (result?.error) throw new Error(result.error);
		return result;
	};

	return {
		id: 'local',
		label: 'This computer',
		description: 'The folder you granted to Redstart Twig on this machine — not on the server',
		list: async (path) => unwrap(await browse(path)),
		preview: async (path) => unwrap(await preview(path)),
		mkdir: async (path) => unwrap(await mkdir(path)),
		move: async (from, to) => unwrap(await move(from, to)),
		remove: async (path) => unwrap(await trash(path))
	};
}
