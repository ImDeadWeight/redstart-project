<script lang="ts">
	/**
	 * Settings → Workflows: saved instructions for one recurring task, run from
	 * the composer by typing `/` and the workflow's name.
	 *
	 * Two lists. Personal workflows are the signed-in account's own, and anyone
	 * may make them. Organization workflows are shown to everyone; they are
	 * editable here only when the server says so (`canEditOrg`, the
	 * manageOrgWorkflows permission) — and the server refuses the write either
	 * way, so this flag decides what renders, never what is allowed.
	 */
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import { Loader, Trash2, Pencil, Plus, X, Building2, User } from '@lucide/svelte';
	import { toast } from 'svelte-sonner';
	import {
		WorkflowService,
		type Workflow,
		type WorkflowDraft,
		type WorkflowLimits,
		type WorkflowScope
	} from '$lib/services/workflow.service';

	let personal = $state<Workflow[]>([]);
	let org = $state<Workflow[]>([]);
	let canEditOrg = $state(false);
	let limits = $state<WorkflowLimits | null>(null);
	let loading = $state(true);
	let error = $state('');
	let saving = $state(false);
	let busyId = $state<string | null>(null);

	// The open editor: which scope, which workflow (null = new), and the draft.
	let editing = $state<{ scope: WorkflowScope; id: string | null } | null>(null);
	let draft = $state<WorkflowDraft>(emptyDraft());
	let exampleInput = $state('');
	let exampleOutput = $state('');

	function emptyDraft(): WorkflowDraft {
		return {
			name: '',
			title: '',
			description: '',
			instructions: '',
			inputs: [{ name: 'input', description: '', required: true }],
			example: null
		};
	}

	async function load() {
		loading = true;
		error = '';
		try {
			const listing = await WorkflowService.list();
			personal = listing.personal;
			org = listing.org;
			canEditOrg = listing.canEditOrg;
			limits = listing.limits;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load workflows';
		} finally {
			loading = false;
		}
	}

	void load();

	function startNew(scope: WorkflowScope) {
		editing = { scope, id: null };
		draft = emptyDraft();
		exampleInput = '';
		exampleOutput = '';
	}

	function startEdit(scope: WorkflowScope, w: Workflow) {
		editing = { scope, id: w.id };
		draft = {
			name: w.name,
			title: w.title,
			description: w.description,
			instructions: w.instructions,
			inputs: w.inputs.map((i) => ({ ...i })),
			example: w.example
		};
		exampleInput = w.example?.input ?? '';
		exampleOutput = w.example?.output ?? '';
	}

	function addInput() {
		draft.inputs = [...draft.inputs, { name: '', description: '', required: false }];
	}

	function removeInput(index: number) {
		draft.inputs = draft.inputs.filter((_, i) => i !== index);
	}

	function insertPlaceholder(name: string) {
		if (!name) return;
		draft.instructions = `${draft.instructions}{{${name}}}`;
	}

	async function save() {
		if (!editing) return;
		saving = true;
		const body: WorkflowDraft = {
			...draft,
			// Both halves or neither: the server refuses half an example.
			example:
				exampleInput.trim() || exampleOutput.trim()
					? { input: exampleInput, output: exampleOutput }
					: null
		};
		try {
			const { scope, id } = editing;
			const saved = id
				? await WorkflowService.update(scope, id, body)
				: await WorkflowService.create(scope, body);
			const replace = (list: Workflow[]) =>
				id ? list.map((w) => (w.id === id ? saved : w)) : [saved, ...list];
			if (scope === 'org') org = replace(org);
			else personal = replace(personal);
			editing = null;
			toast.success(
				`Saved. Type /${scope === 'org' ? 'org-' : ''}${saved.name} in a chat to run it.`
			);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not save');
		} finally {
			saving = false;
		}
	}

	async function remove(scope: WorkflowScope, w: Workflow) {
		if (!confirm(`Delete the workflow "${w.title || w.name}"?`)) return;
		busyId = w.id;
		try {
			await WorkflowService.remove(scope, w.id);
			if (scope === 'org') org = org.filter((x) => x.id !== w.id);
			else personal = personal.filter((x) => x.id !== w.id);
			if (editing?.id === w.id) editing = null;
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not delete');
		} finally {
			busyId = null;
		}
	}

	const command = (scope: WorkflowScope, w: Workflow) =>
		`/${scope === 'org' ? 'org-' : ''}${w.name}`;
