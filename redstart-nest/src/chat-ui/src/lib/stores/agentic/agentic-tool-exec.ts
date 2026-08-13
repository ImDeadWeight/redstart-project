/**
 * agentic-tool-exec - running one turn's tool calls
 *
 * Phase 9 of the agentic loop: for each call the model asked for, check the
 * abort signal, honour a steering interrupt, ask permission, dispatch to the
 * right executor (local FS, built-in, sandboxed frontend, or MCP), record
 * timings, lift out base64 attachments, and append the result to the session
 * history the next turn will send.
 *
 * **Not a move-and-delegate extraction, and the contract is the subtle part.**
 * The original body sat inline in executeAgenticLoop and used `return` to end
 * the whole flow — four times. A function cannot return from its caller, so
 * those become the sentinel this returns:
 *
 *   'stopped' - the flow is over. onFlowComplete has ALREADY been called here,
 *               on the same timings the inline code used. The caller must
 *               return immediately and must not complete the flow again.
 *   'done'    - carry on. Either every call ran, or a steering message cut the
 *               remaining ones short (the inline `break`, still a `break`).
 *               Either way the caller proceeds to its turn-stats block and its
 *               own post-loop steering check, exactly as before.
 *
 * The accumulators - agenticTimings, turnStats, sessionMessages - are mutated in
 * place through the params object, because the caller reads them afterwards.
 * capturedTimings is read but never reassigned in this phase, so it is passed
 * by value.
 *
 * Covered by tests/unit/agentic-loop.test.ts, which pins the callback ordering
 * this must not change.
 */

import {
	MessageRole,
	ContentPartType,
	AttachmentType,
	ToolSource,
	ToolPermissionDecision
} from '$lib/enums';
import { ToolsService } from '$lib/services/tools.service';
import { SandboxService } from '$lib/services/sandbox.service';
import { mcpStore } from '$lib/stores/mcp.svelte';
import { toolsStore } from '$lib/stores/tools.svelte';
import { modelsStore } from '$lib/stores/models.svelte';
import { twigFsApi } from '$lib/utils/twig';
import { permissionsStore } from '$lib/stores/permissions.svelte';
import { isAbortError } from '$lib/utils';
import { extractBase64Attachments } from './agentic-attachments';
import { buildFinalTimings } from './agentic-timings';
import type { AgenticSessionState } from './agentic-session.svelte';
import type { MCPToolCall, DatabaseMessageExtraImageFile } from '$lib/types';
// Trap 11: ChatMessageTimings and ApiChatMessageData are globalised in app.d.ts and
// must stay unimported; these three sit beside them in types/chat.d.ts and are not.
import type {
	ChatMessageAgenticTimings,
	ChatMessageAgenticTurnStats,
	ChatMessageToolCallTiming
} from '$lib/types';
import type { AgenticToolCallList, AgenticFlowCallbacks } from '$lib/types/agentic';

export type ToolCallsOutcome = 'done' | 'stopped';

export class AgenticToolExec {
	constructor(private readonly session: AgenticSessionState) {}

	parseToolArguments(args: string | Record<string, unknown>): Record<string, unknown> {
		if (typeof args === 'object') return args;
		const trimmed = args.trim();
		if (trimmed === '') return {};
		return JSON.parse(trimmed) as Record<string, unknown>;
	}

