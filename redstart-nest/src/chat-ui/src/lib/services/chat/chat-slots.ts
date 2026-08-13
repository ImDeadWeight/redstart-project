/**
 * chat-slots - server slot control and pre-encoding
 *
 * Owns slot-idle checks, reasoning-stop requests, and prompt pre-encoding.
 * Does not know about the streaming pipeline or message conversion.
 */

import { getJsonHeaders } from '$lib/utils/api-headers';
import { resolveApiPath } from '$lib/utils/api-fetch';
import { isAbortError } from '$lib/utils/abort';
import { MessageRole } from '$lib/enums';
import {
	API_CHAT,
	API_SLOTS,
	CONTROL_ACTION
} from '$lib/constants';
import { convertDbMessageToApiChatMessageData, stripReasoningContent } from './chat-message-convert';

export async function areAllSlotsIdle(model?: string | null, signal?: AbortSignal): Promise<boolean> {
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

export async function stopReasoning(completionId: string, model?: string | null): Promise<boolean> {
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

export async function preEncode(
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
