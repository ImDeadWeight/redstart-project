/**
 * Stateless MCP server icon selection, per the MCP spec's icon security rules.
 * Extracted verbatim from mcpStore (mcp.svelte.ts); pure, no store state.
 */

import { extractRootDomain } from '$lib/utils';
import { EXPECTED_THEMED_ICON_PAIR_COUNT, MCP_ALLOWED_ICON_MIME_TYPES } from '$lib/constants';
import { ColorMode, UrlProtocol } from '$lib/enums';
import type { MCPResourceIcon } from '$lib/types';

/**
 * Validates that an icon URI uses a safe scheme (https: or data:).
 */
export function isValidIconUri(src: string): boolean {
	try {
		if (src.startsWith(UrlProtocol.DATA)) return true;

		const url = new URL(src);

		return url.protocol === UrlProtocol.HTTPS;
	} catch {
		return false;
	}
}

/**
 * Selects the best icon URL from an MCP icons array.
 * Follows security guidelines from the MCP specification:
 * - Only allows https: and data: URIs
 * - Filters to supported MIME types
 *
 * Selection priority:
 * 1. Icon matching the current color scheme (dark/light)
 * 2. Universal icon (no theme specified); if exactly 2, assumes [0]=light, [1]=dark
 * 3. First valid icon as last resort
 */
export function getMcpIconUrl(icons: MCPResourceIcon[] | undefined, isDark = false): string | null {
	if (!icons?.length) return null;

	const validIcons = icons.filter((icon) => {
		if (!icon.src || !isValidIconUri(icon.src)) return false;
		if (icon.mimeType && !MCP_ALLOWED_ICON_MIME_TYPES.has(icon.mimeType)) return false;
		return true;
	});

	if (validIcons.length === 0) return null;

	const preferredTheme = isDark ? ColorMode.DARK : ColorMode.LIGHT;

	// 1. Prefer icon explicitly matching the current color scheme
	const themedIcon = validIcons.find((icon) => icon.theme === preferredTheme);
	if (themedIcon) return themedIcon.src;

	// 2. Handle universal icons (no theme specified)
	const universalIcons = validIcons.filter((icon) => !icon.theme);

	if (universalIcons.length === EXPECTED_THEMED_ICON_PAIR_COUNT) {
		// Heuristic: two theme-less icons → assume [0] = light, [1] = dark
		return universalIcons[isDark ? 1 : 0].src;
	}

	if (universalIcons.length > 0) {
		return universalIcons[0].src;
	}

	// 3. Last resort: use opposite-theme icon
	return validIcons[0].src;
}

/**
 * Construct a fallback favicon URL from the MCP server URL.
 * e.g. https://mcp.exa.ai/mcp -> https://exa.ai/favicon.ico
 */
export function getServerFaviconFallback(serverUrl: string): string | null {
	try {
		const url = new URL(serverUrl);
		const rootDomain = extractRootDomain(url);
		if (!rootDomain) return null;

		const origin = `${url.protocol}//${rootDomain}`;
		const candidates = ['favicon.ico', 'favicon.png'];

		for (const path of candidates) {
			const faviconUrl = `${origin}/${path}`;
			if (isValidIconUri(faviconUrl)) {
				return faviconUrl;
			}
		}
	} catch {
		// Invalid URL, return null
	}

	return null;
}
