<script lang="ts">
	import { PromptService } from '$lib/services/prompt.service';
	import { Button } from '$lib/components/ui/button';
	import { Textarea } from '$lib/components/ui/textarea';
	import { Loader, Save, Eye, EyeOff, ShieldAlert, Globe } from '@lucide/svelte';
	import type { PromptBlocksResponse, PromptBlockEdits, EgressFacts } from '$lib/types';

	// The three admin-authored blocks (spec §3). Everything else in the prompt
	// is either code-owned (identity, precedence) or derived from live config
	// (tool policy, data handling) and is deliberately not editable here.
	const BLOCK_FIELDS = [
		{
			key: 'context' as const,
			label: 'Context',
			hint: 'The organization, field, mission, users, and key topics. Keep it to what changes how the assistant answers.'
		},
		{
			key: 'policy' as const,
			label: 'Behavioral Guidelines',
			hint: 'The policy floor. A precedence clause is appended automatically so user preferences cannot override this.'
		},
		{
			key: 'style' as const,
			label: 'Output Format',
			hint: 'Formatting conventions, document defaults, tone.'
		}
	];

	let data = $state<PromptBlocksResponse | null>(null);
	let egress = $state<EgressFacts | null>(null);
	let draft = $state<PromptBlockEdits>({ context: '', policy: '', style: '' });
	let loading = $state(true);
	let saving = $state(false);
	let error = $state('');
	let saved = $state(false);
	let showComposed = $state(false);

	let canEdit = $derived(data?.canEdit ?? false);
	let maxChars = $derived(data?.limits.maxBlockChars ?? 8000);
	let budget = $derived(data?.limits.tokenBudget ?? 1200);

	// Live estimate as the admin types. Mirrors the server's chars-per-token
	// approximation — close enough for a budget indicator, and the budget is
	// advisory anyway (spec §10): nothing is ever truncated.
	let projectedTokens = $derived.by(() => {
		if (!data) return 0;
		const composedLen = data.composed.prompt.length;
		const storedLen =
			(data.blocks.context?.length ?? 0) +
			(data.blocks.policy?.length ?? 0) +
			(data.blocks.style?.length ?? 0);
		const draftLen =
			(draft.context?.length ?? 0) + (draft.policy?.length ?? 0) + (draft.style?.length ?? 0);
		return Math.ceil((composedLen - storedLen + draftLen) / 4);
	});

	let dirty = $derived(
		!!data &&
			(draft.context !== (data.blocks.context ?? '') ||
				draft.policy !== (data.blocks.policy ?? '') ||
				draft.style !== (data.blocks.style ?? ''))
	);

	async function load() {
		loading = true;
		error = '';
		try {
			data = await PromptService.getBlocks();
			draft = {
				context: data.blocks.context ?? '',
				policy: data.blocks.policy ?? '',
				style: data.blocks.style ?? ''
			};
			// Non-blocking: the audit panel is useful but the tab still works
			// without it.
			egress = await PromptService.getEgress().catch(() => null);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load system prompt';
		} finally {
			loading = false;
		}
	}

	void load();

	async function save() {
		saving = true;
		error = '';
		saved = false;
		try {
			await PromptService.saveBlocks(draft);
			await load();
			saved = true;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to save system prompt';
		} finally {
			saving = false;
		}
	}
</script>

