<script lang="ts">
	/**
	 * Share a project (plan D7, 2026-11-24): who it is shared with and what each
	 * may do, and handing it to someone else. Opened by the owner, or by an
	 * admin who manages every project; the server checks it either way.
	 *
	 *   Viewer  opens it and chats in it (their own chats), reads instructions,
	 *           memory and files
	 *   Editor  also changes the name, instructions, memory and files
	 *
	 * Each person's chats stay their own; sharing never shows one person's chats
	 * to another.
	 */
	import { toast } from 'svelte-sonner';
	import { Loader, Users, User, X, Crown } from '@lucide/svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import {
		ProjectService,
		type Directory,
		type Project,
		type ProjectMember
	} from '$lib/services/project.service';

	interface Props {
		open: boolean;
		project: Project;
		/** Called with the updated project after a save or a hand-over. */
		onChanged: (project: Project) => void;
	}

	let { open = $bindable(), project, onChanged }: Props = $props();

	let directory = $state<Directory | null>(null);
	let members = $state<ProjectMember[]>([]);
	let query = $state('');
	let addRole = $state<'viewer' | 'editor'>('viewer');
	let saving = $state(false);
	let error = $state('');
	let newOwnerId = $state('');
	let confirmHandOver = $state(false);

	$effect(() => {
		if (!open) return;
		members = structuredClone($state.snapshot(project.members));
		error = '';
		query = '';
		newOwnerId = '';
		confirmHandOver = false;
		ProjectService.directory()
			.then((d) => (directory = d))
			.catch(() => (directory = { accounts: [], groups: [] }));
	});

	const nameOf = (m: ProjectMember) =>
		m.type === 'group'
			? (directory?.groups.find((g) => g.id === m.id)?.name ?? 'Deleted group')
			: (directory?.accounts.find((a) => a.id === m.id)?.username ?? 'Deleted account');

	const candidates = $derived.by(() => {
		if (!directory || !query.trim()) return [];
		const q = query.trim().toLowerCase();
		const taken = new Set(members.map((m) => `${m.type}:${m.id}`));
		return [
			...directory.groups
				.filter((g) => g.name.toLowerCase().includes(q))
				.map((g) => ({
					type: 'group' as const,
					id: g.id,
					label: g.name,
					sub: `group · ${g.members} people`
				})),
			...directory.accounts
				.filter((a) => a.username.toLowerCase().includes(q) && a.id !== project.ownerKey)
				.map((a) => ({ type: 'account' as const, id: a.id, label: a.username, sub: '' }))
		]
			.filter((c) => !taken.has(`${c.type}:${c.id}`))
			.slice(0, 8);
	});

	const dirty = $derived(JSON.stringify(members) !== JSON.stringify(project.members));

	function add(c: { type: 'account' | 'group'; id: string }) {
		members = [...members, { type: c.type, id: c.id, role: addRole }];
		query = '';
	}

	async function save() {
		saving = true;
		error = '';
		try {
			const updated = await ProjectService.setMembers(project.id, members);
			onChanged(updated);
			toast.success('Sharing saved');
			open = false;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not save';
		} finally {
			saving = false;
		}
	}

	async function handOver() {
		if (!newOwnerId) return;
		saving = true;
		error = '';
		try {
			const updated = await ProjectService.transfer(project.id, newOwnerId);
			onChanged(updated);
			toast.success(
				`Handed over. ${project.ownerName ?? 'The previous owner'} stays on as an editor.`
			);
			open = false;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not hand it over';
		} finally {
			saving = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="max-w-lg">
		<Dialog.Header>
			<Dialog.Title>Share "{project.name}"</Dialog.Title>
			<Dialog.Description>
				Everyone here shares the project's instructions, memory and files. Each person's chats stay
				their own.
			</Dialog.Description>
		</Dialog.Header>

		<div class="space-y-4">
			<!-- Add -->
			<div class="space-y-1.5">
				<div class="flex gap-2">
					<Input
						bind:value={query}
						placeholder="Add a person or group"
						aria-label="Add a person or group"
						class="flex-1"
					/>
					<select
						bind:value={addRole}
						aria-label="Role for who you add"
						class="rounded-md border border-input bg-background px-2 text-sm"
					>
						<option value="viewer">Viewer</option>
						<option value="editor">Editor</option>
					</select>
				</div>
				{#if candidates.length}
					<ul class="rounded-md border">
						{#each candidates as c (c.type + c.id)}
							<li>
								<button
									type="button"
									onclick={() => add(c)}
									class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent/50"
								>
									{#if c.type === 'group'}<Users class="h-3.5 w-3.5" />{:else}<User
											class="h-3.5 w-3.5"
										/>{/if}
									{c.label}
									{#if c.sub}<span class="text-xs text-muted-foreground">{c.sub}</span>{/if}
								</button>
							</li>
						{/each}
					</ul>
				{:else if query.trim() && directory}
					<p class="text-xs text-muted-foreground">Nobody by that name.</p>
				{/if}
			</div>

			<!-- Who has it -->
			<ul class="divide-y rounded-md border text-sm">
				<li class="flex items-center gap-2 px-3 py-2">
					<Crown class="h-3.5 w-3.5 text-amber-500" />
					<span class="flex-1">{project.ownerName ?? 'Owner'}</span>
					<span class="text-xs text-muted-foreground">Owner</span>
				</li>
				{#each members as m, i (m.type + m.id)}
					<li class="flex items-center gap-2 px-3 py-2">
						{#if m.type === 'group'}<Users class="h-3.5 w-3.5" />{:else}<User
								class="h-3.5 w-3.5"
							/>{/if}
						<span class="flex-1 truncate">{nameOf(m)}</span>
						<select
							value={m.role}
							onchange={(e) =>
								(members[i] = { ...m, role: e.currentTarget.value as 'viewer' | 'editor' })}
							aria-label="Role for {nameOf(m)}"
							class="rounded-md border border-input bg-background px-2 py-0.5 text-xs"
						>
							<option value="viewer">Viewer</option>
							<option value="editor">Editor</option>
						</select>
						<button
							type="button"
							class="text-muted-foreground hover:text-foreground"
							onclick={() => (members = members.filter((_, j) => j !== i))}
							aria-label="Remove {nameOf(m)}"
						>
							<X class="h-3.5 w-3.5" />
						</button>
					</li>
				{/each}
			</ul>
			<p class="text-xs text-muted-foreground">
				Viewers open it, chat in it and read everything in it. Editors can also change its
				instructions, memory and files.
			</p>

			<!-- Hand over -->
			<details class="rounded-md border px-3 py-2 text-sm">
				<summary class="cursor-pointer">Hand this project to someone else</summary>
				<div class="mt-2 flex flex-wrap items-center gap-2">
					<select
						bind:value={newOwnerId}
						aria-label="New owner"
						class="min-w-40 flex-1 rounded-md border border-input bg-background px-2 py-1 text-sm"
					>
						<option value="">Choose a person…</option>
						{#each (directory?.accounts ?? []).filter((a) => a.id !== project.ownerKey) as a (a.id)}
							<option value={a.id}>{a.username}</option>
						{/each}
					</select>
					{#if confirmHandOver}
						<Button
							size="sm"
							variant="destructive"
							onclick={handOver}
							disabled={saving || !newOwnerId}
						>
							Hand it over
						</Button>
						<Button size="sm" variant="ghost" onclick={() => (confirmHandOver = false)}
							>Cancel</Button
						>
					{:else}
						<Button
							size="sm"
							variant="outline"
							onclick={() => (confirmHandOver = true)}
							disabled={!newOwnerId}
						>
							Hand over…
						</Button>
					{/if}
				</div>
				<p class="mt-1.5 text-xs text-muted-foreground">
					They become the owner. {project.ownerName ?? 'The current owner'} stays on as an editor.
				</p>
			</details>

			{#if error}<p class="text-sm text-destructive">{error}</p>{/if}
		</div>

		<Dialog.Footer>
			<Button variant="ghost" onclick={() => (open = false)}>Cancel</Button>
			<Button onclick={save} disabled={saving || !dirty}>
				{#if saving}<Loader class="h-3.5 w-3.5 animate-spin" />{/if} Save sharing
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
