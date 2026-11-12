<script lang="ts">
	import { Check, MessageCircleQuestion } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import { INPUT_CLASSES } from '$lib/constants/css-classes';
	import { buildAskAnswer } from '$lib/utils/agentic';
	import type { AskAnswer, AskRequest } from '$lib/agent-core';

	/**
	 * The assistant's ask_user question (plan §4, 1.1), shown with the
	 * composer (ChatFormQuestion.svelte) for an ordinary chat and a
	 * background task alike. One row per option: round bubbles when one may
	 * be picked, square checks when any number may. A text field is always
	 * there (an answer of the user's own, or a note on a pick). Send answers;
	 * Skip is a dismissal: the model is told the user did not answer and to
	 * say what it assumed.
	 *
	 * The rows are real radio and checkbox inputs (visually replaced), so the
	 * keyboard and screen readers treat them as a choice list.
	 */
	interface Props {
		request: AskRequest;
		onAnswer: (answer: AskAnswer | null) => void;
		/** While an answer is on its way: the controls are disabled. */
		busy?: boolean;
	}

	let { request, onAnswer, busy = false }: Props = $props();

	let selected: string[] = $state([]);
	let text = $state('');
	const groupName = `ask-${Math.random().toString(36).slice(2)}`;

	const answer = $derived(buildAskAnswer(selected, text));

	function choose(option: string, checked: boolean) {
		if (!request.multiSelect) {
			selected = [option];
			return;
		}
		selected = checked
			? selected.includes(option)
				? selected
				: [...selected, option]
			: selected.filter((o) => o !== option);
	}

	function send() {
		if (answer && !busy) onAnswer(answer);
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			send();
		}
	}
</script>

<div
	class="{INPUT_CLASSES} mb-2 overflow-hidden rounded-3xl px-4 py-3 backdrop-blur-md"
	data-testid="ask-card"
>
	<div class="flex items-start gap-2 text-sm">
		<MessageCircleQuestion class="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
		<span class="font-medium whitespace-pre-wrap" data-testid="ask-question">{request.question}</span>
	</div>

	{#if request.options?.length}
		<p class="mt-1 ml-6 text-xs text-muted-foreground">
			{request.multiSelect ? 'Select all that apply' : 'Choose one'}
		</p>

		<div
			class="mt-2 flex flex-col gap-1.5"
			role={request.multiSelect ? 'group' : 'radiogroup'}
			aria-label={request.question}
		>
			{#each request.options as option (option)}
				{@const isOn = selected.includes(option)}
				<label
					class="group flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-2 text-sm transition-colors
						{isOn
						? 'border-primary/50 bg-primary/10'
						: 'border-border/60 bg-background/50 hover:bg-accent/60'}
						has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/50
						{busy ? 'pointer-events-none opacity-60' : ''}"
				>
					<input
						class="sr-only"
						type={request.multiSelect ? 'checkbox' : 'radio'}
						name={groupName}
						value={option}
						checked={isOn}
						disabled={busy}
						onchange={(e) => choose(option, e.currentTarget.checked)}
					/>
					{#if request.multiSelect}
						<span
							aria-hidden="true"
							class="flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors
								{isOn ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/50'}"
						>
							{#if isOn}<Check class="h-3 w-3" strokeWidth={3} />{/if}
						</span>
					{:else}
						<span
							aria-hidden="true"
							class="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors
								{isOn ? 'border-primary' : 'border-muted-foreground/50'}"
						>
							{#if isOn}<span class="h-2 w-2 rounded-full bg-primary"></span>{/if}
						</span>
					{/if}
					<span class="min-w-0 flex-1 break-words">{option}</span>
				</label>
			{/each}
		</div>
	{/if}

	<div class="mt-2 flex items-center gap-2">
		<input
			class="h-9 min-w-0 flex-1 rounded-xl border border-border/60 bg-background/50 px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
			placeholder={request.options?.length ? 'Something else, or a note…' : 'Type your answer…'}
			aria-label="Your answer"
			disabled={busy}
			bind:value={text}
			onkeydown={onKeydown}
		/>
		<Button variant="ghost" size="sm" class="rounded-full" disabled={busy} onclick={() => onAnswer(null)}>
			Skip
		</Button>
		<Button size="sm" class="rounded-full" disabled={!answer || busy} onclick={send}>Send</Button>
	</div>
</div>
