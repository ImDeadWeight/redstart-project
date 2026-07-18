/**
 * chat-options - Pure/computational helpers for the chat store.
 *
 * Stateless functions extracted from `chat.svelte.ts`. They read leaf stores
 * (`settings`, `server`, `models`, `conversations`) directly but hold no state
 * of their own; any chat-runtime state they need is passed in as a parameter.
 */

import { config } from '$lib/stores/settings.svelte';
import { conversationsStore } from '$lib/stores/conversations.svelte';
import { contextSize, isRouterMode } from '$lib/stores/server.svelte';
import { selectedModelName, selectedModelContextSize } from '$lib/stores/models.svelte';
import type { ApiProcessingState, DatabaseMessage } from '$lib/types';
import { MessageRole } from '$lib/enums';

/**
 * Resolve the total context window size. The caller supplies the active
 * conversation's current processing state (which may carry a live contextTotal);
 * otherwise fall back to the router/props model context size.
 */
export function getContextTotal(activeState: ApiProcessingState | null): number | null {
	if (activeState && typeof activeState.contextTotal === 'number' && activeState.contextTotal > 0)
		return activeState.contextTotal;

	if (isRouterMode()) {
		const modelContextSize = selectedModelContextSize();

		if (typeof modelContextSize === 'number' && modelContextSize > 0) {
			return modelContextSize;
		}
	} else {
		const propsContextSize = contextSize();

		if (typeof propsContextSize === 'number' && propsContextSize > 0) {
			return propsContextSize;
		}
	}

	return null;
}

export function parseTimingData(
	timingData: Record<string, unknown>,
	contextTotal: number | null
): ApiProcessingState | null {
	const promptTokens = (timingData.prompt_n as number) || 0,
		promptMs = (timingData.prompt_ms as number) || undefined,
		predictedTokens = (timingData.predicted_n as number) || 0,
		tokensPerSecond = (timingData.predicted_per_second as number) || 0,
		cacheTokens = (timingData.cache_n as number) || 0;
	const promptProgress = timingData.prompt_progress as
		| { total: number; cache: number; processed: number; time_ms: number }
		| undefined;
	const currentConfig = config();
	const outputTokensMax = currentConfig.max_tokens || -1;
	const contextUsed = promptTokens + cacheTokens + predictedTokens,
		outputTokensUsed = predictedTokens;
	const progressCache = promptProgress?.cache || 0,
		progressActualDone = (promptProgress?.processed ?? 0) - progressCache,
		progressActualTotal = (promptProgress?.total ?? 0) - progressCache;
	const progressPercent = promptProgress
		? Math.round((progressActualDone / progressActualTotal) * 100)
		: undefined;
	return {
		status: predictedTokens > 0 ? 'generating' : promptProgress ? 'preparing' : 'idle',
		tokensDecoded: predictedTokens,
		tokensRemaining: outputTokensMax - predictedTokens,
		contextUsed,
		contextTotal,
		outputTokensUsed,
		outputTokensMax,
		hasNextToken: predictedTokens > 0,
		tokensPerSecond,
		temperature: currentConfig.temperature ?? 0.8,
		topP: currentConfig.top_p ?? 0.95,
		speculative: false,
		progressPercent,
		promptProgress,
		promptTokens,
		promptMs,
		cacheTokens
	};
}

export function getConversationModel(messages: DatabaseMessage[]): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === MessageRole.ASSISTANT && message.model) return message.model;
	}
	return null;
}

export function getApiOptions(): Record<string, unknown> {
	const currentConfig = config();
	const hasValue = (value: unknown): boolean =>
		value !== undefined && value !== null && value !== '';
	const apiOptions: Record<string, unknown> = { stream: true, timings_per_token: true };

	if (isRouterMode()) {
		const modelName = selectedModelName();
		if (modelName) apiOptions.model = modelName;
	}

	if (currentConfig.systemMessage) apiOptions.systemMessage = currentConfig.systemMessage;

	if (currentConfig.excludeReasoningFromContext) apiOptions.excludeReasoningFromContext = true;

	apiOptions.enableThinking = conversationsStore.getThinkingEnabled();
	apiOptions.reasoningEffort = conversationsStore.getReasoningEffort();

	if (hasValue(currentConfig.temperature))
		apiOptions.temperature = Number(currentConfig.temperature);

	if (hasValue(currentConfig.max_tokens))
		apiOptions.max_tokens = Number(currentConfig.max_tokens);

	if (hasValue(currentConfig.dynatemp_range))
		apiOptions.dynatemp_range = Number(currentConfig.dynatemp_range);

	if (hasValue(currentConfig.dynatemp_exponent))
		apiOptions.dynatemp_exponent = Number(currentConfig.dynatemp_exponent);

	if (hasValue(currentConfig.top_k)) apiOptions.top_k = Number(currentConfig.top_k);

	if (hasValue(currentConfig.top_p)) apiOptions.top_p = Number(currentConfig.top_p);

	if (hasValue(currentConfig.min_p)) apiOptions.min_p = Number(currentConfig.min_p);

	if (hasValue(currentConfig.xtc_probability))
		apiOptions.xtc_probability = Number(currentConfig.xtc_probability);

	if (hasValue(currentConfig.xtc_threshold))
		apiOptions.xtc_threshold = Number(currentConfig.xtc_threshold);

	if (hasValue(currentConfig.typ_p)) apiOptions.typ_p = Number(currentConfig.typ_p);

	if (hasValue(currentConfig.repeat_last_n))
		apiOptions.repeat_last_n = Number(currentConfig.repeat_last_n);

	if (hasValue(currentConfig.repeat_penalty))
		apiOptions.repeat_penalty = Number(currentConfig.repeat_penalty);

	if (hasValue(currentConfig.presence_penalty))
		apiOptions.presence_penalty = Number(currentConfig.presence_penalty);

	if (hasValue(currentConfig.frequency_penalty))
		apiOptions.frequency_penalty = Number(currentConfig.frequency_penalty);

	if (hasValue(currentConfig.dry_multiplier))
		apiOptions.dry_multiplier = Number(currentConfig.dry_multiplier);

	if (hasValue(currentConfig.dry_base)) apiOptions.dry_base = Number(currentConfig.dry_base);

	if (hasValue(currentConfig.dry_allowed_length))
		apiOptions.dry_allowed_length = Number(currentConfig.dry_allowed_length);

	if (hasValue(currentConfig.dry_penalty_last_n))
		apiOptions.dry_penalty_last_n = Number(currentConfig.dry_penalty_last_n);

	if (currentConfig.samplers) apiOptions.samplers = currentConfig.samplers;

	apiOptions.backend_sampling = currentConfig.backend_sampling;

	if (currentConfig.customJson) apiOptions.custom = currentConfig.customJson;

	return apiOptions;
}