<div class="space-y-6">
	{#if loading}
		<div class="flex items-center gap-2 text-sm text-muted-foreground">
			<Loader class="h-4 w-4 animate-spin" />
			Loading system prompt…
		</div>
	{:else}
		{#if error}
			<div class="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
				{error}
			</div>
		{/if}

		{#if !canEdit}
			<div class="flex items-start gap-2 rounded-md border border-border/40 bg-muted/40 p-3 text-sm">
				<ShieldAlert class="mt-0.5 h-4 w-4 shrink-0" />
				<div>
					<p class="font-medium">Read-only</p>
					<p class="text-muted-foreground">
						These guidelines are set by an administrator and apply to everyone. You can read them —
						a rule you are subject to should not be hidden from you — but only an admin can change
						them.
					</p>
				</div>
			</div>
		{/if}

		{#each BLOCK_FIELDS as field (field.key)}
			<div class="space-y-1.5">
				<div class="flex items-baseline justify-between gap-2">
					<label for="prompt-block-{field.key}" class="text-sm font-medium">{field.label}</label>
					<span class="text-xs text-muted-foreground">
						{(draft[field.key] ?? '').length}/{maxChars}
					</span>
				</div>

				<Textarea
					id="prompt-block-{field.key}"
					bind:value={draft[field.key]}
					disabled={!canEdit}
					rows={field.key === 'policy' ? 6 : 4}
					maxlength={maxChars}
					placeholder={canEdit ? field.hint : 'Not set'}
				/>

				<p class="text-xs text-muted-foreground">{field.hint}</p>
			</div>
		{/each}

		<!-- Soft budget (spec §10). Advisory only: an over-budget prompt is
		     flagged here and still sent in full, because a prompt silently cut
		     mid-clause fails worse than a long one. -->
		<div class="flex items-center justify-between rounded-md border border-border/40 p-3 text-sm">
			<div>
				<span class="font-medium">Prompt size</span>
				<span class="text-muted-foreground"> ≈{projectedTokens} / {budget} tokens</span>
			</div>

			{#if projectedTokens > budget}
				<span class="text-xs text-amber-600 dark:text-amber-500">
					Over the recommended budget — still sent in full, but it costs conversation context.
				</span>
			{/if}
		</div>

		{#if data}
			<div class="space-y-2">
				<Button variant="outline" size="sm" onclick={() => (showComposed = !showComposed)}>
					{#if showComposed}
						<EyeOff class="h-3 w-3" />
						Hide assembled prompt
					{:else}
						<Eye class="h-3 w-3" />
						Show assembled prompt
					{/if}
				</Button>

				{#if showComposed}
					<pre
						class="max-h-80 overflow-auto rounded-md border border-border/40 bg-muted/40 p-3 text-xs whitespace-pre-wrap">{data
							.composed.prompt}</pre>
					<p class="text-xs text-muted-foreground">
						Blocks: {data.composed.blocks.join(' → ')}
					</p>
				{/if}
			</div>
		{/if}

		<!-- Data handling (spec §7). Derived from live configuration, never
		     authored — so it cannot drift into claiming a privacy posture the
		     deployment has outgrown. -->
		{#if egress}
			<div class="space-y-1.5 rounded-md border border-border/40 p-3 text-sm">
				<div class="flex items-center gap-2 font-medium">
					<Globe class="h-4 w-4" />
					Where data goes
				</div>

				<p class="text-muted-foreground">
					{egress.inference.local
						? 'Inference runs on this machine — prompts and replies are not sent to an external model provider.'
						: 'Inference runs on a remote endpoint.'}
				</p>

				{#if egress.webDomains.length}
					<p class="text-muted-foreground">
						Web tools reach: {egress.webDomains.join(', ')}
					</p>
				{/if}

				{#if egress.remoteToolServers.length}
					<p class="text-muted-foreground">
						Remote tool servers: {egress.remoteToolServers
							.map((s) => `${s.name} (${s.host})`)
							.join(', ')}
					</p>
				{/if}

				{#if egress.hasEgress && !egress.externalTermsKnown}
					<p class="text-amber-600 dark:text-amber-500">
						Redstart has no record of how those external services retain or use what they receive.
						The assistant is instructed to say so rather than reassure.
					</p>
				{/if}

				{#if !egress.hasEgress}
					<p class="text-muted-foreground">
						No tool currently reaches outside this machine.
					</p>
				{/if}
			</div>
		{/if}

		{#if canEdit}
			<div class="flex items-center gap-3">
				<Button onclick={save} disabled={saving || !dirty}>
					{#if saving}
						<Loader class="h-3 w-3 animate-spin" />
					{:else}
						<Save class="h-3 w-3" />
					{/if}
					Save
				</Button>

				{#if saved && !dirty}
					<span class="text-xs text-muted-foreground">Saved — applies to every new request.</span>
				{/if}

				{#if data?.blocks.updatedAt}
					<span class="text-xs text-muted-foreground">
						Last changed {new Date(data.blocks.updatedAt).toLocaleString()}
						{data.blocks.updatedBy ? `by ${data.blocks.updatedBy}` : ''}
					</span>
				{/if}
			</div>
		{/if}
	{/if}
</div>
