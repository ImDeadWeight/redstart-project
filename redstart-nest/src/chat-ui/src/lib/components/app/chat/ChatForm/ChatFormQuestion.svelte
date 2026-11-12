<script lang="ts">
	/**
	 * With the composer: the question the assistant is waiting on, whoever
	 * asked it (agent-runtime plan §4 1.1, and Phase 3.9). Exactly one source
	 * applies, in this order:
	 *
	 *   1. A background task holding this chat is waiting on a question: it is
	 *      answered through the task routes. The same ask_user call also sits
	 *      in the stored transcript with no result, so (3) must never show for
	 *      a chat a task holds: its answer would go to a browser loop that is
	 *      not running.
	 *   2. The chat's own agentic flow is waiting (live): the session resolves.
	 *   3. A reloaded chat whose last assistant turn ended on an unanswered
	 *      ask_user: chatStore.answerOpenQuestion writes the result and resumes.
	 *
	 * Questions used to render inside the assistant message; they live here so
	 * there is one card, in one place, for every kind of chat.
	 */
	import { toast } from 'svelte-sonner';
	import ChatMessageActionCardQuestion from '$lib/components/app/chat/ChatMessages/ChatMessageActions/ChatMessageActionCard/ChatMessageActionCardQuestion.svelte';
	import { conversationsStore } from '$lib/stores/conversations.svelte';
	import { chatStore } from '$lib/stores/chat.svelte';
	import { tasksStore } from '$lib/stores/tasks.svelte';
	import { agenticIsRunning, agenticPendingQuestion, agenticResolveQuestion } from '$lib/stores/agentic.svelte';
	import { findOpenQuestion, pickQuestionSource } from '$lib/utils/agentic';
	import type { AskAnswer } from '$lib/agent-core';

	const conversation = $derived(conversationsStore.activeConversation);
	const conversationId = $derived(conversation?.id ?? null);

	const source = $derived.by(() => {
		if (!conversationId) return null;
		return pickQuestionSource({
			task: tasksStore.activeFor(conversationId),
			activeTaskId: conversation?.activeTaskId,
			live: agenticPendingQuestion(conversationId),
			flowBusy: agenticIsRunning(conversationId) || chatStore.isLoading,
			open: () => findOpenQuestion(conversationsStore.activeMessages)
		});
	});

	// Hidden once answered, until a different question comes.
	let answeredKey: unknown = $state(null);
	let busy = $state(false);
	const visible = $derived(source && source.key !== answeredKey ? source : null);

	async function onAnswer(answer: AskAnswer | null) {
		const s = visible;
		const id = conversationId;
		if (!s || !id || busy) return;
		if (s.kind === 'live') {
			answeredKey = s.key;
			agenticResolveQuestion(id, answer);
			return;
		}
		busy = true;
		try {
			if (s.kind === 'task') {
				if (await tasksStore.answer(id, answer ?? { dismissed: true })) answeredKey = s.key;
			} else if (await chatStore.answerOpenQuestion(answer)) {
				answeredKey = s.key;
			}
		} catch (err) {
			console.error('[ask_user] Could not answer the question:', err);
			toast.error('Could not send your answer', {
				description: err instanceof Error ? err.message : String(err)
			});
		} finally {
			busy = false;
		}
	}
</script>

{#if visible}
	{#key visible.key}
		<ChatMessageActionCardQuestion request={visible.request} {onAnswer} {busy} />
	{/key}
{/if}
