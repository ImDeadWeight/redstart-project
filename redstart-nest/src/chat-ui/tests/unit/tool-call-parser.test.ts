import { describe, expect, it } from 'vitest';
import { parseToolCallsFromText, parseToolCallsFromTurn } from '$lib/utils/tool-call-parser';
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

describe('parseToolCallsFromText — canonical JSON tool calls', () => {
	const jsonCfg = (patterns = ['json']): ToolCallParserConfig => ({
		patterns,
		availableTools: TOOLS
	});

	it('parses a bare JSON tool call', () => {
		const calls = parseToolCallsFromText(
			'{"name": "create_document", "arguments": {"title": "Log", "format": "docx"}}',
			jsonCfg()
		);
		expect(calls).toHaveLength(1);
		expect(calls[0].name).toBe('create_document');
		expect(JSON.parse(calls[0].arguments)).toStrictEqual({ title: 'Log', format: 'docx' });
	});

	it('parses a call wrapped in <tool_call> tags', () => {
		const calls = parseToolCallsFromText(
			'<tool_call>\n{"name": "write_file", "arguments": {"path": "a.txt"}}\n</tool_call>',
			jsonCfg()
		);
		expect(calls).toHaveLength(1);
		expect(calls[0].name).toBe('write_file');
	});

	it('parses a call inside a json code fence', () => {
		const calls = parseToolCallsFromText(
			'Here is the call:\n```json\n{"name": "write_file", "arguments": {"path": "a.txt"}}\n```',
			jsonCfg()
		);
		expect(calls).toHaveLength(1);
	});

	it('handles nested objects and braces inside string values', () => {
		const calls = parseToolCallsFromText(
			'{"name": "create_document", "arguments": {"content": "a } brace { in text", "meta": {"deep": {"x": 1}}}}',
			jsonCfg()
		);
		expect(calls).toHaveLength(1);
		const args = JSON.parse(calls[0].arguments);
		expect(args.content).toBe('a } brace { in text');
		expect(args.meta.deep.x).toBe(1);
	});

	it('accepts parameters as an alias for arguments', () => {
		const calls = parseToolCallsFromText(
			'{"name": "write_file", "parameters": {"path": "a.txt"}}',
			jsonCfg()
		);
		expect(JSON.parse(calls[0].arguments)).toStrictEqual({ path: 'a.txt' });
	});

	it('parses multiple sequential tool calls', () => {
		const calls = parseToolCallsFromText(
			'<tool_call>{"name":"write_file","arguments":{"path":"a"}}</tool_call>' +
				'<tool_call>{"name":"search_files","arguments":{"pattern":"b"}}</tool_call>',
			jsonCfg()
		);
		expect(calls.map((c) => c.name)).toEqual(['write_file', 'search_files']);
	});

	it('ignores JSON objects that are not tool calls', () => {
		expect(parseToolCallsFromText('{"foo": "bar"}', jsonCfg())).toHaveLength(0);
		expect(parseToolCallsFromText('{"name": "not_a_real_tool"}', jsonCfg())).toHaveLength(0);
	});

	it('ignores malformed JSON', () => {
		expect(parseToolCallsFromText('{"name": "write_file", oops}', jsonCfg())).toHaveLength(0);
	});

	// Installs that saved the previous default pattern list must still recover
	// a plain JSON call — this is the shape templates actually emit.
	it('is tried as a last resort even when not in the pattern list', () => {
		const calls = parseToolCallsFromText(
			'{"name": "create_document", "arguments": {"title": "Log"}}',
			jsonCfg(['braces', 'xml', 'fn'])
		);
		expect(calls).toHaveLength(1);
		expect(calls[0].name).toBe('create_document');
	});

	it('does not override a call the configured patterns already found', () => {
		const calls = parseToolCallsFromText(
			'write_file({"path": "from-fn.txt"})',
			jsonCfg(['fn'])
		);
		expect(calls).toHaveLength(1);
		expect(JSON.parse(calls[0].arguments)).toStrictEqual({ path: 'from-fn.txt' });
	});
});

