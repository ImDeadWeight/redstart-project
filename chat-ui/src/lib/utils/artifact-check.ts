/**
 * chat-ui's answer to artifact_check (artifacts plan D11, §9).
 *
 * Nest defines the tool; this browser answers it, like ask_user. It asks
 * Nest for a view URL with `report: true`, so the content listener injects
 * the reporter (redstart-nest/daemon/artifact-reporter.mjs) first in every
 * HTML page, and loads that URL in a hidden frame with the viewer's own
 * sandbox. The frame is cross-origin: nothing here can look inside it or
 * capture it, so the check is what the reporter posts back, and there is no
 * screenshot.
 *
 * Everything the frame posts is UNTRUSTED (a model wrote the page): a message
 * counts only when its source is that frame's window, every field is checked
 * and capped, and the result is plain text for the model.
 */

import { ArtifactService, VIEWPORTS, type Viewport } from '$lib/services/artifact.service';

export const ARTIFACT_CHECK_TOOL = 'artifact_check';

/** How long the page has to fire load, and how long to wait after it. */
const LOAD_TIMEOUT_MS = 12_000;
const SETTLE_MS = 800;
const SUMMARY_TIMEOUT_MS = 3_000;
const MAX_EVENTS = 40;

export interface ArtifactCheckEvent {
	kind: 'error' | 'rejection' | 'console' | 'resource' | 'fetch';
	text: string;
}

export interface ArtifactCheckSummary {
	title: string;
	text: string;
	elements: number;
	canvases: number;
	images: number;
	links: number;
	buttons: number;
	forms: number;
	height: number;
	width: number;
}

export interface ArtifactCheckReport {
	loaded: boolean;
	events: ArtifactCheckEvent[];
	summary: ArtifactCheckSummary | null;
}

const KINDS = new Set(['error', 'rejection', 'console', 'resource', 'fetch']);
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);

/** One frame message as data, or null when it is not the reporter's. Exported for tests. */
export function readReporterMessage(data: unknown): { type: 'event'; event: ArtifactCheckEvent } | { type: 'ready' } | { type: 'summary'; summary: ArtifactCheckSummary } | null {
	if (!data || typeof data !== 'object') return null;
	const d = data as Record<string, unknown>;
	if (d.source !== 'redstart-artifact') return null;
	if (d.type === 'ready') return { type: 'ready' };
	if (d.type === 'event' && typeof d.kind === 'string' && KINDS.has(d.kind)) {
		return { type: 'event', event: { kind: d.kind as ArtifactCheckEvent['kind'], text: str(d.text, 500) } };
	}
	if (d.type === 'summary') {
		return {
			type: 'summary',
			summary: {
				title: str(d.title, 200),
				text: str(d.text, 2000),
				elements: num(d.elements),
				canvases: num(d.canvases),
				images: num(d.images),
				links: num(d.links),
				buttons: num(d.buttons),
				forms: num(d.forms),
				height: num(d.height),
				width: num(d.width)
			}
		};
	}
	return null;
}

const LABEL: Record<ArtifactCheckEvent['kind'], string> = {
	error: 'Script error',
	rejection: 'Unhandled promise rejection',
	console: 'Console',
	resource: 'Failed to load',
	fetch: 'Request'
};

