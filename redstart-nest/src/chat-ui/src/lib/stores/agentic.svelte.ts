/**
 * agenticStore - Reactive State Store for Agentic Loop Orchestration
 *
 * Manages multi-turn agentic loop with MCP tools:
 * - LLM streaming with tool call detection
 * - Tool execution via mcpStore
 * - Session state management
 * - Turn limit enforcement
 *
 * Each agentic turn produces separate DB messages:
 * - One assistant message per LLM turn (with tool_calls if any)
 * - One tool result message per tool call execution
 *
 * **Architecture & Relationships:**
 * - **ChatService**: Stateless API layer (sendMessage, streaming)
 * - **mcpStore**: MCP connection management and tool execution
 * - **agenticStore** (this): Reactive state + business logic
 *
 * @see ChatService in services/chat.service.ts for API operations
 * @see mcpStore in stores/mcp.svelte.ts for MCP operations
 */

import { convertDbMessageToApiChatMessageData } from '$lib/services/chat/chat-message-convert';
import { config } from '$lib/stores/settings.svelte';
import { mcpStore } from '$lib/stores/mcp.svelte';
import { modelsStore } from '$lib/stores/models.svelte';
import { toolsStore } from '$lib/stores/tools.svelte';
import { ToolPermissionDecision } from '$lib/enums';
import { DEFAULT_AGENTIC_CONFIG } from '$lib/constants';
import {
	MessageRole,
	ToolCallType
} from '$lib/enums';
import type {
	AgenticFlowParams,
	AgenticFlowResult,
	AgenticConfig,
	SettingsConfigType,
	McpServerOverride
} from '$lib/types';
import type {
	AgenticMessage,
	AgenticToolCallList,
	AgenticFlowCallbacks,
	AgenticFlowOptions
} from '$lib/types/agentic';
import type {
	ApiChatCompletionToolCall,
	ApiChatMessageData,
	ApiChatMessageContentPart
} from '$lib/types/api';
import type {
	ChatMessageTimings,
	ChatMessageAgenticTimings,
	ChatMessageAgenticTurnStats
} from '$lib/types/chat';
import type {
	DatabaseMessage,
	DatabaseMessageExtra
} from '$lib/types/database';


function toAgenticMessages(messages: ApiChatMessageData[]): AgenticMessage[] {
	return messages.map((message) => {
		if (
			message.role === MessageRole.ASSISTANT &&
			message.tool_calls &&
			message.tool_calls.length > 0
		) {
			return {
				role: MessageRole.ASSISTANT,
				content: message.content,
				reasoning_content: message.reasoning_content,
				tool_calls: message.tool_calls.map((call, index) => ({
					id: call.id ?? `call_${index}`,
					type: (call.type as ToolCallType.FUNCTION) ?? ToolCallType.FUNCTION,
					function: {
						name: call.function?.name ?? '',
						arguments: call.function?.arguments ?? ''
					}
				}))
			} satisfies AgenticMessage;
		}
		if (message.role === MessageRole.ASSISTANT) {
			return {
				role: MessageRole.ASSISTANT,
				content: message.content,
				reasoning_content: message.reasoning_content
			} satisfies AgenticMessage;
		}
		if (message.role === MessageRole.TOOL && message.tool_call_id) {
			return {
				role: MessageRole.TOOL,
				tool_call_id: message.tool_call_id,
				content: typeof message.content === 'string' ? message.content : ''
			} satisfies AgenticMessage;
		}
		return {
			role: message.role as MessageRole.SYSTEM | MessageRole.USER,
			content: message.content
		} satisfies AgenticMessage;
	});
}

import { AgenticSessionState } from '$lib/stores/agentic/agentic-session.svelte';
import { AgenticToolExec } from '$lib/stores/agentic/agentic-tool-exec';
import { AgenticTurn, createTurnAccumulator } from '$lib/stores/agentic/agentic-turn';
import { buildFinalTimings } from '$lib/stores/agentic/agentic-timings';

