/**
 * agent-core/tool-result — an MCP tools/call result as the text the model reads.
 *
 * Moved here from chat-ui (MCPService.formatToolResult and the line format in
 * utils/resource-links.ts, both of which now delegate to it) so every host
 * hands the model the same text for the same result. A file a Nest tool wrote
 * arrives as a `resource_link` and becomes ONE line:
 *
 *   [file: chats/c1/fig-1.png, image/png, 41 KB]
 *
 * which the model can pass to read_document and the UI parses back to draw
 * the file. The format is pinned on both sides by
 * redstart-nest/scripts/test-tool-result-links.mjs and chat-ui's
 * tests/unit/resource-links.test.ts.
 *
 * Pure: no I/O.
 */

export const DOWNLOAD_ROUTE = '/files/download';
export const DEFAULT_IMAGE_MIME_TYPE = 'image/png';

/**
 * @typedef {{
 *   type: string,
 *   text?: string,
 *   data?: string,
 *   mimeType?: string,
 *   resource?: { text?: string, blob?: string, uri?: string },
 *   uri?: string,
 *   name?: string,
 *   size?: number
 * }} McpContentItem
 */

/** @param {number} [bytes] */
export function sizeLabel(bytes) {
	if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return 'size unknown';
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1048576) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
	return `${(bytes / 1048576).toFixed(1)} MB`;
}

/**
 * The documents-relative path of one of Nest's links, or null for any other link.
 *
 * @param {{ type: string, uri?: string }} item
 * @returns {string | null}
 */
export function linkPath(item) {
	if (item.type !== 'resource_link' || typeof item.uri !== 'string') return null;
	if (!item.uri.startsWith(`${DOWNLOAD_ROUTE}?`)) return null;
	const p = new URLSearchParams(item.uri.slice(DOWNLOAD_ROUTE.length + 1)).get('path');
	// A path is one line of plain text, or it is not ours to render.
	if (!p || /[\r\n,\]]/.test(p)) return null;
	return p;
}

/**
 * The single line a resource_link becomes. Another server's link is named, never rendered.
 *
 * @param {{ type: string, uri?: string, name?: string, mimeType?: string, size?: number }} item
 */
export function resourceLinkText(item) {
	const p = linkPath(item);
	if (!p) return `[resource: ${item.name ?? 'unnamed'} (${item.uri ?? 'no uri'})]`;
	return `[file: ${p}, ${item.mimeType || 'application/octet-stream'}, ${sizeLabel(item.size)}]`;
}

/**
 * @param {string} mimeType
 * @param {string} base64Data
 */
function dataUrl(mimeType, base64Data) {
	return `data:${mimeType};base64,${base64Data}`;
}

/** @param {McpContentItem} content */
function formatSingleContent(content) {
	if (content.type === 'text' && content.text) return content.text;

	if (content.type === 'image' && content.data) {
		return dataUrl(content.mimeType ?? DEFAULT_IMAGE_MIME_TYPE, content.data);
	}

	// A file the tool wrote, by reference. Never the bytes.
	if (content.type === 'resource_link') return resourceLinkText(content);

	if (content.type === 'resource' && content.resource) {
		const resource = content.resource;
		if (resource.text) return resource.text;
		if (resource.blob) return resource.blob;
		return JSON.stringify(resource);
	}

	if (content.data && content.mimeType) return dataUrl(content.mimeType, content.data);

	return JSON.stringify(content);
}

/**
 * Every content item, one per line. An image stays an inline data URL here;
 * the browser host lifts those out as attachments before storing.
 *
 * @param {{ content?: McpContentItem[] } | null | undefined} result
 * @returns {string}
 */
export function formatMcpToolResult(result) {
	const content = result?.content;
	if (!Array.isArray(content)) return '';
	return content
		.map((item) => formatSingleContent(item))
		.filter(Boolean)
		.join('\n');
}
