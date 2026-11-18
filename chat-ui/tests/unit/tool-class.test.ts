import { describe, expect, it } from 'vitest';

import {
	TOOL_CLASS_DESTRUCTIVE,
	canAlwaysAllow,
	isDestructiveClass,
	retainAlwaysAllowable
} from '$lib/stores/tools/tool-class';

/**
 * Guards the one place a client-side click can undo a server-side gate.
 *
 * Redstart Nest refuses destructive tool calls unless an admin has enabled
 * them, at both tools/list and tools/call — enforcement the client cannot
 * bypass. But once the admin HAS enabled deletion, the remaining protection is
 * the per-call prompt, and `permissionsStore` persists an "always allow" grant
 * across sessions. One click on "Always allow" would make every future deletion
 * silent; one click on "Always allow all tools from this server" would do it
 * for the whole File System capability from a menu item that never mentions
 * deletion.
 *
 * Deletions are recoverable, which is what makes the tool defensible — but
 * recovery requires noticing, and "always allow" exists to stop showing you
 * things.
 */

describe('canAlwaysAllow', () => {
	it('refuses to remember a destructive tool', () => {
		expect(canAlwaysAllow(TOOL_CLASS_DESTRUCTIVE)).toBe(false);
	});

	it('allows the non-destructive classes', () => {
		for (const cls of ['read', 'write', 'network']) {
			expect(canAlwaysAllow(cls)).toBe(true);
		}
	});

	it('allows unclassified tools', () => {
		// Most tools carry no class at all — third-party MCP servers, custom
		// tools, the JS sandbox. Treating every unclassified tool as destructive
		// would make the prompt useless without making anything safer.
		expect(canAlwaysAllow(null)).toBe(true);
		expect(canAlwaysAllow(undefined)).toBe(true);
		expect(canAlwaysAllow('')).toBe(true);
	});

	it('does not treat a lookalike class as destructive', () => {
		// The check is exact: a server describing its tool as 'Destructive' or
		// 'destructive-ish' is not making a claim this code understands.
		expect(canAlwaysAllow('Destructive')).toBe(true);
		expect(canAlwaysAllow('destructive-ish')).toBe(true);
	});
});

describe('isDestructiveClass', () => {
	it('is the exact inverse of canAlwaysAllow', () => {
		for (const cls of ['read', 'write', 'network', 'destructive', null, undefined]) {
			expect(isDestructiveClass(cls)).toBe(!canAlwaysAllow(cls));
		}
	});
});

describe('retainAlwaysAllowable', () => {
	it('🔍 strips the destructive tool out of an "allow all from this server" sweep', () => {
		const tools = [
			{ name: 'read_text_file', cls: 'read' },
			{ name: 'write_file', cls: 'write' },
			{ name: 'delete_file', cls: 'destructive' },
			{ name: 'list_directory', cls: 'read' }
		];
		const kept = retainAlwaysAllowable(tools, (t) => t.cls).map((t) => t.name);
		expect(kept).toEqual(['read_text_file', 'write_file', 'list_directory']);
		expect(kept).not.toContain('delete_file');
	});

	it('keeps everything when nothing is destructive', () => {
		const tools = [{ cls: 'read' }, { cls: 'write' }, { cls: null }];
		expect(retainAlwaysAllowable(tools, (t) => t.cls)).toHaveLength(3);
	});

	it('handles an empty set', () => {
		expect(retainAlwaysAllowable([], () => 'read')).toEqual([]);
	});
});
