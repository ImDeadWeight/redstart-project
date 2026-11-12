import { AgenticSectionType, ContinueIntentKind, MessageRole } from '$lib/enums';
import { ATTACHMENT_SAVED_REGEX, FILE_PATH_REGEX, NEWLINE_SEPARATOR } from '$lib/constants';
import { parseResourceLine, type ToolResultResource } from './resource-links';
import type { ApiChatCompletionToolCall } from '$lib/types/api';
import type {
	DatabaseMessage,
	DatabaseMessageExtra,
	DatabaseMessageExtraImageFile
} from '$lib/types/database';
import { AttachmentType } from '$lib/enums';
import { getServerBaseUrl } from './server-url';
import { getAuthHeaders } from './api-headers';
import { ASK_USER_TOOL, formatAskAnswer, parseAskArguments } from '$lib/agent-core';
import type { AskAnswer, AskRequest, PlanStep } from '$lib/agent-core';
import type { TaskRecord } from '$lib/services/task.service';

/**
 * Represents a parsed section of agentic content for display
 */
export interface AgenticSection {
	type: AgenticSectionType;
	content: string;
	toolName?: string;
	toolArgs?: string;
	toolResult?: string;
	toolResultExtras?: DatabaseMessageExtra[];
	wasInterrupted?: boolean;
}

/**
 * Represents a tool result line that may reference an image attachment or a file path
 */
export type ToolResultLine = {
	text: string;
	image?: DatabaseMessageExtraImageFile;
	filePath?: string;
	/** A Phase 2 resource line: drawn as an image, a table or a download chip. */
	resource?: ToolResultResource;
	/** A Phase 3 memory_save line: drawn as a chip with Undo. */
	memory?: { id: string; text: string; fromWeb: boolean; projectId?: string };
};

/**
 * memory_save's first result line (daemon/memory-tool.mjs):
 * `[memory: <id>[ web][ project:<projectId>]] <text>`. A project save names
 * its project so Undo deletes from that project's memory.
 */
export const MEMORY_LINE_REGEX =
	/^\[memory: ([A-Za-z0-9-]{8,64})( web)?(?: project:([A-Za-z0-9-]{1,64}))?\] (.+)$/;

/**
 * Derives display sections from a single assistant message and its direct tool results.
 *
 * @param message - The assistant message
 * @param toolMessages - Tool result messages for this assistant's tool_calls
 * @param streamingToolCalls - Partial tool calls during streaming (not yet persisted)
 */
function deriveSingleTurnSections(
	message: DatabaseMessage,
	toolMessages: DatabaseMessage[] = [],
	streamingToolCalls: ApiChatCompletionToolCall[] = [],
	isStreaming: boolean = false
): AgenticSection[] {
	const sections: AgenticSection[] = [];

	// 1. Reasoning content (from dedicated field)
	if (message.reasoningContent) {
		const toolCalls = parseToolCalls(message.toolCalls);
		const hasContentAfterReasoning =
			!!message.content?.trim() || toolCalls.length > 0 || streamingToolCalls.length > 0;
		const isPending = isStreaming && !hasContentAfterReasoning;
		sections.push({
			type: isPending ? AgenticSectionType.REASONING_PENDING : AgenticSectionType.REASONING,
			content: message.reasoningContent,
			wasInterrupted: !isStreaming && !hasContentAfterReasoning
		});
	}

	// 2. Text content
	if (message.content?.trim()) {
		sections.push({
			type: AgenticSectionType.TEXT,
			content: message.content
		});
	}

	// 3. Persisted tool calls (from message.toolCalls field)
	const toolCalls = parseToolCalls(message.toolCalls);
	for (const tc of toolCalls) {
		const resultMsg = toolMessages.find((m) => m.toolCallId === tc.id);
		// Only show as pending/loading if we're actively streaming; otherwise it's just a tool call without result
		const type = resultMsg
			? AgenticSectionType.TOOL_CALL
			: isStreaming
				? AgenticSectionType.TOOL_CALL_PENDING
				: AgenticSectionType.TOOL_CALL;
		sections.push({
			type,
			content: resultMsg?.content || '',
			toolName: tc.function?.name,
			toolArgs: tc.function?.arguments,
			toolResult: resultMsg?.content,
			toolResultExtras: resultMsg?.extra
		});
	}

	// 4. Streaming tool calls (not yet persisted - currently being received)
	for (const tc of streamingToolCalls) {
		// Skip if already in persisted tool calls
		if (tc.id && toolCalls.find((t) => t.id === tc.id)) continue;
		sections.push({
			type: AgenticSectionType.TOOL_CALL_STREAMING,
			content: '',
			toolName: tc.function?.name,
			toolArgs: tc.function?.arguments
		});
	}

	return sections;
}

