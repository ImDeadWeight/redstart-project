/**
 * Built-in slash commands: the registry (projects-plan D1, Phase 1 table).
 *
 * Each command runs here, in the client, and never reaches the model. The
 * parsing rules are in ./parse.ts; ChatForm.svelte wires both into the `/`
 * picker beside workflows. Twig embeds this chat-ui, so it gets every command
 * with no Twig change.
 *
 * Adding a command: give it a lowercase `name`, a one-line `summary`, an `arg`
 * kind, and a `run`. A `required` arg picked from the list fills `/name ` into
 * the composer instead of running; `options` makes the picker list choices
 * once the name and a space are typed.
 *
 * Commands deferred in the plan, and what each waits on: /temp (a
 * non-persisted chat path), /search /docs /tools (per-turn tool pinning).
 * See docs/notes/projects-plan.md.
 */

import { goto } from '$app/navigation';
import { toast } from 'svelte-sonner';
import { ROUTES, SETTINGS_SECTION_SLUGS } from '$lib/constants/routes';
import { RouterService } from '$lib/services/router.service';
import { MemoryService } from '$lib/services/memory.service';
import { ContextCompactionService } from '$lib/services/context-compaction.service';
import { conversationsStore } from '$lib/stores/conversations.svelte';
import { chatStore } from '$lib/stores/chat.svelte';
import { modelsStore, modelOptions } from '$lib/stores/models.svelte';
import { isRouterMode } from '$lib/stores/server.svelte';
import { promptModesStore } from '$lib/stores/prompt-modes.svelte';
import { projectsStore } from '$lib/stores/projects.svelte';
import { tasksStore } from '$lib/stores/tasks.svelte';
import { copyToClipboard, formatMessageForClipboard } from '$lib/utils';
import { filterOptions, usage, type SlashCommandSpec, type SlashOption } from './parse';

export interface SlashRunContext {
	/** The text after the command name, trimmed. */
	arg: string;
	/** Replace the composer text, keeping focus (used to show a sub-list). */
	setComposer(value: string): void;
	openModelSelector(): void;
	openSystemPrompt(): void;
}

export interface SlashCommand extends SlashCommandSpec {
	/** Choices listed once `/name ` is typed. Read reactively by the picker. */
	options?: () => SlashOption[];
	run(ctx: SlashRunContext): void | Promise<void>;
}

/** The active chat's id, or a toast and null when there is no chat yet. */
function activeChatId(what: string): string | null {
	const id = conversationsStore.activeConversation?.id ?? null;
	if (!id) toast.info(`Start a chat first, then ${what}.`);
	return id;
}

function lastAssistantMessage(): DatabaseMessage | null {
	const messages = conversationsStore.activeMessages;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === 'assistant') return messages[i];
	}
	return null;
}

function errorText(e: unknown, fallback: string): string {
	return e instanceof Error && e.message ? e.message : fallback;
}

function modelChoices(): SlashOption[] {
	return modelOptions().map((m) => ({
		value: m.id,
		label: m.name || m.model,
		description: m.name && m.name !== m.model ? m.model : undefined
	}));
}

const DEFAULT_MODE = 'default';

function modeChoices(): SlashOption[] {
	void promptModesStore.ensureLoaded();
	return [
		{ value: DEFAULT_MODE, label: 'Default', description: 'No task mode' },
		...promptModesStore.modes.map((m) => ({ value: m.id, label: m.label, description: m.summary }))
	];
}

const NO_PROJECT = 'none';

