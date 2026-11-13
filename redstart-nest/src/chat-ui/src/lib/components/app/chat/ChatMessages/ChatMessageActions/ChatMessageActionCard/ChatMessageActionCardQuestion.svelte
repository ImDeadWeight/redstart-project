<script lang="ts">
	import { Check, MessageCircleQuestion } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import { INPUT_CLASSES } from '$lib/constants/css-classes';
	import { buildAskAnswers } from '$lib/utils/agentic';
	import type { AskAnswer, AskRequest } from '$lib/agent-core';

	/**
	 * The assistant's ask_user questions (plan §4, 1.1; several at once, D43),
	 * shown with the composer (ChatFormQuestion.svelte) for an ordinary chat
	 * and a background task alike. Each question is its own block: one row per
	 * option, round bubbles when one may be picked, square checks when any
	 * number may, and a text field that is always there (an answer of the
	 * user's own, or a note on a pick). One Send answers them all; a question
	 * left blank is told to the model as not answered. Skip is a dismissal of
	 * the whole card: the model is told the user did not answer and to say what
	 * it assumed.
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

	const questions = $derived(request.questions);
	const several = $derived(questions.length > 1);

	// The card is keyed by its question (ChatFormQuestion.svelte), so the
	// count never changes under it.
	// svelte-ignore state_referenced_locally
	let picks: Array<{ selected: string[]; text: string }> = $state(
		request.questions.map(() => ({ selected: [], text: '' }))
	);
	const groupName = `ask-${Math.random().toString(36).slice(2)}`;
	const fields: HTMLInputElement[] = [];

	const answer = $derived(buildAskAnswers(picks));

	function choose(index: number, option: string, checked: boolean) {
		const current = picks[index].selected;
		if (!questions[index].multiSelect) {
			picks[index].selected = [option];
			return;
		}
		picks[index].selected = checked
			? current.includes(option)
				? current
				: [...current, option]
			: current.filter((o) => o !== option);
	}

	function send() {
		if (answer && !busy) onAnswer(answer);
	}

	// Enter in a question's field goes to the next one; in the last, it sends.
	function onKeydown(event: KeyboardEvent, index: number) {
		if (event.key !== 'Enter' || event.shiftKey) return;
		event.preventDefault();
		if (index < questions.length - 1) fields[index + 1]?.focus();
		else send();
	}
</script>

<div
	class="{INPUT_CLASSES} mb-2 overflow-hidden rounded-3xl px-4 py-3 backdrop-blur-md"
	data-testid="ask-card"
>
	{#each questions as q, index (index)}
		{@const pick = picks[index]}
		<div class={index > 0 ? 'mt-3 border-t border-border/40 pt-3' : ''} data-testid="ask-item">
			<div class="flex items-start gap-2 text-sm">
				{#if several}
					<span
						class="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground"
						aria-hidden="true">{index + 1}</span
					>
				{:else}
					<MessageCircleQuestion class="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
				{/if}
				<span class="font-medium whitespace-pre-wrap" data-testid="ask-question">{q.question}</span>
			</div>

			{#if q.options?.length}
				<p class="mt-1 ml-6 text-xs text-muted-foreground">
					{q.multiSelect ? 'Select all that apply' : 'Choose one'}
				</p>

				<div
					class="mt-2 flex flex-col gap-1.5"
					role={q.multiSelect ? 'group' : 'radiogroup'}
					aria-label={q.question}
				>
					{#each q.options as option (option)}
						{@const isOn = pick.selected.includes(option)}
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
								type={q.multiSelect ? 'checkbox' : 'radio'}
								name={`${groupName}-${index}`}
								value={option}
								checked={isOn}
								disabled={busy}
								onchange={(e) => choose(index, option, e.currentTarget.checked)}
							/>
							{#if q.multiSelect}
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

			{#if several}
				<input
					bind:this={fields[index]}
					class="mt-2 h-9 w-full min-w-0 rounded-xl border border-border/60 bg-background/50 px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
					placeholder={q.options?.length ? 'Something else, or a note…' : 'Type your answer…'}
					aria-label={`Your answer to question ${index + 1}`}
					disabled={busy}
					bind:value={picks[index].text}
					onkeydown={(e) => onKeydown(e, index)}
				/>
			{/if}
		</div>
	{/each}

	<div class="mt-2 flex items-center gap-2">
		{#if several}
			<span class="min-w-0 flex-1 text-xs text-muted-foreground">Answer what you can; blanks are left to the assistant.</span>
		{:else}
			<input
				bind:this={fields[0]}
				class="h-9 min-w-0 flex-1 rounded-xl border border-border/60 bg-background/50 px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
				placeholder={questions[0]?.options?.length ? 'Something else, or a note…' : 'Type your answer…'}
				aria-label="Your answer"
				disabled={busy}
				bind:value={picks[0].text}
				onkeydown={(e) => onKeydown(e, 0)}
			/>
		{/if}
		<Button variant="ghost" size="sm" class="rounded-full" disabled={busy} onclick={() => onAnswer(null)}>
			Skip
		</Button>
		<Button size="sm" class="rounded-full" disabled={!answer || busy} onclick={send}>Send</Button>
	</div>
</div>
