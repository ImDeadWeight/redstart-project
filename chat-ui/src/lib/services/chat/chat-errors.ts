/**
 * chat-errors - error response parsing and model name extraction
 *
 * Owns HTTP error response parsing and model name extraction from API
 * response data. Does not know about the streaming pipeline or message
 * conversion.
 */

import type { ApiErrorResponse } from '$lib/types/api';

export async function parseErrorResponse(
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

export function extractModelName(data: unknown): string | undefined {
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

	const rootModel = getTrimmedString(root.model);
	if (rootModel) {
		return rootModel;
	}

	const firstChoice = Array.isArray(root.choices) ? asRecord(root.choices[0]) : undefined;
	if (!firstChoice) {
		return undefined;
	}

	const deltaModel = getTrimmedString(asRecord(firstChoice.delta)?.model);
	if (deltaModel) {
		return deltaModel;
	}

	const messageModel = getTrimmedString(asRecord(firstChoice.message)?.model);
	if (messageModel) {
		return messageModel;
	}

	return undefined;
}
