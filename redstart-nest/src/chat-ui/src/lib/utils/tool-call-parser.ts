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
 */

export interface ToolCallParserConfig {
	patterns: string[];
	availableTools: Array<{ name: string }>;
}

export interface ParsedToolCall {
	name: string;
	arguments: string;
}

const DEFAULT_PATTERNS = ['braces', 'xml', 'fn'] as const;
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
		}
	}

	return results;
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
