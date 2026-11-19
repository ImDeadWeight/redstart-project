import { CircleUser, FolderOpen } from '@lucide/svelte';
import type { Component } from 'svelte';

/**
 * Tabs on the account profile page.
 *
 * The profile surface is expected to keep growing — it already replaced a
 * dropdown, and account-level features land here rather than in Settings
 * (Settings configures the *app*; this page is about *you*). So the tab strip
 * is driven by this array: adding a tab is one entry here plus one branch in
 * ProfilePage.svelte, and nothing else needs to know.
 *
 * Deliberately not URL-routed. Settings earns its `/settings/[[section]]` route
 * from having ~a dozen sections worth deep-linking to; a two-or-three tab strip
 * does not, and adding a nested optional route here would mean restructuring
 * the profile route for no benefit yet. If tabs get numerous enough to want
 * bookmarking, promote this to a route param then.
 */

export const PROFILE_TAB_IDS = {
	ACCOUNT: 'account',
	FILES: 'files'
} as const;

export type ProfileTabId = (typeof PROFILE_TAB_IDS)[keyof typeof PROFILE_TAB_IDS];

export interface ProfileTab {
	id: ProfileTabId;
	label: string;
	icon: Component;
}

export const PROFILE_TABS: ProfileTab[] = [
	{ id: PROFILE_TAB_IDS.ACCOUNT, label: 'Account', icon: CircleUser },
	// Your own storage on the server. Scoped server-side by the authenticated
	// account, so there is nothing to gate by role here.
	{ id: PROFILE_TAB_IDS.FILES, label: 'Files', icon: FolderOpen }
];
