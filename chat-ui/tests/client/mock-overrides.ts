/**
 * Per-test response overrides for the client fetch mock.
 *
 * vitest-setup-client.ts serves one fixed response per endpoint, which covers
 * the happy path but cannot express "what does this look like for a non-admin"
 * or "what comes back after the POST". Rather than each test rebuilding the
 * whole mock — and silently losing the models/props/tools stubs the components
 * also need — a test registers an override for the one URL it cares about.
 *
 * Lives in its own module so the setup file and the tests are unambiguously
 * sharing the same instance.
 */

export type MockResponder = (init?: RequestInit) => Response;

const overrides: Array<{ match: string; respond: MockResponder }> = [];

/** Override every request whose URL contains `match`, until the next test. */
export function setOverride(match: string, respond: MockResponder): void {
	overrides.unshift({ match, respond });
}

export function findOverride(url: string): MockResponder | null {
	return overrides.find((o) => url.includes(o.match))?.respond ?? null;
}

/** Called from the setup file's beforeEach so overrides never leak between tests. */
export function clearOverrides(): void {
	overrides.length = 0;
}

/** Convenience for the common case. */
export function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' }
	});
}
