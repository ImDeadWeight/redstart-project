/**
 * The artifact panel beside the conversation (artifacts plan §10).
 *
 * While it is open, its artifact is the conversation's SELECTED artifact:
 * its id rides on each completion as `redstart_artifact` (chat-options),
 * and Nest's system prompt says the person is looking at it. Only the id is
 * sent; Nest resolves it against the caller and quotes its title as data.
 *
 * `revision` counts writes the agent made to the open artifact in this
 * session, so the viewer reloads while the agent works (it shows your live
 * draft while you hold one).
 */

interface OpenArtifact {
	id: string;
	/** The chat it was opened from; null on the artifact's own page. */
	conversationId: string | null;
}

class ArtifactPanelStore {
	open = $state<OpenArtifact | null>(null);
	/** Bumped when the open artifact changed; the viewer reloads on it. */
	revision = $state(0);
	/** Conversations whose current turn has already opened the panel by itself. */
	private autoOpened = new Set<string>();

	show(id: string, conversationId: string | null) {
		if (this.open?.id === id && this.open.conversationId === conversationId) {
			this.revision++;
			return;
		}
		this.open = { id, conversationId };
	}

	close() {
		this.open = null;
	}

	/** The artifact this conversation has open, for redstart_artifact. */
	selectedFor(conversationId: string | null | undefined): string | null {
		return this.open && conversationId && this.open.conversationId === conversationId ? this.open.id : null;
	}

	/**
	 * A tool result named an artifact. Opens the panel the first time an
	 * artifact is CREATED in a turn (§10); otherwise only refreshes it when it
	 * is the open one.
	 */
	noteResult(conversationId: string, id: string, created: boolean) {
		if (this.open?.id === id) {
			this.revision++;
			return;
		}
		if (created && !this.autoOpened.has(conversationId)) {
			this.autoOpened.add(conversationId);
			this.open = { id, conversationId };
		}
	}

	/** A turn ended: the next one may open the panel by itself again. */
	turnEnded(conversationId: string) {
		this.autoOpened.delete(conversationId);
		if (this.open?.conversationId === conversationId) this.revision++;
	}
}

export const artifactPanelStore = new ArtifactPanelStore();