	async requestPermission(
		conversationId: string,
		toolName: string,
		serverLabel: string,
		signal?: AbortSignal
	): Promise<ToolPermissionDecision> {
		const permissionKey = toolsStore.getPermissionKey(toolName);
		// A destructive tool always prompts, even if it somehow acquired a
		// persisted grant — an allow-list entry written before the tool was
		// classified, or one swept in by "always allow all tools from this
		// server". Checked before the short-circuit rather than only at the point
		// of granting, so a stale entry in localStorage cannot silently authorise
		// unattended deletion.
		const destructive = toolsStore.isDestructiveTool(toolName);
		if (!destructive && permissionKey && permissionsStore.hasTool(permissionKey)) {
			return ToolPermissionDecision.ONCE;
		}

		this.session.pendingPermissions.set(conversationId, { toolName, serverLabel });

		return new Promise<ToolPermissionDecision>((resolve) => {
			if (signal?.aborted) {
				this.session.pendingPermissions.set(conversationId, null);
				resolve(ToolPermissionDecision.DENY);
				return;
			}

			this.session.permissionResolvers.set(conversationId, (decision) => {
				this.session.pendingPermissions.set(conversationId, null);
				if (decision === ToolPermissionDecision.ALWAYS && permissionKey && !destructive) {
					permissionsStore.allowTool(permissionKey);
				} else if (decision === ToolPermissionDecision.ALWAYS_SERVER) {
					// Destructive tools are excluded from the sweep. "Always allow all
					// tools from Redstart Built-in" is a menu item about convenience;
					// silently including a delete would make it a menu item about
					// unattended data loss, under a label that never says so.
					const serverToolKeys = toolsStore.allTools
						.filter((t) =>
							t.serverName
								? t.serverName === serverLabel
								: toolsStore.getToolServerLabel(t.definition.function.name) === serverLabel
						)
						.filter((t) => !toolsStore.isDestructiveTool(t.definition.function.name))
						.map((t) => toolsStore.getPermissionKey(t.definition.function.name)!)
						.filter((k): k is string => k !== null);
					permissionsStore.allowTools(serverToolKeys);
				}
				resolve(decision);
			});

			signal?.addEventListener(
				'abort',
				() => {
					const resolver = this.session.permissionResolvers.get(conversationId);
					if (resolver) {
						this.session.permissionResolvers.delete(conversationId);
						this.session.pendingPermissions.set(conversationId, null);
						resolve(ToolPermissionDecision.DENY);
					}
				},
				{ once: true }
			);
		});
	}

