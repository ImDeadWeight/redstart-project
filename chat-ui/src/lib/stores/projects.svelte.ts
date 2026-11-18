import { ProjectService, type Project, type ProjectLimits } from '$lib/services/project.service';
import { conversationsStore } from '$lib/stores/conversations.svelte';

/**
 * The signed-in account's projects (projects-plan Phase 2), for the sidebar,
 * the project pages and `/project`. Loaded on first use and refreshed after
 * every write here. The server is the authority on what exists and who may
 * see it; this is a cache of that answer.
 *
 * Which chats are in a project is not stored here: it is each conversation's
 * `projectId`, held by the conversations store, so a move shows up wherever
 * that list is read.
 */
class ProjectsStore {
	projects = $state<Project[]>([]);
	limits = $state<ProjectLimits | null>(null);
	loaded = $state(false);
	/** Set when the list could not be fetched (an older Nest has no /projects). */
	error = $state<string | null>(null);

	private inFlight: Promise<void> | null = null;

	/** Idempotent, and safe to call from several components at once. */
	ensureLoaded(): Promise<void> {
		if (this.loaded) return Promise.resolve();
		return this.refresh();
	}

	refresh(): Promise<void> {
		if (this.inFlight) return this.inFlight;
		this.inFlight = ProjectService.list()
			.then((res) => {
				this.projects = res.projects ?? [];
				this.limits = res.limits ?? null;
				this.error = null;
			})
			.catch((e) => {
				this.projects = [];
				this.error = e instanceof Error ? e.message : 'Could not load projects';
			})
			.finally(() => {
				this.loaded = true;
				this.inFlight = null;
			});
		return this.inFlight;
	}

	byId(id: string | null | undefined): Project | null {
		if (!id) return null;
		return this.projects.find((p) => p.id === id) ?? null;
	}

	async create(name: string, instructions = ''): Promise<Project> {
		const project = await ProjectService.create({ name, instructions });
		await this.refresh();
		return project;
	}

	async update(id: string, draft: { name?: string; instructions?: string }): Promise<Project> {
		const project = await ProjectService.update(id, draft);
		this.projects = this.projects.map((p) => (p.id === id ? project : p));
		return project;
	}

	/**
	 * Delete a project. Its chats move out (the server clears their
	 * projectId), so the conversation list is reloaded to show them back in
	 * the ordinary list.
	 */
	async remove(id: string): Promise<{ chatsMovedOut: number; memoriesDeleted: number }> {
		const result = await ProjectService.remove(id);
		this.projects = this.projects.filter((p) => p.id !== id);
		await conversationsStore.loadConversations();
		if (conversationsStore.pendingProjectId === id) conversationsStore.setPendingProject(null);
		return result;
	}
}

export const projectsStore = new ProjectsStore();
