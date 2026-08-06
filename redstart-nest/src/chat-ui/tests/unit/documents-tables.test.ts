import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdirSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// documents-tool resolves its output folder from config, but importing the
// electron main module graph still needs the app stub the other main-process
// suites use.
const TEST_DIR = join(tmpdir(), 'redstart-documents-tests')

vi.mock('electron', () => ({
	app: { getPath: () => TEST_DIR }
}))

let outputDir: string

beforeEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true })
	outputDir = join(TEST_DIR, 'documents')
	mkdirSync(outputDir, { recursive: true })
})

async function loadTool() {
	return import('$lib/../../../../electron/main/documents-tool.mjs')
}

function cfg() {
	return { documents: { enabled: true, outputDir } }
}

/** An MCP tool result. callTool returns null for names it doesn't claim. */
type McpResult = { isError?: boolean; content: Array<{ type: string; text: string }> }

/** Call the documents provider and assert it claimed the tool name. */
async function callDocumentTool(name: string, args: Record<string, unknown>): Promise<McpResult> {
	const { callTool } = await loadTool()
	const result = (await callTool(name, args, cfg())) as McpResult | null
	expect(result).not.toBeNull()
	return result as McpResult
}

// ---------------------------------------------------------------------------
// Block parsing — table detection
// ---------------------------------------------------------------------------

describe('parseBlocks — table detection', () => {
	async function parse(content: string) {
		const { parseBlocks } = await loadTool()
		return parseBlocks(content)
	}

	it('parses a pipe table into a table block', async () => {
		const blocks = await parse('| Date | Item |\n| --- | --- |\n| 2026-01-01 | Tile |\n| 2026-01-02 | Grout |')
		expect(blocks).toHaveLength(1)
		expect(blocks[0].type).toBe('table')
		expect(blocks[0].header).toEqual(['Date', 'Item'])
		expect(blocks[0].rows).toEqual([
			['2026-01-01', 'Tile'],
			['2026-01-02', 'Grout']
		])
	})

	it('accepts tables without leading and trailing pipes', async () => {
		const blocks = await parse('Date | Item\n--- | ---\n2026-01-01 | Tile')
		expect(blocks[0].type).toBe('table')
		expect(blocks[0].header).toEqual(['Date', 'Item'])
		expect(blocks[0].rows).toEqual([['2026-01-01', 'Tile']])
	})

	it('accepts alignment colons in the separator row', async () => {
		const blocks = await parse('| Item | Qty |\n| :--- | ---: |\n| Tile | 50 |')
		expect(blocks[0].type).toBe('table')
		expect(blocks[0].rows).toEqual([['Tile', '50']])
	})

	it('pads short rows and truncates long ones to the header width', async () => {
		const blocks = await parse('| A | B | C |\n|---|---|---|\n| 1 |\n| 1 | 2 | 3 | 4 |')
		expect(blocks[0].rows).toEqual([
			['1', '', ''],
			['1', '2', '3']
		])
	})

	it('treats an escaped pipe as literal cell text', async () => {
		const blocks = await parse('| Expr | Note |\n|---|---|\n| a \\| b | or |')
		expect(blocks[0].rows).toEqual([['a | b', 'or']])
	})

	it('ends the table at a blank line and keeps following blocks', async () => {
		const blocks = await parse('| A |\n|---|\n| 1 |\n\nAfter the table.')
		expect(blocks).toHaveLength(2)
		expect(blocks[0].type).toBe('table')
		expect(blocks[1]).toEqual({ type: 'paragraph', text: 'After the table.' })
	})

	it('parses a table that ends at the end of the content', async () => {
		const blocks = await parse('| A |\n|---|\n| 1 |')
		expect(blocks[0].rows).toEqual([['1']])
	})

	it('parses headings and bullets around a table', async () => {
		const blocks = await parse('# Title\n\n| A |\n|---|\n| 1 |\n\n- point one')
		expect(blocks.map((b: { type: string }) => b.type)).toEqual(['heading1', 'table', 'bullet'])
	})

	it('does not treat a bullet list as a table', async () => {
		const blocks = await parse('- alpha\n- beta')
		expect(blocks.every((b: { type: string }) => b.type === 'bullet')).toBe(true)
	})

	it('does not treat a horizontal rule after prose as a table', async () => {
		const blocks = await parse('Some prose.\n\n---\n\nMore prose.')
		expect(blocks.some((b: { type: string }) => b.type === 'table')).toBe(false)
	})

	it('does not treat prose containing a pipe as a table', async () => {
		const blocks = await parse('Use grep | sort to chain commands.')
		expect(blocks).toEqual([{ type: 'paragraph', text: 'Use grep | sort to chain commands.' }])
	})
})

// ---------------------------------------------------------------------------
// Rendering — a real table in the output file, plus the download marker
// ---------------------------------------------------------------------------

