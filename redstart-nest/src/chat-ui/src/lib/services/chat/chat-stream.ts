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

export function mergeToolCallDeltas(
	existing: ApiChatCompletionToolCall[],
	deltas: ApiChatCompletionToolCallDelta[],
	indexOffset = 0
): ApiChatCompletionToolCall[] {
	const result = existing.map((call) => ({
		...call,
		function: call.function ? { ...call.function } : undefined
	}));

	for (const delta of deltas) {
		const index =
			typeof delta.index === 'number' && delta.index >= 0
				? delta.index + indexOffset
				: result.length;

		while (result.length <= index) {
			result.push({ function: undefined });
		}

		const target = result[index]!;

		if (delta.id) {
			target.id = delta.id;
		}

		if (delta.type) {
			target.type = delta.type;
		}

		if (delta.function) {
			const fn = target.function ? { ...target.function } : {};

			if (delta.function.name) {
				fn.name = delta.function.name;
			}

			if (delta.function.arguments) {
				fn.arguments = (fn.arguments ?? '') + delta.function.arguments;
			}

			target.function = fn;
		}
	}

	return result;
}

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

					try {
						const parsed: ApiChatCompletionStreamChunk = JSON.parse(data);
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

						if (content) {
							finalizeOpenToolCallBatch();
							aggregatedContent += content;
							if (!abortSignal?.aborted) {
								onChunk?.(content);
							}
						}

						if (reasoningContent) {
							finalizeOpenToolCallBatch();
							fullReasoningContent += reasoningContent;
							if (!abortSignal?.aborted) {
								onReasoningChunk?.(reasoningContent);
							}
						}

						processToolCallDelta(toolCalls);
					} catch (e) {
						console.error('Error parsing JSON chunk:', e);
					}
				}
			}

			if (abortSignal?.aborted) break;
		}

		if (abortSignal?.aborted) return;

		if (streamFinished) {
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

		const content = data.choices[0]?.message?.content || '';
		const reasoningContent = data.choices[0]?.message?.reasoning_content;
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

		if (!content.trim() && !serializedToolCalls) {
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
