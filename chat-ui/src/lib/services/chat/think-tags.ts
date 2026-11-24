/**
 * think-tags - thinking-tag markup that reached the ANSWER channel.
 *
 * The router lives in the shared core (shared/agent-core/think-tags.mjs), so
 * chat-ui's reader and the daemon's (readChatStream, where a plain Send
 * runs) route a stray `</think>` the same way. See there for what it does
 * and why.
 */

export { ThinkTagRouter, routeThinkTags, type RoutedSegment } from '$lib/agent-core';