/** The report as the model reads it, in the shape of Yellowscript's page check. Exported for tests. */
export function formatArtifactCheck(
	report: ArtifactCheckReport,
	info: { title: string; revision: number | 'draft'; viewport: Viewport }
): string {
	const lines: string[] = [];
	const rev = info.revision === 'draft' ? 'your unsaved draft' : `revision ${info.revision}`;
	lines.push(`Checked "${info.title}" (${rev}) at ${info.viewport} width (${VIEWPORTS[info.viewport]} px).`);
	if (!report.loaded) lines.push(`The page did not finish loading within ${LOAD_TIMEOUT_MS / 1000} s.`);
	const problems = report.events.filter((e) => e.kind !== 'console' || /^error:/.test(e.text));
	const warnings = report.events.filter((e) => e.kind === 'console' && !/^error:/.test(e.text));
	if (problems.length) {
		lines.push(`Problems (${problems.length}):`);
		for (const e of problems) lines.push(`- ${LABEL[e.kind]}: ${e.text}`);
	} else {
		lines.push('No script errors and no failed loads.');
	}
	if (warnings.length) {
		lines.push(`Console warnings (${warnings.length}):`);
		for (const e of warnings.slice(0, 10)) lines.push(`- ${e.text}`);
	}
	const s = report.summary;
	if (s) {
		lines.push(`Page title: ${s.title ? `"${s.title}"` : '(none)'}`);
		lines.push(
			`Elements: ${s.elements}; images ${s.images}, canvases ${s.canvases}, links ${s.links}, buttons ${s.buttons}, forms ${s.forms}. Page size ${s.width}×${s.height} px.`
		);
		if (s.width > VIEWPORTS[info.viewport] + 4) lines.push(`The page is wider than the screen (${s.width} px): it scrolls sideways.`);
		lines.push(s.text ? `Visible text:\n${s.text}` : 'The page shows no text.');
	} else if (report.loaded) {
		lines.push('The page loaded but sent no summary (a script may have stopped it).');
	}
	lines.push('No screenshot: this app cannot capture the page.');
	return lines.join('\n');
}

/**
 * Load the artifact in a hidden sandboxed frame and report what happened.
 * Never throws: a failure is a sentence the model can act on.
 */
export async function runArtifactCheck(args: unknown, signal?: AbortSignal): Promise<{ text: string; isError: boolean }> {
	const a = (args && typeof args === 'object' ? args : {}) as { id?: unknown; viewport?: unknown };
	const id = typeof a.id === 'string' ? a.id.trim() : '';
	if (!id) return { text: 'artifact_check needs "id": the artifact to check.', isError: true };
	const viewport: Viewport = a.viewport === 'tablet' || a.viewport === 'phone' ? a.viewport : 'desktop';

	let view: { url: string; revision: number | 'draft' };
	let title = id;
	try {
		const detail = await ArtifactService.get(id);
		title = detail.title;
		view = await ArtifactService.view(id, { report: true });
	} catch (e) {
		return { text: `Could not open the artifact: ${e instanceof Error ? e.message : String(e)}`, isError: true };
	}

	const frame = document.createElement('iframe');
	frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals');
	frame.setAttribute('referrerpolicy', 'no-referrer');
	frame.setAttribute('aria-hidden', 'true');
	frame.tabIndex = -1;
	Object.assign(frame.style, {
		position: 'fixed',
		left: '-10000px',
		top: '0',
		width: `${VIEWPORTS[viewport]}px`,
		height: '900px',
		border: '0',
		visibility: 'hidden',
		pointerEvents: 'none'
	});

	const report: ArtifactCheckReport = { loaded: false, events: [], summary: null };
	let onReady: () => void = () => {};
	let onSummary: () => void = () => {};
	const listener = (e: MessageEvent) => {
		if (e.source !== frame.contentWindow) return;
		const m = readReporterMessage(e.data);
		if (!m) return;
		if (m.type === 'event' && report.events.length < MAX_EVENTS) report.events.push(m.event);
		else if (m.type === 'ready') { report.loaded = true; onReady(); }
		else if (m.type === 'summary') { report.summary = m.summary; onSummary(); }
	};
	const wait = (ms: number, register: (resolve: () => void) => void) =>
		new Promise<void>((resolve) => {
			const t = setTimeout(resolve, ms);
			register(() => { clearTimeout(t); resolve(); });
			signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
		});

	window.addEventListener('message', listener);
	try {
		document.body.appendChild(frame);
		const ready = wait(LOAD_TIMEOUT_MS, (r) => (onReady = r));
		frame.src = view.url;
		await ready;
		if (!signal?.aborted && report.loaded) {
			const summary = wait(SETTLE_MS + SUMMARY_TIMEOUT_MS, (r) => (onSummary = r));
			frame.contentWindow?.postMessage({ source: 'redstart-host', type: 'summary-request', waitMs: SETTLE_MS }, '*');
			await summary;
		}
	} finally {
		window.removeEventListener('message', listener);
		frame.remove();
	}
	if (signal?.aborted) return { text: 'The check was stopped.', isError: true };
	return { text: formatArtifactCheck(report, { title, revision: view.revision, viewport }), isError: false };
}
