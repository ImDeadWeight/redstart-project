import { getJsonHeaders } from '$lib/utils/api-headers';
import { resolveApiPath } from '$lib/utils/api-fetch';
import { isAbortError } from '$lib/utils/abort';
import {
	API_CHAT,
	REASONING_EFFORT_TOKENS
} from '$lib/constants';
import {
	AttachmentType,
	ContentPartType,
	MessageRole,
	ReasoningFormat
} from '$lib/enums';
import type {
	ApiChatMessageContentPart,
	ApiChatMessageData
} from '$lib/types/api';
import { modelsStore } from '$lib/stores/models.svelte';
import {
	handleStreamResponse,
	handleNonStreamResponse
} from './chat/chat-stream';
import {
	convertDbMessageToApiChatMessageData,
	stripReasoningContent
} from './chat/chat-message-convert';
import { parseErrorResponse } from './chat/chat-errors';

export class ChatService {
	/**
	 *
	 *
	 * Title Generation
	 *
	 *
	 */

	/**
	 * Sends a streaming chat completion request for generating a chat title.
	 * Delegates to `sendMessage` for fetch, SSE parsing, and error handling.
	 *
	 * @param message - The single message to send (a user message containing the title generation prompt)
	 * @param model - Optional model name to use (required in ROUTER mode)
	 * @param signal - Optional AbortSignal to cancel the request
	 * @returns {Promise<string>} The aggregated title text, or empty string if request failed
	 * @static
	 */
	static async generateTitle(
		message: ApiChatMessageData,
		model?: string | null,
		signal?: AbortSignal
	): Promise<string> {
		let titleResponse = '';
		try {
			await ChatService.sendMessage(
				[message],
				{
					model: model || undefined,
					stream: true,
					custom: { chat_template_kwargs: { enable_thinking: false } },
					onChunk: (chunk: string) => {
						titleResponse += chunk;
					}
				},
				undefined,
				signal
			);
		} catch {
			return '';
		}
		return titleResponse;
	}

	/**
	 *
	 *
	 * Messaging
	 *
	 *
	 */

