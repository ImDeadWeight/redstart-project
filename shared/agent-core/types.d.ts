/**
 * agent-core types — the loop's messages, timings and ports.
 *
 * The core is plain ESM with JSDoc types so one file runs in the browser
 * (chat-ui bundles it), under plain Node (the benchmark and
 * scripts/test-agent-core.mjs) and, from Phase 3, in the daemon. These types
 * are structural on purpose: chat-ui's richer types (ApiChatMessageData,
 * ChatMessageTimings, DatabaseMessage) are assignable to them, so the host
 * passes its own objects through without converting.
 *
 * A host adapts the ports; it never branches the loop (plan D2).
 */

export interface AgentToolCall {
	id: string;
	type: 'function';
	function: { name: string; arguments: string };
}

/** What a model stream reports before normalisation: every field optional. */
export interface RawToolCall {
	id?: string;
	type?: string;
	function?: { name?: string; arguments?: string };
}

export interface AgentContentPart {
	type: string;
	text?: string;
	image_url?: { url: string };
}

export interface AgentMessage {
	role: string;
	content?: string | AgentContentPart[] | unknown;
	reasoning_content?: string;
	tool_calls?: AgentToolCall[];
	tool_call_id?: string;
}

export interface LlmStats {
	predicted_n: number;
	predicted_ms: number;
	prompt_n: number;
	prompt_ms: number;
}

export interface ToolCallTiming {
	name: string;
	duration_ms: number;
	success: boolean;
}

export interface TurnStats {
	turn: number;
	llm: LlmStats;
	toolCalls: ToolCallTiming[];
	toolsMs: number;
}

export interface AgenticTimings {
	turns: number;
	toolCallsCount: number;
	toolsMs: number;
	toolCalls?: ToolCallTiming[];
	perTurn?: TurnStats[];
	llm: LlmStats;
}

/** One completion's timings, as llama-server reports them. */
export interface Timings {
	predicted_n?: number;
	predicted_ms?: number;
	prompt_n?: number;
	prompt_ms?: number;
	cache_n?: number;
	agentic?: AgenticTimings;
}

/**
 * Per-turn state, owned by the loop so it survives a throw: when the stream
 * fails mid-turn the loop still saves what had arrived. `captured` spans turns
 * (seeded from the previous one, read back after this one).
 */
export interface TurnAccumulator {
	content: string;
	reasoning: string;
	toolCalls: RawToolCall[];
	timings: Timings | undefined;
	captured: Timings | undefined;
}

/**
 * The `store` port: how the loop records what happened. chat-ui's
 * AgenticFlowCallbacks are this shape (the streaming callbacks are the model
 * port's business, not the loop's).
 */
export interface AgentStoreCallbacks<A = unknown> {
	onAssistantTurnComplete?: (
		content: string,
		reasoningContent: string | undefined,
		timings: Timings | undefined,
		toolCalls: AgentToolCall[] | undefined
	) => Promise<void>;
	createToolResultMessage?: (
		toolCallId: string,
		content: string,
		extras?: A[]
	) => Promise<{ id: string } | undefined | void>;
	createAssistantMessage?: () => Promise<unknown>;
	onAttachments?: (messageId: string, extras: A[]) => void;
	onFlowComplete?: (timings?: Timings) => void;
	onTurnComplete?: (intermediateTimings: Timings) => void;
}

/** An ask_user call, checked (ask-user.mjs parseAskArguments). */
export interface AskRequest {
	question: string;
	/** 2 to 4, distinct. Absent: a free-text question. */
	options?: string[];
	multiSelect: boolean;
}

/** What the person said. Both may be set: a choice plus a note. */
export interface AskAnswer {
	chosen?: string[];
	text?: string;
}

/** One update_plan step (update-plan.mjs). */
export interface PlanStep {
	text: string;
	status: 'pending' | 'in_progress' | 'done' | 'skipped';
	note?: string;
}

export interface ToolCallParserConfig {
	/** Any of 'braces', 'xml', 'fn', 'json', tried in order. */
	patterns: string[];
	/** Only these names are recognised as calls. */
	availableTools: Array<{ name: string }>;
}

export interface ParsedToolCall {
	name: string;
	arguments: string;
}

export interface ToolExecution {
	text: string;
	isError: boolean;
}

/**
 * `A` is the host's attachment type: the core never looks inside one, it only
 * carries what `extractAttachments` returned to the store callbacks and to
 * `extraParts`.
 */
