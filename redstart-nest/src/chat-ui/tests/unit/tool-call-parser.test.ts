import { describe, expect, it } from 'vitest';
import { parseToolCallsFromText } from '$lib/utils/tool-call-parser';
import type { ToolCallParserConfig } from '$lib/utils/tool-call-parser';

const TOOLS = [
	{ name: 'create_document' },
	{ name: 'write_file' },
	{ name: 'search_files' }
];

function cfg(patterns: string[] = ['fn']): ToolCallParserConfig {
	return { patterns, availableTools: TOOLS };
}

function argsOf(content: string, patterns?: string[]): unknown {
	const calls = parseToolCallsFromText(content, cfg(patterns));
	expect(calls).toHaveLength(1);
	return JSON.parse(calls[0].arguments);
}

describe('parseToolCallsFromText — JSON args (existing behavior)', () => {
	it('parses JSON args in fn pattern', () => {
		expect(argsOf('write_file({"path": "a.txt", "content": "hi"})')).toStrictEqual({
			path: 'a.txt',
			content: 'hi'
		});
	});

	it('captures brace-delimited args in braces pattern', () => {
		// The regex captures between the outer braces, so the JSON body's own
		// braces re-wrap in tryParseJson only when the capture is itself valid
		// JSON; a bare key:value capture passes through as the raw string.
		const calls = parseToolCallsFromText('write_file{"path": "a.txt"}', cfg(['braces']));
		expect(calls).toHaveLength(1);
		expect(calls[0].arguments).toBe('"path": "a.txt"');
	});

	it('ignores tool names not in availableTools', () => {
		expect(parseToolCallsFromText('unknown_tool(x=1)', cfg())).toHaveLength(0);
	});
});

describe('parseToolCallsFromText — Python-style kwargs fallback', () => {
	it('parses single-quoted string kwargs', () => {
		expect(
			argsOf("create_document(content='Hello World', filename='hello_world.md', format='md')")
		).toStrictEqual({ content: 'Hello World', filename: 'hello_world.md', format: 'md' });
	});

	it('parses double-quoted string kwargs', () => {
		expect(argsOf('write_file(path="notes/a.txt", content="line one")')).toStrictEqual({
			path: 'notes/a.txt',
			content: 'line one'
		});
	});

	it('unescapes escaped quotes and backslashes inside strings', () => {
		expect(argsOf("write_file(content='it\\'s a \\\\ test')")).toStrictEqual({
			content: "it's a \\ test"
		});
	});

	it('parses integer and float values', () => {
		expect(argsOf('search_files(limit=10, threshold=0.5, offset=-3)')).toStrictEqual({
			limit: 10,
			threshold: 0.5,
			offset: -3
		});
	});

	it('parses true, false, and null literals', () => {
		expect(argsOf('search_files(recursive=true, hidden=false, filter=null)')).toStrictEqual({
			recursive: true,
			hidden: false,
			filter: null
		});
	});

	it('works in the xml pattern too', () => {
		expect(argsOf("<function=write_file>path='a.txt'</function>", ['xml'])).toStrictEqual({
			path: 'a.txt'
		});
	});

	it('prefers JSON when args are valid JSON', () => {
		// {"a": 1} is valid JSON; kwargs parsing must not rewrite it.
		const calls = parseToolCallsFromText('write_file({"a": 1})', cfg());
		expect(calls).toHaveLength(1);
		expect(calls[0].arguments).toBe('{"a": 1}');
	});

	it('falls back to the raw string when args are mostly prose', () => {
		// Contains one k=v pair but is dominated by prose — the 80% consumed
		// threshold must reject it so callers see the original text.
		const prose = 'please summarize the report where status=done and include all sections';
		const calls = parseToolCallsFromText(`search_files(${prose})`, cfg());
		expect(calls).toHaveLength(1);
		expect(calls[0].arguments).toBe(prose);
	});

	it('falls back to the raw string when nothing matches', () => {
		const calls = parseToolCallsFromText('search_files(just some words)', cfg());
		expect(calls).toHaveLength(1);
		expect(calls[0].arguments).toBe('just some words');
	});
});