describe('create_document — table rendering', () => {
	function tableMarkdown(rowCount: number) {
		let md = '| Date | Item | Qty |\n| --- | --- | ---: |\n'
		for (let i = 1; i <= rowCount; i++) md += `| 2026-01-${String(i).padStart(2, '0')} | Item ${i} | ${i} |\n`
		return md
	}

	it('writes a real Word table, not pipe-text paragraphs', async () => {
		const result = await callDocumentTool('create_document', {
			title: 'Purchase Log',
			content: tableMarkdown(50),
			format: 'docx'
		})
		expect(result.isError).toBeFalsy()

		const mammoth = (await import('mammoth')).default
		const { value: html } = await mammoth.convertToHtml({ path: join(outputDir, 'purchase-log.docx') })

		expect((html.match(/<table>/g) || []).length).toBe(1)
		expect((html.match(/<tr>/g) || []).length).toBe(51) // header + 50 rows
		// Exactly one repeating header row; body rows must be data cells, not
		// headers, or Word repeats all 50 on every page.
		const thead = html.match(/<thead>[\s\S]*?<\/thead>/)?.[0] ?? ''
		expect((thead.match(/<tr>/g) || []).length).toBe(1)
		expect((html.match(/<td>/g) || []).length).toBe(150) // 50 rows x 3 columns
		expect(html).toContain('Item 50')
	})

	it('renders a table to PDF without error', async () => {
		const result = await callDocumentTool('create_document', {
			title: 'Pdf Log',
			content: tableMarkdown(50),
			format: 'pdf'
		})
		expect(result.isError).toBeFalsy()
		expect(existsSync(join(outputDir, 'pdf-log.pdf'))).toBe(true)
	})

	it('returns a [FILE: ...] marker so the chat UI renders a download button', async () => {
		const result = await callDocumentTool('create_document', {
			title: 'Marker Doc',
			content: 'Body text.',
			format: 'markdown'
		})
		expect(result.isError).toBeFalsy()

		const text = result.content[0].text
		// Must be the first thing on its own line — that is what FILE_PATH_REGEX anchors on.
		expect(text.split('\n')[0]).toBe('[FILE: marker-doc.md]')
		expect(text).toContain('Document created:')
	})

	// A local model that guesses the signature will retry, so the error it sees
	// has to name the real arguments or it just repeats the same bad call.
	it('gives usage guidance when the document cannot be named at all', async () => {
		const result = await callDocumentTool('create_document', {
			content: '| A |\n|---|\n| 1 |',
			format: 'docx'
		})
		expect(result.isError).toBe(true)
		expect(result.content[0].text).toContain('title')
		expect(result.content[0].text).toContain('format')
	})

	it('still requires content even when a filename is supplied', async () => {
		const result = await callDocumentTool('create_document', { filename: 'empty.docx' })
		expect(result.isError).toBe(true)
		expect(result.content[0].text).toContain('content')
	})

	// The recovered orphan payload arrives with the model's own key names. It is
	// otherwise a complete, valid call, so accept it rather than bouncing it.
	it('accepts filename as an alias for title and infers format from it', async () => {
		const result = await callDocumentTool('create_document', {
			filename: 'Tiling_Company_Purchase_Log.docx',
			content: '| Pricing | Items |\n|---|---|\n| 2,450.00 | Ceramic Floor Tiles |'
		})
		expect(result.isError).toBeFalsy()
		expect(result.content[0].text.split('\n')[0]).toBe('[FILE: tiling-company-purchase-log.docx]')
		expect(existsSync(join(outputDir, 'tiling-company-purchase-log.docx'))).toBe(true)
	})

	it('honors an explicit format over the filename extension', async () => {
		const result = await callDocumentTool('create_document', {
			filename: 'report.docx',
			content: 'Body',
			format: 'markdown'
		})
		expect(result.isError).toBeFalsy()
		expect(existsSync(join(outputDir, 'report.md'))).toBe(true)
	})

	it('ignores any directory in the supplied filename', async () => {
		const result = await callDocumentTool('create_document', {
			file_path: '../../escape/Secret Notes.pdf',
			content: 'Body'
		})
		expect(result.isError).toBeFalsy()
		// Server-derived name in the configured folder — no traversal honored.
		expect(existsSync(join(outputDir, 'secret-notes.pdf'))).toBe(true)
	})

	it('names the valid formats when format is invalid', async () => {
		const result = await callDocumentTool('create_document', { title: 'T', content: 'x', format: 'xlsx' })
		expect(result.isError).toBe(true)
		expect(result.content[0].text).toContain('docx')
	})

	it('marker path is relative to the documents folder, not absolute', async () => {
		const result = await callDocumentTool('create_document', {
			title: 'Rel Path',
			content: 'x',
			format: 'markdown'
		})
		const marker = result.content[0].text.split('\n')[0]
		expect(marker).toBe('[FILE: rel-path.md]')
		expect(marker).not.toContain(outputDir)
	})
})
