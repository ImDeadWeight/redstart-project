import { describe, expect, it } from 'vitest';

import { normalizeLocalFsReply } from '$lib/stores/tools/local-fs';

/**
 * Guards a compatibility seam between two independently-shipped apps.
 *
 * Redstart Twig serves a chat-ui bundle that was built separately from it, so
 * either side can be the older one: a Twig installer carries whichever bundle
 * existed when it was packaged, and a freshly built bundle can land inside an
 * older shell. Both `fs:get-tools` reply shapes therefore have to stay readable
 * indefinitely — and getting this wrong does not throw, it just silently
 * produces zero local file tools, which reads as "the folder grant broke".
 */

const TOOL = {
	type: 'function' as const,
	function: { name: 'fs_read_file', description: 'Read a file', parameters: {} }
};

describe('normalizeLocalFsReply', () => {
	it('reads the current { tools, classes } shape', () => {
		const { tools, classes } = normalizeLocalFsReply({
			tools: [TOOL],
			classes: { fs_delete_file: 'destructive' }
		});
		expect(tools).toHaveLength(1);
		expect(classes.fs_delete_file).toBe('destructive');
	});

	it('🔍 still reads a bare array from an older Twig', () => {
		// The whole reason this function exists. An older shell returns just the
		// definitions; the tools must still work, minus the class information.
		const { tools, classes } = normalizeLocalFsReply([TOOL]);
		expect(tools).toHaveLength(1);
		expect(classes).toEqual({});
	});

	it('treats a missing classes map as "no class information", not an error', () => {
		const { tools, classes } = normalizeLocalFsReply({ tools: [TOOL] });
		expect(tools).toHaveLength(1);
		expect(classes).toEqual({});
	});

	it('survives junk without throwing', () => {
		// A bridge that errors or returns something unexpected should cost the
		// local tools, not break the whole tools store on startup.
		for (const junk of [null, undefined, 'nope', 42, {}, { tools: 'not-an-array' }]) {
			const { tools, classes } = normalizeLocalFsReply(junk);
			expect(tools).toEqual([]);
			expect(classes).toEqual({});
		}
	});

	it('an empty grant returns no tools rather than undefined', () => {
		// What Twig sends before the user has picked a folder.
		const { tools, classes } = normalizeLocalFsReply({ tools: [], classes: {} });
		expect(tools).toEqual([]);
		expect(classes).toEqual({});
	});
});