	async runToolCalls(params: {
		normalizedCalls: AgenticToolCallList;
		conversationId: string;
		sessionMessages: ApiChatMessageData[];
		agenticTimings: ChatMessageAgenticTimings;
		turnStats: ChatMessageAgenticTurnStats;
		capturedTimings: ChatMessageTimings | undefined;
		effectiveModel: string;
		callbacks: AgenticFlowCallbacks;
		signal?: AbortSignal;
	}): Promise<ToolCallsOutcome> {
		const {
			normalizedCalls,
			conversationId,
			sessionMessages,
			agenticTimings,
			turnStats,
			capturedTimings,
			effectiveModel,
			callbacks,
			signal
		} = params;
		const { onFlowComplete, createToolResultMessage, onAttachments } = callbacks;

	// Execute each tool call and create result messages
	for (let i = 0; i < normalizedCalls.length; i++) {
		const toolCall = normalizedCalls[i];

		if (signal?.aborted) {
			onFlowComplete?.(buildFinalTimings(capturedTimings, agenticTimings));
			return 'stopped';
		}

		// Check for pending steering message - skip remaining tool calls
		if (this.session.steeringMessages.has(conversationId)) {
			console.log(
				`[AgenticStore] Steering message detected, skipping ${normalizedCalls.length - i} remaining tool call(s)`
			);
			for (let j = i; j < normalizedCalls.length; j++) {
				const remainingCall = normalizedCalls[j];
				const interruptedContent = 'Tool execution was interrupted by a new user message.';
				if (createToolResultMessage) {
					await createToolResultMessage(remainingCall.id, interruptedContent);
				}
				sessionMessages.push({
					role: MessageRole.TOOL,
					tool_call_id: remainingCall.id,
					content: interruptedContent
				});
			}
			break;
		}

		const toolName = toolCall.function.name;
		const serverLabel = toolsStore.getToolServerLabel(toolName);

		// Ask for permission before executing the tool
		const permission = await this.requestPermission(
			conversationId,
			toolName,
			serverLabel,
			signal
		);

		// Yield to allow Svelte to flush the UI update (hide permission dialog)
		await new Promise((r) => setTimeout(r, 0));

		if (signal?.aborted) {
			onFlowComplete?.(buildFinalTimings(capturedTimings, agenticTimings));
			return 'stopped';
		}

		const toolStartTime = performance.now();
		const toolSource = toolsStore.getToolSource(toolName);

		let result: string;
		let toolSuccess = true;

		if (permission === ToolPermissionDecision.DENY) {
			result = 'Tool execution was denied by the user.';
			toolSuccess = false;
		} else {
			try {
				if (toolSource === ToolSource.LOCAL_FS) {
					const api = twigFsApi();
					const args = this.parseToolArguments(toolCall.function.arguments);
					if (!api) {
						result =
							'Local file system tools are only available in the Redstart Twig desktop app.';
						toolSuccess = false;
					} else {
						const executionResult = await api.execute(toolName, args);
						result = (executionResult.content ?? []).map((c) => c.text).join('\n');
						if (executionResult.isError) toolSuccess = false;
					}
				} else if (toolSource === ToolSource.BUILTIN) {
					const args = this.parseToolArguments(toolCall.function.arguments);
					const executionResult = await ToolsService.executeTool(toolName, args, signal);

					result = executionResult.content;

					if (executionResult.isError) toolSuccess = false;
				} else if (toolSource === ToolSource.FRONTEND) {
					const args = this.parseToolArguments(toolCall.function.arguments);
					const executionResult = await SandboxService.executeTool(toolName, args, signal);

					result = executionResult.content;

					if (executionResult.isError) toolSuccess = false;
				} else {
					const mcpCall: MCPToolCall = {
						id: toolCall.id,
						function: { name: toolName, arguments: toolCall.function.arguments }
					};
					const executionResult = await mcpStore.executeTool(mcpCall, signal);

					result = executionResult.content;

					if (executionResult.isError) toolSuccess = false;
				}
			} catch (error) {
				if (isAbortError(error)) {
					onFlowComplete?.(buildFinalTimings(capturedTimings, agenticTimings));
					return 'stopped';
				}
				result = `Error: ${error instanceof Error ? error.message : String(error)}`;
				toolSuccess = false;
			}
		}

		const toolDurationMs = performance.now() - toolStartTime;
		const toolTiming: ChatMessageToolCallTiming = {
			name: toolCall.function.name,
			duration_ms: Math.round(toolDurationMs),
			success: toolSuccess
		};

		agenticTimings.toolCalls!.push(toolTiming);
		agenticTimings.toolCallsCount++;
		agenticTimings.toolsMs += Math.round(toolDurationMs);
		turnStats.toolCalls.push(toolTiming);
		turnStats.toolsMs += Math.round(toolDurationMs);

		if (signal?.aborted) {
			onFlowComplete?.(buildFinalTimings(capturedTimings, agenticTimings));
			return 'stopped';
		}

		const { cleanedResult, attachments } = extractBase64Attachments(result);

		// Create the tool result message in the DB
		let toolResultMessage: DatabaseMessage | undefined;
		if (createToolResultMessage) {
			toolResultMessage = await createToolResultMessage(
				toolCall.id,
				cleanedResult,
				attachments.length > 0 ? attachments : undefined
			);
		}

		if (attachments.length > 0 && toolResultMessage) {
			onAttachments?.(toolResultMessage.id, attachments);
		}

		// Build content parts for session history (including images for vision models)
		const contentParts: ApiChatMessageContentPart[] = [
			{ type: ContentPartType.TEXT, text: cleanedResult }
		];
		for (const attachment of attachments) {
			if (attachment.type === AttachmentType.IMAGE) {
				if (modelsStore.modelSupportsVision(effectiveModel)) {
					contentParts.push({
						type: ContentPartType.IMAGE_URL,
						image_url: {
							url: (attachment as DatabaseMessageExtraImageFile).base64Url
						}
					});
				} else {
					console.info(
						`[AgenticStore] Skipping image attachment (model "${effectiveModel}" does not support vision)`
					);
				}
			}
		}

		sessionMessages.push({
			role: MessageRole.TOOL,
			tool_call_id: toolCall.id,
			content: contentParts.length === 1 ? cleanedResult : contentParts
		});
	}

		return 'done';
	}
}
