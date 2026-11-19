import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * The Files tab shows one tab per place files actually live: the server's
 * storage spaces, plus the folder granted on this computer when running inside
 * Redstart Twig. Those are different machines with different trust models, and
 * conflating them is precisely what confused the model — so the seam between
 * them is worth pinning.
 *
 * Two properties:
 *   1. Outside Twig there is no local browser at all (web, Android, or an older
 *      shell without the explorer bridge). A partial one whose buttons fail on
 *      click would be worse than none.
 *   2. The bridge resolves with `{ error }` rather than rejecting — an Error
 *      cannot cross Electron IPC — so failures must become throws, or they read
 *      as success and the explorer shows an empty folder with no explanation.
 */

const bridge = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));

vi.mock('$lib/utils/twig', () => ({
	twigFsApi: () => bridge.current
}));

import { localBrowser } from '$lib/services/file-browser';

function fullBridge(overrides: Record<string, unknown> = {}) {
	return {
		browse: async () => ({ path: '.', entries: [] }),
		preview: async () => ({ text: 'hi', truncated: false }),
		mkdir: async () => ({ path: 'made' }),
		move: async () => ({ path: 'moved' }),
		trash: async () => ({ path: 'gone', recoverable: 'recycle-bin', hint: 'the Recycle Bin' }),
		...overrides
	};
}

beforeEach(() => {
	bridge.current = null;
});

describe('localBrowser', () => {
	it('is absent outside the Twig desktop shell', () => {
		expect(localBrowser()).toBeNull();
	});

	it('🔍 is absent when the bridge is only partially present', () => {
		// An older Twig has the fs tools but none of the explorer channels. Half a
		// file manager is not worth offering.
		bridge.current = { getTools: async () => [], execute: async () => ({}) };
		expect(localBrowser()).toBeNull();

		const missingOne = fullBridge();
		delete (missingOne as Record<string, unknown>).trash;
		bridge.current = missingOne;
		expect(localBrowser()).toBeNull();
	});

	it('is offered when the whole explorer bridge is there', async () => {
		bridge.current = fullBridge();
		const browser = localBrowser();
		expect(browser).not.toBeNull();
		expect(browser!.id).toBe('local');
		// The label has to distinguish it from the server at a glance.
		expect(browser!.label).toBe('This computer');
		expect(browser!.description).toMatch(/not on the server/i);
	});

	it('🔍 turns a resolved { error } into a throw', async () => {
		bridge.current = fullBridge({
			browse: async () => ({ error: 'No folder has been granted yet.' })
		});
		const browser = localBrowser()!;
		await expect(browser.list('.')).rejects.toThrow('No folder has been granted yet.');
	});

	it('passes successful results through unchanged', async () => {
		bridge.current = fullBridge({
			browse: async () => ({
				path: 'notes',
				entries: [
					{
						name: 'a.md',
						path: 'notes/a.md',
						type: 'file',
						size: 1,
						modified: '',
						previewable: true
					}
				]
			})
		});
		const listing = await localBrowser()!.list('notes');
		expect(listing.path).toBe('notes');
		expect(listing.entries).toHaveLength(1);
	});

	it('🔍 offers no upload or download for the local folder', () => {
		// Its files are already on this machine: there is nothing to upload and
		// nothing to fetch over HTTP. The UI hides both controls, so an absent
		// capability is a missing button rather than one that fails.
		bridge.current = fullBridge();
		const browser = localBrowser()!;
		expect(browser.upload).toBeUndefined();
		expect(browser.downloadUrl).toBeUndefined();
	});

	it('supports the operations that do make sense locally', async () => {
		bridge.current = fullBridge();
		const browser = localBrowser()!;
		await expect(browser.mkdir('new')).resolves.toBeTruthy();
		await expect(browser.move('a', 'b')).resolves.toBeTruthy();
		await expect(browser.remove('a')).resolves.toHaveProperty('hint');
		await expect(browser.preview('a.md')).resolves.toHaveProperty('text', 'hi');
	});
});