	/**
	 * Sends a chat completion request to the llama-server.
	 * Supports both streaming and non-streaming responses with comprehensive parameter configuration.
	 * Automatically converts database messages with attachments to the appropriate API format.
	 *
	 * @param messages - Array of chat messages to send to the API (supports both ApiChatMessageData and DatabaseMessage with attachments)
	 * @param options - Configuration options for the chat completion request. See `SettingsChatServiceOptions` type for details.
	 * @returns {Promise<string | void>} that resolves to the complete response string (non-streaming) or void (streaming)
	 * @throws {Error} if the request fails or is aborted
	 */
	static async sendMessage(
		messages: ApiChatMessageData[] | (DatabaseMessage & { extra?: DatabaseMessageExtra[] })[],
		options: SettingsChatServiceOptions = {},
		conversationId?: string,
		signal?: AbortSignal
	): Promise<string | void> {
		const {
			stream,
			onChunk,
			onComplete,
			onError,
			onReasoningChunk,
			onToolCallChunk,
			onModel,
			onCompletionId,
			onTimings,
			// Tools for function calling
			tools,
			// Generation parameters
			temperature,
			max_tokens,
			// Sampling parameters
			dynatemp_range,
			dynatemp_exponent,
			top_k,
			top_p,
			min_p,
			xtc_probability,
			xtc_threshold,
			typ_p,
			// Penalty parameters
			repeat_last_n,
			repeat_penalty,
			presence_penalty,
			frequency_penalty,
			dry_multiplier,
			dry_base,
			dry_allowed_length,
			dry_penalty_last_n,
			// Other parameters
			samplers,
			backend_sampling,
			custom,
			timings_per_token,
			// Config options
			excludeReasoningFromContext,
			enableThinking,
			reasoningEffort,
			continueFinalMessage,
			promptMode
		} = options;

		const normalizedMessages: ApiChatMessageData[] = (
			await Promise.all(
				messages.map((msg) => {
					if ('id' in msg && 'convId' in msg && 'timestamp' in msg) {
						const dbMsg = msg as DatabaseMessage & { extra?: DatabaseMessageExtra[] };

						return convertDbMessageToApiChatMessageData(dbMsg);
					} else {
						return msg as ApiChatMessageData;
					}
				})
			)
		).filter((msg: { role: ChatRole; content: string | ApiChatMessageContentPart[] }) => {
			// Filter out empty system messages
			if (msg.role === MessageRole.SYSTEM) {
				const content = typeof msg.content === 'string' ? msg.content : '';

				return content.trim().length > 0;
			}

			return true;
		});

		// Filter out image attachments if the model doesn't support vision
		if (options.model && !modelsStore.modelSupportsVision(options.model)) {
			normalizedMessages.forEach((msg) => {
				if (Array.isArray(msg.content)) {
					msg.content = msg.content.filter((part: ApiChatMessageContentPart) => {
						if (part.type === ContentPartType.IMAGE_URL) {
							console.info(
								`[ChatService] Skipping image attachment in message history (model "${options.model}" does not support vision)`
							);

							return false;
						}

						return true;
					});
					// If only text remains and it's a single part, simplify to string
					if (
						msg.content.length === 1 &&
						msg.content[0].type === ContentPartType.TEXT &&
						typeof msg.content[0].text === 'string'
					) {
						msg.content = msg.content[0].text;
					}
				}
			});
		}

		const requestBody: ApiChatCompletionRequest = {
			messages: normalizedMessages.map((msg: ApiChatMessageData) => {
				const mapped: ApiChatCompletionRequest['messages'][0] = {
					role: msg.role,
					content: msg.content,
					tool_calls: msg.tool_calls,
					tool_call_id: msg.tool_call_id
				};
				// Include reasoning_content from the dedicated field
				if (!excludeReasoningFromContext && msg.reasoning_content) {
					mapped.reasoning_content = msg.reasoning_content;
				}
				return mapped;
			}),
			stream,
			return_progress: stream ? true : undefined,
			tools: tools && tools.length > 0 ? tools : undefined
		};

		// Include model in request if provided (required in ROUTER mode)
		if (options.model) {
			requestBody.model = options.model;
		}

		requestBody.reasoning_format = ReasoningFormat.AUTO;

		const reasoningBudgetTokens =
			enableThinking && reasoningEffort ? (REASONING_EFFORT_TOKENS[reasoningEffort] ?? -1) : -1;

		requestBody.chat_template_kwargs = {
			...(requestBody.chat_template_kwargs ?? {}),
			enable_thinking: enableThinking
		};

		if (reasoningBudgetTokens >= 0) {
			requestBody.thinking_budget_tokens = reasoningBudgetTokens;
		}

		// arms the budget sampler so reasoning can be ended at runtime via the control endpoint
		requestBody.reasoning_control = true;

		if (continueFinalMessage) {
			requestBody.continue_final_message = true;
			requestBody.add_generation_prompt = false;
		}

		// Redstart-only field: the gateway resolves the mode ID into the system
		// prompt and deletes it before forwarding, so llama-server never sees a
		// parameter it has no concept of. See docs/connector-contract.md §3.
		if (promptMode) {
			requestBody.redstart_mode = promptMode;
		}

		if (temperature !== undefined) requestBody.temperature = temperature;
		if (max_tokens !== undefined) {
			// Set max_tokens to -1 (infinite) when explicitly configured as 0 or null
			requestBody.max_tokens = max_tokens !== null && max_tokens !== 0 ? max_tokens : -1;
		}

		if (dynatemp_range !== undefined) requestBody.dynatemp_range = dynatemp_range;
		if (dynatemp_exponent !== undefined) requestBody.dynatemp_exponent = dynatemp_exponent;
		if (top_k !== undefined) requestBody.top_k = top_k;
		if (top_p !== undefined) requestBody.top_p = top_p;
		if (min_p !== undefined) requestBody.min_p = min_p;
		if (xtc_probability !== undefined) requestBody.xtc_probability = xtc_probability;
		if (xtc_threshold !== undefined) requestBody.xtc_threshold = xtc_threshold;
		if (typ_p !== undefined) requestBody.typ_p = typ_p;

		if (repeat_last_n !== undefined) requestBody.repeat_last_n = repeat_last_n;
		if (repeat_penalty !== undefined) requestBody.repeat_penalty = repeat_penalty;
		if (presence_penalty !== undefined) requestBody.presence_penalty = presence_penalty;
		if (frequency_penalty !== undefined) requestBody.frequency_penalty = frequency_penalty;
		if (dry_multiplier !== undefined) requestBody.dry_multiplier = dry_multiplier;
		if (dry_base !== undefined) requestBody.dry_base = dry_base;
		if (dry_allowed_length !== undefined) requestBody.dry_allowed_length = dry_allowed_length;
		if (dry_penalty_last_n !== undefined) requestBody.dry_penalty_last_n = dry_penalty_last_n;

		if (samplers !== undefined) {
			requestBody.samplers =
				typeof samplers === 'string'
					? samplers.split(';').filter((s: string) => s.trim())
					: samplers;
		}

		if (backend_sampling !== undefined) requestBody.backend_sampling = backend_sampling;

		if (timings_per_token !== undefined) requestBody.timings_per_token = timings_per_token;

		if (custom) {
			try {
				const customParams = typeof custom === 'string' ? JSON.parse(custom) : custom;
				Object.assign(requestBody, customParams);
			} catch (error) {
				console.warn('Failed to parse custom parameters:', error);
			}
		}

		try {
			const response = await fetch(resolveApiPath(API_CHAT.COMPLETIONS), {
				method: 'POST',
				headers: getJsonHeaders(),
				body: JSON.stringify(requestBody),
				signal
			});

			if (!response.ok) {
				const error = await parseErrorResponse(response);

				if (onError) {
					onError(error);
				}

				throw error;
			}

			if (stream) {
				await handleStreamResponse(
					response,
					onChunk,
					onComplete,
					onError,
					onReasoningChunk,
					onToolCallChunk,
					onModel,
					onCompletionId,
					onTimings,
					conversationId,
					signal
				);

				return;
			} else {
				return handleNonStreamResponse(
					response,
					onComplete,
					onError,
					onToolCallChunk,
					onModel
				);
			}
		} catch (error) {
			if (isAbortError(error)) {
				console.log('Chat completion request was aborted');
				return;
			}

			let userFriendlyError: Error;

			if (error instanceof Error) {
				if (error.name === 'TypeError' && error.message.includes('fetch')) {
					userFriendlyError = new Error(
						'Unable to connect to server - please check if the server is running'
					);
					userFriendlyError.name = 'NetworkError';
				} else if (error.message.includes('ECONNREFUSED')) {
					userFriendlyError = new Error('Connection refused - server may be offline');
					userFriendlyError.name = 'NetworkError';
				} else if (error.message.includes('ETIMEDOUT')) {
					userFriendlyError = new Error('Request timed out - the server took too long to respond');
					userFriendlyError.name = 'TimeoutError';
				} else {
					userFriendlyError = error;
				}
			} else {
				userFriendlyError = new Error('Unknown error occurred while sending message');
			}

			console.error('Error in sendMessage:', error);

			if (onError) {
				onError(userFriendlyError);
			}

			throw userFriendlyError;
		}
	}
}
