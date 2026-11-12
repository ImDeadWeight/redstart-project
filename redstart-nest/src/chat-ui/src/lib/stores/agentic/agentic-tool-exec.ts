/**
 * agentic-tool-exec - the browser's tool executors and permission gate
 *
 * The loop core (shared/agent-core/tool-calls.mjs) runs one turn's tool calls:
 * abort checks, the steering skip, the gate, dispatch, timings, the result
 * message, and the 'done' | 'stopped' sentinel contract (documented there).
 * This file is what the browser plugs into it:
 *
 *   gate.approve           the permission card, and the "always allow" list
 *   tools.execute          the four executors: Twig's local FS, llama-server's
 *                          built-ins, the in-page sandbox, and MCP
 *   tools.extractAttachments  base64 images lifted out of a result
 *   tools.extraParts       images sent to a vision model with this result
 *
 * Covered by tests/unit/agentic-loop.test.ts (through agenticStore) and, for
 * the core's half, redstart-nest/scripts/test-agent-core.mjs.
 */

import { ContentPartType, AttachmentType, ToolSource, ToolPermissionDecision } from '$lib/enums';
import { ToolsService } from '$lib/services/tools.service';
import { SandboxService } from '$lib/services/sandbox.service';
import { mcpStore } from '$lib/stores/mcp.svelte';
import { toolsStore } from '$lib/stores/tools.svelte';
import { modelsStore } from '$lib/stores/models.svelte';
import { twigFsApi } from '$lib/utils/twig';
import { permissionsStore } from '$lib/stores/permissions.svelte';
import { extractBase64Attachments } from './agentic-attachments';
import { parseResourceLine, resourceKind } from '$lib/utils/resource-links';
import { fetchFileBlob } from '$lib/utils/agentic';
import type { AgentPorts, AgentToolCall, AgentContentPart, ToolExecution } from '$lib/agent-core';
import type { AgenticSessionState } from './agentic-session.svelte';
import type { MCPToolCall, DatabaseMessageExtraImageFile } from '$lib/types';

// Images a tool returned BY REFERENCE (Phase 2 resource lines) reach a vision
// model the way base64 attachments always did: fetched now, for this request
// only, and never written into the stored message. Capped so one result with
// twenty charts cannot fill the context with pixels.
const MAX_LINKED_IMAGES_FOR_VISION = 4;
const MAX_LINKED_IMAGE_BYTES = 4 * 1024 * 1024;

async function linkedImagesAsDataUrls(result: string): Promise<string[]> {
	const urls: string[] = [];
	for (const line of result.split(/\r?\n/)) {
		if (urls.length >= MAX_LINKED_IMAGES_FOR_VISION) break;
		const resource = parseResourceLine(line);
		if (!resource || resourceKind(resource.mimeType) !== 'image') continue;
		try {
			const blob = await fetchFileBlob(resource.path);
			if (blob.size > MAX_LINKED_IMAGE_BYTES) continue;
			urls.push(
				await new Promise<string>((resolve, reject) => {
					const reader = new FileReader();
					reader.onload = () => resolve(reader.result as string);
					reader.onerror = () => reject(reader.error);
					reader.readAsDataURL(blob);
				})
			);
		} catch {
			/* the model still has the [file: ...] line; the picture is a bonus */
		}
	}
	return urls;
}

export class AgenticToolExec {
	constructor(private readonly session: AgenticSessionState) {}

	parseToolArguments(args: string | Record<string, unknown>): Record<string, unknown> {
		if (typeof args === 'object') return args;
		const trimmed = args.trim();
		if (trimmed === '') return {};
		return JSON.parse(trimmed) as Record<string, unknown>;
	}

	/**
	 * Will this call put the card in front of the person, or does a standing
	 * grant let it through? A destructive tool always prompts, even if it
	 * somehow acquired a persisted grant — an allow-list entry written before
	 * the tool was classified, or one swept in by "always allow all tools from
	 * this server". Checked before the short-circuit rather than only at the
	 * point of granting, so a stale entry cannot silently authorise unattended
	 * deletion.
	 */
	asksPerson(toolName: string): boolean {
		const permissionKey = toolsStore.getPermissionKey(toolName);
		const destructive = toolsStore.isDestructiveTool(toolName);
		return destructive || !permissionKey || !permissionsStore.hasTool(permissionKey);
	}

