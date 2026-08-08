import type { SETTING_CONFIG_DEFAULT, SETTINGS_SECTION_TITLES } from '$lib/constants';
import type { ChatMessagePromptProgress, ChatMessageTimings } from './chat';
import type { OpenAIToolDefinition } from './mcp';
import type { DatabaseMessageExtra } from './database';
import type {
	ParameterSource,
	ReasoningEffort,
	SyncableParameterType,
	SettingsFieldType
} from '$lib/enums';
import type { Icon } from '@lucide/svelte';
import type { Component } from 'svelte';

export type SettingsConfigValue = string | number | boolean | undefined;

/** Section title type derived from registry section titles. */
export type SettingsSectionTitle =
	(typeof SETTINGS_SECTION_TITLES)[keyof typeof SETTINGS_SECTION_TITLES];

/** Per-setting metadata — one entry per setting. */
export interface SettingsEntry {
	key: string;
	label: string;
	help: string;
	defaultValue: SettingsConfigValue;
	type: SettingsFieldType;
	section?: string;
	options?: SettingsFieldOption[];
	isExperimental?: boolean;
	isPositiveInteger?: boolean;
	sync?: {
		serverKey: string;
		paramType: SyncableParameterType;
	};
}

/** A settings section with its icon, slug, title, and ordered settings. */
export interface SettingsSectionEntry {
	title: SettingsSectionTitle;
	slug: string;
	icon: Component;
	settings: SettingsEntry[];
}

/**
 * One choice in a SELECT setting.
 *
 * Shared by SettingsEntry and SettingsFieldConfig, which previously declared
 * the same shape two different ways — icon required vs optional, and
 * `Component` vs `typeof Icon`. That only stayed invisible because the field
 * list was built by an inline literal receiving contextual typing; extracting
 * it to a function surfaced the disagreement immediately.
 */
export interface SettingsFieldOption {
	value: string;
	label: string;
	icon?: Component;
}

export interface SettingsFieldConfig {
	key: string;
	label: string;
	type: SettingsFieldType;
	isExperimental?: boolean;
	isPositiveInteger?: boolean;
	help?: string;
	options?: SettingsFieldOption[];
	/**
	 * Subheading this field sits under within its section. Used by Advanced,
	 * which merges several former sections and would otherwise be an
	 * undifferentiated wall of twenty inference knobs.
	 */
	group?: string;
}

/** Re-exported for backward compatibility. */
export interface SettingsSection {
	fields?: SettingsFieldConfig[];
	icon: Component;
	slug: string;
	title: SettingsSectionTitle;
}

export interface SettingsChatServiceOptions {
	stream?: boolean;
	// Model (required in ROUTER mode, optional in MODEL mode)
	model?: string;
	// System message to inject
	systemMessage?: string;
	// Strip reasoning content from context before sending
	excludeReasoningFromContext?: boolean;
	// Enable model thinking/reasoning via chat_template_kwargs
	enableThinking?: boolean;
	// Reasoning effort level (low/medium/high/max) for thinking models
	reasoningEffort?: ReasoningEffort;
	tools?: OpenAIToolDefinition[];
	// Generation parameters
	temperature?: number;
	max_tokens?: number;
	// Sampling parameters
	dynatemp_range?: number;
	dynatemp_exponent?: number;
	top_k?: number;
	top_p?: number;
	min_p?: number;
	xtc_probability?: number;
	xtc_threshold?: number;
	typ_p?: number;
	// Penalty parameters
	repeat_last_n?: number;
	repeat_penalty?: number;
	presence_penalty?: number;
	frequency_penalty?: number;
	dry_multiplier?: number;
	dry_base?: number;
	dry_allowed_length?: number;
	dry_penalty_last_n?: number;
	// Sampler configuration
	samplers?: string | string[];
	backend_sampling?: boolean;
	// Custom JSON parameters
	customJson?: string;
	timings_per_token?: boolean;
	// Continuation control (vLLM compat), opt in to the explicit continue final message flag
	continueFinalMessage?: boolean;
	// Task mode ID for this request (spec §9). Resolved server-side.
	promptMode?: string | null;
	// Callbacks
	onChunk?: (chunk: string) => void;
	onReasoningChunk?: (chunk: string) => void;
	onToolCallChunk?: (chunk: string) => void;
	onAttachments?: (extras: DatabaseMessageExtra[]) => void;
	onModel?: (model: string) => void;
	onCompletionId?: (id: string) => void;
	onTimings?: (timings?: ChatMessageTimings, promptProgress?: ChatMessagePromptProgress) => void;
	onComplete?: (
		response: string,
		reasoningContent?: string,
		timings?: ChatMessageTimings,
		toolCalls?: string
	) => void;
	onError?: (error: Error) => void;
}

export type SettingsConfigType = typeof SETTING_CONFIG_DEFAULT & {
	[key: string]: SettingsConfigValue;
};

/**
 * Parameter synchronization types for server defaults and user overrides
 * Note: ParameterSource and SyncableParameterType enums are imported from '$lib/enums'
 */
export type ParameterValue = string | number | boolean;
export type ParameterRecord = Record<string, ParameterValue>;

export interface ParameterInfo {
	value: string | number | boolean;
	source: ParameterSource;
	serverDefault?: string | number | boolean;
	userOverride?: string | number | boolean;
}

export interface SyncableParameter {
	key: string;
	serverKey: string;
	type: SyncableParameterType;
	canSync: boolean;
}

/**
 * Shape of the settings JSON export file.
 * Versioned to allow future schema evolution.
 */
export interface SettingsExportType {
	/** Export format version — bumped on breaking changes */
	version: number;
	/** Unix timestamp of export */
	timestamp: number;
	/** Full settings config (includes theme as a config key) */
	config: SettingsConfigType;
	/** Keys that differ from server defaults (derived, but persisted for fidelity) */
	userOverrides: string[];
}
