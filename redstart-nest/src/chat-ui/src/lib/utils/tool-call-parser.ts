import type { ApiChatCompletionToolCall } from '$lib/types/api';

/**
 * Fallback text-to-tool-call parser.
 *
 * When a model emits tool calls as raw assistant text instead of structured
 * tool_calls, this module extracts them so the agentic loop can still
 * execute the call.
 *
 * Supported patterns (configurable):
 *  - braces : toolName{...} — JSON args inside braces
 *  - xml    : <function=toolName>args</function>
 *  - fn     : toolName(args)
 *  - json   : {"name": "toolName", "arguments": {...}} — the canonical shape,
 *             including inside <tool_call> tags or a ```json fence
 */

export interface ToolCallParserConfig {
	patterns: string[];
	availableTools: Array<{ name: string }>;
}

export interface ParsedToolCall {
	name: string;
	arguments: string;
}

const DEFAULT_PATTERNS = ['braces', 'xml', 'fn', 'json'] as const;
type PatternName = typeof DEFAULT_PATTERNS[number];

function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildBracesRegex(tools: string[]): RegExp {
	const names = tools.map(escapeRegex).join('|');
	return new RegExp(`\\b(${names})\\{([\\s\\S]*?)\\}`, 'g');
}

function buildXmlRegex(tools: string[]): RegExp {
	const names = tools.map(escapeRegex).join('|');
	return new RegExp(`<function\\s*=\\s*(${names})\\s*>([\\s\\S]*?)</function>`, 'g');
}

function buildFnRegex(tools: string[]): RegExp {
	const names = tools.map(escapeRegex).join('|');
	return new RegExp(`(${names})\\(([\\s\\S]*?)\\)`, 'g');
}

function tryParseJson(str: string): string | null {
	const trimmed = str.trim();
	if (!trimmed) return '{}';
	try {
		JSON.parse(trimmed);
		return trimmed;
	} catch {
		return null;
	}
}

