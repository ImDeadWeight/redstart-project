/**
 * mcp-health - MCP server health-check state
 *
 * Owns the per-server health-check record and the accessors over it. It knows
 * nothing about the connection pool, the tool index or the server registry:
 * this is the shared substrate those concerns are injected with, mirroring the
 * role ConversationCoreState plays in stores/conversations/.
 *
 * The health-check *operations* (runHealthCheck, runHealthChecksForServers,
 * promoteHealthCheckToConnection) need connections and the tool index, so they
 * stay on the facade until seam 5d folds them in here.
 */

import { HealthCheckStatus } from '$lib/enums';
import type { HealthCheckState } from '$lib/types';

export class MCPHealth {
	healthChecks = $state<Record<string, HealthCheckState>>({});

	updateHealthCheck(serverId: string, state: HealthCheckState): void {
		this.healthChecks = { ...this.healthChecks, [serverId]: state };
	}

	getHealthCheckState(serverId: string): HealthCheckState {
		return this.healthChecks[serverId] ?? { status: HealthCheckStatus.IDLE };
	}

	hasHealthCheck(serverId: string): boolean {
		return (
			serverId in this.healthChecks && this.healthChecks[serverId].status !== HealthCheckStatus.IDLE
		);
	}

	clearHealthCheck(serverId: string): void {
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		const { [serverId]: _removed, ...rest } = this.healthChecks;
		this.healthChecks = rest;
	}

	clearAllHealthChecks(): void {
		this.healthChecks = {};
	}

	/**
	 * Get server instructions from health check results (for display before active connection).
	 * Useful for showing instructions in settings UI.
	 */
	getHealthCheckInstructions(): Array<{
		serverId: string;
		serverTitle?: string;
		instructions: string;
	}> {
		const results: Array<{ serverId: string; serverTitle?: string; instructions: string }> = [];

		for (const [serverId, state] of Object.entries(this.healthChecks)) {
			if (state.status === HealthCheckStatus.SUCCESS && state.instructions) {
				results.push({
					serverId,
					serverTitle: state.serverInfo?.title || state.serverInfo?.name,
					instructions: state.instructions
				});
			}
		}

		return results;
	}
}
