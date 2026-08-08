/**
 * Full chat settings page layout with sidebar, mobile header, and content area.
 * Manages local configuration state, section navigation, and context setup.
 * Accepts an optional `initialSection` prop to override the URL-based section resolution.
 */
export { default as SettingsChat } from './SettingsChat/SettingsChat.svelte';

/**
 * Desktop sidebar navigation for chat settings.
 * Displays a list of settings sections with icons and titles.
 * Supports both hash-link navigation (via `getHref`) and in-app section switching (via `onSectionChange`).
 */
export { default as SettingsChatDesktopSidebar } from './SettingsChatDesktopSidebar.svelte';

/**
 * Mobile header with a horizontally scrollable section picker for chat settings.
 * Shows chevron buttons for scroll navigation and highlights the active section.
 * Supports both hash-link navigation (via `getHref`) and in-app section switching (via `onSectionChange`).
 */
export { default as SettingsChatMobileHeader } from './SettingsChatMobileHeader.svelte';

/**
 * Badge indicating parameter source for sampling settings. Shows one of:
 * - **Custom**: User has explicitly set this value (orange badge)
 * - **Server Props**: Using default from `/props` endpoint (blue badge)
 * - **Default**: Using app default, server props unavailable (gray badge)
 * Updates in real-time as user types to show immediate feedback.
 */
export { default as SettingsChatParameterSourceIndicator } from './SettingsChat/SettingsChatParameterSourceIndicator.svelte';

/**
 * Section wrapper for settings panels. Displays a title heading with
 * child content in a structured layout.
 */
export { default as SettingsGroup } from './SettingsGroup.svelte';

/**
 * Footer with save/cancel buttons for settings panel. Positioned at bottom
 * of settings dialog. Save button commits form state to config store,
 * cancel button triggers reset and close.
 */
export { default as SettingsFooter } from './SettingsFooter.svelte';

/**
 * Settings Import/Export panel.
 * Provides UI for importing and exporting chat conversations.
 */
export { default as SettingsChatImportExportTab } from './SettingsChat/SettingsChatImportExportTab.svelte';

/**
 * Section wrapper for import/export sections. Displays a title, description,
 * icon button, and optional summary of recent actions.
 */
export { default as SettingsChatImportExportSection } from './SettingsChat/SettingsChatImportExportSection.svelte';

/**
 * Form fields renderer for individual settings. Generates appropriate input
 * components based on field type (text, number, select, checkbox, textarea).
 * Handles validation, help text display, and parameter source indicators.
 */
export { default as SettingsChatFields } from './SettingsChat/SettingsChatFields.svelte';

/**
 * Server settings tab — configure the local llama.cpp server URL and
 * scan the network for servers (Android only).
 */
export { default as SettingsChatServerTab } from './SettingsChat/SettingsChatServerTab.svelte';

/**
 * **SettingsChatToolsTab** - Tools configuration tab for chat settings
 *
 * Displays available tools grouped by source (built-in, MCP, custom) with
 * toggles to enable/disable individual tools and tool groups. Shows MCP
 * server favicons and permission management controls.
 */
export { default as SettingsChatToolsTab } from './SettingsChat/SettingsChatToolsTab.svelte';

/**
 * **SettingsChatAccountsTab** - Admin account management settings tab
 *
 * Lists accounts, creates new ones, and manages password/API-key resets.
 * Only reachable by logged-in admins — the section itself is filtered out
 * of the sidebar for non-admins in SettingsChat.svelte.
 */
export { default as SettingsChatAccountsTab } from './SettingsChat/SettingsChatAccountsTab.svelte';

/**
 * **SettingsChatSystemPromptTab** - Admin-owned system prompt blocks
 *
 * Edits the context / behavioral-guidelines / output-format blocks the
 * gateway composes into every request, with a live token-budget indicator,
 * the assembled preview, and the derived data-handling audit.
 *
 * Visible to everyone and read-only for non-admins: the policy block governs
 * how the assistant treats them, and the server gates writes regardless of
 * what this component renders.
 */
export { default as SettingsChatSystemPromptTab } from './SettingsChat/SettingsChatSystemPromptTab.svelte';

/**
 * **SettingsChatConnectorsTab** - Per-connector credentials (spec §8)
 *
 * Issues, lists, and revokes keys bound to a specific connector app, so the
 * server derives the calling surface from the credential rather than a header.
 * Self-service: acts on the current account only, for every role.
 */
export { default as SettingsChatConnectorsTab } from './SettingsChat/SettingsChatConnectorsTab.svelte';
