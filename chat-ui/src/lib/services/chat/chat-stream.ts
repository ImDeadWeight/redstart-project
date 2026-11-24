/**
 * chat-stream - SSE reader loop and streaming response handling
 *
 * Owns the streaming and non-streaming response readers, tool-call delta
 * assembly, and timing notification. Does not know about message conversion
 * or error classification.
 */

import { UrlProtocol } from '$lib/enums';
import type {
	ApiChatCompletionStreamChunk,
	ApiChatCompletionToolCall,
	ApiChatCompletionToolCallDelta
} from '$lib/types/api';
import { extractModelName } from './chat-errors';
import { mergeToolCallDeltas as coreMergeToolCallDeltas, streamErrorMessage } from '$lib/agent-core';
import { ThinkTagRouter, routeThinkTags, type RoutedSegment } from './think-tags';

/**
 * Fold one chunk's tool-call deltas into the calls so far. One implementation,
 * in the shared loop core (shared/agent-core/chat-stream.mjs), so the bench
 * and the daemon assemble calls exactly as the browser does.
 */
export const mergeToolCallDeltas = coreMergeToolCallDeltas as (
	existing: ApiChatCompletionToolCall[],
	deltas: ApiChatCompletionToolCallDelta[],
	indexOffset?: number
) => ApiChatCompletionToolCall[];

export function notifyTimings(
	timings: ChatMessageTimings | undefined,
	promptProgress: ChatMessagePromptProgress | undefined,
	onTimingsCallback:
		| ((timings?: ChatMessageTimings, promptProgress?: ChatMessagePromptProgress) => void)
		| undefined
): void {
	if (!onTimingsCallback || (!timings && !promptProgress)) return;

	onTimingsCallback(timings, promptProgress);
}

export async function handleStreamResponse(
	response: Response,
	onChunk?: (chunk: string) => void,
	onComplete?: (
		response: string,
		reasoningContent?: string,
		timings?: ChatMessageTimings,
		toolCalls?: string
	) => void,
	onError?: (error: Error) => void,
	onReasoningChunk?: (chunk: string) => void,
	onToolCallChunk?: (chunk: string) => void,
	onModel?: (model: string) => void,
	onCompletionId?: (id: string) => void,
	onTimings?: (timings?: ChatMessageTimings, promptProgress?: ChatMessagePromptProgress) => void,
	conversationId?: string,
	abortSignal?: AbortSignal
): Promise<void> {
	const reader = response.body?.getReader();

	if (!reader) {
		throw new Error('No response body');
	}

	const decoder = new TextDecoder();
	let aggregatedContent = '';
	let fullReasoningContent = '';
	let aggregatedToolCalls: ApiChatCompletionToolCall[] = [];
	let lastTimings: ChatMessageTimings | undefined;
	let streamFinished = false;
	let modelEmitted = false;
	let idEmitted = false;
	let toolCallIndexOffset = 0;
	let hasOpenToolCallBatch = false;
	// Thinking markup the server's parser let through into the content goes to
	// the reasoning channel or is dropped (see think-tags.ts).
	const thinkRouter = new ThinkTagRouter();

	const finalizeOpenToolCallBatch = () => {
		if (!hasOpenToolCallBatch) {
			return;
		}

		toolCallIndexOffset = aggregatedToolCalls.length;
		hasOpenToolCallBatch = false;
	};

	const processToolCallDelta = (toolCalls?: ApiChatCompletionToolCallDelta[]) => {
		if (!toolCalls || toolCalls.length === 0) {
			return;
		}

		aggregatedToolCalls = mergeToolCallDeltas(
			aggregatedToolCalls,
			toolCalls,
			toolCallIndexOffset
		);

		if (aggregatedToolCalls.length === 0) {
			return;
		}

		hasOpenToolCallBatch = true;

		const serializedToolCalls = JSON.stringify(aggregatedToolCalls);

		if (import.meta.env.DEV && import.meta.env.VITE_DEBUG) {
			console.log('[ChatService] Aggregated tool calls:', serializedToolCalls);
		}

		if (!serializedToolCalls) {
			return;
		}

		if (!abortSignal?.aborted) {
			onToolCallChunk?.(serializedToolCalls);
		}
	};

	const emitContent = (text: string) => {
		if (!text) return;
		finalizeOpenToolCallBatch();
		aggregatedContent += text;
		if (!abortSignal?.aborted) onChunk?.(text);
	};
	const emitReasoning = (text: string) => {
		if (!text) return;
		finalizeOpenToolCallBatch();
		fullReasoningContent += text;
		if (!abortSignal?.aborted) onReasoningChunk?.(text);
	};
	const emitRouted = (segments: RoutedSegment[]) => {
		for (const segment of segments) {
			if (segment.kind === 'content') emitContent(segment.text);
			else emitReasoning(segment.text);
		}
	};

	try {
		let chunk = '';
		while (true) {
			if (abortSignal?.aborted) break;

			const { done, value } = await reader.read();
			if (done) break;

			if (abortSignal?.aborted) break;

			chunk += decoder.decode(value, { stream: true });
			const lines = chunk.split('\n');
			chunk = lines.pop() || '';

			for (const line of lines) {
				if (abortSignal?.aborted) break;

				if (line.startsWith(UrlProtocol.DATA)) {
					const data = line.slice(6);
					if (data === '[DONE]') {
						streamFinished = true;

						continue;
					}

					// A server error mid-reply (see streamErrorMessage). Recorded
					// here and thrown below, outside the try that swallows a chunk
					// that fails to parse: the outer catch reports it through onError.
					let streamError: string | null = null;
					try {
						const parsed: ApiChatCompletionStreamChunk = JSON.parse(data);
						// An error chunk has no choices, so the rest of this block
						// does nothing with it.
						streamError = streamErrorMessage(parsed);
						const choice = parsed.choices?.[0];
						const content = choice?.delta?.content;
						const reasoningContent = choice?.delta?.reasoning_content;
						const toolCalls = choice?.delta?.tool_calls;
						const timings = parsed.timings;
						const promptProgress = parsed.prompt_progress;

						const chunkModel = extractModelName(parsed);
						if (chunkModel && !modelEmitted) {
							modelEmitted = true;
							onModel?.(chunkModel);
						}

						if (parsed.id && !idEmitted) {
							idEmitted = true;
							onCompletionId?.(parsed.id);
						}

						if (promptProgress) {
							notifyTimings(undefined, promptProgress, onTimings);
						}

						if (timings) {
							notifyTimings(timings, promptProgress, onTimings);
							lastTimings = timings;
						}

						if (content) emitRouted(thinkRouter.push(content));

						if (reasoningContent) emitReasoning(reasoningContent);

						processToolCallDelta(toolCalls);
					} catch (e) {
						console.error('Error parsing JSON chunk:', e);
					}
					if (streamError) throw new Error(streamError);
				}
			}

			if (abortSignal?.aborted) break;
		}

		if (abortSignal?.aborted) return;

		if (streamFinished) {
			emitRouted(thinkRouter.flush());
			finalizeOpenToolCallBatch();

			const finalToolCalls =
				aggregatedToolCalls.length > 0 ? JSON.stringify(aggregatedToolCalls) : undefined;

			onComplete?.(
				aggregatedContent,
				fullReasoningContent || undefined,
				lastTimings,
				finalToolCalls
			);
		}
	} catch (error) {
		const err = error instanceof Error ? error : new Error('Stream error');

		onError?.(err);

		throw err;
	} finally {
		reader.releaseLock();
	}
}

