import { describe, it, expect } from 'vitest';
import { readReporterMessage, formatArtifactCheck, type ArtifactCheckReport } from '$lib/utils/artifact-check';
import { parseToolResultWithImages, ARTIFACT_LINE_REGEX } from '$lib/utils/agentic';
import { artifactPanelStore } from '$lib/stores/artifact-panel.svelte';
import { parseArtifactLines, formatArtifactLine } from '$lib/agent-core';
import { DEFAULT_MCP_CONFIG } from '$lib/constants/mcp';

// artifacts plan §9-§10. What reaches the model and the transcript from an
// artifact, and what the browser trusts from a sandboxed frame.

const ID = '12345678-1234-1234-1234-123456789abc';

describe('artifact_check: the frame is untrusted', () => {
	it('reads only the reporter\'s messages, by source and shape', () => {
		expect(readReporterMessage({ source: 'redstart-artifact', type: 'ready' })).toEqual({ type: 'ready' });
		expect(readReporterMessage({ source: 'someone-else', type: 'ready' })).toBeNull();
		expect(readReporterMessage({ source: 'redstart-artifact', type: 'event', kind: 'exfiltrate', text: 'x' })).toBeNull();
		expect(readReporterMessage('a string')).toBeNull();
		expect(readReporterMessage(null)).toBeNull();
	});

	it('caps and coerces every field', () => {
		const ev = readReporterMessage({ source: 'redstart-artifact', type: 'event', kind: 'error', text: 'x'.repeat(5000) });
		expect(ev?.type === 'event' && ev.event.text.length).toBe(500);
		const s = readReporterMessage({ source: 'redstart-artifact', type: 'summary', title: 7, text: 'y'.repeat(9000), elements: -3, canvases: 'a lot', height: 1e3 });
		expect(s?.type === 'summary' && s.summary).toMatchObject({ title: '', elements: 0, canvases: 0, height: 1000 });
		expect(s?.type === 'summary' && s.summary.text.length).toBe(2000);
	});

	it('reports problems, the page, and that there is no screenshot', () => {
		const report: ArtifactCheckReport = {
			loaded: true,
			events: [
				{ kind: 'error', text: 'ReferenceError: x is not defined (app.js:3)' },
				{ kind: 'resource', text: 'script https://cdn.example.com/lib.js' },
				{ kind: 'console', text: 'warn: deprecated' }
			],
			summary: { title: 'Dash', text: 'Sales 2026', elements: 40, canvases: 1, images: 2, links: 3, buttons: 4, forms: 0, height: 900, width: 1500 }
		};
		const text = formatArtifactCheck(report, { title: 'Dashboard', revision: 'draft', viewport: 'desktop' });
		expect(text).toContain('Checked "Dashboard" (your unsaved draft) at desktop width (1280 px).');
		expect(text).toContain('Problems (2):');
		expect(text).toContain('- Script error: ReferenceError: x is not defined (app.js:3)');
		expect(text).toContain('- Failed to load: script https://cdn.example.com/lib.js');
		expect(text).toContain('Console warnings (1):');
		expect(text).toContain('wider than the screen (1500 px)');
		expect(text).toContain('Visible text:\nSales 2026');
		expect(text).toContain('No screenshot');
	});

	it('says when the page never loaded', () => {
		const text = formatArtifactCheck({ loaded: false, events: [], summary: null }, { title: 'X', revision: 3, viewport: 'phone' });
		expect(text).toContain('(revision 3) at phone width (390 px)');
		expect(text).toContain('did not finish loading');
	});
});

describe('the [artifact: …] line', () => {
	it('becomes a card line in the transcript, not text', () => {
		const lines = parseToolResultWithImages(`Edited index.html at line 4.\n${formatArtifactLine(ID, 'draft')}`);
		expect(lines[1].artifact).toEqual({ id: ID, revision: 'draft' });
		expect(lines[0].artifact).toBeUndefined();
		expect(parseToolResultWithImages(`[artifact: ${ID} r12]`)[0].artifact).toEqual({ id: ID, revision: 12 });
	});

	it('matches the shared parser, and nothing malformed', () => {
		expect(parseArtifactLines(`x\n${formatArtifactLine(ID, 3)}`)).toEqual([{ id: ID, revision: 3 }]);
		for (const bad of ['[artifact: nope r1]', `[artifact: ${ID} r]`, `[artifact: ${ID} draft] trailing`, ` [artifact: ${ID} draft]`]) {
			expect(ARTIFACT_LINE_REGEX.test(bad)).toBe(false);
		}
	});
});

describe('the panel', () => {
	it('opens itself for the first artifact a turn CREATES, and only beside its chat', () => {
		artifactPanelStore.close();
		artifactPanelStore.noteResult('c1', ID, false);
		expect(artifactPanelStore.open).toBeNull();
		artifactPanelStore.noteResult('c1', ID, true);
		expect(artifactPanelStore.open).toEqual({ id: ID, conversationId: 'c1' });
		expect(artifactPanelStore.selectedFor('c1')).toBe(ID);
		expect(artifactPanelStore.selectedFor('c2')).toBeNull();
	});

	it('a closed panel stays closed for the rest of the turn; the next turn may open it again', () => {
		artifactPanelStore.close();
		artifactPanelStore.noteResult('c1', 'aaaaaaaa-1234-1234-1234-123456789abc', true);
		expect(artifactPanelStore.open).toBeNull();
		artifactPanelStore.turnEnded('c1');
		artifactPanelStore.noteResult('c1', ID, true);
		expect(artifactPanelStore.open?.id).toBe(ID);
	});

	it('a write to the open artifact refreshes it', () => {
		artifactPanelStore.show(ID, 'c1');
		const before = artifactPanelStore.revision;
		artifactPanelStore.noteResult('c1', ID, false);
		expect(artifactPanelStore.revision).toBe(before + 1);
	});
});

it('chat-ui declares artifact_check as a host tool it answers', () => {
	const names = (DEFAULT_MCP_CONFIG.capabilities.experimental as Record<string, { names: string[] }>)['redstart/hostTools'].names;
	expect(names).toContain('artifact_check');
});
