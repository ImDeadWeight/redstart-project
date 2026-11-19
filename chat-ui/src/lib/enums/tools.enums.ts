export enum ToolSource {
	BUILTIN = 'builtin',
	MCP = 'mcp',
	CUSTOM = 'custom',
	FRONTEND = 'frontend',
	// Local file system tools executed by the Redstart Twig desktop shell against
	// a folder on the user's own machine (not the remote server).
	LOCAL_FS = 'local_fs'
}

export enum ToolPermissionDecision {
	ALWAYS = 'always',
	ALWAYS_SERVER = 'always_server',
	ONCE = 'once',
	DENY = 'deny'
}

export enum ToolResponseField {
	PLAIN_TEXT = 'plain_text_response',
	ERROR = 'error'
}
