import { describe, it, expect } from 'vitest';
import {
	resourceLinkText,
	parseResourceLine,
	linkPath,
	resourceKind,
	parseDelimited,
	sizeLabel
} from '$lib/utils/resource-links';
import { parseToolResultWithImages } from '$lib/utils/agentic';

// chat-tooling Phase 2. The [file: ...] line is both the model's copy of a
// resource_link and the UI's stored reference to it. Server side, the same
// format is pinned by scripts/test-tool-result-links.mjs.

const link = {
	type: 'resource_link',
	uri: '/files/download?path=' + encodeURIComponent('chats/c1/fig-1.png'),
	name: 'fig-1.png',
	mimeType: 'image/png',
	size: 41231
};

describe('resource links', () => {
	it('a Nest link becomes one [file: path, mime, size] line', () => {
		expect(resourceLinkText(link)).toBe('[file: chats/c1/fig-1.png, image/png, 40 KB]');
	});

	it('the line parses back to the same path and type', () => {
		const r = parseResourceLine(resourceLinkText(link));
		expect(r).toEqual({ path: 'chats/c1/fig-1.png', mimeType: 'image/png', sizeLabel: '40 KB' });
	});

	it('another server\'s link is named, never rendered as one of our files', () => {
		const foreign = { type: 'resource_link', uri: 'https://evil.example/x.png', name: 'x.png', mimeType: 'image/png' };
		expect(linkPath(foreign)).toBeNull();
		const text = resourceLinkText(foreign);
		expect(text.startsWith('[resource: ')).toBe(true);
		expect(parseResourceLine(text)).toBeUndefined();
	});

	it('a path that would break the line format is refused', () => {
		const bad = { ...link, uri: '/files/download?path=' + encodeURIComponent('a, image/png, 1 KB]\n[file: b') };
		expect(linkPath(bad)).toBeNull();
	});

	it('parseToolResultWithImages marks resource lines and their path', () => {
		const lines = parseToolResultWithImages(`Result: 14\n${resourceLinkText(link)}\n[FILE: report.docx]`);
		expect(lines[1].resource?.path).toBe('chats/c1/fig-1.png');
		expect(lines[1].filePath).toBe('chats/c1/fig-1.png');
		expect(lines[2].filePath).toBe('report.docx');
		expect(lines[0].resource).toBeUndefined();
	});

	it('kinds: images inline, csv/tsv as a table, the rest as a chip', () => {
		expect(resourceKind('image/png')).toBe('image');
		expect(resourceKind('image/svg+xml')).toBe('file');
		expect(resourceKind('text/csv')).toBe('table');
		expect(resourceKind('application/pdf')).toBe('file');
	});

	it('parseDelimited handles quotes, doubled quotes, CRLF and the row cap', () => {
		expect(parseDelimited('a,b\r\n"x, y","he said ""hi"""\r\n3,4\n', 50)).toEqual([
			['a', 'b'],
			['x, y', 'he said "hi"'],
			['3', '4']
		]);
		const many = 'h\n' + Array.from({ length: 100 }, (_, i) => String(i)).join('\n');
		expect(parseDelimited(many, 10).length).toBe(11);
	});

	it('sizeLabel', () => {
		expect(sizeLabel(512)).toBe('512 B');
		expect(sizeLabel(2048)).toBe('2.0 KB');
		expect(sizeLabel(5 * 1048576)).toBe('5.0 MB');
		expect(sizeLabel(undefined)).toBe('size unknown');
	});
});
