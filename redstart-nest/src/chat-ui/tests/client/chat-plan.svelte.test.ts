import { describe, it, expect, vi, afterEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import ChatFormPlan from '$lib/components/app/chat/ChatForm/ChatFormPlan.svelte';
import { conversationsStore } from '$lib/stores/conversations.svelte';
import type { DatabaseConversation } from '$lib/types';

/**
 * The update_plan checklist above the composer (plan §4, 1.2): every step
 * with its state, open while steps are open, collapsed once none are, and a
 * Clear that removes the plan from the conversation.
 */

const conv = (plan: DatabaseConversation['plan']): DatabaseConversation =>
	({ id: 'plan-chat', name: 'chat', currNode: null, lastModified: 0, plan }) as DatabaseConversation;

afterEach(() => {
	conversationsStore.activeConversation = null;
	vi.restoreAllMocks();
});

describe('plan checklist', () => {
	it('shows every step with its state while steps are open', async () => {
		conversationsStore.activeConversation = conv({
			steps: [
				{ text: 'read the notes', status: 'done' },
				{ text: 'write the summary', status: 'in_progress' },
				{ text: 'send it', status: 'skipped', note: 'no address' }
			],
			updatedAt: 1
		});
		const screen = await render(ChatFormPlan);
		await expect.element(screen.getByText('Plan · 1 of 3 done')).toBeInTheDocument();
		await expect.element(screen.getByText('write the summary')).toBeInTheDocument();
		await expect.element(screen.getByText(/no address/)).toBeInTheDocument();
		await expect.element(screen.getByLabelText('in progress')).toBeInTheDocument();
	});

	it('collapses once nothing is open, and opens on click', async () => {
		conversationsStore.activeConversation = conv({ steps: [{ text: 'read the notes', status: 'done' }], updatedAt: 2 });
		const screen = await render(ChatFormPlan);
		await expect.element(screen.getByText('Plan · done')).toBeInTheDocument();
		await expect.element(screen.getByText('read the notes')).not.toBeInTheDocument();
		await screen.getByRole('button', { name: /Plan · done/ }).click();
		await expect.element(screen.getByText('read the notes')).toBeInTheDocument();
	});

	it('Clear removes the plan from the conversation; nothing renders without one', async () => {
		conversationsStore.activeConversation = conv({ steps: [{ text: 'a', status: 'pending' }], updatedAt: 3 });
		const clear = vi
			.spyOn(conversationsStore, 'setConversationPlan')
			.mockImplementation(async () => {
				conversationsStore.activeConversation = conv(null);
			});
		const screen = await render(ChatFormPlan);
		await screen.getByRole('button', { name: 'Clear the plan' }).click();
		expect(clear).toHaveBeenCalledWith('plan-chat', null);
		await expect.element(screen.getByTestId('chat-plan')).not.toBeInTheDocument();
	});
});