class AgenticStore {
	/**
	 * Per-conversation session state. A sub-store rather than a facade split:
	 * §4.5 is explicit that the facade recipe is wrong for this file, but the
	 * session maps are pure state with no loop logic, so they separate cleanly.
	 * The loop reaches them directly through `this.session.<map>` — Trap 7, since
	 * requestPermission, requestContinue and the loop all mutate them in place.
	 */
	readonly session = new AgenticSessionState();

	/**
	 * One turn's tool calls. Returns 'stopped' when it has already completed the
	 * flow and the loop must return immediately — see the header there.
	 */
	private readonly toolExec = new AgenticToolExec(this.session);

	/** One streaming LLM turn. Fills the caller's accumulator; never ends the flow. */
	private readonly turnRunner = new AgenticTurn(this.session);

	get isReady(): boolean {
		return true;
	}
	getConfig(settings: SettingsConfigType, perChatOverrides?: McpServerOverride[]): AgenticConfig {
		const maxTurns = Number(settings.agenticMaxTurns) || DEFAULT_AGENTIC_CONFIG.maxTurns;
		const maxToolPreviewLines =
			Number(settings.agenticMaxToolPreviewLines) || DEFAULT_AGENTIC_CONFIG.maxToolPreviewLines;
		const hasTools =
			mcpStore.hasEnabledServers(perChatOverrides) ||
			toolsStore.builtinTools.length > 0 ||
			toolsStore.customTools.length > 0;
		return {
			enabled: hasTools && DEFAULT_AGENTIC_CONFIG.enabled,
			maxTurns,
			maxToolPreviewLines
		};
	}

	private async requestContinue(conversationId: string, signal?: AbortSignal): Promise<boolean> {
		this.session.pendingContinueRequests.set(conversationId, true);

		return new Promise<boolean>((resolve) => {
			if (signal?.aborted) {
				this.session.pendingContinueRequests.set(conversationId, false);
				resolve(false);
				return;
			}

			this.session.continueResolvers.set(conversationId, (shouldContinue) => {
				this.session.pendingContinueRequests.set(conversationId, false);
				resolve(shouldContinue);
			});

			signal?.addEventListener(
				'abort',
				() => {
					const resolver = this.session.continueResolvers.get(conversationId);
					if (resolver) {
						this.session.continueResolvers.delete(conversationId);
						this.session.pendingContinueRequests.set(conversationId, false);
						resolve(false);
					}
				},
				{ once: true }
			);
		});
	}