export async function handleNonStreamResponse(
	response: Response,
	onComplete?: (
		response: string,
		reasoningContent?: string,
		timings?: ChatMessageTimings,
		toolCalls?: string
	) => void,
	onError?: (error: Error) => void,
	onToolCallChunk?: (chunk: string) => void,
	onModel?: (model: string) => void
): Promise<string> {
	try {
		const responseText = await response.text();

		if (!responseText.trim()) {
			const noResponseError = new Error('No response received from server. Please try again.');

			throw noResponseError;
		}

		const data: ApiChatCompletionResponse = JSON.parse(responseText);

		const responseModel = extractModelName(data);
		if (responseModel) {
			onModel?.(responseModel);
		}

		const rawContent = data.choices[0]?.message?.content || '';
		const routed = routeThinkTags(rawContent);
		const content = routed.content;
		const serverReasoning = data.choices[0]?.message?.reasoning_content;
		const reasoningContent =
			serverReasoning || routed.reasoning ? `${serverReasoning ?? ''}${routed.reasoning}` : undefined;
		const toolCalls = data.choices[0]?.message?.tool_calls;

		let serializedToolCalls: string | undefined;

		if (toolCalls && toolCalls.length > 0) {
			const mergedToolCalls = mergeToolCallDeltas([], toolCalls);

			if (mergedToolCalls.length > 0) {
				serializedToolCalls = JSON.stringify(mergedToolCalls);
				if (serializedToolCalls) {
					onToolCallChunk?.(serializedToolCalls);
				}
			}
		}

		// Judged on what the server sent: a reply that was all thinking is a
		// reply, even if routing leaves its content empty.
		if (!rawContent.trim() && !serializedToolCalls) {
			const noResponseError = new Error('No response received from server. Please try again.');

			throw noResponseError;
		}

		onComplete?.(content, reasoningContent, undefined, serializedToolCalls);

		return content;
	} catch (error) {
		const err = error instanceof Error ? error : new Error('Parse error');

		onError?.(err);

		throw err;
	}
}
