import { describe, expect, it } from 'vitest';

import {
	extractBase64Attachments,
	buildAttachmentName
} from '$lib/stores/agentic/agentic-attachments';
import { buildFinalTimings } from '$lib/stores/agentic/agentic-timings';
import { AttachmentType } from '$lib/enums';

/**
 * agentic-pure - the stateless halves of the agentic loop
 *
 * Seams 7b and 7c of docs/notes/god-files-refactor-plan.md. §9 of that plan
 * lists these two modules by name as extractions that must not stay untested
 * once they are their own files: they are pure functions, so there is no excuse.
 *
 * Neither had a single test while it lived inside `executeAgenticLoop` — the
 * behaviour below was only ever exercised by running a real multi-turn flow
 * against a real model.
 */

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const PDF = 'data:application/pdf;base64,JVBERi0xLjQK';

describe('extractBase64Attachments', () => {
	it('leaves a result with no data URI untouched', () => {
		const result = extractBase64Attachments('plain tool output');

		expect(result.cleanedResult).toBe('plain tool output');
		expect(result.attachments).toEqual([]);
	});

	it('returns an empty result unchanged without allocating attachments', () => {
		expect(extractBase64Attachments('   ')).toEqual({ cleanedResult: '   ', attachments: [] });
	});

	it('lifts an image data URI out and leaves a placeholder line', () => {
		const { cleanedResult, attachments } = extractBase64Attachments(`before\n${PNG}\nafter`);

		expect(attachments).toHaveLength(1);
		expect(attachments[0]).toMatchObject({ type: AttachmentType.IMAGE, base64Url: PNG });

		const lines = cleanedResult.split('\n');
		expect(lines[0]).toBe('before');
		expect(lines[2]).toBe('after');
		expect(lines[1]).toBe(`[Attachment saved: ${attachments[0].name}]`);
		// the payload must not survive in the transcript, only in the attachment
		expect(cleanedResult).not.toContain('iVBORw0KGgo=');
	});

	// Only images are lifted. A non-image data URI stays inline rather than
	// becoming an attachment the UI has no way to render.
	it('leaves a non-image data URI in place', () => {
		const { cleanedResult, attachments } = extractBase64Attachments(PDF);

		expect(attachments).toEqual([]);
		expect(cleanedResult).toBe(PDF);
	});

	it('numbers multiple images so their names differ', () => {
		const { attachments } = extractBase64Attachments(`${PNG}\n${PNG}`);

		expect(attachments).toHaveLength(2);
		expect(attachments[0].name).not.toBe(attachments[1].name);
	});
});

describe('buildAttachmentName', () => {
	it('uses the extension for a known mime type', () => {
		expect(buildAttachmentName('image/png', 1)).toMatch(/\.png$/);
	});

	it('falls back to a default extension for an unknown mime type', () => {
		expect(buildAttachmentName('image/unheard-of', 1)).toMatch(/\.[a-z0-9]+$/);
	});

	it('includes the index so two names in one result cannot collide', () => {
		expect(buildAttachmentName('image/png', 1)).not.toBe(buildAttachmentName('image/png', 2));
	});
});

describe('buildFinalTimings', () => {
	const agentic = {
		turns: 2,
		toolCallsCount: 3,
		toolsMs: 120,
		llm: { predicted_n: 10, predicted_ms: 100, prompt_n: 20, prompt_ms: 200 }
	};

	// The zero-tool case is the one that matters: a flow that called no tool must
	// report exactly what a non-agentic completion would, with no `agentic` key.
	it('returns the captured timings untouched when no tool was called', () => {
		const captured = { predicted_n: 5, predicted_ms: 50 };

		expect(buildFinalTimings(captured, { ...agentic, toolCallsCount: 0 })).toBe(captured);
	});

	it('returns undefined when nothing was captured and no tool was called', () => {
		expect(buildFinalTimings(undefined, { ...agentic, toolCallsCount: 0 })).toBeUndefined();
	});

	it('folds the agentic counters into the captured timings', () => {
		const result = buildFinalTimings(
			{ predicted_n: 5, predicted_ms: 50, prompt_n: 7, prompt_ms: 70, cache_n: 1 },
			agentic
		);

		expect(result).toEqual({
			predicted_n: 5,
			predicted_ms: 50,
			prompt_n: 7,
			prompt_ms: 70,
			cache_n: 1,
			agentic
		});
	});

	// A tool ran but the completion reported nothing — the agentic half must
	// still surface, rather than the whole object collapsing to undefined.
	it('still reports the agentic half when nothing was captured', () => {
		expect(buildFinalTimings(undefined, agentic)).toEqual({
			predicted_n: undefined,
			predicted_ms: undefined,
			prompt_n: undefined,
			prompt_ms: undefined,
			cache_n: undefined,
			agentic
		});
	});
});
