/**
 * resource-links - MCP `resource_link` tool results, as one line each
 *
 * chat-tooling Phase 2. A Nest tool that produced a file returns
 * `{ type: 'resource_link', uri: '/files/download?path=…', name, mimeType, size }`
 * (daemon/tool-result-links.mjs). This module turns that into the ONE line
 * both readers use:
 *
 *   [file: chats/c1/fig-1.png, image/png, 41 KB]
 *
 * - The model reads the line: a path it can pass to read_document, a type and
 *   a size, and never the bytes (vision models are handed the image
 *   separately, at request time, by agentic-tool-exec).
 * - The UI parses the line back and draws the file: an image inline, a CSV as
 *   a table, anything else as a download chip.
 *
 * The line IS the stored reference, so a message never holds the file
 * itself. Old messages with base64 attachments still render as before.
 *
 * Pure: no I/O. The format is pinned on both sides by
 * scripts/test-tool-result-links.mjs (server) and
 * tests/unit/resource-links.test.ts (here).
 */

export const DOWNLOAD_ROUTE = '/files/download';

export const RESOURCE_LINE_REGEX = /^\[file: ([^,\]]+), ([^,\]]+), ([^\]]+)\]$/;

export interface ResourceLinkItem {
	type: string;
	uri?: string;
	name?: string;
	mimeType?: string;
	size?: number;
}

export interface ToolResultResource {
	path: string;
	mimeType: string;
	sizeLabel: string;
}

export function sizeLabel(bytes?: number): string {
	if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return 'size unknown';
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1048576) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
	return `${(bytes / 1048576).toFixed(1)} MB`;
}

/** The documents-relative path of one of Nest's links, or null for any other link. */
export function linkPath(item: ResourceLinkItem): string | null {
	if (item.type !== 'resource_link' || typeof item.uri !== 'string') return null;
	if (!item.uri.startsWith(`${DOWNLOAD_ROUTE}?`)) return null;
	const p = new URLSearchParams(item.uri.slice(DOWNLOAD_ROUTE.length + 1)).get('path');
	// A path is one line of plain text, or it is not ours to render.
	if (!p || /[\r\n,\]]/.test(p)) return null;
	return p;
}

/** The single line a resource_link becomes. Another server's link is named, never rendered. */
export function resourceLinkText(item: ResourceLinkItem): string {
	const p = linkPath(item);
	if (!p) return `[resource: ${item.name ?? 'unnamed'} (${item.uri ?? 'no uri'})]`;
	return `[file: ${p}, ${item.mimeType || 'application/octet-stream'}, ${sizeLabel(item.size)}]`;
}

export function parseResourceLine(line: string): ToolResultResource | undefined {
	const m = line.trim().match(RESOURCE_LINE_REGEX);
	if (!m) return undefined;
	return { path: m[1].trim(), mimeType: m[2].trim(), sizeLabel: m[3].trim() };
}

export type ResourceKind = 'image' | 'table' | 'file';

export function resourceKind(mimeType: string): ResourceKind {
	if (/^image\/(png|jpeg|gif|webp)$/.test(mimeType)) return 'image';
	if (mimeType === 'text/csv' || mimeType === 'text/tab-separated-values') return 'table';
	return 'file';
}

/**
 * The first rows of a CSV/TSV, for the inline table. A small RFC 4180 reader
 * (quotes, doubled quotes, CRLF), not a library: the table is a preview, and
 * the download is the file itself.
 */
export function parseDelimited(text: string, maxRows = 50, delimiter = ','): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = '';
	let quoted = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quoted) {
			if (c === '"') {
				if (text[i + 1] === '"') { field += '"'; i++; }
				else quoted = false;
			} else field += c;
			continue;
		}
		if (c === '"' && field === '') { quoted = true; continue; }
		if (c === delimiter) { row.push(field); field = ''; continue; }
		if (c === '\n' || c === '\r') {
			if (c === '\r' && text[i + 1] === '\n') i++;
			row.push(field); field = '';
			rows.push(row); row = [];
			if (rows.length >= maxRows + 1) return rows;
			continue;
		}
		field += c;
	}
	if (field !== '' || row.length) { row.push(field); rows.push(row); }
	return rows.slice(0, maxRows + 1);
}
