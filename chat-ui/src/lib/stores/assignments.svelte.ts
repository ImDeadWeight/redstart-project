import { AssignmentService, type AssignmentCounts } from '$lib/services/assignment.service';

/**
 * The sidebar's count of the signed-in account's open tasks (tasks plan
 * Phase 1). Lists themselves are loaded by the pages that show them; this
 * holds only the badge, and a `version` that goes up after every change made
 * in this tab, so an open list knows to reload.
 *
 * Refreshed when first shown, when the window regains focus, after a change
 * here, and every two minutes, so a task someone else gives you appears
 * without a reload. An older Nest has no /assignments: the badge then stays
 * hidden, with no error.
 */
const POLL_MS = 2 * 60 * 1000;

class AssignmentsStore {
	counts = $state<AssignmentCounts | null>(null);
	/** Bumped after each change made here; lists reload when it moves. */
	version = $state(0);

	private started = false;
	private inFlight: Promise<void> | null = null;

	/** Begin keeping the count fresh. Idempotent. */
	start(): void {
		if (this.started || typeof window === 'undefined') return;
		this.started = true;
		void this.refresh();
		window.addEventListener('focus', () => void this.refresh());
		setInterval(() => {
			if (document.visibilityState === 'visible') void this.refresh();
		}, POLL_MS);
	}

	refresh(): Promise<void> {
		if (this.inFlight) return this.inFlight;
		this.inFlight = AssignmentService.count()
			.then((c) => {
				this.counts = c;
			})
			.catch(() => {
				this.counts = null;
			})
			.finally(() => {
				this.inFlight = null;
			});
		return this.inFlight;
	}

	/** Call after any write: the badge refreshes and open lists reload. */
	changed(): void {
		this.version++;
		void this.refresh();
	}
}

export const assignmentsStore = new AssignmentsStore();