</script>

{#snippet row(scope: WorkflowScope, w: Workflow, editable: boolean)}
	<li class="rounded-lg border border-border/50 p-3">
		<div class="flex items-start gap-2">
			<div class="min-w-0 flex-1">
				<div class="flex flex-wrap items-baseline gap-x-2 text-sm">
					<span class="font-medium">{w.title || w.name}</span>
					<code class="text-xs text-muted-foreground">{command(scope, w)}</code>
				</div>
				{#if w.description}
					<div class="mt-0.5 text-xs text-muted-foreground">{w.description}</div>
				{/if}
				{#if w.inputs.length}
					<div class="mt-1 text-xs text-muted-foreground">
						Inputs: {w.inputs.map((i) => i.name + (i.required ? '' : ' (optional)')).join(', ')}
					</div>
				{/if}
				{#if scope === 'org' && w.createdBy}
					<div class="mt-1 text-xs text-muted-foreground">Added by {w.createdBy}</div>
				{/if}
			</div>
			{#if editable}
				<Button size="sm" variant="ghost" onclick={() => startEdit(scope, w)} aria-label="Edit">
					<Pencil class="h-4 w-4" />
				</Button>
				<Button
					size="sm"
					variant="ghost"
					onclick={() => remove(scope, w)}
					disabled={busyId === w.id}
					aria-label="Delete"
				>
					<Trash2 class="h-4 w-4" />
				</Button>
			{/if}
		</div>
	</li>
{/snippet}

<div class="space-y-6">
	<p class="text-sm text-muted-foreground">
		A workflow is a saved instruction for one task you do often, such as turning shorthand notes
		into the format your job uses. Type <code>/</code> in a chat to pick one; it asks for its inputs and
		sends them with the instructions. One worked example helps the model more than a long description
		of the format.
	</p>

	{#if loading}
		<div class="flex items-center gap-2 text-sm text-muted-foreground">
			<Loader class="h-4 w-4 animate-spin" /> Loading…
		</div>
	{:else if error}
		<div class="text-sm text-destructive">{error}</div>
	{:else if editing}
		<div class="space-y-4 rounded-lg border border-border/50 p-4">
			<div class="flex items-center justify-between">
				<h3 class="text-sm font-medium">
					{editing.id ? 'Edit' : 'New'}
					{editing.scope === 'org' ? 'organization' : 'personal'} workflow
				</h3>
				<Button size="sm" variant="ghost" onclick={() => (editing = null)} aria-label="Close">
					<X class="h-4 w-4" />
				</Button>
			</div>

			<div class="grid gap-3 sm:grid-cols-2">
				<label class="space-y-1 text-sm">
					<span>Command name</span>
					<Input
						bind:value={draft.name}
						placeholder="weekly-report"
						maxlength={limits?.maxNameChars}
					/>
					<span class="text-xs text-muted-foreground">
						Lowercase letters, digits and hyphens. You run it as
						<code>/{editing.scope === 'org' ? 'org-' : ''}{draft.name || 'name'}</code>.
					</span>
				</label>
				<label class="space-y-1 text-sm">
					<span>Title</span>
					<Input
						bind:value={draft.title}
						placeholder="Weekly report"
						maxlength={limits?.maxTitleChars}
					/>
				</label>
			</div>

			<label class="block space-y-1 text-sm">
				<span>Description <span class="text-muted-foreground">(shown in the picker)</span></span>
				<Input bind:value={draft.description} maxlength={limits?.maxDescriptionChars} />
			</label>

			<div class="space-y-2">
				<div class="text-sm">Inputs</div>
				{#each draft.inputs as input, i (i)}
					<div class="flex flex-wrap items-center gap-2">
						<Input
							bind:value={input.name}
							placeholder="notes"
							class="w-36"
							aria-label="Input name"
						/>
						<Input
							bind:value={input.description}
							placeholder="What to paste here"
							class="min-w-40 flex-1"
							aria-label="Input description"
						/>
						<label class="flex items-center gap-1.5 text-xs">
							<input type="checkbox" bind:checked={input.required} /> required
						</label>
						<Button
							size="sm"
							variant="ghost"
							onclick={() => insertPlaceholder(input.name)}
							title="Insert this input's placeholder into the instructions"
						>
							{'{{…}}'}
						</Button>
						<Button
							size="sm"
							variant="ghost"
							onclick={() => removeInput(i)}
							aria-label="Remove input"
						>
							<X class="h-4 w-4" />
						</Button>
					</div>
				{/each}
				{#if draft.inputs.length < (limits?.maxInputs ?? 8)}
					<Button size="sm" variant="outline" onclick={addInput}>
						<Plus class="h-3 w-3" /> Add input
					</Button>
				{/if}
			</div>

			<label class="block space-y-1 text-sm">
				<span>Instructions</span>
				<Textarea
					bind:value={draft.instructions}
					rows={8}
					maxlength={limits?.maxInstructionsChars}
					placeholder={'Rewrite {{input}} as a status report with sections Done, Blocked and Next.'}
				/>
				<span class="text-xs text-muted-foreground">
					Write <code>{'{{name}}'}</code> where an input should go. Inputs you don't place are added after
					the instructions.
				</span>
			</label>

			<div class="grid gap-3 sm:grid-cols-2">
				<label class="space-y-1 text-sm">
					<span>Example input <span class="text-muted-foreground">(optional)</span></span>
					<Textarea bind:value={exampleInput} rows={4} maxlength={limits?.maxExampleChars} />
				</label>
				<label class="space-y-1 text-sm">
					<span>What it should become</span>
					<Textarea bind:value={exampleOutput} rows={4} maxlength={limits?.maxExampleChars} />
				</label>
			</div>

			<div class="flex justify-end gap-2">
				<Button variant="ghost" onclick={() => (editing = null)}>Cancel</Button>
				<Button onclick={save} disabled={saving}>
					{#if saving}<Loader class="h-4 w-4 animate-spin" />{/if} Save
				</Button>
			</div>
		</div>
	{:else}
		<section class="space-y-2">
			<div class="flex items-center justify-between">
				<h3 class="flex items-center gap-1.5 text-sm font-medium">
					<User class="h-4 w-4" /> Yours
				</h3>
				<Button size="sm" variant="outline" onclick={() => startNew('personal')}>
					<Plus class="h-3 w-3" /> New workflow
				</Button>
			</div>
			{#if personal.length === 0}
				<div class="text-sm text-muted-foreground italic">No workflows of your own yet.</div>
			{:else}
				<ul class="space-y-2">
					{#each personal as w (w.id)}
						{@render row('personal', w, true)}
					{/each}
				</ul>
			{/if}
		</section>

		<section class="space-y-2">
			<div class="flex items-center justify-between">
				<h3 class="flex items-center gap-1.5 text-sm font-medium">
					<Building2 class="h-4 w-4" /> Organization
				</h3>
				{#if canEditOrg}
					<Button size="sm" variant="outline" onclick={() => startNew('org')}>
						<Plus class="h-3 w-3" /> New for everyone
					</Button>
				{/if}
			</div>
			{#if org.length === 0}
				<div class="text-sm text-muted-foreground italic">
					{canEditOrg
						? 'None yet. Workflows added here are available to every account.'
						: 'None yet. An administrator can add workflows for everyone.'}
				</div>
			{:else}
				<ul class="space-y-2">
					{#each org as w (w.id)}
						{@render row('org', w, canEditOrg)}
					{/each}
				</ul>
			{/if}
		</section>
	{/if}
</div>
