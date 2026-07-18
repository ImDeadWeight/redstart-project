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
						const args = tryParseJson(argsStr) ?? argsStr.trim();
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
						const args = tryParseJson(argsStr) ?? argsStr.trim();
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
						const args = tryParseJson(argsStr) ?? argsStr.trim();
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
