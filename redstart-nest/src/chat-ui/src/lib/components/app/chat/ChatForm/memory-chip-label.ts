import type { MemorySuggestion } from '$lib/services/memory.service';

/**
 * The words a suggestion chip shows beyond its text (agent-runtime 8.6):
 * what a merge folds in. Pure, so the unit test pins it without a DOM.
 * An older suggestion has ids but no texts; it then says how many.
 */
export function suggestionLabel(s: Pick<MemorySuggestion, 'replaces' | 'replacedTexts'>): { merge: string | null } {
	const n = s.replaces?.length ?? 0;
	if (n === 0) return { merge: null };
	const texts = (s.replacedTexts ?? []).filter((t) => typeof t === 'string' && t.trim());
	if (texts.length === n) return { merge: `Replaces: ${texts.map((t) => `“${t}”`).join(', ')}` };
	return { merge: `Replaces ${n} other memor${n === 1 ? 'y' : 'ies'}` };
}
