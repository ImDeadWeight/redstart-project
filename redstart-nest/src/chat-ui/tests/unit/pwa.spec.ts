import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIST_DIR = resolve(__dirname, '../../dist');
const distExists = existsSync(DIST_DIR);

// PWA Build Output tests are integration tests that require a built dist/.
// CI builds first then runs these tests; local devs should run `npm run build` or use `npm run test:pwa`.
describe('PWA Build Output', () => {
	if (!distExists) {
		console.warn(`⚠ Skipping PWA Build Output tests - dist/ not found (run 'npm run build' first)`);
		it('skipped - dist/ not found', () => {});
		return;
	}

	const swContent = readFileSync(resolve(DIST_DIR, 'sw.js'), 'utf-8');
	const indexContent = readFileSync(resolve(DIST_DIR, 'index.html'), 'utf-8');

	describe('Core files exist', () => {
		it('service worker (sw.js) exists', () => {
			expect(existsSync(resolve(DIST_DIR, 'sw.js')), 'sw.js not found').toBeTruthy();
		});

		it('workbox library exists (hashed filename)', () => {
			// SvelteKit generates workbox-{hash}.js files
			const files = readdirSync(DIST_DIR).filter((f) => f.match(/^workbox-[^.]+\.js$/));
			expect(files.length).toBeGreaterThan(0);
		});

		it('manifest.webmanifest exists', () => {
			expect(
				existsSync(resolve(DIST_DIR, 'manifest.webmanifest')),
				'manifest.webmanifest not found'
			).toBeTruthy();
		});

		it('SvelteKit bundle.js exists in _app/immutable/', () => {
			// SvelteKit generates hashed bundle names in _app/immutable/
			const appDir = resolve(DIST_DIR, '_app', 'immutable');
			expect(existsSync(appDir), '_app/immutable/ not found').toBeTruthy();
			const files = readdirSync(appDir).filter((f) => f.startsWith('bundle.') && f.endsWith('.js'));
			expect(files.length).toBeGreaterThan(0);
		});

		it('SvelteKit bundle.css exists in _app/immutable/assets/', () => {
			// SvelteKit generates hashed CSS bundles in _app/immutable/assets/
			const cssDir = resolve(DIST_DIR, '_app', 'immutable', 'assets');
			expect(existsSync(cssDir), '_app/immutable/assets/ not found').toBeTruthy();
			const files = readdirSync(cssDir).filter(
				(f) => f.startsWith('bundle.') && f.endsWith('.css')
			);
			expect(files.length).toBeGreaterThan(0);
		});

		it('version.json exists in _app/', () => {
			// SvelteKit stores version.json in _app directory
			expect(
				existsSync(resolve(DIST_DIR, '_app', 'version.json')),
				'_app/version.json not found'
			).toBeTruthy();
		});
	});

	describe('version.json content', () => {
		it('has valid JSON with version field', () => {
			const content = readFileSync(resolve(DIST_DIR, '_app', 'version.json'), 'utf-8');
			const parsed = JSON.parse(content);
			expect(parsed).toHaveProperty('version');
			expect(typeof parsed.version).toBe('string');
			expect(parsed.version.length).toBeGreaterThan(0);
		});
	});

	describe('Service worker content', () => {
		// @vite-pwa/sveltekit 2 emits a classic worker that loads Workbox with
		// importScripts(), where 1.x emitted an AMD self.define() wrapper. It is
		// built unminified (minify: false in SVELTEKIT_PWA_OPTIONS), which is
		// what keeps the strategy names below visible to these checks.
		it('service worker loads the hashed workbox file with importScripts', () => {
			expect(swContent).toBeTruthy();
			expect(swContent).toMatch(/importScripts\("\.\/workbox-[a-zA-Z0-9]+\.js"\)/);
		});

		it('service worker is not minified (strategy names stay readable)', () => {
			expect(swContent).toBeTruthy();
			expect(swContent).not.toMatch(/^var \{ a: \w, i: \w/m);
		});

		// Regression: an unscoped '**/*' glob pattern matched the client output
		// a second time under @vite-pwa/sveltekit 2 (it globs from
		// .svelte-kit/output and adds its own client/** pattern), listing every
		// precache URL twice. See GLOB_PATTERNS in src/lib/constants/pwa.ts.
		it('precache lists every URL exactly once', () => {
			expect(swContent).toBeTruthy();
			const urls = [...swContent.matchAll(/url:\s*["`]([^"`]+)["`]/g)].map((m) => m[1]);
			expect(urls.length).toBeGreaterThan(0);
			const duplicates = urls.filter((url, i) => urls.indexOf(url) !== i);
			expect(duplicates).toEqual([]);
		});

		it('precache contains SvelteKit bundle.js with content hash', () => {
			expect(swContent).toBeTruthy();
			// SvelteKit uses content-hashed bundle names in _app/immutable/
			expect(swContent).toMatch(/"_app\/immutable\/bundle\.[a-zA-Z0-9_-]+\.js"/);
		});

		it('precache contains SvelteKit bundle.css with content hash', () => {
			expect(swContent).toBeTruthy();
			// SvelteKit uses content-hashed CSS bundle names in _app/immutable/assets/
			expect(swContent).toMatch(/"_app\/immutable\/assets\/bundle\.[a-zA-Z0-9_-]+\.css"/);
		});

		it('precache contains _app/version.json', () => {
			expect(swContent).toBeTruthy();
			// SvelteKit stores version.json in _app directory
			expect(swContent).toMatch(/"_app\/version\.json"/);
		});

		it('precache contains manifest.webmanifest', () => {
			expect(swContent).toBeTruthy();
			expect(swContent).toMatch(/"manifest\.webmanifest"/);
		});

		it('has navigation route registered', () => {
			expect(swContent).toBeTruthy();
			expect(swContent).toMatch(/NavigationRoute/);
		});

		it('has runtime caching for API routes', () => {
			expect(swContent).toBeTruthy();
			expect(swContent).toMatch(/api-cache/);
			expect(swContent).toMatch(/NetworkFirst/);
		});
	});

	describe('index.html content', () => {
		it('has modulepreload link for SvelteKit bundle with content hash', () => {
			expect(indexContent).toBeTruthy();
			// SvelteKit generates hashed bundle names in _app/immutable/
			expect(indexContent).toMatch(/href="(\.\/|\/)_app\/immutable\/bundle\.[a-zA-Z0-9_-]+\.js"/);
		});

		it('has stylesheet link for SvelteKit bundle.css with content hash', () => {
			expect(indexContent).toBeTruthy();
			expect(indexContent).toMatch(
				/href="(\.\/|\/)_app\/immutable\/assets\/bundle\.[a-zA-Z0-9_-]+\.css"/
			);
		});

		it('has dynamic import for SvelteKit bundle with content hash', () => {
			expect(indexContent).toBeTruthy();
			expect(indexContent).toMatch(
				/import\("(\.\/|\/)_app\/immutable\/bundle\.[a-zA-Z0-9_-]+\.js"\)/
			);
		});

		it('has __sveltekit__ variable (SvelteKit adds hash suffix)', () => {
			expect(indexContent).toBeTruthy();
			// SvelteKit 2.x uses __sveltekit__ as base with random suffix
			expect(indexContent).toMatch(/__sveltekit_[a-zA-Z0-9-]+/);
		});

		it('has PWA manifest link', () => {
			expect(indexContent).toBeTruthy();
			expect(indexContent).toMatch(/rel="manifest" href="(\.?\/)?manifest\.webmanifest"/);
		});

		it('has apple-touch-icon link', () => {
			expect(indexContent).toBeTruthy();
			expect(indexContent).toMatch(/rel="apple-touch-icon"/);
		});

		it('has _app paths for SvelteKit bundles', () => {
			expect(indexContent).toBeTruthy();
			// SvelteKit uses _app paths for hashed assets
			expect(indexContent).toMatch(/_app\//);
		});
	});

	describe('SvelteKit _app directory', () => {
		it('_app directory exists (SvelteKit uses it for hashed assets)', () => {
			expect(existsSync(resolve(DIST_DIR, '_app'))).toBeTruthy();
		});
	});

	describe('Hashed workbox files', () => {
		it('workbox-*.js files exist in dist root (SvelteKit build output)', () => {
			const files = readdirSync(DIST_DIR).filter((f) => f.match(/^workbox-[^.]+\.js$/));
			expect(files.length).toBeGreaterThan(0);
		});
	});

	describe('Static assets', () => {
		it('has favicon.ico', () => {
			expect(existsSync(resolve(DIST_DIR, 'favicon.ico'))).toBeTruthy();
		});

		it('has PWA icons', () => {
			expect(existsSync(resolve(DIST_DIR, 'pwa-64x64.png'))).toBeTruthy();
			expect(existsSync(resolve(DIST_DIR, 'pwa-192x192.png'))).toBeTruthy();
			expect(existsSync(resolve(DIST_DIR, 'pwa-512x512.png'))).toBeTruthy();
		});

		it('has loading.html fallback page', () => {
			expect(existsSync(resolve(DIST_DIR, 'loading.html'))).toBeTruthy();
		});
	});
});