function projectChoices(): SlashOption[] {
	void projectsStore.ensureLoaded();
	return [
		{ value: NO_PROJECT, label: 'No project', description: 'Take this chat out of its project' },
		...projectsStore.projects.map((p) => ({
			value: p.id,
			label: p.name,
			description: p.instructions ? p.instructions.slice(0, 80) : undefined
		}))
	];
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
	{
		name: 'help',
		summary: 'List commands and workflows',
		arg: 'none',
		// The picker IS the list: an empty `/` shows every command and workflow.
		run: (ctx) => ctx.setComposer('/')
	},
	{
		name: 'new',
		aliases: ['clear'],
		summary: 'Start a new chat',
		arg: 'none',
		run: () => goto(ROUTES.NEW_CHAT)
	},
	{
		name: 'remember',
		summary: 'Save something about you to memory',
		arg: 'required',
		argHint: '<text>',
		async run({ arg }) {
			try {
				const memory = await MemoryService.create(
					arg,
					conversationsStore.activeConversation?.id ?? null
				);
				if (memory.duplicate) {
					toast.info('Already remembered');
					return;
				}
				toast.success(`Remembered: ${memory.text}`, {
					action: {
						label: 'Undo',
						onClick: () => {
							MemoryService.remove(memory.id).catch((e) =>
								toast.error(errorText(e, 'Could not undo'))
							);
						}
					}
				});
			} catch (e) {
				toast.error(errorText(e, 'Could not save that memory'));
			}
		}
	},
	{
		name: 'memory',
		summary: 'See and edit what is remembered about you',
		arg: 'none',
		run: () => goto(RouterService.settings(SETTINGS_SECTION_SLUGS.MEMORY))
	},
	{
		name: 'model',
		summary: 'Switch model',
		arg: 'optional',
		argHint: '[name]',
		options: () => (isRouterMode() ? modelChoices() : []),
		async run(ctx) {
			if (!ctx.arg) return ctx.openModelSelector();
			if (!isRouterMode()) {
				toast.info('This server runs one model; switch it from the model menu.');
				return;
			}
			const match = filterOptions(modelChoices(), ctx.arg)[0];
			if (!match) {
				toast.error(`No model matches "${ctx.arg}"`);
				return;
			}
			await modelsStore.selectModelById(match.value);
			toast.success(`Model: ${match.label}`);
		}
	},
	{
		name: 'mode',
		summary: "Set this chat's task mode",
		arg: 'optional',
		argHint: '[name]',
		options: modeChoices,
		async run(ctx) {
			await promptModesStore.ensureLoaded();
			if (!ctx.arg) return ctx.setComposer('/mode ');
			const match = filterOptions(modeChoices(), ctx.arg)[0];
			if (!match) {
				toast.error(`No mode matches "${ctx.arg}"`);
				return;
			}
			await conversationsStore.setPromptMode(match.value === DEFAULT_MODE ? null : match.value);
			toast.success(`Mode: ${match.label}`);
		}
	},
	{
		name: 'project',
		summary: 'Put this chat in a project, or take it out',
		arg: 'optional',
		argHint: '[name]',
		options: projectChoices,
		async run(ctx) {
			await projectsStore.ensureLoaded();
			if (!ctx.arg) return ctx.setComposer('/project ');
			const match = filterOptions(projectChoices(), ctx.arg)[0];
			if (!match) {
				toast.error(`No project matches "${ctx.arg}". Create one under Projects.`);
				return;
			}
			const target = match.value === NO_PROJECT ? null : match.value;
			const active = conversationsStore.activeConversation;
			try {
				if (active) {
					await conversationsStore.moveToProject(active.id, target);
				} else {
					// Not started yet: the chat is created in the project on send.
					conversationsStore.setPendingProject(target);
				}
				toast.success(target ? `In project: ${match.label}` : 'Not in a project');
			} catch (e) {
				toast.error(errorText(e, 'Could not move this chat'));
			}
		}
	},
	{
		name: 'retry',
		summary: 'Regenerate the last reply',
		arg: 'none',
		async run() {
			if (!activeChatId('retry a reply')) return;
			if (chatStore.isLoading) {
				toast.info('Wait for the reply to finish, or stop it first.');
				return;
			}
			const last = lastAssistantMessage();
			if (!last) {
				toast.info('There is no reply to retry yet.');
				return;
			}
			await chatStore.regenerateMessageWithBranching(last.id);
			await conversationsStore.refreshActiveMessages();
		}
	},
	{
		name: 'copy',
		summary: 'Copy the last reply',
		arg: 'none',
		async run() {
			const last = lastAssistantMessage();
			if (!last) {
				toast.info('There is no reply to copy yet.');
				return;
			}
			await copyToClipboard(
				formatMessageForClipboard(last.content, last.extra, false),
				'Reply copied to clipboard'
			);
		}
	},
	{
		name: 'rename',
		summary: 'Rename this chat',
		arg: 'required',
		argHint: '<title>',
		async run({ arg }) {
			const id = activeChatId('rename it');
			if (!id) return;
			await conversationsStore.renameConversationByUser(id, arg);
			toast.success(`Renamed to "${arg}"`);
		}
	},
	{
		name: 'export',
		summary: 'Download this chat',
		arg: 'none',
		async run() {
			const id = activeChatId('export it');
			if (id) await conversationsStore.downloadConversation(id);
		}
	},
	{
		name: 'compact',
		summary: 'Summarize older messages to free up context',
		arg: 'none',
		async run() {
			const id = activeChatId('compact it');
			if (!id) return;
			if (chatStore.isLoading) {
				toast.info('Wait for the reply to finish first.');
				return;
			}
			try {
				const result = await ContextCompactionService.compactNow(
					id,
					conversationsStore.activeMessages
				);
				toast.info(result.message);
			} catch (e) {
				toast.error(errorText(e, 'Could not compact this chat'));
			}
		}
	},
	{
		// agent-runtime Phase 3.9: the daemon runs the agent loop for this chat
		// with no browser attached; the chat follows it and shows its cards.
		name: 'task',
		summary: 'Run a request in the background, even with this page closed',
		arg: 'required',
		argHint: '<request>',
		async run({ arg }) {
			if (chatStore.isLoading) {
				toast.info('Wait for the reply to finish, or stop it first.');
				return;
			}
			let id = conversationsStore.activeConversation?.id ?? null;
			if (id && tasksStore.activeFor(id)) {
				toast.info('A background task is already running in this chat. Messages you send go to it.');
				return;
			}
			try {
				if (!id) id = await conversationsStore.createConversation();
			} catch (e) {
				toast.error(errorText(e, 'Could not start a chat for the task'));
				return;
			}
			const task = await tasksStore.start(id, arg);
			if (task) toast.success('Running in the background. You can close this page; it keeps going.');
		}
	},
	{
		name: 'system',
		summary: "Edit this chat's system prompt",
		arg: 'none',
		run: (ctx) => ctx.openSystemPrompt()
	}
];

/** For a usage hint when a required argument is missing. */
export function missingArgMessage(command: SlashCommand): string {
	return `Usage: ${usage(command)}`;
}