	async requestPermission(
		conversationId: string,
		toolName: string,
		serverLabel: string,
		signal?: AbortSignal
	): Promise<ToolPermissionDecision> {
		const permissionKey = toolsStore.getPermissionKey(toolName);
		const destructive = toolsStore.isDestructiveTool(toolName);
		if (!this.asksPerson(toolName)) {
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

	/**
	 * The browser's `tools` and `gate` ports for one flow. The loop core
	 * (shared/agent-core/tool-calls.mjs) owns the order: abort checks, steering
	 * skip, the gate, dispatch, timings, the result message. This supplies the
	 * four executors, the permission card and the vision parts.
	 */
	ports(
		conversationId: string,
		effectiveModel: string
	): Pick<AgentPorts<DatabaseMessageExtra>, 'tools' | 'gate'> {
		// Calls the person approved on the card in this flow, by call id. Nest
		// enforces an approval on some tools (agent-runtime Phase 2): the MCP
		// executor answers Nest's request for one only for these, so a call that
		// passed the gate on a standing grant is never approved on anyone's
		// behalf. Each id is used once.
		const approvedByPerson = new Set<string>();
		return {
			gate: {
				approve: async (call, signal) => {
					const toolName = call.function.name;
					const asked = this.asksPerson(toolName);
					const decision = await this.requestPermission(
						conversationId,
						toolName,
						toolsStore.getToolServerLabel(toolName),
						signal
					);
					const allowed = decision !== ToolPermissionDecision.DENY;
					if (allowed && asked && call.id) approvedByPerson.add(call.id);
					return allowed;
				}
			},
			tools: {
				execute: (call, signal) => {
					const approved = !!call.id && approvedByPerson.delete(call.id);
					return this.execute(conversationId, call, signal, approved);
				},
				extractAttachments: (text) => {
					const { cleanedResult, attachments } = extractBase64Attachments(text);
					return { text: cleanedResult, attachments };
				},
				extraParts: (text, attachments) => this.visionParts(text, attachments, effectiveModel)
			}
		};
	}

	/** Dispatch one call to the executor that owns it. Throws on abort. */
	private async execute(
		conversationId: string,
		toolCall: AgentToolCall,
		signal?: AbortSignal,
		approvedByPerson = false
	): Promise<ToolExecution> {
		const toolName = toolCall.function.name;
		const toolSource = toolsStore.getToolSource(toolName);

		if (toolSource === ToolSource.LOCAL_FS) {
			const api = twigFsApi();
			const args = this.parseToolArguments(toolCall.function.arguments);
			if (!api) {
				return {
					text: 'Local file system tools are only available in the Redstart Twig desktop app.',
					isError: true
				};
			}
			const executionResult = await api.execute(toolName, args);
			return {
				text: (executionResult.content ?? []).map((c) => c.text).join('\n'),
				isError: !!executionResult.isError
			};
		}
		if (toolSource === ToolSource.BUILTIN) {
			const args = this.parseToolArguments(toolCall.function.arguments);
			const executionResult = await ToolsService.executeTool(toolName, args, signal);
			return { text: executionResult.content, isError: !!executionResult.isError };
		}
		if (toolSource === ToolSource.FRONTEND) {
			const args = this.parseToolArguments(toolCall.function.arguments);
			const executionResult = await SandboxService.executeTool(toolName, args, signal);
			return { text: executionResult.content, isError: !!executionResult.isError };
		}
		const mcpCall: MCPToolCall = {
			id: toolCall.id,
			function: { name: toolName, arguments: toolCall.function.arguments }
		};
		const executionResult = await mcpStore.executeTool(mcpCall, signal, {
			conversationId,
			approvedByPerson
		});
		return { text: executionResult.content, isError: !!executionResult.isError };
	}

	/**
	 * Images that go to a vision model with this result, for this request only:
	 * base64 attachments lifted out of the text, then images the result linked
	 * by reference. None for a model without vision.
	 */
	private async visionParts(
		cleanedResult: string,
		attachments: DatabaseMessageExtra[],
		effectiveModel: string
	): Promise<AgentContentPart[]> {
		const parts: AgentContentPart[] = [];
		const vision = modelsStore.modelSupportsVision(effectiveModel);
		for (const attachment of attachments) {
			if (attachment.type === AttachmentType.IMAGE) {
				if (vision) {
					parts.push({
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

		if (vision) {
			for (const url of await linkedImagesAsDataUrls(cleanedResult)) {
				parts.push({ type: ContentPartType.IMAGE_URL, image_url: { url } });
			}
		}
		return parts;
	}
}
