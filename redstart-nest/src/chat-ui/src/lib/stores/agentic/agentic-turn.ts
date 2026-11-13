/**
 * agentic-turn - the browser's model port: one streaming LLM turn
 *
 * Sends the conversation through ChatService, and fills the loop core's
 * accumulator with the answer, the reasoning stream and any tool calls as they
 * arrive. The core folds this turn's timings into the flow totals afterwards,
 * and runs the fallback parser when the model narrated a call instead of
 * emitting one (the browser's settings reach it through the store's
 * `fallbackParser` port).
 *
 * **Why an accumulator rather than a return value.** This can throw: the stream
 * can fail or be aborted mid-turn. The core's catch block then saves whatever
 * the model had already produced, and losing that save silently drops the
 * user's partial response. A returned object would not exist on the throwing
 * path. So the core owns the accumulator, passes it in, and this fills it as
 * chunks arrive.
 *
 * Covered by tests/unit/agentic-loop.test.ts.
 */

import { ChatService } from '$lib/services/chat.service';
import { toolsStore } from '$lib/stores/tools.svelte';
import type { AgenticSessionState } from './agentic-session.svelte';
import type { AgenticFlowCallbacks, AgenticFlowOptions } from '$lib/types/agentic';
import type { TurnAccumulator } from '$lib/agent-core';

export class AgenticTurn {
	constructor(private readonly session: AgenticSessionState) {}

	async runTurn(params: {
		acc: TurnAccumulator;
		conversationId: string;
		sessionMessages: ApiChatMessageData[];
		options: AgenticFlowOptions;
		tools: ReturnType<typeof toolsStore.getEnabledToolsForLLM>;
		callbacks: AgenticFlowCallbacks;
		signal?: AbortSignal;
	}): Promise<void> {
		const {
			acc,
			conversationId,
			sessionMessages,
			options,
			tools,
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
	}
}
