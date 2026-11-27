export const NEW_CHAT_PARAM = 'new_chat';
/** On a new-chat URL: start the chat in this project (projects-plan Phase 2). */
export const NEW_CHAT_PROJECT_PARAM = 'project';

/** Settings section slugs — used for routes and navigation. */
export const SETTINGS_SECTION_SLUGS = {
	GENERAL: 'general',
	DISPLAY: 'display',
	SAMPLING: 'sampling',
	PENALTIES: 'penalties',
	AGENTIC: 'agentic',
	DEVELOPER: 'developer',
	TOOLS: 'tools',
	IMPORT_EXPORT: 'import-export',
	SERVER: 'server',
	PEOPLE: 'people',
	SYSTEM_PROMPT: 'system-prompt',
	CONNECTORS: 'connectors',
	MEMORY: 'memory',
	ADVANCED: 'advanced'
} as const;

export const ROUTES = {
	/** Root — start of the app. */
	START: '#/',
	/** New chat — root with new chat query param. */
	NEW_CHAT: `?${NEW_CHAT_PARAM}=true#/`,
	/** Chat base — for dynamic chat URLs use RouterService. */
	CHAT: '#/chat',
	/** Settings base — for dynamic settings URLs use RouterService. */
	SETTINGS: '#/settings',
	/** Account profile — full page, not a dropdown. */
	PROFILE: '#/profile',
	/** Workflows — full page, reached from the sidebar next to New chat. */
	WORKFLOWS: '#/workflows',
	/** My tasks — given to me or my groups, across projects (tasks plan Phase 1). */
	ASSIGNMENTS: '#/tasks',
	/** Projects — the list; one project is RouterService.project(id). */
	PROJECTS: '#/projects',
	/** Artifacts — the gallery; one artifact is RouterService.artifact(id). */
	ARTIFACTS: '#/artifacts'
} as const;