describe('parseToolCallsFromTurn — reasoning fallback', () => {
	it('prefers a call in the visible answer', () => {
		const calls = parseToolCallsFromTurn(
			"write_file(path='answer.txt')",
			"write_file(path='reasoning.txt')",
			cfg()
		);
		expect(calls).toHaveLength(1);
		expect(JSON.parse(calls[0].arguments)).toStrictEqual({ path: 'answer.txt' });
	});

	it('finds a call left in the reasoning stream when the answer has none', () => {
		const calls = parseToolCallsFromTurn(
			'I have saved the file for you.',
			"I'll call create_document(content='the table', filename='log.docx') now.",
			cfg()
		);
		expect(calls).toHaveLength(1);
		expect(calls[0].name).toBe('create_document');
	});

	it('recovers the real-world case: model narrates success but only called in its thinking', () => {
		// Condensed from an actual session — the visible answer claimed the file
		// was written while the only call lived in the reasoning block.
		const reasoning = [
			'I should verify the create_document tool signature.',
			"create_document(title='Tiling Purchase Log', content='| Date | Item |', format='docx')",
			'All steps complete.'
		].join('\n');
		const answer =
			'I have generated the purchase log with exactly 50 rows.\n' +
			'It has been saved as a formatted .docx file for you.';

		expect(parseToolCallsFromText(answer, cfg())).toHaveLength(0);

		const calls = parseToolCallsFromTurn(answer, reasoning, cfg());
		expect(calls).toHaveLength(1);
		expect(calls[0].name).toBe('create_document');
		expect(JSON.parse(calls[0].arguments)).toStrictEqual({
			title: 'Tiling Purchase Log',
			content: '| Date | Item |',
			format: 'docx'
		});
	});

	it('returns nothing when neither stream has a call', () => {
		expect(parseToolCallsFromTurn('just prose', 'more prose', cfg())).toHaveLength(0);
	});

	describe('orphan arguments (payload in the answer, tool named in reasoning)', () => {
		// Reproduces an observed session: the answer was prose plus a ```json
		// fence holding only the arguments — no "name" key anywhere — while the
		// tool was named solely in the reasoning.
		const answer =
			"I'll generate the DOCX file with your requested purchase log table.\n\n" +
			'```json\n' +
			'{\n"filename": "Tiling_Company_Purchase_Log.docx",\n' +
			'"content": "| Pricing | Items |\\n|---|---|\\n| 2,450.00 | Ceramic Floor Tiles |",\n' +
			'"format": "docx"\n}\n' +
			'```';
		const reasoning =
			"I'll now create the document using create_document.\n" +
			'create_document(filename="Tiling_Company_Purchase_Log.docx", content=markdown_table, format="docx")';

		it('attributes the payload to the tool named in reasoning', () => {
			const calls = parseToolCallsFromTurn(answer, reasoning, cfg());
			expect(calls).toHaveLength(1);
			expect(calls[0].name).toBe('create_document');
			const args = JSON.parse(calls[0].arguments);
			expect(args.filename).toBe('Tiling_Company_Purchase_Log.docx');
			expect(args.format).toBe('docx');
			// The answer's real table, not the reasoning's "markdown_table" placeholder.
			expect(args.content).toContain('Ceramic Floor Tiles');
		});

		// In the negative cases the reasoning-text scan is still free to recover
		// something on its own — that is a separate path. What must never happen
		// is the answer's payload being routed to a guessed tool.
		const attributedThePayload = (calls: Array<{ arguments: string }>) =>
			calls.some((c) => c.arguments.includes('Ceramic Floor Tiles'));

		it('refuses to guess when several tools are named', () => {
			const ambiguous = `${reasoning}\nOr maybe write_file would be better.`;
			expect(attributedThePayload(parseToolCallsFromTurn(answer, ambiguous, cfg()))).toBe(false);
		});

		it('refuses to guess when no tool is named anywhere', () => {
			expect(parseToolCallsFromTurn(answer, 'No tool mentioned here.', cfg())).toHaveLength(0);
		});

		it('ignores a turn with several candidate objects', () => {
			const twoObjects = '```json\n{"a": 1}\n```\n```json\n{"b": 2}\n```';
			const calls = parseToolCallsFromTurn(twoObjects, reasoning, cfg());
			expect(calls.some((c) => /"[ab]"\s*:/.test(c.arguments))).toBe(false);
		});

		it('does not hijack a properly named tool call', () => {
			const named = '{"name": "write_file", "arguments": {"path": "a.txt"}}';
			const calls = parseToolCallsFromTurn(named, reasoning, cfg());
			expect(calls).toHaveLength(1);
			expect(calls[0].name).toBe('write_file');
		});
	});

	it('handles missing reasoning content', () => {
		expect(parseToolCallsFromTurn('just prose', undefined, cfg())).toHaveLength(0);
	});
});
