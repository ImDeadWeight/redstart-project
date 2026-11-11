<script lang="ts">
	import { MessageCircleQuestion } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import ChatMessageActionCard from './ChatMessageActionCard.svelte';
	import { buildAskAnswer } from '$lib/utils/agentic';
	import type { AskAnswer, AskRequest } from '$lib/agent-core';

	/**
	 * The assistant's ask_user question (plan §4, 1.1): options as buttons, a
	 * text field that is always there, and Skip. With a single-choice question
	 * a click on an option answers at once (with whatever is typed as a note);
	 * with multi_select, options toggle and Send answers. Skip is a dismissal:
	 * the model is told the user did not answer and to say what it assumed.
	 */
	interface Props {
		request: AskRequest;
		onAnswer: (answer: AskAnswer | null) => void;
	}

	let { request, onAnswer }: Props = $props();

	let selected: string[] = $state([]);
	let text = $state('');

	const answer = $derived(buildAskAnswer(selected, text));

	function pick(option: string) {
		if (!request.multiSelect) {
			onAnswer(buildAskAnswer([option], text));
			return;
		}
		selected = selected.includes(option)
			? selected.filter((o) => o !== option)
			: [...selected, option];
	}

	function send() {
		if (answer) onAnswer(answer);
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			send();
		}
	}
</script>

<ChatMessageActionCard icon={MessageCircleQuestion}>
	{#snippet message()}
		<span class="whitespace-pre-wrap" data-testid="ask-question">{request.question}</span>
	{/snippet}

	{#snippet actions()}
		<div class="flex w-full flex-col gap-2">
			{#if request.options}
				<div class="flex flex-wrap gap-2">
					{#each request.options as option (option)}
						<Button
							size="sm"
							variant={selected.includes(option) ? 'default' : 'outline'}
							aria-pressed={request.multiSelect ? selected.includes(option) : undefined}
							onclick={() => pick(option)}
						>
							{option}
						</Button>
					{/each}
				</div>
			{/if}

			<div class="flex items-center gap-2">
				<input
					class="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm"
					placeholder={request.options ? 'Or type an answer…' : 'Type your answer…'}
					aria-label="Your answer"
					bind:value={text}
					onkeydown={onKeydown}
				/>
				<Button size="sm" disabled={!answer} onclick={send}>Send</Button>
				<Button variant="ghost" size="sm" onclick={() => onAnswer(null)}>Skip</Button>
			</div>
		</div>
	{/snippet}
</ChatMessageActionCard>
