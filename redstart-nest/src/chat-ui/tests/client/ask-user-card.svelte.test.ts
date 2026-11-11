import { describe, it, expect, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { userEvent } from 'vitest/browser';
import ChatMessageActionCardQuestion from '$lib/components/app/chat/ChatMessages/ChatMessageActions/ChatMessageActionCard/ChatMessageActionCardQuestion.svelte';

/**
 * The ask_user question card (plan §4, 1.1): options as buttons, a text field
 * that is always there, and Skip. What it hands back is what the model reads,
 * so each way of answering is pinned here.
 */

describe('ask_user question card', () => {
	it('a single-choice option answers at once, with what was typed as a note', async () => {
		const onAnswer = vi.fn();
		const screen = await render(ChatMessageActionCardQuestion, {
			request: { question: 'Which draft?', options: ['draft_a.md', 'draft_b.md'], multiSelect: false },
			onAnswer
		});
		await expect.element(screen.getByText('Which draft?')).toBeInTheDocument();
		await userEvent.fill(screen.getByLabelText('Your answer'), 'the newer one');
		await screen.getByRole('button', { name: 'draft_b.md' }).click();
		expect(onAnswer).toHaveBeenCalledWith({ chosen: ['draft_b.md'], text: 'the newer one' });
	});

	it('multi-select toggles, and Send answers with every pick', async () => {
		const onAnswer = vi.fn();
		const screen = await render(ChatMessageActionCardQuestion, {
			request: { question: 'Which parts?', options: ['A', 'B', 'C'], multiSelect: true },
			onAnswer
		});
		const send = screen.getByRole('button', { name: 'Send' });
		await expect.element(send).toBeDisabled();
		await screen.getByRole('button', { name: 'A' }).click();
		await screen.getByRole('button', { name: 'C' }).click();
		await screen.getByRole('button', { name: 'A' }).click();
		await screen.getByRole('button', { name: 'B' }).click();
		expect(onAnswer).not.toHaveBeenCalled();
		await send.click();
		expect(onAnswer).toHaveBeenCalledWith({ chosen: ['C', 'B'] });
	});

	it('a free-text question sends on Enter, and Skip dismisses', async () => {
		const onAnswer = vi.fn();
		const screen = await render(ChatMessageActionCardQuestion, {
			request: { question: 'What unit?', multiSelect: false },
			onAnswer
		});
		await userEvent.fill(screen.getByLabelText('Your answer'), 'Celsius');
		await userEvent.keyboard('{Enter}');
		expect(onAnswer).toHaveBeenLastCalledWith({ text: 'Celsius' });
		await screen.getByRole('button', { name: 'Skip' }).click();
		expect(onAnswer).toHaveBeenLastCalledWith(null);
	});
});
