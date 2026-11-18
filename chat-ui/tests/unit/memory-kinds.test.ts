import { describe, expect, it } from 'vitest';
import { parseRemember, stateAge } from '$lib/services/memory.service';
import { suggestionLabel } from '$lib/components/app/chat/ChatForm/memory-chip-label';

// agent-runtime 8.6: memory kinds in chat-ui. /remember's prefixes, the state
// date and its stale marker, and what a merge chip says it replaces.

describe('/remember with a kind', () => {
	it('plain text is a fact, as before', () => {
		expect(parseRemember('  Uses Postgres 16 ')).toEqual({ ok: true, text: 'Uses Postgres 16', kind: 'fact' });
	});

	it('guidance needs "because", and keeps the why apart', () => {
		expect(parseRemember('guidance: show the command first because it ran the wrong suite twice')).toEqual({
			ok: true,
			text: 'show the command first',
			kind: 'guidance',
			why: 'it ran the wrong suite twice'
		});
		expect(parseRemember('Guidance:Use metric BECAUSE I live in Oslo')).toMatchObject({ ok: true, kind: 'guidance', text: 'Use metric', why: 'I live in Oslo' });
		const missing = parseRemember('guidance: always use metric');
		expect(missing.ok).toBe(false);
		// Not saved as a fact instead: guidance is followed, so it is refused.
		expect(missing).toMatchObject({ error: expect.stringMatching(/because/) });
		expect(parseRemember('guidance: because I said so').ok).toBe(false);
	});

	it('state and an explicit fact prefix; empty is refused', () => {
		expect(parseRemember('state: export step 2 is done')).toEqual({ ok: true, text: 'export step 2 is done', kind: 'state' });
		expect(parseRemember('fact: lives in Denver')).toEqual({ ok: true, text: 'lives in Denver', kind: 'fact' });
		expect(parseRemember('state:   ').ok).toBe(false);
		expect(parseRemember('   ').ok).toBe(false);
	});

	it('a colon elsewhere is just text', () => {
		expect(parseRemember('Meeting rule: no laptops')).toEqual({ ok: true, text: 'Meeting rule: no laptops', kind: 'fact' });
	});
});

describe('a state memory\'s date', () => {
	const now = Date.parse('2026-11-13T12:00:00Z');
	it('is its asOf, marked once past 60 days', () => {
		expect(stateAge({ kind: 'state', asOf: '2026-11-10', updatedAt: 0 }, now)).toEqual({ date: '2026-11-10', stale: false });
		expect(stateAge({ kind: 'state', asOf: '2026-08-01', updatedAt: 0 }, now)).toEqual({ date: '2026-08-01', stale: true });
	});
	it('falls back to when it was written, and is null for other kinds', () => {
		expect(stateAge({ kind: 'state', updatedAt: Date.parse('2026-11-01T09:00:00Z') }, now)?.date).toBe('2026-11-01');
		expect(stateAge({ kind: 'fact', asOf: '2026-01-01', updatedAt: 0 }, now)).toBeNull();
		expect(stateAge({ updatedAt: 0 }, now)).toBeNull();
	});
});

describe('a merge chip', () => {
	it('lists what it replaces, by text', () => {
		expect(suggestionLabel({ replaces: ['a', 'b'], replacedTexts: ['Uses tabs', 'Indents YAML'] }).merge).toBe(
			'Replaces: “Uses tabs”, “Indents YAML”'
		);
	});
	it('counts them when the texts are missing (an older suggestion), and says nothing for no merge', () => {
		expect(suggestionLabel({ replaces: ['a'] }).merge).toBe('Replaces 1 other memory');
		expect(suggestionLabel({ replaces: ['a', 'b'], replacedTexts: ['x'] }).merge).toBe('Replaces 2 other memories');
		expect(suggestionLabel({}).merge).toBeNull();
	});
});
