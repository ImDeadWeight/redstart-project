/**
 * chat-message-repo - Message create/persist orchestration for the chat store.
 *
 * Stateless async helpers over DatabaseService + conversationsStore. They hold
 * no chat state; any collaborator they need (e.g. ChatUiState for the pending
 * system-prompt edit id) is passed in so nothing imports the facade upward.
 */

import { DatabaseService } from '$lib/services/database.service';
import { conversationsStore } from '$lib/stores/conversations.svelte';
import { findMessageById } from '$lib/utils';
import { SYSTEM_MESSAGE_PLACEHOLDER } from '$lib/constants';
import { MessageRole, MessageType } from '$lib/enums';
import type { DatabaseMessage, DatabaseMessageExtra } from '$lib/types';
import type { ChatUiState } from '$lib/stores/chat/chat-ui-state.svelte';

export function getMessageByIdWithRole(
	messageId: string,
	expectedRole?: MessageRole
): { message: DatabaseMessage; index: number } | null {
	const index = conversationsStore.findMessageIndex(messageId);
	if (index === -1) return null;
	const message = conversationsStore.activeMessages[index];
	if (expectedRole && message.role !== expectedRole) return null;
	return { message, index };
}

export async function addMessage(
	role: MessageRole,
	content: string,
	type: MessageType = MessageType.TEXT,
	parent: string = '-1',
	extras?: DatabaseMessageExtra[]
): Promise<DatabaseMessage> {
	const activeConv = conversationsStore.activeConversation;
	if (!activeConv) throw new Error('No active conversation');
	let parentId: string | null = null;
	if (parent === '-1') {
		const am = conversationsStore.activeMessages;
		if (am.length > 0) parentId = am[am.length - 1].id;
		else {
			const all = await conversationsStore.getConversationMessages(activeConv.id);
			const r = all.find((m) => m.parent === null && m.type === 'root');
			parentId = r ? r.id : await DatabaseService.createRootMessage(activeConv.id);
		}
	} else parentId = parent;
	const message = await DatabaseService.createMessageBranch(
		{
			convId: activeConv.id,
			role,
			content,
			type,
			timestamp: Date.now(),
			toolCalls: '',
			children: [],
			extra: extras
		},
		parentId
	);
	conversationsStore.addMessageToActive(message);
	await conversationsStore.updateCurrentNode(message.id);
	conversationsStore.updateConversationTimestamp();
	return message;
}

export async function addSystemPrompt(ui: ChatUiState): Promise<void> {
	let activeConv = conversationsStore.activeConversation;
	if (!activeConv) {
		await conversationsStore.createConversation();
		activeConv = conversationsStore.activeConversation;
	}
	if (!activeConv) return;
	try {
		const allMessages = await conversationsStore.getConversationMessages(activeConv.id);
		const rootMessage = allMessages.find((m) => m.type === 'root' && m.parent === null);
		const rootId = rootMessage
			? rootMessage.id
			: await DatabaseService.createRootMessage(activeConv.id);
		const existingSystemMessage = allMessages.find(
			(m) => m.role === MessageRole.SYSTEM && m.parent === rootId
		);
		if (existingSystemMessage) {
			ui.pendingEditMessageId = existingSystemMessage.id;
			if (!conversationsStore.activeMessages.some((m) => m.id === existingSystemMessage.id))
				conversationsStore.activeMessages.unshift(existingSystemMessage);
			return;
		}
		const am = conversationsStore.activeMessages;
		const firstActiveMessage = am.find((m) => m.parent === rootId);
		const systemMessage = await DatabaseService.createSystemMessage(
			activeConv.id,
			SYSTEM_MESSAGE_PLACEHOLDER,
			rootId
		);
		if (firstActiveMessage) {
			await DatabaseService.updateMessage(firstActiveMessage.id, {
				parent: systemMessage.id
			});
			await DatabaseService.updateMessage(systemMessage.id, {
				children: [firstActiveMessage.id]
			});
			const updatedRootChildren = rootMessage
				? rootMessage.children.filter((id: string) => id !== firstActiveMessage.id)
				: [];
			await DatabaseService.updateMessage(rootId, {
				children: [
					...updatedRootChildren.filter((id: string) => id !== systemMessage.id),
					systemMessage.id
				]
			});
			const firstMsgIndex = conversationsStore.findMessageIndex(firstActiveMessage.id);
			if (firstMsgIndex !== -1)
				conversationsStore.updateMessageAtIndex(firstMsgIndex, {
					parent: systemMessage.id
				});
		}
		conversationsStore.activeMessages.unshift(systemMessage);
		ui.pendingEditMessageId = systemMessage.id;
		conversationsStore.updateConversationTimestamp();
	} catch (error) {
		console.error('Failed to add system prompt:', error);
	}
}

export async function removeSystemPromptPlaceholder(messageId: string): Promise<boolean> {
	const activeConv = conversationsStore.activeConversation;
	if (!activeConv) return false;
	try {
		const allMessages = await conversationsStore.getConversationMessages(activeConv.id);
		const systemMessage = findMessageById(allMessages, messageId);
		if (!systemMessage || systemMessage.role !== MessageRole.SYSTEM) return false;
		const rootMessage = allMessages.find((m) => m.type === 'root' && m.parent === null);
		if (!rootMessage) return false;
		if (allMessages.length === 2 && systemMessage.children.length === 0) {
			await conversationsStore.deleteConversation(activeConv.id);
			return true;
		}
		for (const childId of systemMessage.children) {
			await DatabaseService.updateMessage(childId, { parent: rootMessage.id });
			const childIndex = conversationsStore.findMessageIndex(childId);
			if (childIndex !== -1)
				conversationsStore.updateMessageAtIndex(childIndex, { parent: rootMessage.id });
		}
		await DatabaseService.updateMessage(rootMessage.id, {
			children: [
				...rootMessage.children.filter((id: string) => id !== messageId),
				...systemMessage.children
			]
		});
		await DatabaseService.deleteMessage(messageId);
		const systemIndex = conversationsStore.findMessageIndex(messageId);
		if (systemIndex !== -1) conversationsStore.activeMessages.splice(systemIndex, 1);
		conversationsStore.updateConversationTimestamp();
		return false;
	} catch (error) {
		console.error('Failed to remove system prompt placeholder:', error);
		return false;
	}
}

export async function createAssistantMessage(parentId?: string): Promise<DatabaseMessage> {
	const activeConv = conversationsStore.activeConversation;
	if (!activeConv) throw new Error('No active conversation');
	return await DatabaseService.createMessageBranch(
		{
			convId: activeConv.id,
			type: MessageType.TEXT,
			role: MessageRole.ASSISTANT,
			content: '',
			timestamp: Date.now(),
			toolCalls: '',
			children: [],
			model: null
		},
		parentId || null
	);
}
