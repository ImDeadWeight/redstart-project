/**
 *
 * MCP (Model Context Protocol)
 *
 * Components for managing MCP server connections and displaying server status.
 * MCP enables agentic workflows by connecting to external tool servers.
 *
 * The MCP system integrates with:
 * - `mcpStore` for server CRUD operations and health checks
 * - `conversationsStore` for per-conversation server enable/disable
 *
 */

/**
 * **McpCapabilitiesBadges** - Server capabilities display
 *
 * Displays MCP server capabilities as colored badges.
 * Shows which features the server supports (tools, resources, prompts, etc.).
 *
 * **Features:**
 * - Tools badge (green) - server provides callable tools
 * - Resources badge (blue) - server provides data resources
 * - Prompts badge (purple) - server provides prompt templates
 * - Logging badge (orange) - server supports logging
 * - Completions badge (cyan) - server provides completions
 * - Tasks badge (pink) - server supports task management
 */
export { default as McpCapabilitiesBadges } from './McpCapabilitiesBadges.svelte';

/**
 * **McpConnectionLogs** - Connection log viewer
 *
 * Collapsible panel showing MCP server connection logs.
 * Displays timestamped log entries with level-based styling.
 *
 * **Features:**
 * - Collapsible log list with entry count
 * - Connection time display in milliseconds
 * - Log level icons and color coding
 * - Scrollable log container with max height
 * - Monospace font for log readability
 */
export { default as McpConnectionLogs } from './McpConnectionLogs.svelte';

/**
 * MCP protocol logo SVG component. Renders the official MCP icon
 * with customizable size via class and style props.
 */
export { default as McpLogo } from './McpLogo.svelte';

/**
 *
 * SERVER CARD
 *
 * Components for displaying individual MCP server status and controls.
 * McpServerCard is the main component, with sub-components for specific sections.
 *
 */

/**
 * **McpServerIdentity** - Server identity display (icon, name, version)
 *
 * Reusable headless component for displaying server name, favicon/icon, and version badge.
 * Accepts all data via props with no store dependencies for predictable rendering.
 *
 * **Features:**
 * - Server favicon/icon with fallback
 * - Truncated display name with max-width
 * - Optional version badge (v1.2.3)
 * - Optional external link to server website
 *
 * @example
 * ```svelte
 * <McpServerIdentity displayName={name} faviconUrl={iconUrl} serverInfo={info} />
 * ```
 */
export { default as McpServerIdentity } from './McpServerIdentity.svelte';

/**
 * **McpServerInfo** - Server instructions display
 *
 * Collapsible panel showing server-provided instructions.
 * Displays guidance text from the MCP server for users.
 */
export { default as McpServerInfo } from './McpServerInfo.svelte';

/**
 * **McpResourcesBrowser** - MCP resources tree browser
 *
 * Tree view component showing resources grouped by server.
 * Supports resource selection and quick attach actions.
 *
 * **Features:**
 * - Collapsible server sections
 * - Resource icons based on MIME type
 * - Resource selection highlighting
 * - Quick attach button per resource
 * - Refresh all resources action
 * - Loading states per server
 */
export { default as McpResourcesBrowser } from './McpResourcesBrowser/McpResourcesBrowser.svelte';

/**
 * **McpResourcePreview** - MCP resource content preview
 *
 * Preview panel showing resource content with metadata.
 * Supports text and binary content display.
 *
 * **Features:**
 * - Text content display with monospace formatting
 * - Image preview for image MIME types
 * - Copy to clipboard action
 * - Download content action
 * - Resource metadata display (MIME type, priority, server)
 * - Loading and error states
 */
export { default as McpResourcePreview } from './McpResourcePreview.svelte';

/**
 * **McpResourceTemplateForm** - MCP resource template variable form
 *
 * Form for filling in resource template variables with auto-completion
 * via the Completions API. Shows live URI preview as variables are filled.
 *
 * **Features:**
 * - Template variable input fields
 * - Completions API integration for variable auto-complete
 * - Live URI preview as variables are filled
 * - Read resolved resource action
 */
export { default as McpResourceTemplateForm } from './McpResourceTemplateForm.svelte';