	async runAgenticFlow(params: AgenticFlowParams): Promise<AgenticFlowResult> {
		const { conversationId, messages, options = {}, callbacks, signal, perChatOverrides } = params;

		// Clear any pending permissions/continue requests for this conversation when starting a new flow
		this.session.pendingPermissions.set(conversationId, null);
		this.session.permissionResolvers.delete(conversationId);
		this.session.pendingContinueRequests.set(conversationId, false);
		this.session.continueResolvers.delete(conversationId);
		this.session.steeringMessages.delete(conversationId);

		// Ensure built-in tools are fetched before checking if agentic is enabled
		if (toolsStore.builtinTools.length === 0 && !toolsStore.loading) {
			await toolsStore.fetchBuiltinTools();
		}

		const agenticConfig = this.getConfig(config(), perChatOverrides);
		if (!agenticConfig.enabled) return { handled: false };

		const hasMcpServers = mcpStore.hasEnabledServers(perChatOverrides);
		if (hasMcpServers) {
			const initialized = await mcpStore.ensureInitialized(perChatOverrides);

			if (!initialized) {
				console.log('[AgenticStore] MCP not initialized');
			}
		}

		const tools = toolsStore.getEnabledToolsForLLM();
		if (tools.length === 0) {
			// Bailing here sends the turn with no tools, which looks identical to
			// the model simply choosing not to call one — the failure that made
			// every tool-delivery bug in this stack invisible. Say which link
			// broke instead of returning silently.
			console.warn('[AgenticStore] No tools available — sending this turn without tools.', {
				mcpServersConfigured: mcpStore.getServers().length,
				mcpEnabledForThisChat: hasMcpServers,
				mcpOverridesSeen: perChatOverrides?.length ?? 0,
				mcpLiveConnections: mcpStore.getConnections().size,
				builtinToolsFromServer: toolsStore.builtinTools.length
			});
			return { handled: false };
		}

		console.log(`[AgenticStore] Starting agentic flow with ${tools.length} tools`);

		const normalizedMessages: ApiChatMessageData[] = (
			await Promise.all(
				messages.map((msg) => {
					if ('id' in msg && 'convId' in msg && 'timestamp' in msg)
						return convertDbMessageToApiChatMessageData(
							msg as DatabaseMessage & { extra?: DatabaseMessageExtra[] }
						);
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

		this.session.updateSession(conversationId, {
			isRunning: true,
			currentTurn: 0,
			totalToolCalls: 0,
			lastError: null
		});

		if (hasMcpServers) mcpStore.acquireConnection();

		try {
			await this.executeAgenticLoop({
				conversationId,
				messages: normalizedMessages,
				options,
				tools,
				agenticConfig,
				callbacks,
				signal
			});
			return { handled: true };
		} catch (error) {
			const normalizedError = error instanceof Error ? error : new Error(String(error));
			this.session.updateSession(conversationId, { lastError: normalizedError });
			callbacks.onError?.(normalizedError);
			return { handled: true, error: normalizedError };
		} finally {
			this.session.updateSession(conversationId, { isRunning: false });

			if (hasMcpServers) {
				await mcpStore
					.releaseConnection()
					.catch((err: unknown) =>
						console.warn('[AgenticStore] Failed to release MCP connection:', err)
					);
			}
		}
	}

	private async executeAgenticLoop(params: {
		conversationId: string;
		messages: ApiChatMessageData[];
		options: AgenticFlowOptions;
		tools: ReturnType<typeof mcpStore.getToolDefinitionsForLLM>;
		agenticConfig: AgenticConfig;
		callbacks: AgenticFlowCallbacks;
		signal?: AbortSignal;
	}): Promise<void> {
		const { conversationId, messages, options, tools, agenticConfig, callbacks, signal } = params;
		const {
			onChunk,
			onReasoningChunk,
			onToolCallsStreaming,
			onAttachments,
			onModel,
			onCompletionId,
			onAssistantTurnComplete,
			createToolResultMessage,
			createAssistantMessage,
			onFlowComplete,
			onTimings,
			onTurnComplete
		} = callbacks;

		const sessionMessages: AgenticMessage[] = toAgenticMessages(messages);
		let capturedTimings: ChatMessageTimings | undefined;
		let totalToolCallCount = 0;

		const agenticTimings: ChatMessageAgenticTimings = {
			turns: 0,
			toolCallsCount: 0,
			toolsMs: 0,
			toolCalls: [],
			perTurn: [],
			llm: { predicted_n: 0, predicted_ms: 0, prompt_n: 0, prompt_ms: 0 }
		};
		const maxTurns = agenticConfig.maxTurns;

		const effectiveModel = options.model || modelsStore.models[0]?.model || '';

		let turn = 0;
		while (true) {
			if (turn >= maxTurns) {
				// Turn limit reached - ask user whether to continue
				const shouldContinue = await this.requestContinue(conversationId, signal);

				// Yield to allow Svelte to flush the UI update
				await new Promise((r) => setTimeout(r, 0));

				if (!shouldContinue || signal?.aborted) {
					onFlowComplete?.(buildFinalTimings(capturedTimings, agenticTimings));
					return;
				}

				// User chose to continue - extend the limit
				turn = 0;
			}

			this.session.updateSession(conversationId, { currentTurn: turn + 1 });
			agenticTimings.turns = turn + 1;

			if (signal?.aborted) {
				onFlowComplete?.(buildFinalTimings(capturedTimings, agenticTimings));
				return;
			}

			// For turns > 0, create a new assistant message via callback
			if (turn > 0 && createAssistantMessage) {
				await createAssistantMessage();
			}

			// One mutable object rather than six `let`s: runTurn fills it as chunks
			// arrive, so the catch below still sees the partial answer if the stream
			// throws. Copies read out afterwards would be stale on exactly that path.
			const acc = createTurnAccumulator(capturedTimings);

			const turnStats: ChatMessageAgenticTurnStats = {
				turn: turn + 1,
				llm: { predicted_n: 0, predicted_ms: 0, prompt_n: 0, prompt_ms: 0 },
				toolCalls: [],
				toolsMs: 0
			};

			try {
				await this.turnRunner.runTurn({
					acc,
					conversationId,
					sessionMessages: sessionMessages as ApiChatMessageData[],
					options,
					tools,
					agenticTimings,
					turnStats,
					callbacks,
					signal
				});
			} catch (error) {
				if (signal?.aborted) {
					// Save whatever we have for this turn before exiting
					await onAssistantTurnComplete?.(
						acc.content,
						acc.reasoning || undefined,
						buildFinalTimings(acc.captured, agenticTimings),
						undefined
					);
					onFlowComplete?.(buildFinalTimings(acc.captured, agenticTimings));
					return;
				}
				const normalizedError = error instanceof Error ? error : new Error('LLM stream error');
				// preserve partial output as is, the outer error dialog informs the user separately
				await onAssistantTurnComplete?.(
					acc.content,
					acc.reasoning || undefined,
					buildFinalTimings(acc.captured, agenticTimings),
					undefined
				);
				onFlowComplete?.(buildFinalTimings(acc.captured, agenticTimings));
				throw normalizedError;
			}

			// runTurn writes captured timings into the accumulator; carry them to the
			// next turn, which seeds a fresh accumulator from this variable.
			capturedTimings = acc.captured;

			// === Steering check: if a user message was queued during this turn, exit the flow.
			// The caller (chatStore) will consume the pending message and re-send it normally.
			if (this.session.steeringMessages.has(conversationId)) {
				console.log('[AgenticStore] Steering message detected after turn, exiting agentic flow');
				await onAssistantTurnComplete?.(
					acc.content,
					acc.reasoning || undefined,
					buildFinalTimings(capturedTimings, agenticTimings),
					acc.toolCalls.length > 0 ? this.normalizeToolCalls(acc.toolCalls) : undefined
				);
				onFlowComplete?.(buildFinalTimings(capturedTimings, agenticTimings));
				return;
			}

			// No tool calls = final turn, save and complete
			if (acc.toolCalls.length === 0) {
				agenticTimings.perTurn!.push(turnStats);

				const finalTimings = buildFinalTimings(capturedTimings, agenticTimings);

				await onAssistantTurnComplete?.(
					acc.content,
					acc.reasoning || undefined,
					finalTimings,
					undefined
				);

				if (finalTimings) onTurnComplete?.(finalTimings);

				onFlowComplete?.(finalTimings);

				return;
			}

			// Normalize and save assistant turn with tool calls
			const normalizedCalls = this.normalizeToolCalls(acc.toolCalls);
			if (normalizedCalls.length === 0) {
				await onAssistantTurnComplete?.(
					acc.content,
					acc.reasoning || undefined,
					buildFinalTimings(capturedTimings, agenticTimings),
					undefined
				);
				onFlowComplete?.(buildFinalTimings(capturedTimings, agenticTimings));
				return;
			}

			totalToolCallCount += normalizedCalls.length;
			this.session.updateSession(conversationId, { totalToolCalls: totalToolCallCount });

			// Save the assistant message with its tool calls
			await onAssistantTurnComplete?.(
				acc.content,
				acc.reasoning || undefined,
				acc.timings,
				normalizedCalls
			);

			// Add assistant message to session history
			sessionMessages.push({
				role: MessageRole.ASSISTANT,
				content: acc.content || undefined,
				reasoning_content: acc.reasoning || undefined,
				tool_calls: normalizedCalls
			});

			const toolOutcome = await this.toolExec.runToolCalls({
				normalizedCalls,
				conversationId,
				sessionMessages,
				agenticTimings,
				turnStats,
				capturedTimings,
				effectiveModel,
				callbacks,
				signal
			});

			// 'stopped' means runToolCalls already called onFlowComplete. Returning
			// here is what the four inline `return`s used to do; completing again
			// would fire the callback twice.
			if (toolOutcome === 'stopped') return;

			if (turnStats.toolCalls.length > 0) {
				agenticTimings.perTurn!.push(turnStats);

				const intermediateTimings = buildFinalTimings(capturedTimings, agenticTimings);
				if (intermediateTimings) onTurnComplete?.(intermediateTimings);
			}

			// If tools were interrupted by a steering message, exit now instead of starting another LLM turn
			if (this.session.steeringMessages.has(conversationId)) {
				console.log(
					'[AgenticStore] Steering message detected after tool execution, exiting agentic flow'
				);
				onFlowComplete?.(buildFinalTimings(capturedTimings, agenticTimings));
				return;
			}

			turn++;
		}
	}

	private normalizeToolCalls(toolCalls: ApiChatCompletionToolCall[]): AgenticToolCallList {
		if (!toolCalls) return [];
		return toolCalls.map((call, index) => ({
			id: call?.id ?? `tool_${index}`,
			type: (call?.type as ToolCallType.FUNCTION) ?? ToolCallType.FUNCTION,
			function: {
				name: call?.function?.name ?? '',
				arguments: call?.function?.arguments ?? ''
			}
		}));
	}

}

export const agenticStore = new AgenticStore();

export function agenticIsRunning(conversationId: string) {
	return agenticStore.session.isRunning(conversationId);
}

export function agenticCurrentTurn(conversationId: string) {
	return agenticStore.session.currentTurn(conversationId);
}

export function agenticTotalToolCalls(conversationId: string) {
	return agenticStore.session.totalToolCalls(conversationId);
}

export function agenticLastError(conversationId: string) {
	return agenticStore.session.lastError(conversationId);
}

export function agenticStreamingToolCall(conversationId: string) {
	return agenticStore.session.streamingToolCall(conversationId);
}

export function agenticPendingPermissionRequest(conversationId: string) {
	return agenticStore.session.pendingPermissionRequest(conversationId);
}

export function agenticResolvePermission(conversationId: string, decision: ToolPermissionDecision) {
	agenticStore.session.resolvePermission(conversationId, decision);
}

export function agenticPendingContinueRequest(conversationId: string) {
	return agenticStore.session.pendingContinueRequest(conversationId);
}

export function agenticResolveContinue(conversationId: string, shouldContinue: boolean) {
	agenticStore.session.resolveContinue(conversationId, shouldContinue);
}

export function agenticHasPendingSteeringMessage(conversationId: string) {
	return agenticStore.session.hasPendingSteeringMessage(conversationId);
}

export function agenticInjectSteeringMessage(
	conversationId: string,
	content: string,
	extras?: DatabaseMessageExtra[]
) {
	agenticStore.session.injectSteeringMessage(conversationId, content, extras);
}

export function agenticPendingSteeringMessageContent(conversationId: string) {
	return agenticStore.session.pendingSteeringMessageContent(conversationId);
}

export function agenticPendingSteeringMessageExtras(conversationId: string) {
	return agenticStore.session.pendingSteeringMessageExtras(conversationId);
}

export function agenticClearSteeringMessage(conversationId: string) {
	agenticStore.session.clearSteeringMessage(conversationId);
}

export function agenticIsAnyRunning() {
	return agenticStore.session.isAnyRunning;
}
