import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Same harness as documents-tables.test.ts: the electron main module graph
// needs the app stub, and the tool resolves its folder from config.
const TEST_DIR = join(tmpdir(), 'redstart-documents-format-tests');

vi.mock('electron', () => ({
	app: { getPath: () => TEST_DIR }
}));

let outputDir: string;
/** Where documents land: the anonymous caller's folder inside the root. */
let writtenDir: string;

beforeEach(async () => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	outputDir = join(TEST_DIR, 'documents');
	mkdirSync(outputDir, { recursive: true });
	const { resolveUserRoot } = await import('$lib/../../../../electron/main/user-scope.mjs');
	writtenDir = resolveUserRoot(outputDir, null, { create: true });
});

async function loadTool() {
	return import('$lib/../../../../electron/main/documents-tool.mjs');
}

function cfg() {
	return { documents: { enabled: true, outputDir } };
}

type McpResult = { isError?: boolean; content: Array<{ type: string; text: string }> };

async function callDocumentTool(name: string, args: Record<string, unknown>): Promise<McpResult> {
	const { callTool } = await loadTool();
	const result = (await callTool(name, args, cfg())) as McpResult | null;
	expect(result).not.toBeNull();
	return result as McpResult;
}

function readWritten(filename: string): string {
	return readFileSync(join(writtenDir, filename), 'utf8');
}

// ---------------------------------------------------------------------------
// The source and data formats
// ---------------------------------------------------------------------------

describe('create_document — verbatim formats', () => {
	// format -> [expected filename, content that must survive byte-for-byte]
	const cases: Array<[string, string, string]> = [
		['text', 'note.txt', 'Line one\nLine two\n'],
		['csv', 'note.csv', 'Date,Item\n2026-01-01,Tile\n'],
		['json', 'note.json', '{\n  "model": "qwen",\n  "ctx": 32768\n}\n'],
		['html', 'note.html', '<!doctype html>\n<h1>Report</h1>\n'],
		['javascript', 'note.js', 'export function run() {\n\treturn 1;\n}\n'],
		['powershell', 'note.ps1', 'Get-ChildItem |\n\tSelect-Object Name\n']
	];

	for (const [format, filename, content] of cases) {
		it(`writes ${format} to ${filename.split('.')[1]} exactly as supplied`, async () => {
			const result = await callDocumentTool('create_document', {
				title: 'Note',
				content,
				format
			});
			expect(result.isError).toBeFalsy();
			expect(existsSync(join(writtenDir, filename))).toBe(true);
			// Verbatim: no title heading, no reflowing, no block parsing. For
			// json and csv a prepended "# Note" line would be corruption, and in
			// python/powershell it would change the file's meaning.
			expect(readWritten(filename)).toBe(content);
		});
	}

	it('writes json that parses back as json', async () => {
		const profile = { name: 'Local', model: 'qwen3.6-35b', contextSize: 32768 };
		await callDocumentTool('create_document', {
			title: 'Profile',
			content: JSON.stringify(profile, null, 2),
			format: 'json'
		});
		expect(JSON.parse(readWritten('profile.json'))).toEqual(profile);
	});

	it('strips an enclosing markdown fence the model wrapped the file in', async () => {
		await callDocumentTool('create_document', {
			title: 'Fenced',
			content: '```json\n{"a": 1}\n```',
			format: 'json'
		});
		// A leading ```json line makes the file invalid json — and unrunnable
		// for the script formats, which is why the fence strip exists.
		expect(readWritten('fenced.json')).toBe('{"a": 1}\n');
		expect(JSON.parse(readWritten('fenced.json'))).toEqual({ a: 1 });
	});

	it('still prepends the title heading for markdown, which is prose', async () => {
		await callDocumentTool('create_document', {
			title: 'Prose',
			content: 'Body text',
			format: 'markdown'
		});
		expect(readWritten('prose.md')).toBe('# Prose\n\nBody text');
	});
});

// ---------------------------------------------------------------------------
// Format normalization — models pass extensions and language names
// ---------------------------------------------------------------------------

describe('create_document — format aliases', () => {
	const aliases: Array<[string, string]> = [
		['txt', 'aliased.txt'],
		['js', 'aliased.js'],
		['ps1', 'aliased.ps1'],
		['htm', 'aliased.html'],
		['pwsh', 'aliased.ps1'],
		['PDF', 'aliased.pdf'],
		['Markdown', 'aliased.md']
	];

	for (const [format, filename] of aliases) {
		it(`accepts "${format}" as a format`, async () => {
			const result = await callDocumentTool('create_document', {
				title: 'Aliased',
				content: 'x',
				format
			});
			expect(result.isError).toBeFalsy();
			expect(existsSync(join(writtenDir, filename))).toBe(true);
		});
	}

	it('infers the format from a supplied filename', async () => {
		const result = await callDocumentTool('create_document', {
			filename: 'nest_profile.json',
			content: '{"a": 1}'
		});
		expect(result.isError).toBeFalsy();
		expect(existsSync(join(writtenDir, 'nest-profile.json'))).toBe(true);
	});

	it('rejects .mjs rather than silently writing it as .js', async () => {
		// Renaming an ES module to .js can change how node parses it, so this
		// errors on purpose — the message names the format to retry with.
		const result = await callDocumentTool('create_document', {
			title: 'Module',
			content: 'export default 1',
			format: 'mjs'
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain('javascript');
	});
});

// ---------------------------------------------------------------------------
// Reading back — the round trip the new write formats imply
// ---------------------------------------------------------------------------

describe('read_document / list_documents — new types', () => {
	it('reads back a json file it just wrote', async () => {
		await callDocumentTool('create_document', {
			title: 'Roundtrip',
			content: '{"ctx": 32768}',
			format: 'json'
		});
		const read = await callDocumentTool('read_document', { path: 'roundtrip.json' });
		expect(read.isError).toBeFalsy();
		expect(read.content[0].text).toContain('32768');
	});

	it('lists the new file types alongside the old ones', async () => {
		for (const [title, format] of [
			['Script', 'powershell'],
			['Data', 'csv'],
			['Page', 'html'],
			['Config', 'json']
		]) {
			await callDocumentTool('create_document', { title, content: 'x', format });
		}
		const listed = (await callDocumentTool('list_documents', {})).content[0].text;
		expect(listed).toContain('script.ps1');
		expect(listed).toContain('data.csv');
		expect(listed).toContain('page.html');
		expect(listed).toContain('config.json');
	});
});

// ---------------------------------------------------------------------------
// Preview alignment — files-api gates previews on its own extension set, and
// an entry there that extractText cannot handle fails the request at runtime.
// ---------------------------------------------------------------------------

describe('extractText covers every previewable text type', () => {
	// The binary formats go through pdf-parse/mammoth/exceljs and need real
	// fixtures; the text ones are the half that silently drifted.
	const TEXT_PREVIEWABLE = ['.txt', '.md', '.csv', '.json', '.html', '.log', '.py', '.js', '.ps1'];

	for (const extension of TEXT_PREVIEWABLE) {
		it(`extracts ${extension}`, async () => {
			const { extractText } = await loadTool();
			const file = join(writtenDir, `sample${extension}`);
			writeFileSync(file, 'hello contents', 'utf8');
			await expect(extractText(file)).resolves.toBe('hello contents');
		});
	}

	it('still rejects a type it cannot parse', async () => {
		const { extractText } = await loadTool();
		const file = join(writtenDir, 'sample.bin');
		writeFileSync(file, 'x', 'utf8');
		await expect(extractText(file)).rejects.toThrow('Unsupported file type');
	});
});
