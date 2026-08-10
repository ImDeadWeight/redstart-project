import { getJsonHeaders } from '$lib/utils/api-headers';
import { resolveApiPath } from '$lib/utils/api-fetch';
import { isAbortError } from '$lib/utils/abort';
import {
	ATTACHMENT_LABEL_PDF_FILE,
	REASONING_EFFORT_TOKENS,
	API_CHAT,
	API_SLOTS,
	CONTROL_ACTION
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
				const error = await ChatService.parseErrorResponse(response);

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

	/**
	 * Checks whether all server slots are currently idle (not processing any requests).
	 * Queries the /slots endpoint (requires --slots flag on the server).
	 * Returns true if all slots are idle, false if any is processing.
	 * If the endpoint is unavailable or errors out, returns true (best-effort fallback).
	 *
	 * @param signal - Optional AbortSignal to cancel the request if needed
	 * @param model - Optional model name to check slots for (required in ROUTER mode)
	 * @returns {Promise<boolean>} Promise that resolves to true if all slots are idle, false if any is processing
	 */
	static async areAllSlotsIdle(model?: string | null, signal?: AbortSignal): Promise<boolean> {
		try {
			const basePath = resolveApiPath(API_SLOTS.LIST);
			const url = model ? `${basePath}?model=${encodeURIComponent(model)}` : basePath;
			const res = await fetch(url, { signal });
			if (!res.ok) return true;

			const slots: { is_processing: boolean }[] = await res.json();
			return slots.every((s) => !s.is_processing);
		} catch {
			return true;
		}
	}

	/**
	 * Ends the current reasoning block of a running completion, targeted by its
	 * chat completion id (streamed back as `id`). Matching the completion rather
	 * than a slot index avoids a TOCTOU: a finished completion simply matches
	 * nothing server side. The model is carried so the router forwards to the
	 * right child, single model ignores it. Returns true on success.
	 */
	static async stopReasoning(completionId: string, model?: string | null): Promise<boolean> {
		if (!completionId) {
			console.error(
				'stopReasoning: no completion id for the active message, cannot target the running completion'
			);
			return false;
		}

		const body: Record<string, unknown> = {
			id: completionId,
			action: CONTROL_ACTION.END_REASONING
		};
		if (model) body.model = model;

		try {
			const res = await fetch(resolveApiPath(API_CHAT.CONTROL), {
				method: 'POST',
				headers: getJsonHeaders(),
				body: JSON.stringify(body)
			});

			const data = await res.json().catch(() => null);
			if (!res.ok || data?.success !== true) {
				console.error('stopReasoning: control request failed', {
					status: res.status,
					completionId,
					response: data
				});
				return false;
			}
			return true;
		} catch (error) {
			console.error('stopReasoning: control request threw', { completionId, error });
			return false;
		}
	}

	/**
	 * Sends a fire-and-forget request to pre-encode the conversation in the server's KV cache.
	 * After a response completes, this re-submits the full conversation
	 * using n_predict=0 and stream=false so the server processes the prompt without generating tokens.
	 * This warms the cache for the next turn, making it faster.
	 *
	 * When excludeReasoningFromContext is true, reasoning content is stripped from the messages
	 * to match what sendMessage would send on the next turn (avoiding cache misses).
	 * When false, reasoning_content is preserved so the cached prompt matches the next request.
	 *
	 * @param messages - The full conversation including the latest assistant response
	 * @param model - Optional model name (required in ROUTER mode)
	 * @param excludeReasoning - Whether to strip reasoning content (should match excludeReasoningFromContext setting)
	 * @param signal - Optional AbortSignal to cancel the pre-encode request
	 */
	static async preEncode(
		messages: ApiChatMessageData[] | (DatabaseMessage & { extra?: DatabaseMessageExtra[] })[],
		model?: string | null,
		excludeReasoning?: boolean,
		signal?: AbortSignal
	): Promise<void> {
		const normalizedMessages: ApiChatMessageData[] = (
			await Promise.all(
				messages.map((msg) => {
					if ('id' in msg && 'convId' in msg && 'timestamp' in msg) {
						return convertDbMessageToApiChatMessageData(
							msg as DatabaseMessage & { extra?: DatabaseMessageExtra[] }
						);
					}

					return msg as ApiChatMessageData;
				})
			)
		).filter((msg: { role: ChatRole; content: string | ApiChatMessageContentPart[] }) => {
			if (msg.role === MessageRole.SYSTEM) {
				const content = typeof msg.content === 'string' ? msg.content : '';

				return content.trim().length > 0;
			}

			return true;
		});

		const requestBody: Record<string, unknown> = {
			messages: normalizedMessages.map((msg: ApiChatMessageData) => {
				const mapped: Record<string, unknown> = {
					role: msg.role,
					content: excludeReasoning ? stripReasoningContent(msg.content) : msg.content,
					tool_calls: msg.tool_calls,
					tool_call_id: msg.tool_call_id
				};

				if (!excludeReasoning && msg.reasoning_content) {
					mapped.reasoning_content = msg.reasoning_content;
				}

				return mapped;
			}),
			stream: false,
			n_predict: 0
		};

		if (model) {
			requestBody.model = model;
		}

		try {
			await fetch(resolveApiPath(API_CHAT.COMPLETIONS), {
				method: 'POST',
				headers: getJsonHeaders(),
				body: JSON.stringify(requestBody),
				signal
			});
		} catch (error) {
			if (!isAbortError(error)) {
				console.warn('[ChatService] Pre-encode request failed:', error);
			}
		}
	}

	/**
	 *
	 *
	 * Conversion
	 *
	 *
	 */

	/**
	 * Parses error response and creates appropriate error with context information
	 * @param response - HTTP response object
	 * @returns Promise<Error> - Parsed error with context info if available
	 */
	private static async parseErrorResponse(
		response: Response
	): Promise<Error & { contextInfo?: { n_prompt_tokens: number; n_ctx: number } }> {
		try {
			const errorText = await response.text();
			const errorData: ApiErrorResponse = JSON.parse(errorText);

			const message = errorData.error?.message || 'Unknown server error';
			const error = new Error(message) as Error & {
				contextInfo?: { n_prompt_tokens: number; n_ctx: number };
			};
			error.name = response.status === 400 ? 'ServerError' : 'HttpError';

			if (errorData.error && 'n_prompt_tokens' in errorData.error && 'n_ctx' in errorData.error) {
				error.contextInfo = {
					n_prompt_tokens: errorData.error.n_prompt_tokens,
					n_ctx: errorData.error.n_ctx
				};
			}

			return error;
		} catch {
			const fallback = new Error(
				`Server error (${response.status}): ${response.statusText}`
			) as Error & {
				contextInfo?: { n_prompt_tokens: number; n_ctx: number };
			};
			fallback.name = 'HttpError';

			return fallback;
		}
	}

	/**
	 * Extracts model name from Chat Completions API response data.
	 * Handles various response formats including streaming chunks and final responses.
	 *
	 * WORKAROUND: In single model mode, llama-server returns a default/incorrect model name
	 * in the response. We override it with the actual model name from serverStore.
	 *
	 * @param data - Raw response data from the Chat Completions API
	 * @returns Model name string if found, undefined otherwise
	 * @private
	 */
	private static extractModelName(data: unknown): string | undefined {
		const asRecord = (value: unknown): Record<string, unknown> | undefined => {
			return typeof value === 'object' && value !== null
				? (value as Record<string, unknown>)
				: undefined;
		};

		const getTrimmedString = (value: unknown): string | undefined => {
			return typeof value === 'string' && value.trim() ? value.trim() : undefined;
		};

		const root = asRecord(data);
		if (!root) return undefined;

		// 1) root (some implementations provide `model` at the top level)
		const rootModel = getTrimmedString(root.model);
		if (rootModel) {
			return rootModel;
		}

		// 2) streaming choice (delta) or final response (message)
		const firstChoice = Array.isArray(root.choices) ? asRecord(root.choices[0]) : undefined;
		if (!firstChoice) {
			return undefined;
		}

		// priority: delta.model (first chunk) else message.model (final response)
		const deltaModel = getTrimmedString(asRecord(firstChoice.delta)?.model);
		if (deltaModel) {
			return deltaModel;
		}

		const messageModel = getTrimmedString(asRecord(firstChoice.message)?.model);
		if (messageModel) {
			return messageModel;
		}

		// avoid guessing from non-standard locations (metadata, etc.)
		return undefined;
	}
}
