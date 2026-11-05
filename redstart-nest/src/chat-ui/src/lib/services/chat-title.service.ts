/**
 * chat-title - the model names a conversation after it has answered
 *
 * A new conversation is titled with the text of its first prompt the moment it
 * is sent, so the sidebar has something to show. That is usually a long
 * sentence. Once the first answer is in, the model is asked, in a separate
 * short request, to name the conversation in a few words. It is asked once
 * more after the third prompt, when it is clearer where the conversation went,
 * and then never again.
 *
 * A name the user typed is never replaced; see `nameSetByUser`, and
 * `looksHandNamed` for chats renamed before that flag existed. Failure of any
 * kind (server busy, model returns nothing useful) leaves the current title
 * alone, because a missing title is not worth an error dialog.
 *
 * This file only decides and asks. Saving the title is the caller's job
 * (chat-send), so this service stays free of the conversation stores.
 */

import { ChatService } from '$lib/services/chat.service';
import { config } from '$lib/stores/settings.svelte';
import { MessageRole } from '$lib/enums';
import { generateConversationTitle } from '$lib/utils/text';
import type { DatabaseConversation, DatabaseMessage } from '$lib/types/database';

/** After this many of the user's prompts the conversation is named again. */
export const RENAME_AFTER = 3;
/** Longest title kept from the model. */
const TITLE_LENGTH = 60;
/** Characters of each message shown to the model when it names a conversation. */
const EXCERPT_LENGTH = 600;
/** A title is a handful of words; this is generous for that and caps a runaway reply. */
const TITLE_MAX_TOKENS = 32;

const TITLE_SYSTEM_PROMPT =
	'You name chats. Reply with only a short title (2 to 6 words) for what this conversation is about, in Title Case. No quotes, no punctuation at the end, nothing else.';

/** A model's reply, cleaned up into one line: no thinking, quotes, Markdown or "Title:". */
export function cleanTitle(text: string): string {
	const line = text
		.replace(/<think>[\s\S]*?(<\/think>|$)/g, '')
		.split('\n')
		.map((l) => l.trim())
		.find(Boolean);
	return (line ?? '')
		.replace(/^(chat\s+|conversation\s+)?title\s*:\s*/i, '')
		.replace(/[*_#`]/g, '')
		.replace(/^["'“”‘’]+|["'“”‘’.]+$/g, '')
		.trim()
		.slice(0, TITLE_LENGTH)
		.trim();
}

/**
 * Whether the model should name this conversation now. `prompts` is how many
 * user messages are on the branch being shown.
 */
export function shouldName(conv: Pick<DatabaseConversation, 'autoTitledAt' | 'nameSetByUser'>, prompts: number): boolean {
	if (config().autoTitleConversations === false) return false;
	if (conv.nameSetByUser) return false;
	if (prompts < 1) return false;
	const titledAt = conv.autoTitledAt;
	if (titledAt === undefined || titledAt === null) return true;
	return titledAt < RENAME_AFTER && prompts >= RENAME_AFTER;
}

/**
 * True for a conversation someone renamed by hand before `nameSetByUser`
 * existed. Those carry neither flag, so they are recognised by their name: a
 * title nobody has touched is still the first prompt's text (in one of the two
 * forms the "first line" setting gives), or the "Chat <date>" a chat that
 * started with only attachments gets. Anything else was typed by someone,
 * either in the rename box or in the fork dialog. Only asked of conversations
 * the model has never named (`autoTitledAt` absent, not null).
 */
export function looksHandNamed(
	conv: Pick<DatabaseConversation, 'name' | 'autoTitledAt' | 'nameSetByUser'>,
	messages: readonly DatabaseMessage[]
): boolean {
	if (conv.nameSetByUser) return true;
	if (conv.autoTitledAt !== undefined) return false;
	const name = (conv.name ?? '').trim();
	if (!name || /^Chat \d/.test(name)) return false;
	const first = messages.find((m) => m.role === MessageRole.USER);
	const prompt = typeof first?.content === 'string' ? first.content : '';
	if (!prompt.trim()) return false;
	return name !== generateConversationTitle(prompt, false) && name !== generateConversationTitle(prompt, true);
}

/** The conversation as the model sees it when naming it: prompts and answers only, each clipped. */
function transcript(messages: readonly DatabaseMessage[]): string {
	return messages
		.flatMap((m) => {
			if (m.role !== MessageRole.USER && m.role !== MessageRole.ASSISTANT) return [];
			const text = (typeof m.content === 'string' ? m.content : '').trim();
			if (!text) return [];
			const who = m.role === MessageRole.USER ? 'User' : 'Assistant';
			return [`${who}: ${text.slice(0, EXCERPT_LENGTH)}`];
		})
		.join('\n\n');
}

export class ChatTitleService {
	/**
	 * Asks the model to name the conversation, if it is due a name. Returns the
	 * title and the prompt count it was made at, or null when no name is due
	 * or the model gave nothing usable.
	 */
	static async suggest(
		conv: Pick<DatabaseConversation, 'name' | 'autoTitledAt' | 'nameSetByUser'>,
		messages: readonly DatabaseMessage[],
		model?: string | null
	): Promise<{ title: string; titledAt: number } | null> {
		const prompts = messages.filter((m) => m.role === MessageRole.USER).length;
		if (!shouldName(conv, prompts)) return null;
		if (looksHandNamed(conv, messages)) return null;
		// Only after something has been answered: the answer is half of what the
		// conversation is about.
		const answered = messages.some(
			(m) => m.role === MessageRole.ASSISTANT && typeof m.content === 'string' && m.content.trim()
		);
		if (!answered) return null;

		try {
			const reply = await ChatService.sendMessage(
				[
					{ role: MessageRole.SYSTEM, content: TITLE_SYSTEM_PROMPT },
					{ role: MessageRole.USER, content: `Name this chat:\n\n${transcript(messages)}` }
				],
				{
					stream: false,
					temperature: 0.3,
					max_tokens: TITLE_MAX_TOKENS,
					// A thinking model would spend the whole token budget thinking.
					enableThinking: false,
					...(model ? { model } : {})
				}
			);
			const title = cleanTitle(typeof reply === 'string' ? reply : '');
			return title ? { title, titledAt: prompts } : null;
		} catch (error) {
			console.warn('[ChatTitle] Naming the conversation failed; it keeps its title:', error);
			return null;
		}
	}
}