// Some models emit Python-style keyword arguments instead of JSON, e.g.
// create_document(content='Hello World', filename='hello_world.md', format='md').
// Parse key=value pairs (quoted strings, numbers, true/false/null) into a JSON
// object so the call can still execute. Bails (returns null) unless the matched
// pairs account for most of the string, so it doesn't misfire on prose that
// merely contains an "=" sign.
function tryParseKwargs(str: string): string | null {
	const trimmed = str.trim();
	if (!trimmed) return '{}';

	const pairRegex =
		/([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|(-?\d+(?:\.\d+)?)|(true|false|null))/g;
	const obj: Record<string, unknown> = {};
	let match: RegExpExecArray | null;
	let consumedLength = 0;

	while ((match = pairRegex.exec(trimmed)) !== null) {
		consumedLength += match[0].length;
		const key = match[1];
		if (match[2] !== undefined) obj[key] = match[2].replace(/\\(['"\\])/g, '$1');
		else if (match[3] !== undefined) obj[key] = match[3].replace(/\\(['"\\])/g, '$1');
		else if (match[4] !== undefined) obj[key] = Number(match[4]);
		else obj[key] = match[5] === 'null' ? null : match[5] === 'true';
	}

	if (consumedLength === 0) return null;

	const nonSeparatorLength = trimmed.replace(/[\s,]/g, '').length;
	if (consumedLength < nonSeparatorLength * 0.8) return null;

	return JSON.stringify(obj);
}

function validateToolName(name: string, availableTools: Array<{ name: string }>): boolean {
	return availableTools.some((t) => t.name === name);
}

// Every balanced {...} region in the text. A regex can't do this: tool arguments
// are themselves objects, so the closing brace has to be found by counting depth
// while ignoring braces inside strings.
function extractJsonObjects(text: string): string[] {
	const found: string[] = [];
	for (let start = 0; start < text.length; start++) {
		if (text[start] !== '{') continue;
		let depth = 0;
		let inString = false;
		let escaped = false;
		for (let i = start; i < text.length; i++) {
			const ch = text[i];
			if (escaped) {
				escaped = false;
			} else if (ch === '\\') {
				escaped = true;
			} else if (ch === '"') {
				inString = !inString;
			} else if (!inString) {
				if (ch === '{') depth++;
				else if (ch === '}') {
					depth--;
					if (depth === 0) {
						found.push(text.slice(start, i + 1));
						start = i; // continue scanning after this object
						break;
					}
				}
			}
		}
	}
	return found;
}

/**
 * Tool calls in the canonical `{"name": ..., "arguments": {...}}` shape.
 *
 * This is what chat templates instruct models to emit (usually wrapped in
 * <tool_call> tags), so it is what leaks into visible content whenever
 * llama.cpp fails to parse the call back into structured tool_calls — a
 * mismatched template, a missing wrapper tag, or stray indentation is enough.
 * Surrounding tags or a ```json fence don't matter here: the object is located
 * by brace matching, not by its delimiters.
 */
function parseJsonToolCalls(
	content: string,
	availableTools: Array<{ name: string }>
): ParsedToolCall[] {
	const results: ParsedToolCall[] = [];
	for (const candidate of extractJsonObjects(content)) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(candidate);
		} catch {
			continue;
		}
		if (!parsed || typeof parsed !== 'object') continue;
		const obj = parsed as Record<string, unknown>;
		const name = obj.name;
		if (typeof name !== 'string' || !validateToolName(name, availableTools)) continue;

		// `parameters` is a common stand-in for `arguments`.
		const rawArgs = obj.arguments ?? obj.parameters ?? {};
		results.push({
			name,
			arguments: typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs)
		});
	}
	return results;
}

export function parseToolCallsFromText(
	content: string,
	config: ToolCallParserConfig
): ParsedToolCall[] {
	if (!content.trim() || config.patterns.length === 0) return [];

	const available = config.availableTools.map((t) => t.name);
	const results: ParsedToolCall[] = [];

	for (const pattern of config.patterns) {
		if (!DEFAULT_PATTERNS.includes(pattern as PatternName)) continue;

		let regex: RegExp;

		switch (pattern) {
			case 'braces': {
				regex = buildBracesRegex(available);
				let m;
				while ((m = regex.exec(content)) !== null) {
					const name = m[1];
					const argsStr = m[2];
					if (validateToolName(name, config.availableTools)) {
						const args = tryParseJson(argsStr) ?? tryParseKwargs(argsStr) ?? argsStr.trim();
						results.push({ name, arguments: args });
					}
				}
				break;
			}
			case 'xml': {
				regex = buildXmlRegex(available);
				let m;
				while ((m = regex.exec(content)) !== null) {
					const name = m[1];
					const argsStr = m[2];
					if (validateToolName(name, config.availableTools)) {
						const args = tryParseJson(argsStr) ?? tryParseKwargs(argsStr) ?? argsStr.trim();
						results.push({ name, arguments: args });
					}
				}
				break;
			}
			case 'fn': {
				regex = buildFnRegex(available);
				let m;
				while ((m = regex.exec(content)) !== null) {
					const name = m[1];
					const argsStr = m[2];
					if (validateToolName(name, config.availableTools)) {
						const args = tryParseJson(argsStr) ?? tryParseKwargs(argsStr) ?? argsStr.trim();
						results.push({ name, arguments: args });
					}
				}
				break;
			}
			case 'json': {
				results.push(...parseJsonToolCalls(content, config.availableTools));
				break;
			}
		}
	}

	// The canonical JSON shape is tried even when it isn't in the pattern list.
	// It predates being listable, so installs that saved the older default
	// ("braces,xml,fn") would otherwise never recover a plain JSON tool call —
	// the single most common way a call leaks into visible content. Only runs
	// when the configured patterns found nothing, so it can't override them.
	if (results.length === 0 && !config.patterns.includes('json')) {
		results.push(...parseJsonToolCalls(content, config.availableTools));
	}

	return results;
}

/**
 * Resolve fallback tool calls for a turn that produced no structured
 * `tool_calls`, scanning the visible answer first and the reasoning stream
 * second.
 *
 * Reasoning models routinely emit the call inside their thinking block and then
 * only narrate it in the answer ("I've saved the file"), which leaves the user
 * told a tool ran when nothing did. `reasoning_content` arrives on a separate
 * stream from the answer, so it has to be scanned explicitly — but only as a
 * last resort, since a call in the visible answer is the stronger signal of
 * intent.
 */
export function parseToolCallsFromTurn(
	content: string,
	reasoningContent: string | undefined,
	config: ToolCallParserConfig
): ParsedToolCall[] {
	const fromAnswer = parseToolCallsFromText(content, config);
	if (fromAnswer.length > 0) return fromAnswer;
	if (!reasoningContent) return [];
	return parseToolCallsFromText(reasoningContent, config);
}

export function createApiToolCalls(parsed: ParsedToolCall[]): ApiChatCompletionToolCall[] {
	return parsed.map((tc, i) => ({
		id: `fallback_tool_${Date.now()}_${i}`,
		type: 'function' as const,
		function: {
			name: tc.name,
			arguments: tc.arguments
		}
	}));
}
