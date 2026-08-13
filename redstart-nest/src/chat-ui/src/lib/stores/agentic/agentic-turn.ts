/**
 * agentic-turn - one streaming LLM turn
 *
 * Phases 3-5 of the agentic loop: send the conversation, accumulate the answer,
 * the reasoning stream and any tool calls as they arrive, fold this turn's
 * timings into the running totals, and - when the model narrated a call instead
 * of emitting one - run the fallback parser over what it said.
 *
 * **Why an accumulator rather than a return value.** This can throw: the stream
 * can fail or be aborted mid-turn. The caller's catch block then saves whatever
 * the model had already produced, and §4.5 is explicit that losing that save
 * silently drops the user's partial response. A returned object would not exist
 * on the throwing path, and locals copied out afterwards would be stale. So the
 * caller owns an AgenticTurnAccumulator, passes it in, and this fills it as
 * chunks arrive - the same mutation the inline code did to its `let`s, and the
 * reason the caller reads `acc.*` everywhere instead of keeping copies.
 *
 * Unlike agentic-tool-exec this needs no sentinel: the block it replaces holds
 * no `return`, `break` or flow-completion callback. Every exit path around it
 * stays in executeAgenticLoop untouched.
 *
 * Covered by tests/unit/agentic-loop.test.ts.
 */

import { ChatService } from '$lib/services/chat.service';
import { config } from '$lib/stores/settings.svelte';
import { toolsStore } from '$lib/stores/tools.svelte';
import { parseToolCallsFromTurn, createApiToolCalls } from '$lib/utils/tool-call-parser';
import type { AgenticSessionState } from './agentic-session.svelte';
import type { AgenticFlowCallbacks, AgenticFlowOptions } from '$lib/types/agentic';
import type { ChatMessageAgenticTimings, ChatMessageAgenticTurnStats } from '$lib/types';

/**
 * Per-turn state, owned by the caller so it survives a throw. `captured` spans
 * turns: seeded from the previous one, read back after this one.
 */
export interface AgenticTurnAccumulator {
	content: string;
	reasoning: string;
	toolCalls: ApiChatCompletionToolCall[];
	timings: ChatMessageTimings | undefined;
	captured: ChatMessageTimings | undefined;
}

export function createTurnAccumulator(
	captured: ChatMessageTimings | undefined
): AgenticTurnAccumulator {
	return { content: '', reasoning: '', toolCalls: [], timings: undefined, captured };
}

export class AgenticTurn {
	constructor(private readonly session: AgenticSessionState) {}

	async runTurn(params: {
		acc: AgenticTurnAccumulator;
		conversationId: string;
		sessionMessages: ApiChatMessageData[];
		options: AgenticFlowOptions;
		tools: ReturnType<typeof toolsStore.getEnabledToolsForLLM>;
		agenticTimings: ChatMessageAgenticTimings;
		turnStats: ChatMessageAgenticTurnStats;
		callbacks: AgenticFlowCallbacks;
		signal?: AbortSignal;
	}): Promise<void> {
		const {
			acc,
			conversationId,
			sessionMessages,
			options,
			tools,
			agenticTimings,
			turnStats,
			callbacks,
			signal
		} = params;
		const { onChunk, onReasoningChunk, onToolCallsStreaming, onModel, onCompletionId, onTimings } =
			callbacks;
		// Streaming dedupe trackers, previously two `let`s beside the turn locals.
		const dedupe = { name: '', argsLength: 0 };

		await ChatService.sendMessage(
			sessionMessages as ApiChatMessageData[],
			{
				...options,
				stream: true,
				tools: tools.length > 0 ? tools : undefined,
				onChunk: (chunk: string) => {
					acc.content += chunk;
					onChunk?.(chunk);
				},
				onReasoningChunk: (chunk: string) => {
					acc.reasoning += chunk;
					onReasoningChunk?.(chunk);
				},
				onToolCallChunk: (serialized: string) => {
					try {
						acc.toolCalls = JSON.parse(serialized) as ApiChatCompletionToolCall[];
						onToolCallsStreaming?.(acc.toolCalls);

						if (acc.toolCalls.length > 0 && acc.toolCalls[0]?.function) {
							const name = acc.toolCalls[0].function.name || '';
							const args = acc.toolCalls[0].function.arguments || '';
							const argsLengthBucket = Math.floor(args.length / 100);
							if (
								name !== dedupe.name ||
								argsLengthBucket !== dedupe.argsLength
							) {
								dedupe.name = name;
								dedupe.argsLength = argsLengthBucket;
								this.session.updateSession(conversationId, {
									streamingToolCall: { name, arguments: args }
								});
							}
						}
					} catch {
						/* Ignore parse errors during streaming */
					}
				},
				onModel,
				onCompletionId,
				onTimings: (timings?: ChatMessageTimings, progress?: ChatMessagePromptProgress) => {
					onTimings?.(timings, progress);
					if (timings) {
						acc.captured = timings;
						acc.timings = timings;
					}
				},
				onComplete: () => {
					/* Completion handled after sendMessage resolves */
				},
				onError: (error: Error) => {
					throw error;
				}
			},
			undefined,
			signal
		);

		this.session.updateSession(conversationId, { streamingToolCall: null });

		if (acc.timings) {
			agenticTimings.llm.predicted_n += acc.timings.predicted_n || 0;
			agenticTimings.llm.predicted_ms += acc.timings.predicted_ms || 0;
			agenticTimings.llm.prompt_n += acc.timings.prompt_n || 0;
			agenticTimings.llm.prompt_ms += acc.timings.prompt_ms || 0;
			turnStats.llm.predicted_n = acc.timings.predicted_n || 0;
			turnStats.llm.predicted_ms = acc.timings.predicted_ms || 0;
			turnStats.llm.prompt_n = acc.timings.prompt_n || 0;
			turnStats.llm.prompt_ms = acc.timings.prompt_ms || 0;
		}

		if (acc.toolCalls.length === 0 && config().toolCallFallbackParserEnabled) {
			const patternList: string[] = (config().toolCallFallbackParserPatterns || '')
				.split(',')
				.map((p: string) => p.trim())
				.filter(Boolean);
			// Scans the visible answer, then the reasoning stream — a reasoning
			// model often writes the call in its thinking block and only
			// narrates it in the answer, which would otherwise drop it silently.
			const parsed = parseToolCallsFromTurn(acc.content, acc.reasoning, {
				patterns: patternList,
				availableTools: toolsStore.allTools.map((t) => ({ name: t.definition.function.name }))
			});

			if (parsed.length > 0) {
				acc.toolCalls = createApiToolCalls(parsed);
			}
		}
	}
}
