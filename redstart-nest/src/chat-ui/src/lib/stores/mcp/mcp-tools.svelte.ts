/**
 * mcp-tools - the tool-name index and the count derived from it
 *
 * Owns which server serves each tool name, and the reactive count the UI reads.
 * It knows nothing about connections, health checks or the server registry:
 * this is the shared substrate the connection layer writes into, mirroring the
 * role ConversationCoreState plays in stores/conversations/.
 *
 * The tool *operations* (executeTool, getToolDefinitionsForLLM, the Nest `_meta`
 * provenance lookups) all read the connection map, so they stay on the facade
 * until seam 5c folds them in here.
 *
 * Note that `toolsIndex` is a plain Map, not `$state` — it was not reactive
 * before this seam either. `toolCount` is the only reactive signal the index
 * publishes, and the connection layer sets it explicitly after every mutation.
 */

export class MCPTools {
	toolsIndex = new Map<string, string>();

	toolCount = $state(0);

	getToolNames(): string[] {
		return Array.from(this.toolsIndex.keys());
	}

	hasTool(toolName: string): boolean {
		return this.toolsIndex.has(toolName);
	}

	getToolServer(toolName: string): string | undefined {
		return this.toolsIndex.get(toolName);
	}
}