export interface AgentPorts<A = unknown> {
	model: {
		/**
		 * Stream one turn. Fill `acc` as chunks arrive (never replace it), and
		 * throw on a stream error or abort. The loop folds `acc.timings` into its
		 * totals afterwards.
		 */
		streamTurn(req: {
			acc: TurnAccumulator;
			messages: AgentMessage[];
			signal?: AbortSignal;
		}): Promise<void>;
	};
	tools: {
		/** Run one call. Throw an AbortError to stop the flow; any other throw becomes an error result. */
		execute(call: AgentToolCall, signal?: AbortSignal): Promise<ToolExecution>;
		/** Lift inline payloads out of a result before it is stored. Default: none. */
		extractAttachments?(text: string): { text: string; attachments: A[] };
		/** Extra content parts (images for a vision model) sent with this result. Default: none. */
		extraParts?(text: string, attachments: A[]): Promise<AgentContentPart[]>;
	};
	gate: {
		/** Authorise one call. `false` means denied. Resolve `false` on abort. */
		approve(call: AgentToolCall, signal?: AbortSignal): Promise<boolean>;
	};
	/**
	 * The person behind the flow, for `ask_user` (ask-user.mjs). Omitted: the
	 * call goes through the gate and the executor like any other tool (Nest
	 * answers it with an error, since only a host can ask).
	 */
	ask?: {
		/**
		 * Put the question to the person and resolve with their answer, or
		 * null when they dismiss it. Resolve null on abort. A message the
		 * person types while the question is open is their answer: resolve
		 * with it as `text` and consume it, so the steering check that follows
		 * does not also treat it as an interruption.
		 */
		user(request: AskRequest, signal?: AbortSignal, call?: AgentToolCall): Promise<AskAnswer | null>;
		/**
		 * An ask_user call whose arguments were malformed: the loop answered it
		 * with `error` and asked nobody. For a host that records every call
		 * (the bench). Optional.
		 */
		invalid?(call: AgentToolCall, error: string): void;
	};
	/**
	 * Where the conversation's plan lives, for `update_plan` (update-plan.mjs).
	 * Omitted: the call goes through the gate and the executor like any other
	 * tool, there is no tail note and no completion check.
	 */
	plan?: {
		/** The current steps, or null with no plan. Read before every turn. */
		get(): readonly PlanStep[] | null;
		/** Store the whole new list. A throw becomes an error result. */
		save(steps: PlanStep[], call?: AgentToolCall): Promise<void> | void;
		/** A malformed update_plan the loop answered with `error`. Optional. */
		invalid?(call: AgentToolCall, error: string): void;
		/**
		 * The one completion check (a turn that answers with steps open gets
		 * one more). Default on; the bench turns it off to measure the tool
		 * alone (plan U5).
		 */
		completionCheck?: boolean;
	};
	limit: {
		/** The turn limit was reached: may the flow go on? Resolve `false` on abort. */
		askContinue(signal?: AbortSignal): Promise<boolean>;
	};
	steering: {
		/** True while a user message typed mid-flow is waiting to be sent. */
		pending(): boolean;
	};
	/**
	 * The fallback parser's settings for this turn, or null when it is off.
	 * Asked once per turn that ends with no structured tool_calls; the loop
	 * then looks for a call the model wrote out as text. Omitted: off.
	 */
	fallbackParser?(): ToolCallParserConfig | null;
	/** Turn and call counters, for a host that shows them live. */
	progress?(patch: { currentTurn?: number; totalToolCalls?: number }): void;
	/** Wall clock for tool timings, in ms. Default: performance.now. */
	now?(): number;
	/** Yield to the host between a prompt resolving and the loop going on. Default: one macrotask. */
	yield?(): Promise<void>;
	log?(message: string): void;
}

export interface AgentLoopParams<A = unknown> {
	/** The conversation so far. Appended to in place as the flow runs. */
	messages: AgentMessage[];
	maxTurns: number;
	ports: AgentPorts<A>;
	callbacks: AgentStoreCallbacks<A>;
	signal?: AbortSignal;
}

/**
 * runToolCalls' result. 'stopped': the flow is over and onFlowComplete has
 * ALREADY been called; the caller returns without completing again. 'done':
 * carry on (every call ran, or steering cut the rest short).
 */
export type ToolCallsOutcome = 'done' | 'stopped';
