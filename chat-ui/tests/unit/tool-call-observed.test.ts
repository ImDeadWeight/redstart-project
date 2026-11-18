import { describe, expect, it } from 'vitest';
import { parseToolCallsFromTurn } from '$lib/utils/tool-call-parser';

/**
 * Regression cases captured verbatim from real sessions with a local model.
 *
 * Each of these produced no tool call and no file while the assistant text
 * implied success, so they are pinned here in the exact shape observed rather
 * than a tidied-up approximation.
 */

const DOCUMENTS_TOOLS = [
	{ name: 'create_document' },
	{ name: 'read_document' },
	{ name: 'list_documents' }
];

const cfg = () => ({
	patterns: ['braces', 'xml', 'fn', 'json'],
	availableTools: DOCUMENTS_TOOLS
});

describe('observed: correct arguments emitted as a fenced object with no envelope', () => {
	// The model reasoned its way to the right schema (title/content/format) and
	// emitted it as a bare object under a bare "json" label — no tool_call tags,
	// no {"name": ...} envelope.
	const answer = [
		'json',
		'',
		'{',
		'  "title": "Tiling Company Purchase Log",',
		'  "content": "| Date | Item | Quantity | Unit Price | Total Price | Vendor |\\n|------|------|----------|------------|-------------|--------|\\n| 2024-01-05 | Ceramic Floor Tiles 12x12 | 500 sq ft | $1.85 | $925.00 | TileDepot |\\n| 2024-01-12 | Cement Backer Board 1/2\\" | 120 sheets | $18.99 | $2,278.80 | Lumber & Tile Depot |",',
		'  "format": "docx"',
		'}'
	].join('\n');

	const reasoning = [
		'I will generate the DOCX using the `create_document` tool.',
		'I need to construct the content in a format the tool accepts.',
		'I will use `create_document(title="Tiling Company Purchase Log", content=..., format="docx")`.'
	].join('\n');

	it('recovers the call', () => {
		const calls = parseToolCallsFromTurn(answer, reasoning, cfg());
		expect(calls).toHaveLength(1);
		expect(calls[0].name).toBe('create_document');
	});

	it('recovers the real arguments, not the reasoning placeholder', () => {
		const calls = parseToolCallsFromTurn(answer, reasoning, cfg());
		const args = JSON.parse(calls[0].arguments);
		expect(args.title).toBe('Tiling Company Purchase Log');
		expect(args.format).toBe('docx');
		expect(args.content).toContain('Ceramic Floor Tiles');
		// Escaped quotes inside the table (a 1/2" backer board) must survive.
		expect(args.content).toContain('Cement Backer Board 1/2"');
	});

	// The failure mode this guards: with no tools delivered, availableTools is
	// empty, no tool name can be found in the turn, and recovery silently
	// declines — which is what made the tool-delivery bug so hard to see.
	it('declines when no tools are available to attribute to', () => {
		const noTools = { patterns: cfg().patterns, availableTools: [] };
		expect(parseToolCallsFromTurn(answer, reasoning, noTools)).toHaveLength(0);
	});
});
