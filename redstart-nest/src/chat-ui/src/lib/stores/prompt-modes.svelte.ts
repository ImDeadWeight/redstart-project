import { PromptService } from '$lib/services/prompt.service';
import type { PromptMode } from '$lib/types';

/**
 * Task modes offered by this deployment (system-prompt spec §9).
 *
 * Fetched once per session and cached. The list is server-owned: modes are
 * code-defined presets, so a client that guessed at the set would drift from
 * whatever the deployment actually resolves. If the fetch fails the list stays
 * empty and the picker hides itself — a mode the server does not know is inert
 * anyway, so there is nothing useful to fall back to.
 */
class PromptModesStore {
	modes = $state<PromptMode[]>([]);
	loaded = $state(false);

	private inFlight: Promise<void> | null = null;

	/** Idempotent, and safe to call from several components at once. */
	async ensureLoaded(): Promise<void> {
		if (this.loaded || this.inFlight) return this.inFlight ?? undefined;

		this.inFlight = PromptService.getModes()
			.then((modes) => {
				this.modes = modes;
			})
			.catch(() => {
				// An older Nest has no /prompt-modes route. Not an error worth
				// surfacing: the picker simply does not appear.
				this.modes = [];
			})
			.finally(() => {
				this.loaded = true;
				this.inFlight = null;
			});

		return this.inFlight;
	}
}

export const promptModesStore = new PromptModesStore();
