<script lang="ts">
	import { tick } from 'svelte';
	import { Check, MessageCircleQuestion } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import { INPUT_CLASSES } from '$lib/constants/css-classes';
	import { buildAskAnswer, buildAskAnswers } from '$lib/utils/agentic';
	import type { AskAnswer, AskRequest } from '$lib/agent-core';

	/**
	 * The assistant's ask_user questions (plan §4, 1.1), shown with the
	 * composer (ChatFormQuestion.svelte) for an ordinary chat and a background
	 * task alike. Each question: one row per option, round bubbles when one
	 * may be picked, square checks when any number may, and a text field that
	 * is always there (an answer of the user's own, or a note on a pick).
	 *
	 * Several questions (D43) are tabs of one panel, not a stack, so the card
	 * stays the height of one question (D44). A tab is titled by the
	 * question's `header`, or "Question N", and shows a check once answered.
	 * One Send answers them all; a question left blank is told to the model
	 * as not answered. Enter in a field, or Next, goes to the next tab; on the
	 * last, Enter sends. Skip is a dismissal of the whole card: the model is
	 * told the user did not answer and to say what it assumed.
	 *
	 * The rows are real radio and checkbox inputs (visually replaced), and the
	 * tabs are a real tablist, so the keyboard and screen readers treat them
	 * as such.
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
	let active = $state(0);
	let field: HTMLInputElement | undefined = $state();
	const id = `ask-${Math.random().toString(36).slice(2)}`;

	const answer = $derived(buildAskAnswers(picks));
	const answered = $derived(picks.map((p) => buildAskAnswer(p.selected, p.text) !== null));
	const answeredCount = $derived(answered.filter(Boolean).length);
	const q = $derived(questions[active]);
	const isLast = $derived(active === questions.length - 1);

	function tabLabel(index: number): string {
		return questions[index].header || `Question ${index + 1}`;
	}

	function choose(option: string, checked: boolean) {
		const current = picks[active].selected;
		if (!q.multiSelect) {
			picks[active].selected = [option];
			return;
		}
		picks[active].selected = checked
			? current.includes(option)
				? current
				: [...current, option]
			: current.filter((o) => o !== option);
	}

	async function goTo(index: number, focus: 'field' | 'tab' = 'field') {
		active = Math.max(0, Math.min(questions.length - 1, index));
		await tick();
		if (focus === 'field') field?.focus();
		else document.getElementById(`${id}-tab-${active}`)?.focus();
	}

	function send() {
		if (answer && !busy) onAnswer(answer);
	}

	function onFieldKeydown(event: KeyboardEvent) {
		if (event.key !== 'Enter' || event.shiftKey) return;
		event.preventDefault();
		if (!isLast) void goTo(active + 1);
		else send();
	}

	// Arrow keys move between tabs, as a tablist does.
	function onTabKeydown(event: KeyboardEvent) {
		const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
		if (event.key === 'Home') void goTo(0, 'tab');
		else if (event.key === 'End') void goTo(questions.length - 1, 'tab');
		else if (step) void goTo((active + step + questions.length) % questions.length, 'tab');
		else return;
		event.preventDefault();
	}
</script>

<div
	class="{INPUT_CLASSES} mb-2 overflow-hidden rounded-3xl px-4 py-3 backdrop-blur-md"
	data-testid="ask-card"
>
	{#if several}
		<div
			class="-mx-1 mb-2 flex gap-1 overflow-x-auto pb-0.5"
			role="tablist"
			aria-label="Questions"
			tabindex="-1"
			onkeydown={onTabKeydown}
		>
			{#each questions as _, index (index)}
				{@const on = index === active}
				<button
					type="button"
					id={`${id}-tab-${index}`}
					role="tab"
					aria-selected={on}
					aria-controls={`${id}-panel`}
					tabindex={on ? 0 : -1}
					disabled={busy}
					class="flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors
						{on
						? 'border-primary/50 bg-primary/10 font-medium text-foreground'
						: 'border-border/60 bg-background/50 text-muted-foreground hover:bg-accent/60'}
						focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
					onclick={() => goTo(index)}
				>
					{#if answered[index]}
						<Check class="h-3 w-3 text-primary" strokeWidth={3} aria-hidden="true" />
					{/if}
					<span class="max-w-[10rem] truncate">{tabLabel(index)}</span>
					{#if answered[index]}<span class="sr-only">(answered)</span>{/if}
				</button>
			{/each}
		</div>
	{/if}

	<div
		id={`${id}-panel`}
		role={several ? 'tabpanel' : undefined}
		aria-labelledby={several ? `${id}-tab-${active}` : undefined}
		data-testid="ask-item"
	>
		<div class="flex items-start gap-2 text-sm">
			<MessageCircleQuestion class="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
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
				{#each q.options as option (`${active}:${option}`)}
					{@const isOn = picks[active].selected.includes(option)}
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
							name={`${id}-${active}`}
							value={option}
							checked={isOn}
							disabled={busy}
							onchange={(e) => choose(option, e.currentTarget.checked)}
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
	</div>

	<div class="mt-2 flex items-center gap-2">
		<input
			bind:this={field}
			class="h-9 min-w-0 flex-1 rounded-xl border border-border/60 bg-background/50 px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
			placeholder={q.options?.length ? 'Something else, or a note…' : 'Type your answer…'}
			aria-label="Your answer"
			disabled={busy}
			bind:value={picks[active].text}
			onkeydown={onFieldKeydown}
		/>
		<Button variant="ghost" size="sm" class="rounded-full" disabled={busy} onclick={() => onAnswer(null)}>
			Skip
		</Button>
		{#if several && !isLast}
			<Button variant="outline" size="sm" class="rounded-full" disabled={busy} onclick={() => goTo(active + 1)}>
				Next
			</Button>
		{/if}
		<Button size="sm" class="rounded-full" disabled={!answer || busy} onclick={send}>Send</Button>
	</div>
	{#if several}
		<p class="mt-1.5 px-1 text-xs text-muted-foreground" aria-live="polite">
			{answeredCount} of {questions.length} answered{answeredCount < questions.length
				? '; blanks are left to the assistant'
				: ''}
		</p>
	{/if}
</div>
