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
 * - **shared/agent-core** (via $lib/agent-core): the loop itself, host-agnostic,
 *   also run by the benchmark under Node and later by the daemon
 * - **ChatService**: Stateless API layer (sendMessage, streaming)
 * - **mcpStore**: MCP connection management and tool execution
 * - **agenticStore** (this): Reactive state, the setup around a flow, and the
 *   browser's ports into the core
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
	AgenticFlowCallbacks,
	AgenticFlowOptions
} from '$lib/types/agentic';
import type { ApiChatMessageData, ApiChatMessageContentPart } from '$lib/types/api';
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
import { AgenticTurn } from '$lib/stores/agentic/agentic-turn';
import { runAgentLoop } from '$lib/agent-core';

class AgenticStore {
	/**
	 * Per-conversation session state. A sub-store rather than a facade split:
	 * §4.5 is explicit that the facade recipe is wrong for this file, but the
	 * session maps are pure state with no loop logic, so they separate cleanly.
	 * The loop reaches them directly through `this.session.<map>` — Trap 7, since
	 * requestPermission, requestContinue and the loop all mutate them in place.
	 */
	readonly session = new AgenticSessionState();

	/** The browser's tool executors and permission gate (the core's tools/gate ports). */
	private readonly toolExec = new AgenticToolExec(this.session);

	/** The browser's model port: one streaming LLM turn into the core's accumulator. */
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

	/**
	 * The browser host of the shared loop core (shared/agent-core/loop.mjs).
	 * Everything the loop does is there; this builds its ports from the stores.
	 * Kept as a method of this name and shape because tests/unit/agentic-loop.test.ts
	 * drives the loop through it.
	 */
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
		const effectiveModel = options.model || modelsStore.models[0]?.model || '';

		await runAgentLoop({
			messages: toAgenticMessages(messages),
			maxTurns: agenticConfig.maxTurns,
			callbacks,
			signal,
			ports: {
				model: {
					streamTurn: ({ acc, messages: sessionMessages, signal: turnSignal }) =>
						this.turnRunner.runTurn({
							acc,
							conversationId,
							sessionMessages: sessionMessages as ApiChatMessageData[],
							options,
							tools,
							callbacks,
							signal: turnSignal
						})
				},
				...this.toolExec.ports(conversationId, effectiveModel),
				limit: { askContinue: (s) => this.requestContinue(conversationId, s) },
				steering: { pending: () => this.session.steeringMessages.has(conversationId) },
				progress: (patch) => this.session.updateSession(conversationId, patch),
				log: (message) => console.log(`[AgenticStore] ${message}`)
			}
		});
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
