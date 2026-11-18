import { describe, it, expect, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { userEvent } from 'vitest/browser';
import ChatMessageActionCardQuestion from '$lib/components/app/chat/ChatMessages/ChatMessageActions/ChatMessageActionCard/ChatMessageActionCardQuestion.svelte';

/**
 * The ask_user question card (plan §4, 1.1), shown with the composer: one row
 * per option, radio bubbles when one may be picked and checkboxes when any
 * number may, a text field that is always there, Send and Skip. What it hands
 * back is what the model reads, so each way of answering is pinned here.
 */

describe('ask_user question card', () => {
	it('one choice: the rows are radios; picking another moves the pick; Send answers with the note', async () => {
		const onAnswer = vi.fn();
		const screen = await render(ChatMessageActionCardQuestion, {
			request: { questions: [{ question: 'Which draft?', options: ['draft_a.md', 'draft_b.md'], multiSelect: false }] },
			onAnswer
		});
		await expect.element(screen.getByText('Which draft?')).toBeInTheDocument();
		await expect.element(screen.getByText('Choose one')).toBeInTheDocument();
		const send = screen.getByRole('button', { name: 'Send' });
		await expect.element(send).toBeDisabled();
		await screen.getByRole('radio', { name: 'draft_a.md' }).click();
		await screen.getByRole('radio', { name: 'draft_b.md' }).click();
		await expect.element(screen.getByRole('radio', { name: 'draft_a.md' })).not.toBeChecked();
		await expect.element(screen.getByRole('radio', { name: 'draft_b.md' })).toBeChecked();
		expect(onAnswer).not.toHaveBeenCalled();
		await userEvent.fill(screen.getByLabelText('Your answer'), 'the newer one');
		await send.click();
		expect(onAnswer).toHaveBeenCalledWith({ chosen: ['draft_b.md'], text: 'the newer one' });
	});

	it('select all that apply: the rows are checkboxes, and Send answers with every pick in order', async () => {
		const onAnswer = vi.fn();
		const screen = await render(ChatMessageActionCardQuestion, {
			request: { questions: [{ question: 'Which parts?', options: ['A', 'B', 'C'], multiSelect: true }] },
			onAnswer
		});
		await expect.element(screen.getByText('Select all that apply')).toBeInTheDocument();
		const send = screen.getByRole('button', { name: 'Send' });
		await expect.element(send).toBeDisabled();
		await screen.getByRole('checkbox', { name: 'A' }).click();
		await screen.getByRole('checkbox', { name: 'C' }).click();
		await screen.getByRole('checkbox', { name: 'A' }).click();
		await screen.getByRole('checkbox', { name: 'B' }).click();
		expect(onAnswer).not.toHaveBeenCalled();
		await send.click();
		expect(onAnswer).toHaveBeenCalledWith({ chosen: ['C', 'B'] });
	});

	it('a free-text question sends on Enter, and Skip dismisses', async () => {
		const onAnswer = vi.fn();
		const screen = await render(ChatMessageActionCardQuestion, {
			request: { questions: [{ question: 'What unit?', multiSelect: false }] },
			onAnswer
		});
		await userEvent.fill(screen.getByLabelText('Your answer'), 'Celsius');
		await userEvent.keyboard('{Enter}');
		expect(onAnswer).toHaveBeenLastCalledWith({ text: 'Celsius' });
		await screen.getByRole('button', { name: 'Skip' }).click();
		expect(onAnswer).toHaveBeenLastCalledWith(null);
	});

	it('while an answer is on its way, nothing can be sent twice', async () => {
		const onAnswer = vi.fn();
		const screen = await render(ChatMessageActionCardQuestion, {
			request: { questions: [{ question: 'Which?', options: ['x', 'y'], multiSelect: false }] },
			onAnswer,
			busy: true
		});
		await expect.element(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
		await expect.element(screen.getByRole('button', { name: 'Skip' })).toBeDisabled();
		await expect.element(screen.getByRole('radio', { name: 'x' })).toBeDisabled();
	});

	it('one question has no tabs and no Next', async () => {
		const screen = await render(ChatMessageActionCardQuestion, {
			request: { questions: [{ question: 'Which?', options: ['x', 'y'], multiSelect: false }] },
			onAnswer: vi.fn()
		});
		expect(screen.container.querySelector('[role="tablist"]')).toBeNull();
		expect(screen.container.textContent).not.toContain('Next');
		expect(screen.container.textContent).not.toContain('answered');
	});

	it('several questions (D43, D44): tabs of one panel; picks survive switching; blanks go back as null', async () => {
		const onAnswer = vi.fn();
		const screen = await render(ChatMessageActionCardQuestion, {
			request: {
				questions: [
					{ header: 'Format', question: 'Which format?', options: ['CSV', 'JSON'], multiSelect: false },
					{ question: 'Which columns?', options: ['id', 'name', 'date'], multiSelect: true },
					{ header: 'Notes', question: 'Anything else?', multiSelect: false }
				]
			},
			onAnswer
		});
		// The tabs carry the header, or "Question N" without one; one panel shows.
		await expect.element(screen.getByRole('tab', { name: 'Format' })).toHaveAttribute('aria-selected', 'true');
		await expect.element(screen.getByRole('tab', { name: 'Question 2' })).toBeInTheDocument();
		await expect.element(screen.getByText('Which format?')).toBeInTheDocument();
		expect(screen.container.textContent).not.toContain('Which columns?');
		const send = screen.getByRole('button', { name: 'Send' });
		await expect.element(send).toBeDisabled();

		await screen.getByRole('radio', { name: 'JSON' }).click();
		await userEvent.fill(screen.getByLabelText('Your answer'), 'pretty-printed');
		// Enter goes to the next tab, not Send, and the field there is empty.
		await userEvent.keyboard('{Enter}');
		expect(onAnswer).not.toHaveBeenCalled();
		await expect.element(screen.getByText('Which columns?')).toBeInTheDocument();
		await expect.element(screen.getByLabelText('Your answer')).toHaveValue('');
		await expect.element(screen.getByLabelText('Your answer')).toHaveFocus();
		await screen.getByRole('checkbox', { name: 'date' }).click();
		await screen.getByRole('checkbox', { name: 'id' }).click();

		// Back to the first tab: its pick and note are still there; answered tabs say so.
		await screen.getByRole('tab', { name: /Format/ }).click();
		await expect.element(screen.getByRole('radio', { name: 'JSON' })).toBeChecked();
		await expect.element(screen.getByLabelText('Your answer')).toHaveValue('pretty-printed');
		await expect.element(screen.getByRole('tab', { name: 'Format (answered)' })).toBeInTheDocument();
		await expect.element(screen.getByText('2 of 3 answered; blanks are left to the assistant')).toBeInTheDocument();

		// Next walks on; the last tab has none.
		await screen.getByRole('button', { name: 'Next' }).click();
		await screen.getByRole('button', { name: 'Next' }).click();
		await expect.element(screen.getByText('Anything else?')).toBeInTheDocument();
		expect(screen.container.textContent).not.toContain('Next');

		await send.click();
		expect(onAnswer).toHaveBeenCalledWith({
			answers: [{ chosen: ['JSON'], text: 'pretty-printed' }, { chosen: ['date', 'id'] }, null]
		});
	});

	it('arrow keys move between tabs', async () => {
		const screen = await render(ChatMessageActionCardQuestion, {
			request: {
				questions: [
					{ question: 'A?', multiSelect: false },
					{ question: 'B?', multiSelect: false }
				]
			},
			onAnswer: vi.fn()
		});
		await screen.getByRole('tab', { name: 'Question 1' }).click();
		(document.getElementById(screen.getByRole('tab', { name: 'Question 1' }).element().id) as HTMLElement).focus();
		await userEvent.keyboard('{ArrowRight}');
		await expect.element(screen.getByRole('tab', { name: 'Question 2' })).toHaveFocus();
		await expect.element(screen.getByText('B?')).toBeInTheDocument();
		await userEvent.keyboard('{ArrowRight}');
		await expect.element(screen.getByRole('tab', { name: 'Question 1' })).toHaveFocus();
	});
});
