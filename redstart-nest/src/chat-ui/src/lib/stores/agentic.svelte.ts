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

import { ChatService } from '$lib/services';
import { convertDbMessageToApiChatMessageData } from '$lib/services/chat/chat-message-convert';
import { config } from '$lib/stores/settings.svelte';
import { mcpStore } from '$lib/stores/mcp.svelte';
import { modelsStore } from '$lib/stores/models.svelte';
import { toolsStore } from '$lib/stores/tools.svelte';
import { permissionsStore } from '$lib/stores/permissions.svelte';
import { ToolSource, ToolPermissionDecision } from '$lib/enums';
import { ToolsService } from '$lib/services/tools.service';
import { SandboxService } from '$lib/services/sandbox.service';
import { isAbortError } from '$lib/utils';
import { twigFsApi } from '$lib/utils/twig';
import { parseToolCallsFromTurn, createApiToolCalls } from '$lib/utils/tool-call-parser';
import { DEFAULT_AGENTIC_CONFIG } from '$lib/constants';
import {
	AttachmentType,
	ContentPartType,
	MessageRole,
	ToolCallType
} from '$lib/enums';
import type {
	AgenticFlowParams,
	AgenticFlowResult,
	AgenticConfig,
	SettingsConfigType,
	McpServerOverride,
	MCPToolCall
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
	ChatMessagePromptProgress,
	ChatMessageTimings,
	ChatMessageAgenticTimings,
	ChatMessageToolCallTiming,
	ChatMessageAgenticTurnStats
} from '$lib/types/chat';
import type {
	DatabaseMessage,
	DatabaseMessageExtra,
	DatabaseMessageExtraImageFile
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
import { buildFinalTimings } from '$lib/stores/agentic/agentic-timings';
import { extractBase64Attachments } from '$lib/stores/agentic/agentic-attachments';

class AgenticStore {
	/**
	 * Per-conversation session state. A sub-store rather than a facade split:
	 * §4.5 is explicit that the facade recipe is wrong for this file, but the
	 * session maps are pure state with no loop logic, so they separate cleanly.
	 * The loop reaches them directly through `this.session.<map>` — Trap 7, since
	 * requestPermission, requestContinue and the loop all mutate them in place.
	 */
	readonly session = new AgenticSessionState();

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

	private parseToolArguments(args: string | Record<string, unknown>): Record<string, unknown> {
		if (typeof args === 'object') return args;
		const trimmed = args.trim();
		if (trimmed === '') return {};
		return JSON.parse(trimmed) as Record<string, unknown>;
	}

	private async requestPermission(
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

			let turnContent = '';
			let turnReasoningContent = '';
			let turnToolCalls: ApiChatCompletionToolCall[] = [];
			let lastStreamingToolCallName = '';
			let lastStreamingToolCallArgsLength = 0;
			let turnTimings: ChatMessageTimings | undefined;

			const turnStats: ChatMessageAgenticTurnStats = {
				turn: turn + 1,
				llm: { predicted_n: 0, predicted_ms: 0, prompt_n: 0, prompt_ms: 0 },
				toolCalls: [],
				toolsMs: 0
			};

			try {
				await ChatService.sendMessage(
					sessionMessages as ApiChatMessageData[],
					{
						...options,
						stream: true,
						tools: tools.length > 0 ? tools : undefined,
						onChunk: (chunk: string) => {
							turnContent += chunk;
							onChunk?.(chunk);
						},
						onReasoningChunk: (chunk: string) => {
							turnReasoningContent += chunk;
							onReasoningChunk?.(chunk);
						},
						onToolCallChunk: (serialized: string) => {
							try {
								turnToolCalls = JSON.parse(serialized) as ApiChatCompletionToolCall[];
								onToolCallsStreaming?.(turnToolCalls);

								if (turnToolCalls.length > 0 && turnToolCalls[0]?.function) {
									const name = turnToolCalls[0].function.name || '';
									const args = turnToolCalls[0].function.arguments || '';
									const argsLengthBucket = Math.floor(args.length / 100);
									if (
										name !== lastStreamingToolCallName ||
										argsLengthBucket !== lastStreamingToolCallArgsLength
									) {
										lastStreamingToolCallName = name;
										lastStreamingToolCallArgsLength = argsLengthBucket;
										this.session.updateSession(conversationId, {
											streamingToolCall: { name, arguments: args }
										});
									}
								}
							} catch {
								/* Ignore parse errors during streaming */
							}
						},
						onModel,
						onCompletionId,
						onTimings: (timings?: ChatMessageTimings, progress?: ChatMessagePromptProgress) => {
							onTimings?.(timings, progress);
							if (timings) {
								capturedTimings = timings;
								turnTimings = timings;
							}
						},
						onComplete: () => {
							/* Completion handled after sendMessage resolves */
						},
						onError: (error: Error) => {
							throw error;
						}
					},
					undefined,
					signal
				);

				this.session.updateSession(conversationId, { streamingToolCall: null });

				if (turnTimings) {
					agenticTimings.llm.predicted_n += turnTimings.predicted_n || 0;
					agenticTimings.llm.predicted_ms += turnTimings.predicted_ms || 0;
					agenticTimings.llm.prompt_n += turnTimings.prompt_n || 0;
					agenticTimings.llm.prompt_ms += turnTimings.prompt_ms || 0;
					turnStats.llm.predicted_n = turnTimings.predicted_n || 0;
					turnStats.llm.predicted_ms = turnTimings.predicted_ms || 0;
					turnStats.llm.prompt_n = turnTimings.prompt_n || 0;
					turnStats.llm.prompt_ms = turnTimings.prompt_ms || 0;
				}

				if (turnToolCalls.length === 0 && config().toolCallFallbackParserEnabled) {
					const patternList: string[] = (config().toolCallFallbackParserPatterns || '')
						.split(',')
						.map((p: string) => p.trim())
						.filter(Boolean);
					// Scans the visible answer, then the reasoning stream — a reasoning
					// model often writes the call in its thinking block and only
					// narrates it in the answer, which would otherwise drop it silently.
					const parsed = parseToolCallsFromTurn(turnContent, turnReasoningContent, {
						patterns: patternList,
						availableTools: toolsStore.allTools.map((t) => ({ name: t.definition.function.name }))
					});

					if (parsed.length > 0) {
						turnToolCalls = createApiToolCalls(parsed);
					}
				}
			} catch (error) {
				if (signal?.aborted) {
					// Save whatever we have for this turn before exiting
					await onAssistantTurnComplete?.(
						turnContent,
						turnReasoningContent || undefined,
						buildFinalTimings(capturedTimings, agenticTimings),
						undefined
					);
					onFlowComplete?.(buildFinalTimings(capturedTimings, agenticTimings));
					return;
				}
				const normalizedError = error instanceof Error ? error : new Error('LLM stream error');
				// preserve partial output as is, the outer error dialog informs the user separately
				await onAssistantTurnComplete?.(
					turnContent,
					turnReasoningContent || undefined,
					buildFinalTimings(capturedTimings, agenticTimings),
					undefined
				);
				onFlowComplete?.(buildFinalTimings(capturedTimings, agenticTimings));
				throw normalizedError;
			}

			// === Steering check: if a user message was queued during this turn, exit the flow.
			// The caller (chatStore) will consume the pending message and re-send it normally.
			if (this.session.steeringMessages.has(conversationId)) {
				console.log('[AgenticStore] Steering message detected after turn, exiting agentic flow');
				await onAssistantTurnComplete?.(
					turnContent,
					turnReasoningContent || undefined,
					buildFinalTimings(capturedTimings, agenticTimings),
					turnToolCalls.length > 0 ? this.normalizeToolCalls(turnToolCalls) : undefined
				);
				onFlowComplete?.(buildFinalTimings(capturedTimings, agenticTimings));
				return;
			}

			// No tool calls = final turn, save and complete
			if (turnToolCalls.length === 0) {
				agenticTimings.perTurn!.push(turnStats);

				const finalTimings = buildFinalTimings(capturedTimings, agenticTimings);

				await onAssistantTurnComplete?.(
					turnContent,
					turnReasoningContent || undefined,
					finalTimings,
					undefined
				);

				if (finalTimings) onTurnComplete?.(finalTimings);

				onFlowComplete?.(finalTimings);

				return;
			}

			// Normalize and save assistant turn with tool calls
			const normalizedCalls = this.normalizeToolCalls(turnToolCalls);
			if (normalizedCalls.length === 0) {
				await onAssistantTurnComplete?.(
					turnContent,
					turnReasoningContent || undefined,
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
				turnContent,
				turnReasoningContent || undefined,
				turnTimings,
				normalizedCalls
			);

			// Add assistant message to session history
			sessionMessages.push({
				role: MessageRole.ASSISTANT,
				content: turnContent || undefined,
				reasoning_content: turnReasoningContent || undefined,
				tool_calls: normalizedCalls
			});

			// Execute each tool call and create result messages
			for (let i = 0; i < normalizedCalls.length; i++) {
				const toolCall = normalizedCalls[i];

				if (signal?.aborted) {
					onFlowComplete?.(buildFinalTimings(capturedTimings, agenticTimings));
					return;
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
					return;
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
							return;
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
					return;
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
