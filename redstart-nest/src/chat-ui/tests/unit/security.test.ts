import { describe, it, expect } from 'vitest';
import { FILE_PATH_REGEX } from '$lib/constants/agentic';

// chat-ui's own boundary cases. The daemon cases that used to live here
// (accounts, auth, sessions, beacon, the File System containment gate, the
// /files/download endpoint) moved to redstart-nest/scripts/test-daemon-security.mjs
// in master plan Phase 7b: a chat-ui test may not import daemon code.

// ---------------------------------------------------------------------------
// File path marker parsing — chat UI download button support
// ---------------------------------------------------------------------------
// Tests the regex the UI actually uses (utils/agentic.ts matches it per line).
// It used to test a copy of the regex written inside this file, which could
// not catch a change to the real one.

describe('file path marker parsing', () => {
	function parseFileMarkers(text: string): string[] {
		const paths: string[] = [];
		for (const line of text.split('\n')) {
			const match = line.match(FILE_PATH_REGEX);
			if (match) paths.push(match[1]);
		}
		return paths;
	}

	it('extracts file path from [FILE: ...] marker', () => {
		const input = '[FILE: scripts/hello.py]\nWritten to: scripts/hello.py\n\nprint("hello")';
		const paths = parseFileMarkers(input);
		expect(paths).toEqual(['scripts/hello.py']);
	});

	it('returns empty array when no file markers present', () => {
		const paths = parseFileMarkers('Search completed. No results found.');
		expect(paths).toEqual([]);
	});

	it('extracts multiple file paths from multiple markers', () => {
		const input = '[FILE: a.txt]\n[FILE: b.txt]\nDone.';
		const paths = parseFileMarkers(input);
		expect(paths).toEqual(['a.txt', 'b.txt']);
	});

	it('ignores [Attachment saved: ...] markers', () => {
		const input = '[FILE: docs/note.md]\n[Attachment saved: chart.png]\nDone.';
		const paths = parseFileMarkers(input);
		expect(paths).toEqual(['docs/note.md']);
	});
});

// ---------------------------------------------------------------------------
// Tool display names
// ---------------------------------------------------------------------------
// The wire name is the identity: Redstart's gateway is provenance-blind, so a
// server-side ban is a flat name match and the namespace prefix is the only
// thing that makes a ban targetable (docs/tool-namespacing.md). A friendlier
// label is allowed to exist beside that name; it is never allowed to replace
// it anywhere a decision is made. These pin the boundary.

describe('tool display names', () => {
	it('prefers the server-published MCP title', async () => {
		const { toolDisplayName } = await import('$lib/stores/tools/tool-display');
		expect(toolDisplayName('comfyui_mcp__enqueue_workflow', 'Enqueue workflow', true)).toBe(
			'Enqueue workflow'
		);
	});

	it('strips the namespace prefix ONLY when a header already names the source', async () => {
		const { toolDisplayName } = await import('$lib/stores/tools/tool-display');
		expect(toolDisplayName('comfyui_mcp__enqueue_workflow', undefined, true)).toBe(
			'enqueue_workflow'
		);
		// No header: the prefix is the only thing saying where this came from.
		expect(toolDisplayName('comfyui_mcp__enqueue_workflow', undefined, false)).toBe(
			'comfyui_mcp__enqueue_workflow'
		);
	});

	it('leaves an un-namespaced name alone', async () => {
		const { toolDisplayName } = await import('$lib/stores/tools/tool-display');
		expect(toolDisplayName('read_text_file', undefined, true)).toBe('read_text_file');
		// A single underscore is a client-app prefix, not a namespace separator.
		expect(toolDisplayName('fs_read_file', undefined, true)).toBe('fs_read_file');
	});

	it('does not slice a name that merely starts with, or ends at, the separator', async () => {
		const { toolDisplayName } = await import('$lib/stores/tools/tool-display');
		// Slicing here would leave a DIFFERENT tool's name behind.
		expect(toolDisplayName('__read_text_file', undefined, true)).toBe('__read_text_file');
		// A prefix with nothing after it is not a namespace, and an empty label
		// would render an unclickable blank row.
		expect(toolDisplayName('comfyui_mcp__', undefined, true)).toBe('comfyui_mcp__');
	});

	it('never returns an empty label', async () => {
		const { toolDisplayName } = await import('$lib/stores/tools/tool-display');
		for (const name of ['a__b', '__', 'x', 'plugin__tool']) {
			expect(toolDisplayName(name, undefined, true).length).toBeGreaterThan(0);
		}
	});
});
