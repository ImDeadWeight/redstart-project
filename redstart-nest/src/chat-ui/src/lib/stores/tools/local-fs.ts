import type { OpenAIToolDefinition } from '$lib/types';

/**
 * Normalising what Redstart Twig's `fs:get-tools` bridge returns.
 *
 * This is a **compatibility seam between two independently-shipped apps.** The
 * chat-ui is built into a bundle that Twig then serves, but the two are versioned
 * and released separately — a Twig installer carries whichever bundle existed
 * when it was built, and a rebuilt bundle can land in an older shell. So both
 * reply shapes have to be readable, indefinitely:
 *
 *   older Twig:  OpenAIToolDefinition[]              (no class information)
 *   current:     { tools, classes: { name: class } }
 *
 * `classes` exists because Twig's tools reach the model as plain OpenAI function
 * definitions and never travel over MCP — there is nowhere in that wire format
 * for the `_meta` annotation Redstart Nest uses. Without it the chat-ui cannot
 * tell that `fs_delete_file` is destructive, and would let a user grant it
 * "always allow" — on the one delete in the system that runs on their own
 * machine, where no server-side policy can reach it.
 *
 * An older Twig therefore reports no classes, and its tools are treated like any
 * other unclassified tool. That is the honest degradation: the shell that cannot
 * describe its own tools does not get the protection that depends on the
 * description.
 */

export interface LocalFsToolReply {
	tools: OpenAIToolDefinition[];
	classes: Record<string, string>;
}

/** Accepts either reply shape (or junk) and always returns a usable pair. */
export function normalizeLocalFsReply(reply: unknown): LocalFsToolReply {
	if (Array.isArray(reply)) {
		return { tools: reply as OpenAIToolDefinition[], classes: {} };
	}
	if (reply && typeof reply === 'object') {
		const { tools, classes } = reply as Partial<LocalFsToolReply>;
		return {
			tools: Array.isArray(tools) ? tools : [],
			classes: classes && typeof classes === 'object' ? classes : {}
		};
	}
	return { tools: [], classes: {} };
}
