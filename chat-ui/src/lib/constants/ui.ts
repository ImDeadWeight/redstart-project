import {
	Settings,
	Search,
	SquarePen,
	CircleUser,
	Workflow,
	FolderKanban,
	AppWindow,
	ListTodo
} from '@lucide/svelte';
import type { Component } from 'svelte';
import { ROUTES } from './routes';

export const FORK_TREE_DEPTH_PADDING = 8;
export const SYSTEM_MESSAGE_PLACEHOLDER = 'System message';

export const ICON_STRIP_TRANSITION_DURATION = 150;
export const ICON_STRIP_TRANSITION_DELAY_MULTIPLIER = 50;

export interface DesktopIconStripItem {
	icon: Component;
	tooltip: string;
	route?: string;
	activeRouteId?: string;
	activeRoutePrefix?: string;
	keys?: string[];
	/** Hidden when nobody is signed in (there is no account to open). */
	requiresAuth?: boolean;
	/** A thin line above it, setting it apart from the items before. */
	separatedAbove?: boolean;
	/** Shows a count beside it: 'myTasks' is the open-task badge (workItemsStore). */
	badge?: 'myTasks';
}

/**
 * The sidebar actions, in display order.
 *
 * Rendered by BOTH the expanded sidebar (SidebarNavigationActions) and the
 * collapsed icon rail (DesktopIconStrip), which is the point: one array means
 * the two surfaces cannot drift in content or order. Profile used to be a
 * bespoke block in the sidebar only — so it was missing from the rail entirely,
 * and it was labelled with the username while every neighbour was labelled with
 * what it does.
 */
export const SIDEBAR_ACTIONS_ITEMS: DesktopIconStripItem[] = [
	{
		icon: CircleUser,
		tooltip: 'Profile',
		route: ROUTES.PROFILE,
		activeRoutePrefix: '/profile',
		requiresAuth: true
	},
	{ icon: SquarePen, tooltip: 'New chat', route: ROUTES.NEW_CHAT, keys: ['shift', 'cmd', 'o'] },
	// Beside New chat rather than inside Settings: a workflow is something you
	// run, not something you configure once.
	{
		icon: Workflow,
		tooltip: 'Workflows',
		route: ROUTES.WORKFLOWS,
		activeRoutePrefix: '/workflows'
	},
	// My tasks (tasks plan Phase 1): what has been given to me, with a count of
	// what is still open, red when any of it is overdue.
	{
		icon: ListTodo,
		tooltip: 'My tasks',
		route: ROUTES.TASKS,
		activeRoutePrefix: '/tasks',
		badge: 'myTasks'
	},
	// Projects hold chats (they are also listed in the sidebar with their chats
	// nested); this opens the list and New project.
	{
		icon: FolderKanban,
		tooltip: 'Projects',
		route: ROUTES.PROJECTS,
		activeRoutePrefix: '/projects'
	},
	// Artifacts (artifacts plan §10): pages, prototypes and mockups, the
	// person's own and shared with them.
	{
		icon: AppWindow,
		tooltip: 'Artifacts',
		route: ROUTES.ARTIFACTS,
		activeRoutePrefix: '/artifacts'
	},
	{
		icon: Settings,
		tooltip: 'Settings',
		route: ROUTES.SETTINGS,
		activeRoutePrefix: '/settings'
	},
	// Last and set apart: it searches the conversation list right below it
	// (Projects, Recent conversations), so it sits next to that list rather
	// than among the pages.
	{ icon: Search, tooltip: 'Search Conversations', keys: ['cmd', 'k'], separatedAbove: true }
];
