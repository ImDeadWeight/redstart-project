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
	 * What to SHOW for this tool. The wire name stays in `definition`, which is
	 * what the model is sent and what a server-side ban matches; this is the
	 * label a human reads. Derived from the server's optional MCP `title`, and
	 * otherwise from the name with its namespace prefix removed — the prefix is
	 * redundant once the row sits under a header naming its source.
	 */
	displayName: string;
	/**
	 * Human label for what provided this tool ("ComfyUI"). Only ever set from a
	 * Nest-provisioned server's `_meta` (see redstartMeta). Every plugin reaches
	 * a client through Nest's ONE built-in MCP server, so without this they all
	 * group under "Redstart Built-in" and the only clue about which plugin owns
	 * a tool is the prefix buried in its name.
	 */
	sourceLabel?: string;
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
