/**
 * agent-core/host-tools — the two tools a host answers itself.
 *
 * ask_user (the person answers, through the ask port) and update_plan (the
 * host stores the plan, through the plan port) are never sent to the gate or
 * an executor: asking needs no approval and nothing on a server could answer
 * it, and a plan changes nothing outside the conversation. runToolCalls
 * (tool-calls.mjs) hands each such call here; split out of it in master plan
 * Phase 4, behaviour unchanged.
 */

import { formatAskAnswer, parseAskArguments } from './ask-user.mjs';
import { formatPlanResult, parsePlanArguments, samePlan } from './update-plan.mjs';

/** @typedef {import('./types').AgentToolCall} AgentToolCall */

/**
 * Put an ask_user call to the person.
 *
 * `stopped`: the flow was aborted while the question was open, and the
 * caller ends it. `answered`: the person was asked and answered, so the time
 * they took is not tool time (the caller restarts its clock).
 *
 * @param {AgentToolCall} toolCall
 * @param {NonNullable<import('./types').AgentPorts<any>['ask']>} ask
 * @param {AbortSignal | undefined} signal
 * @param {() => Promise<void>} yieldToHost
 * @returns {Promise<{ result: string, success: boolean, stopped?: boolean, answered?: boolean }>}
 */
export async function runAskUser(toolCall, ask, signal, yieldToHost) {
	const parsed = parseAskArguments(toolCall.function.arguments);
	if (!parsed.ok) {
		// Nobody was asked, but the host may still record the attempt.
		ask.invalid?.(toolCall, parsed.error);
		return { result: parsed.error, success: false };
	}
	const answer = await ask.user(parsed.request, signal, toolCall);
	// Let the host repaint (the browser hides the question card here).
	await yieldToHost();
	if (signal?.aborted) return { result: '', success: false, stopped: true };
	return { result: formatAskAnswer(answer, parsed.request), success: true, answered: true };
}

/**
 * Store an update_plan call's steps (unless they are the plan already).
 *
 * @param {AgentToolCall} toolCall
 * @param {NonNullable<import('./types').AgentPorts<any>['plan']>} plan
 * @returns {Promise<{ result: string, success: boolean }>}
 */
export async function runUpdatePlan(toolCall, plan) {
	const parsed = parsePlanArguments(toolCall.function.arguments);
	if (!parsed.ok) {
		plan.invalid?.(toolCall, parsed.error);
		return { result: parsed.error, success: false };
	}
	try {
		const unchanged = samePlan(plan.get(), parsed.steps);
		if (!unchanged) await plan.save(parsed.steps, toolCall);
		return { result: formatPlanResult(parsed.steps, { unchanged }), success: true };
	} catch (error) {
		return {
			result: `Error: the plan could not be saved: ${error instanceof Error ? error.message : String(error)}`,
			success: false
		};
	}
}