/**
 * Derives display sections from structured message data.
 *
 * Handles both single-turn (one assistant + its tool results) and multi-turn
 * agentic sessions (multiple assistant + tool messages grouped together).
 *
 * When `toolMessages` contains continuation assistant messages (from multi-turn
 * agentic flows), they are processed in order to produce sections across all turns.
 *
 * @param message - The first/anchor assistant message
 * @param toolMessages - Tool result messages and continuation assistant messages
 * @param streamingToolCalls - Partial tool calls during streaming (not yet persisted)
 * @param isStreaming - Whether the message is currently being streamed
 */
export function deriveAgenticSections(
	message: DatabaseMessage,
	toolMessages: DatabaseMessage[] = [],
	streamingToolCalls: ApiChatCompletionToolCall[] = [],
	isStreaming: boolean = false
): AgenticSection[] {
	const hasAssistantContinuations = toolMessages.some((m) => m.role === MessageRole.ASSISTANT);

	if (!hasAssistantContinuations) {
		return deriveSingleTurnSections(message, toolMessages, streamingToolCalls, isStreaming);
	}

	const sections: AgenticSection[] = [];

	const firstTurnToolMsgs = collectToolMessages(toolMessages, 0);
	sections.push(...deriveSingleTurnSections(message, firstTurnToolMsgs));

	let i = firstTurnToolMsgs.length;

	while (i < toolMessages.length) {
		const msg = toolMessages[i];

		if (msg.role === MessageRole.ASSISTANT) {
			const turnToolMsgs = collectToolMessages(toolMessages, i + 1);
			const isLastTurn = i + 1 + turnToolMsgs.length >= toolMessages.length;

			sections.push(
				...deriveSingleTurnSections(
					msg,
					turnToolMsgs,
					isLastTurn ? streamingToolCalls : [],
					isLastTurn && isStreaming
				)
			);

			i += 1 + turnToolMsgs.length;
		} else {
			i++;
		}
	}

	return sections;
}

/**
 * Collect consecutive tool messages starting at `startIndex`.
 */
function collectToolMessages(messages: DatabaseMessage[], startIndex: number): DatabaseMessage[] {
	const result: DatabaseMessage[] = [];

	for (let i = startIndex; i < messages.length; i++) {
		if (messages[i].role === MessageRole.TOOL) {
			result.push(messages[i]);
		} else {
			break;
		}
	}

	return result;
}

/**
 * Parse tool result text into lines, matching image attachments by name.
 */
export function parseToolResultWithImages(
	toolResult: string,
	extras?: DatabaseMessageExtra[]
): ToolResultLine[] {
	const lines = toolResult.split(NEWLINE_SEPARATOR);
	return lines.map((line) => {
		const resource = parseResourceLine(line);
		if (resource) return { text: line, resource, filePath: resource.path };
		const mem = line.match(MEMORY_LINE_REGEX);
		if (mem) {
			return {
				text: line,
				memory: { id: mem[1], text: mem[4], fromWeb: !!mem[2], projectId: mem[3] || undefined }
			};
		}
		const match = line.match(ATTACHMENT_SAVED_REGEX);
		if (!match || !extras) {
			const fileMatch = line.match(FILE_PATH_REGEX);
			return { text: line, filePath: fileMatch?.[1]?.trim() };
		}

		const attachmentName = match[1];
		const image = extras.find(
			(e): e is DatabaseMessageExtraImageFile =>
				e.type === AttachmentType.IMAGE && e.name === attachmentName
		);

		return { text: line, image };
	});
}

/**
 * Safely parse the toolCalls JSON string from a DatabaseMessage.
 */
