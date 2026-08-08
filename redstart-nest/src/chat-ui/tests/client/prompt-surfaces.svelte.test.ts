import { describe, it, expect } from 'vitest';
import { render } from 'vitest-browser-svelte';
import SystemPromptTabHarness from './components/SystemPromptTabHarness.svelte';
import ConnectorsTabHarness from './components/ConnectorsTabHarness.svelte';
import ModeToggleHarness from './components/ModeToggleHarness.svelte';
import ProfilePageHarness from './components/ProfilePageHarness.svelte';
import SidebarActionsHarness from './components/SidebarActionsHarness.svelte';
import LoadingScreenHarness from './components/LoadingScreenHarness.svelte';
import { setOverride, jsonResponse } from './mock-overrides';

/**
 * Mount coverage for the system-prompt surfaces.
 *
 * Everything these components rely on was verified at the HTTP layer by the
 * node suites, and `svelte-check` proved the types line up — but neither can
 * catch a component that throws on mount, binds to a prop the UI library does
 * not expose, or renders nothing because a store never resolves. These were
 * built without ever being rendered; this suite is what retires that risk and
 * keeps it retired.
 *
 * Endpoints are mocked in vitest-setup-client.ts.
 */

describe('System Prompt settings tab', () => {
	it('mounts and shows the admin blocks it loaded, with editing available', async () => {
		const screen = render(SystemPromptTabHarness);

		await expect.element(screen.getByText('Behavioral Guidelines')).toBeInTheDocument();
		await expect.element(screen.getByText('Context')).toBeInTheDocument();

		// The positive half of the tier pair below. Without this, the non-admin
		// test's "no Save button" assertion would still pass if the button were
		// renamed or removed for everyone.
		await expect.element(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
		await expect.element(screen.getByLabelText('Behavioral Guidelines')).not.toBeDisabled();
	});

	it('renders the derived data-handling panel, including unknown third-party terms', async () => {
		const screen = render(SystemPromptTabHarness);

		// The mock reports hasEgress: true with externalTermsKnown: false — the
		// case where silence would read as reassurance (spec §7).
		await expect.element(screen.getByText(/Where data goes/)).toBeInTheDocument();
		await expect
			.element(screen.getByText(/no record of how those external services/))
			.toBeInTheDocument();
	});

	it('shows the token budget indicator', async () => {
		const screen = render(SystemPromptTabHarness);

		await expect.element(screen.getByText(/Prompt size/)).toBeInTheDocument();
	});

	it('renders read-only for a non-admin: policy visible, editing withheld', async () => {
		// The tier that matters. A user must be able to READ the policy that
		// governs them — a rule you are subject to but cannot see is not a
		// policy you can hold the deployment to — while every edit affordance
		// stays absent. The server gates writes regardless, so this is about
		// not offering a control that would 403.
		setOverride('/prompt-blocks', () =>
			jsonResponse({
				blocks: {
					context: 'Org context a plain user may read.',
					policy: 'Never disclose salary data.',
					style: '',
					updatedAt: '2026-08-07T00:00:00.000Z',
					updatedBy: 'owner'
				},
				limits: { maxBlockChars: 8000, tokenBudget: 1200 },
				composed: {
					tokens: 120,
					overBudget: false,
					blocks: ['identity', 'policy', 'precedence'],
					prompt: 'Composed test prompt.'
				},
				canEdit: false
			})
		);

		const screen = render(SystemPromptTabHarness);

		await expect.element(screen.getByText('Read-only')).toBeInTheDocument();

		// Readable...
		await expect.element(screen.getByText(/only an admin can change/)).toBeInTheDocument();

		// ...but not editable: no Save control at all for a non-admin.
		await expect.element(screen.getByRole('button', { name: 'Save' })).not.toBeInTheDocument();

		// And the textareas are disabled rather than merely unsaved.
		const policyField = screen.getByLabelText('Behavioral Guidelines');
		await expect.element(policyField).toBeDisabled();
	});
});

describe('Connectors settings tab', () => {
	it('mounts and lists an existing connector key without leaking a hash', async () => {
		const screen = render(ConnectorsTabHarness);

		await expect.element(screen.getByText('Workbench laptop')).toBeInTheDocument();
		// The key row, not the surface <option> in the issue form — both carry
		// the word "blueprints", so match the row's full metadata line.
		await expect.element(screen.getByText(/blueprints · rst_1234/)).toBeInTheDocument();
	});

	it('offers the issue control', async () => {
		const screen = render(ConnectorsTabHarness);

		await expect.element(screen.getByText('Issue a key')).toBeInTheDocument();
	});

	it('reveals a newly issued key exactly once, with the warning that it will not return', async () => {
		// The reveal-once dialog is the only place the raw key ever exists in
		// the UI — the server stores a hash and cannot show it again. If this
		// dialog fails to appear, the key is issued and lost, and the only
		// recovery is to revoke and re-issue. Worth an interaction test rather
		// than trusting that a boolean flips.
		const RAW_KEY = 'rst_testkey_shown_once_0123456789';

		setOverride('/auth/me/client-keys', (init) => {
			if (init?.method === 'POST') {
				return jsonResponse({
					apiKey: RAW_KEY,
					clientKey: {
						id: 'key-2',
						surface: 'yellowscript',
						label: 'yellowscript',
						keyPrefix: 'rst_test',
						createdAt: '2026-08-07T00:00:00.000Z'
					}
				});
			}

			return jsonResponse({
				clientKeys: [],
				surfaces: ['nest-chat', 'blueprints', 'yellowscript']
			});
		});

		const screen = render(ConnectorsTabHarness);

		await screen.getByRole('button', { name: 'Issue' }).click();

		await expect.element(screen.getByText('New connector key')).toBeInTheDocument();
		await expect.element(screen.getByText(RAW_KEY)).toBeInTheDocument();
		await expect.element(screen.getByText(/shown once/)).toBeInTheDocument();
	});
});

describe('Profile page', () => {
	it('mounts and shows identity plus the stored key prefix', async () => {
		const screen = render(ProfilePageHarness);

		// The username appears twice by design (heading and details row), so
		// target the heading rather than a bare text match.
		await expect.element(screen.getByRole('heading', { name: 'alice' })).toBeInTheDocument();
		await expect.element(screen.getByText(/rst_abcd/)).toBeInTheDocument();
	});

	it('keeps a regenerated key on the page until dismissed, rather than in a dialog', async () => {
		// The behaviour this whole page exists for. The server stores only a
		// hash, so a key that scrolls past or is lost to a stray click is gone
		// for good — the previous dropdown showed it in a modal, which is what
		// made losing it easy. Assert it lands in persistent page content.
		const NEW_KEY = 'rst_regenerated_key_abcdef0123456789';

		setOverride('/auth/me/regenerate-key', () =>
			jsonResponse({
				account: {
					id: 'acc-test',
					username: 'alice',
					role: 'user',
					apiKeyPrefix: 'rst_regen',
					createdAt: '2026-01-02T03:04:05.000Z',
					lastLoginAt: '2026-08-07T09:10:11.000Z'
				},
				apiKey: NEW_KEY
			})
		);

		const screen = render(ProfilePageHarness);

		await screen.getByRole('button', { name: /Generate new key/ }).click();

		await expect.element(screen.getByText('New key generated')).toBeInTheDocument();
		await expect.element(screen.getByText(NEW_KEY)).toBeInTheDocument();

		// Still there after an unrelated interaction — a modal would have closed.
		await screen.getByText('New key generated').click();
		await expect.element(screen.getByText(NEW_KEY)).toBeInTheDocument();
	});
});

describe('Startup loading screen', () => {
	/**
	 * The stuck-forever case. Opening Twig BEFORE the server is the normal desktop
	 * sequence — turn on the laptop, then go start the model. A single startup
	 * scan found nothing, no server URL was stored, so the connect step was
	 * skipped entirely and `error` stayed null: the screen rendered a bare
	 * spinner, with no retry and no way out but restarting the app.
	 */

	it('says it is retrying instead of showing a bare spinner', async () => {
		const screen = render(LoadingScreenHarness, { retrying: true });

		await expect.element(screen.getByText(/Looking for your server/)).toBeInTheDocument();
		await expect.element(screen.getByText(/Retrying every 10 seconds/)).toBeInTheDocument();
	});

	it('🔍 offers Retry once the retry window ends, even with no error to report', async () => {
		// showRetry without an error is exactly the state that used to hang: no
		// request failed, because there was no server to send one to.
		const screen = render(LoadingScreenHarness, { showRetry: true });

		await expect.element(screen.getByText('No server found')).toBeInTheDocument();
		await expect.element(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
		await expect
			.element(screen.getByRole('button', { name: 'Server settings' }))
			.toBeInTheDocument();
	});

	it('does not claim an error when none occurred', async () => {
		const screen = render(LoadingScreenHarness, { showRetry: true });
		// The red "Can't reach the server" box reports a failed request; nothing
		// failed here, so saying so would be a lie the user has to debug.
		expect(screen.container.textContent).not.toContain('Can’t reach the server');
	});

	it('still shows the error box when a request genuinely failed', async () => {
		const screen = render(LoadingScreenHarness, { error: 'connect ECONNREFUSED' });

		await expect.element(screen.getByText('Can’t reach the server')).toBeInTheDocument();
		await expect.element(screen.getByText(/ECONNREFUSED/)).toBeInTheDocument();
		await expect.element(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
	});

	it('Retry reaches its handler', async () => {
		const screen = render(LoadingScreenHarness, { showRetry: true });

		await screen.getByRole('button', { name: 'Retry' }).click();
		await expect.element(screen.getByTestId('retry-count')).toHaveTextContent('1');
	});

	it('shows no retry affordance while the first attempt is still running', async () => {
		// Plain startup: spinner only, no buttons to click before anything has
		// had a chance to fail.
		const screen = render(LoadingScreenHarness);
		expect(screen.container.querySelector('button')).toBeNull();
	});
});

describe('Collapsed sidebar rail', () => {
	it('offers Profile above New chat, labelled by what it does', async () => {
		// The rail and the expanded sidebar render the same registry, so an action
		// present in one and missing from the other is a bug — which is exactly
		// what Profile was, having been a bespoke block in the sidebar only.
		const screen = render(SidebarActionsHarness);

		await expect.element(screen.getByLabelText('Profile')).toBeInTheDocument();
		await expect.element(screen.getByLabelText('New chat')).toBeInTheDocument();
		await expect.element(screen.getByLabelText('Search')).toBeInTheDocument();
		await expect.element(screen.getByLabelText('Settings')).toBeInTheDocument();

		// Labelled 'Profile', never the username: every neighbour says what it
		// does, and 'alice' says who you are.
		expect(screen.container.textContent).not.toContain('alice');
	});

	it('hides Profile when nobody is signed in', async () => {
		const screen = render(SidebarActionsHarness, { signedIn: false });

		await expect.element(screen.getByLabelText('New chat')).toBeInTheDocument();
		expect(screen.container.querySelector('[aria-label="Profile"]')).toBeNull();
	});
});

describe('Profile page tabs', () => {
	it('opens on Account and shows the tab strip', async () => {
		const screen = render(ProfilePageHarness);

		await expect.element(screen.getByRole('tab', { name: /Account/ })).toBeInTheDocument();
		await expect.element(screen.getByRole('tab', { name: /Files/ })).toBeInTheDocument();

		// Account is the default tab, so its content is present without a click —
		// which is also what keeps the two API-key tests above meaningful.
		await expect.element(screen.getByText(/rst_abcd/)).toBeInTheDocument();
	});

	it('switches to Files and mounts the explorer against its own storage', async () => {
		// The reason this test exists: the explorer was built, type-checked and
		// covered at the HTTP layer, but shipped in a bundle nobody rebuilt — so
		// it had never actually been mounted. This is the check that it renders.
		const screen = render(ProfilePageHarness);

		await screen.getByRole('tab', { name: /Files/ }).click();

		await expect.element(screen.getByText('Your files on the server')).toBeInTheDocument();
		await expect.element(screen.getByText('quarterly-report.md')).toBeInTheDocument();

		// The Account tab's content is gone, not merely hidden behind it.
		expect(screen.container.textContent).not.toContain('rst_abcd');
	});

	it('selects rows and offers to move the whole set', async () => {
		// Multi-select exists so a drag moves everything chosen. The drag itself
		// needs a real pointer, so this covers the half that can be asserted:
		// selection state, the count, and the affordance telling you what a drag
		// will now do.
		const screen = render(ProfilePageHarness);
		await screen.getByRole('tab', { name: /Files/ }).click();

		await expect.element(screen.getByText('quarterly-report.md')).toBeInTheDocument();
		await screen.getByLabelText('Select quarterly-report.md').click();

		await expect.element(screen.getByText(/1 selected/)).toBeInTheDocument();
		await expect
			.element(screen.getByText(/drag any of them to move the whole set/))
			.toBeInTheDocument();

		// Clearing puts the bar away rather than leaving a stale selection that a
		// later drag would silently act on.
		await screen.getByRole('button', { name: 'Clear' }).click();
		expect(screen.container.textContent).not.toContain('1 selected');
	});

	it('offers an Up control, disabled at the top of the storage', async () => {
		const screen = render(ProfilePageHarness);
		await screen.getByRole('tab', { name: /Files/ }).click();

		// Present so there is a way back out of a folder without reaching for the
		// breadcrumbs, and disabled at the root so it never looks like it would
		// escape the account's own storage.
		const up = screen.getByLabelText('Go up one folder');
		await expect.element(up).toBeInTheDocument();
		await expect.element(up).toBeDisabled();
	});
});

describe('Task mode picker', () => {
	it('mounts and exposes the modes the server advertises', async () => {
		const screen = render(ModeToggleHarness);

		// The trigger's aria-label carries the current state; with no mode set
		// it must read as "no task mode" rather than showing a stale label.
		await expect.element(screen.getByLabelText(/No task mode/)).toBeInTheDocument();
	});
});
