/**
 * mcp-tool-ops - discovery, provenance and execution over the connected tools
 *
 * Reads the tool index to route a call and the connection pool to make it, so
 * it is injected with both. That pairing is why it is its own module rather
 * than part of mcp-tools: the pool is already injected with the index (it
 * writes it), so folding these operations in there would make the two
 * sub-stores mutually dependent — a 0.7 stop condition. Same resolution as
 * gateway/http-json.mjs in item 4: the shared consumer becomes its own node
 * and the graph stays a DAG.
 *
 * It owns no state, so it is a plain .ts.
 */

import { NEST_MCP_SERVER_ID_PREFIX } from '$lib/constants';
import { MCPService } from '$lib/services/mcp.service';
import { JsonSchemaType, ToolCallType } from '$lib/enums';
import type { MCPToolCall, OpenAIToolDefinition, ToolExecutionResult } from '$lib/types';
import { normalizeSchemaProperties, parseToolArguments } from './mcp-schema';
import type { MCPTools } from './mcp-tools.svelte';
import type { MCPConnections } from './mcp-connections.svelte';

export class MCPToolOps {
	constructor(
		private readonly tools: MCPTools,
		private readonly conn: MCPConnections
	) {}

	/**
	 * Redstart provenance carried on a tool's `_meta` by Redstart Nest's
	 * built-in MCP server: which capability produced it, and its class.
	 *
	 * Honoured ONLY for Nest-provisioned servers (id prefix `redstart-`, set in
	 * syncServersFromHost from the host's own advertised list). `_meta` is an
	 * open passthrough field that any MCP server can populate with anything, so
	 * reading it from an arbitrary third-party server would let that server
	 * claim to be one of Nest's capabilities — or, once tool class drives the
	 * permission prompt, declare its own destructive tool harmless. The trust
	 * boundary is the server, so it is checked here rather than at each caller.
	 */
	private redstartMeta(
		serverId: string,
		tool: { _meta?: Record<string, unknown> }
	): { capability: string | null; toolClass: string | null; source: string | null } {
		if (!serverId.startsWith(NEST_MCP_SERVER_ID_PREFIX)) {
			return { capability: null, toolClass: null, source: null };
		}
		const meta = tool._meta ?? {};
		const capability = meta['redstart/capability'];
		const toolClass = meta['redstart/class'];
		// A human label for what provided this tool ("ComfyUI"), for grouping and
		// display only. Read behind the same server check as the other two: it is
		// shown to the user, so a third-party server must not be able to caption
		// its own tools with someone else's name.
		const source = meta['redstart/source'];
		return {
			capability: typeof capability === 'string' ? capability : null,
			toolClass: typeof toolClass === 'string' ? toolClass : null,
			source: typeof source === 'string' && source ? source : null
		};
	}

	/** Public accessor for a tool's provenance, by name. See redstartMeta. */
	getNestToolMeta(toolName: string): {
		capability: string | null;
		toolClass: string | null;
		source: string | null;
	} {
		for (const [serverId, connection] of this.conn.connections) {
			for (const tool of connection.tools) {
				if (tool.name === toolName) return this.redstartMeta(serverId, tool);
			}
		}
		return { capability: null, toolClass: null, source: null };
	}

	/**
	 * Names of the tools a given Nest capability is currently serving.
	 *
	 * Derived live from what the server actually advertised, so the caller can
	 * act on capability IDENTITY without hardcoding tool names. That distinction
	 * is the whole point: the previous filesystem precedence rule was expressed
	 * as a name collision, and it stopped working — silently — the moment Nest
	 * renamed its file tools.
	 */
	getNestToolNamesForCapability(capability: string): Set<string> {
		const names = new Set<string>();
		for (const [serverId, connection] of this.conn.connections) {
			for (const tool of connection.tools) {
				if (this.redstartMeta(serverId, tool).capability === capability) names.add(tool.name);
			}
		}
		return names;
	}

	getToolDefinitionsForLLM(): OpenAIToolDefinition[] {
		const tools: OpenAIToolDefinition[] = [];

		for (const connection of this.conn.connections.values()) {
			for (const tool of connection.tools) {
				const rawSchema = (tool.inputSchema as Record<string, unknown>) ?? {
					type: JsonSchemaType.OBJECT,
					properties: {},
					required: []
				};

				tools.push({
					type: ToolCallType.FUNCTION as const,
					function: {
						name: tool.name,
						description: tool.description,
						parameters: normalizeSchemaProperties(rawSchema)
					}
				});
			}
		}

		return tools;
	}

	async executeTool(toolCall: MCPToolCall, signal?: AbortSignal): Promise<ToolExecutionResult> {
		const toolName = toolCall.function.name;

		const serverName = this.tools.toolsIndex.get(toolName);
		if (!serverName) throw new Error(`Unknown tool: ${toolName}`);

		const connection = this.conn.connections.get(serverName);
		if (!connection) throw new Error(`Server "${serverName}" is not connected`);

		const args = parseToolArguments(toolCall.function.arguments);

		try {
			return await MCPService.callTool(connection, { name: toolName, arguments: args }, signal);
		} catch (error) {
			// Session expired (server restarted) - reconnect and retry once
			if (MCPService.isSessionExpiredError(error)) {
				await this.conn.reconnectServer(serverName);

				const newConnection = this.conn.connections.get(serverName);
				if (!newConnection) throw new Error(`Failed to reconnect to "${serverName}"`);

				return MCPService.callTool(newConnection, { name: toolName, arguments: args }, signal);
			}

			throw error;
		}
	}

	async executeToolByName(
		toolName: string,
		args: Record<string, unknown>,
		signal?: AbortSignal
	): Promise<ToolExecutionResult> {
		const serverName = this.tools.toolsIndex.get(toolName);
		if (!serverName) throw new Error(`Unknown tool: ${toolName}`);
		const connection = this.conn.connections.get(serverName);
		if (!connection) throw new Error(`Server "${serverName}" is not connected`);

		try {
			return await MCPService.callTool(connection, { name: toolName, arguments: args }, signal);
		} catch (error) {
			if (MCPService.isSessionExpiredError(error)) {
				await this.conn.reconnectServer(serverName);

				const newConnection = this.conn.connections.get(serverName);
				if (!newConnection) throw new Error(`Failed to reconnect to "${serverName}"`);

				return MCPService.callTool(newConnection, { name: toolName, arguments: args }, signal);
			}

			throw error;
		}
	}
}