function parseToolCalls(toolCallsJson?: string): ApiChatCompletionToolCall[] {
	if (!toolCallsJson) return [];

	try {
		const parsed = JSON.parse(toolCallsJson);

		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

/**
 * Check if a message has agentic content (tool calls or is part of an agentic flow).
 */
export function hasAgenticContent(
	message: DatabaseMessage,
	toolMessages: DatabaseMessage[] = []
): boolean {
	if (message.toolCalls) {
		const tc = parseToolCalls(message.toolCalls);

		if (tc.length > 0) return true;
	}

	return toolMessages.length > 0;
}

/**
 * Classification of how a Continue click on an assistant message should resume
 * generation. The caller dispatches the resume path based on this value.
 *
 *   append_text  -> the target is a plain text turn, resume with
 *                   continue_final_message and rehydrate the persisted
 *                   tool_calls and attachments through the regular DB to API
 *                   message converter.
 *   rerun_turn   -> the target carries tool_calls that were never resolved by
 *                   tool result messages. The agentic stream was cut mid turn,
 *                   so we drop the target and rerun the loop from the previous
 *                   history. truncateAfter is the last kept index, inclusive.
 *   next_turn    -> the target's tool_calls were already resolved by trailing
 *                   tool results. Hand the history up to and including the
 *                   last consecutive tool result back to the agentic loop so it
 *                   starts the next turn naturally. truncateAfter points at
 *                   that last tool result.
 */
export type ContinueIntent =
	| { kind: ContinueIntentKind.APPEND_TEXT }
	| { kind: ContinueIntentKind.RERUN_TURN; truncateAfter: number }
	| { kind: ContinueIntentKind.NEXT_TURN; truncateAfter: number };

/**
 * Decide how a Continue click on messages[idx] should resume generation.
 * Pure function over the persisted history snapshot.
 */
export function classifyContinueIntent(messages: DatabaseMessage[], idx: number): ContinueIntent {
	const target = messages[idx];

	// Defensive default: callers already filter by role, stay deterministic.
	if (!target || target.role !== MessageRole.ASSISTANT) {
		return { kind: ContinueIntentKind.APPEND_TEXT };
	}

	const hasToolCalls = parseToolCalls(target.toolCalls).length > 0;
	if (!hasToolCalls) {
		return { kind: ContinueIntentKind.APPEND_TEXT };
	}

	// Walk consecutive trailing tool results. The agentic loop only emits tool
	// messages directly after the assistant turn that owns them, so the first
	// non tool message marks the boundary.
	let lastTrailingTool = idx;
	for (let i = idx + 1; i < messages.length; i++) {
		if (messages[i].role === MessageRole.TOOL) {
			lastTrailingTool = i;
		} else {
			break;
		}
	}

	if (lastTrailingTool > idx) {
		return { kind: ContinueIntentKind.NEXT_TURN, truncateAfter: lastTrailingTool };
	}

	return { kind: ContinueIntentKind.RERUN_TURN, truncateAfter: idx - 1 };
}

/**
 * An ask_user question the conversation is still waiting on (plan §4, 1.1).
 *
 * The assistant message carrying the call is saved before the flow pauses, so
 * a question survives a refresh with no storage of its own: the active path
 * ends on an assistant message (or its trailing tool results) with an
 * ask_user call that has no result. Only the last assistant turn counts, and
 * only a call whose arguments parse (a malformed one was answered by the
 * core with an error, which would have been saved).
 */
export interface OpenQuestion {
	assistantId: string;
	toolCallId: string;
	request: AskRequest;
	/** Every call of that turn with no result yet, in order, the question included. */
	unanswered: Array<{ id: string; name: string }>;
	/** The message the new results chain from: the assistant, or its last trailing result. */
	anchorId: string;
}

export function findOpenQuestion(messages: readonly DatabaseMessage[]): OpenQuestion | null {
	let idx = messages.length - 1;
	while (idx >= 0 && messages[idx].role === MessageRole.TOOL) idx--;
	const assistant = messages[idx];
	if (!assistant || assistant.role !== MessageRole.ASSISTANT) return null;

	const calls = parseToolCalls(assistant.toolCalls).filter(
		(c): c is ApiChatCompletionToolCall & { id: string } => typeof c.id === 'string' && !!c.id
	);
	const answered = new Set(
		messages
			.slice(idx + 1)
			.map((m) => m.toolCallId)
			.filter(Boolean)
	);
	const unanswered = calls
		.filter((c) => !answered.has(c.id))
		.map((c) => ({ id: c.id, name: c.function?.name ?? '' }));

	for (const call of calls) {
		if (answered.has(call.id) || call.function?.name !== ASK_USER_TOOL) continue;
		const parsed = parseAskArguments(call.function?.arguments);
		if (!parsed.ok) continue;
		return {
			assistantId: assistant.id,
			toolCallId: call.id,
			request: parsed.request,
			unanswered,
			anchorId: messages[messages.length - 1].id
		};
	}
	return null;
}

/**
 * The question card's answer from what is picked and typed, or null when
 * there is nothing to send yet (Skip is the dismissal, not an empty Send).
 */
export function buildAskAnswer(selected: readonly string[], text: string): AskAnswer | null {
	const chosen = selected.filter((s) => s.trim());
	const typed = text.trim();
	if (chosen.length === 0 && !typed) return null;
	return { ...(chosen.length ? { chosen: [...chosen] } : {}), ...(typed ? { text: typed } : {}) };
}

/** Where the composer's question card comes from (ChatFormQuestion.svelte). */
export type QuestionSource =
	| { kind: 'task'; key: string; request: AskRequest }
	| { kind: 'live'; key: unknown; request: AskRequest }
	| { kind: 'reloaded'; key: string; request: AskRequest };

/**
 * The one question the composer shows, or null. A background task holding
 * the chat (a followed task, or the record's activeTaskId before the follow
 * has loaded) answers only through the task: the same ask_user call sits in
 * the stored transcript with no result, and offering it as a reloaded
 * question would send the answer to a browser loop that is not running.
 */
export function pickQuestionSource(input: {
	task: Pick<TaskRecord, 'id' | 'waiting'> | null;
	activeTaskId: string | null | undefined;
	live: AskRequest | null;
	flowBusy: boolean;
	open: () => OpenQuestion | null;
}): QuestionSource | null {
	const { task, activeTaskId, live, flowBusy, open } = input;
	if (task || activeTaskId) {
		const w = task?.waiting;
		if (!task || w?.kind !== 'question') return null;
		return {
			kind: 'task',
			key: `task:${task.id}:${w.callId ?? w.question}`,
			request: { question: w.question, options: w.options, multiSelect: !!w.multiSelect }
		};
	}
	if (live) return { kind: 'live', key: live, request: live };
	if (flowBusy) return null;
	const found = open();
	return found ? { kind: 'reloaded', key: `reloaded:${found.toolCallId}`, request: found.request } : null;
}

/** The plan checklist's one-line summary: "1 of 3 done", or "done" when nothing is open. */
export function planProgress(steps: readonly PlanStep[]): { open: number; label: string } {
	const done = steps.filter((s) => s.status === 'done').length;
	const skipped = steps.filter((s) => s.status === 'skipped').length;
	const open = steps.length - done - skipped;
	if (open > 0) return { open, label: `${done} of ${steps.length} done` };
	return { open, label: skipped > 0 ? `done (${skipped} skipped)` : 'done' };
}

/** What a call left unrun by a reload gets as its result. */
export const NOT_RUN_AFTER_RELOAD_RESULT =
	'This call was not run: the chat was reloaded while a question was open. Call it again if you still need it.';

/**
 * The tool results that close an open question's turn, in the order to write
 * them: the answer for the question, and the not-run text for every other call
 * that never got a result (a call has to have one, or the transcript is
 * malformed).
 */
export function resultsForAnsweredQuestion(
	open: OpenQuestion,
	answer: AskAnswer | null
): Array<{ toolCallId: string; content: string }> {
	return open.unanswered.map((c) => ({
		toolCallId: c.id,
		content: c.id === open.toolCallId ? formatAskAnswer(answer) : NOT_RUN_AFTER_RELOAD_RESULT
	}));
}

/**
 * Fetch a file a tool produced, with the session, as a Blob. An <img src> or
 * a plain link would not carry the auth header, which is why every renderer of
 * a tool's file goes through this (Phase 2: images, tables, downloads).
 */
export async function fetchFileBlob(relativePath: string): Promise<Blob> {
	const base = getServerBaseUrl().replace(/\/$/, '');
	const url = `${base}/files/download?path=${encodeURIComponent(relativePath)}`;
	const response = await fetch(url, { headers: getAuthHeaders() });
	if (!response.ok) {
		let detail = '';
		try {
			const body = await response.json();
			detail = body?.error?.message ? ` — ${body.error.message}` : '';
		} catch {
			/* non-JSON body */
		}
		throw new Error(`Download failed: ${response.status} ${response.statusText}${detail}`);
	}
	return response.blob();
}

/**
 * Download a file a tool produced. The server exposes
 * /files/download?path=<relative-path>, which validates path containment
 * against each configured root (File System and Documents) before streaming.
 */
export async function downloadFile(relativePath: string, fileName?: string): Promise<void> {
	const base = getServerBaseUrl().replace(/\/$/, '');
	const url = `${base}/files/download?path=${encodeURIComponent(relativePath)}`;
	const response = await fetch(url, {
		headers: getAuthHeaders()
	});
	if (!response.ok) {
		// The endpoint explains itself in the body ("outside the configured file
		// roots", "File not found", ...). Reporting only the status code throws
		// that away and leaves a failed download indistinguishable by cause.
		let detail = '';
		try {
			const body = await response.json();
			detail = body?.error?.message ? ` — ${body.error.message}` : '';
		} catch {
			/* non-JSON body; the status alone will have to do */
		}
		throw new Error(`Download failed: ${response.status} ${response.statusText}${detail}`);
	}
	const blob = await response.blob();
	const blobUrl = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = blobUrl;
	a.download = fileName || relativePath.split('/').pop() || 'download';
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(blobUrl);
}
