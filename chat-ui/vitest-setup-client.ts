/// <reference types="@vitest/browser/matchers" />
/// <reference types="@vitest/browser/providers/playwright" />

import { beforeEach, vi } from 'vitest';
import { clearOverrides, findOverride } from './tests/client/mock-overrides';

// Captured ONCE at module load, before any spy exists.
//
// This used to live inside beforeEach. Nothing restores mocks between tests,
// so from the second test onward it captured the *previous test's spy* — and
// any URL the mocks below don't match would call the spy from inside itself.
// That recursed until "RangeError: Maximum call stack size exceeded", which
// surfaced as an unexplained "Failed to initialize conversations" whenever a
// test hit an unmocked endpoint.
const realFetch = globalThis.fetch;

// Mock fetch for API calls during client tests.
// In test environment there is no backend server, so we intercept
// the specific endpoints the app uses and return valid mock data.
beforeEach(() => {
	clearOverrides();

	vi.spyOn(globalThis, 'fetch').mockImplementation(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

			// A test may override one endpoint (e.g. a non-admin's /prompt-blocks)
			// without rebuilding the rest of the mock. Checked first so it wins.
			const override = findOverride(url);
			if (override) return override(init);

			// --- Redstart system-prompt endpoints (spec §3/§7/§8/§9) ---
			// Checked first: these are gateway routes, and some would otherwise
			// be swallowed by the looser matches below.

			if (url.includes('/prompt-blocks')) {
				return new Response(
					JSON.stringify({
						blocks: {
							context: 'Test org context.',
							policy: 'Test policy.',
							style: '',
							updatedAt: '2026-08-07T00:00:00.000Z',
							updatedBy: 'owner'
						},
						limits: { maxBlockChars: 8000, tokenBudget: 1200 },
						composed: {
							tokens: 120,
							overBudget: false,
							blocks: ['identity', 'context', 'policy', 'data_handling', 'session', 'precedence'],
							prompt: 'Composed test prompt.'
						},
						canEdit: true
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } }
				);
			}

			if (url.includes('/prompt-modes')) {
				return new Response(
					JSON.stringify({
						modes: [
							{ id: 'research', label: 'Research', summary: 'Accuracy and provenance' },
							{ id: 'coding', label: 'Coding', summary: 'Working code over description' }
						]
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } }
				);
			}

			if (url.includes('/egress')) {
				return new Response(
					JSON.stringify({
						inference: { local: true, detail: 'llama-server on this machine' },
						webDomains: ['docs.example.org'],
						remoteToolServers: [{ name: 'Remote Index', host: 'mcp.vendor.example' }],
						localStores: ['a local documents folder'],
						hasEgress: true,
						externalTermsKnown: false
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } }
				);
			}

			// File explorer (profile page Files tab). Ordered before the generic
			// handlers because '/files/list' would otherwise fall through.
			if (url.includes('/files/spaces')) {
				return new Response(
					JSON.stringify({
						spaces: [
							{ id: 'documents', label: 'Documents' },
							{ id: 'files', label: 'Files' }
						]
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } }
				);
			}

			// Mutating explorer routes. Echo enough for the UI to report a result;
			// the real containment and limit behaviour is covered server-side in
			// scripts/test-file-isolation.mjs, not here.
			if (url.includes('/files/rename') || url.includes('/files/upload')) {
				return new Response(JSON.stringify({ path: 'moved', size: 1 }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				});
			}

			if (url.includes('/files/list')) {
				return new Response(
					JSON.stringify({
						space: 'documents',
						path: '.',
						truncated: false,
						entries: [
							{
								name: 'quarterly-report.md',
								path: 'quarterly-report.md',
								type: 'file',
								size: 2048,
								modified: '2026-08-07T00:00:00.000Z',
								previewable: true
							}
						]
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } }
				);
			}

			if (url.includes('/auth/me/client-keys')) {
				return new Response(
					JSON.stringify({
						clientKeys: [
							{
								id: 'key-1',
								surface: 'blueprints',
								label: 'Workbench laptop',
								keyPrefix: 'rst_1234',
								createdAt: '2026-08-07T00:00:00.000Z'
							}
						],
						surfaces: ['nest-chat', 'twig', 'blueprints', 'yellowscript', 'greenhouse']
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } }
				);
			}

			// Mock server props endpoint
			if (url.includes('/server')) {
				return new Response(
					JSON.stringify({
						mode: 'router',
						version: 'test',
						git_commit: 'test',
						git_branch: 'test'
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } }
				);
			}

			// Mock models list endpoint
			if (/\/v1\/models|\/models\b/.test(url)) {
				return new Response(
					JSON.stringify({
						object: 'list',
						data: [
							{
								id: 'test-model.gguf',
								object: 'model',
								owned_by: 'llamacpp',
								created: 0,
								in_cache: false,
								path: 'models/test-model.gguf',
								status: { value: 'unloaded' },
								meta: {}
							}
						],
						models: [
							{
								model: 'test-model.gguf',
								name: 'Test Model',
								details: {}
							}
						]
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } }
				);
			}

			// Mock /props endpoint (used for modalities)
			if (url.includes('/props')) {
				return new Response(
					JSON.stringify({
						default_generation_settings: { n_ctx: 2048 }
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } }
				);
			}

			// Mock /tools endpoint (used for built-in tools list)
			if (url.includes('/tools')) {
				return new Response(JSON.stringify([]), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				});
			}

			// Default: the genuine fetch, never whatever spy is currently installed.
			return realFetch(input, init);
		}
	);
});
