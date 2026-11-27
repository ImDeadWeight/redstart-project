import { ROUTES, NEW_CHAT_PARAM, NEW_CHAT_PROJECT_PARAM } from '$lib/constants/routes';

export class RouterService {
	static chat(id: string): string {
		return `${ROUTES.CHAT}/${id}`;
	}

	static settings(section: string): string {
		return `${ROUTES.SETTINGS}/${section}`;
	}

	static project(id: string): string {
		return `${ROUTES.PROJECTS}/${encodeURIComponent(id)}`;
	}

	/** One program's page: a group of projects (tasks plan Phase 4). */
	static program(id: string): string {
		return `#/programs/${encodeURIComponent(id)}`;
	}

	/** One artifact's own page (artifacts plan §10). */
	static artifact(id: string): string {
		return `${ROUTES.ARTIFACTS}/${encodeURIComponent(id)}`;
	}

	/** A new chat that starts in this project. */
	static newChatInProject(id: string): string {
		return `?${NEW_CHAT_PARAM}=true&${NEW_CHAT_PROJECT_PARAM}=${encodeURIComponent(id)}#/`;
	}
}
