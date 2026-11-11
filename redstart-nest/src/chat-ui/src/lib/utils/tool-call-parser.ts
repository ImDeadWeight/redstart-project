/**
 * Fallback text-to-tool-call parser.
 *
 * Moved to the shared loop core (shared/agent-core/tool-call-parser.mjs), where
 * the loop applies it for every host. Re-exported here, with chat-ui's types,
 * so existing imports and tests keep working.
 */

import {
	parseToolCallsFromText as coreParseText,
	parseToolCallsFromTurn as coreParseTurn,
	createApiToolCalls as coreCreateApiToolCalls
} from '$lib/agent-core';
import type { ToolCallParserConfig, ParsedToolCall } from '$lib/agent-core';
import type { ApiChatCompletionToolCall } from '$lib/types/api';

export type { ToolCallParserConfig, ParsedToolCall };

export const parseToolCallsFromText: (
	content: string,
	config: ToolCallParserConfig
) => ParsedToolCall[] = coreParseText;

export const parseToolCallsFromTurn: (
	content: string,
	reasoningContent: string | undefined,
	config: ToolCallParserConfig
) => ParsedToolCall[] = coreParseTurn;

export const createApiToolCalls: (parsed: ParsedToolCall[]) => ApiChatCompletionToolCall[] =
	coreCreateApiToolCalls;
