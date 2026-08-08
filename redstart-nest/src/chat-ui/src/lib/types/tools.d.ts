import type { ToolSource } from '$lib/enums';
import type { OpenAIToolDefinition } from './mcp';

export interface ToolEntry {
	source: ToolSource;
	/** For MCP tools, the server display name (used for UI grouping) */
	serverName?: string;
	/** For MCP tools, the server ID (used for permission keys) */
	serverId?: string;
	/** Stable selection identity: builtin:name, mcp-<serverId>:name, mcp:name, custom:name */
	key: string;
	definition: OpenAIToolDefinition;
	/**
	 * Redstart Nest capability that produced this tool (`file_system`, `vault`,
	 * …), read from the tool's `_meta` on tools/list.
	 *
	 * Only ever populated for tools from a Nest-provisioned MCP server. A
	 * third-party server can put anything it likes in `_meta`, so trusting it
	 * from an arbitrary source would let that server describe itself as one of
	 * Nest's capabilities. See `nestCapabilityOf` in mcp.svelte.ts.
	 */
	capability?: string | null;
	/** Tool class from the same `_meta` — 'read' | 'write' | 'destructive' | 'network'. */
	toolClass?: string | null;
}

export interface ToolGroup {
	source: ToolSource;
	label: string;
	/** For MCP groups, the server ID */
	serverId?: string;
	tools: ToolEntry[];
}
