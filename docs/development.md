# Development

*[← back to the README](../README.md) · [docs index](README.md)*

Repository layout, dev loops, and how to build the binaries and installers.

---

## Prerequisites

- [Node.js](https://nodejs.org/) 22+ (the chat-ui's `@capacitor/cli` requires Node ≥ 22)
- [Android Studio](https://developer.android.com/studio) (for Android builds only)
- [Java 17+](https://adoptium.net/) (for Android builds only)

---

## Repository layout

```
redstart-project/
├── docs/                  # This documentation, plus contracts and specs
├── deploy/                # Service units, SCM procedure and Caddyfile for appliance installs
├── redstart-nest/         # Redstart Nest Electron app (server manager)
│   ├── bin/nestd.mjs      # The headless entrypoint — the daemon under plain Node
│   ├── electron/main/     # The daemon — gateway, MCP server, providers, control plane
│   │   ├── admin/         # The control plane's HTTP routes (auth, api, events, cors)
│   │   ├── gateway/       # The data plane's non-proxied routes
│   │   └── ipc/           # Handler bodies, one module per namespace
│   ├── scripts/           # Security/contract test suites (npm run test:security)
│   ├── src/
│   │   ├── App.tsx        # React UI (the launcher — a browser page, served by :19083)
│   │   ├── api/http.ts    # The launcher's HTTP client for the control plane
│   │   └── chat-ui/       # SvelteKit chat frontend (shared with all clients)
│   │       └── android/   # Capacitor Android project (Redstart Twig for Android)
│   └── electron-builder.json
├── shared/                # Code shared between Nest and Twig main processes
│   └── mcp-stdio-process.mjs   # stdio MCP child-process supervisor
└── redstart-twig/         # Redstart Twig client apps
    └── windows/           # Redstart Twig Windows Electron app
        ├── electron/fs/   # Twig's own local file tools (fs_*) — see below
        └── SMOKE.md       # Manual checklist for what the suites cannot reach
```

**Two frontend frameworks, two jobs.** React owns the launcher — the surface that starts and stops the model, configures capabilities and manages accounts. SvelteKit owns the chat UI, served on the data plane and shared by every client (browser, Twig Windows, Twig Android, Blueprints). They share no state, no routing and no auth code, and neither imports from the other.

**The launcher talks HTTP, not IPC.** There is no preload script and no `contextBridge`; the bridge was retired once the launcher had to be servable to a browser, because a UI that reaches the main process through Electron-only plumbing cannot be. `src/api/http.ts` implements the same `RedstartAPI` surface against `POST /admin/api/<namespace>/<method>` on the control plane, so the Electron window and a browser on another machine are the same client over the same transport. `scripts/test-admin-api.mjs` holds the two halves together: every method the type declares must have a route, and every route must be gated.

**One daemon, two entrypoints.** `electron/main/index.mjs` (desktop) and `bin/nestd.mjs` (headless) both start the *same* daemon; what differs is what they inject. Paths come from `platform-paths.mjs` and crypto from `secrets.mjs`, both fail-closed seams — the desktop wires up `app.getPath` and `safeStorage`, the daemon wires up a directory and a key file. Nothing below those seams imports `electron`, which is what makes the headless boot possible; `scripts/check-mjs.mjs` and the test suites' stub loader both depend on it staying that way.

**Twig owns its local file tools.** Twig's `fs_*` tools act on a folder on the *user's* machine and live in `redstart-twig/windows/electron/fs/`. They keep the `fs_*` prefix rather than adopting the upstream server's names, so the model — and an admin writing a tool ban — can tell Twig's local filesystem from Nest's server-side one. Only `path-scope.mjs` is duplicated between the apps; it is kept in sync by hand, and both copies say so.

**Chat-ui state.** `chat.svelte.ts` is a thin facade over focused sub-stores in `lib/stores/chat/` (UI state, runtime state, message repo, send pipeline, message ops, helpers). Dependencies flow one way and the public API is unchanged.

---

## Redstart Nest (dev mode)

The launcher and the chat-ui are **two separate npm packages** — you must install both:

```bash
cd redstart-nest
npm install                       # launcher / Electron main-process deps
npm install --prefix src/chat-ui  # the SvelteKit chat-ui is its own package
npm run dev
```

This starts Vite (React launcher UI), the SvelteKit chat-ui dev server, and Electron concurrently. (`npm install` in `redstart-nest` does **not** install the chat-ui's dependencies — `npm run dev` launches the chat-ui dev server via `--prefix src/chat-ui`, so its `node_modules` must exist first.)

> **Note:** In dev mode the chat-ui runs on its own port (`:5174`). The `--path` flag that serves it through llama-server only applies in production builds.

> **Starting a model in dev:** the launcher UI runs fine without the inference binary, but **Start Server** needs `llama-server.exe`. In dev it's looked up at `redstart-nest/llama-cpp-turboquant/build/bin/Release/llama-server.exe` (or point at a custom path in Settings). See [Building the llama-server binary](#building-from-source--llama-server-binary) to produce it.

---

## The daemon, without Electron

```bash
cd redstart-nest
npm run daemon            # boots in ./.redstart-daemon (a dev scratch tree)
npm run daemon:status     # running / stopped / stale / unknown
npm run daemon:stop
```

The three scripts all pass `--dir .redstart-daemon` so a dev run never touches a
real install. Invoked directly, `node bin/nestd.mjs` resolves its directory as
`--dir`, else `$REDSTART_DIR`, else `~/.redstart` — no platform guessing, because
a service install passes the directory it wants explicitly.

No window, no desktop session, no Electron. The control plane comes up on
`:19083` and serves the built launcher bundle, so administration is a browser
tab — which also means `npm run build` has to have run at least once, or there
is no bundle to serve.

`daemon:status` distinguishes **stale** (a pid file whose process is gone — what
a hard kill leaves behind) from **unknown** (a live process whose identity could
not be confirmed). It will not signal an `unknown`: pid reuse is real, and
killing on a matching number alone is the bug the whole supervision layer exists
to have removed.

For running it as a real service — systemd, the Windows SCM, TLS in front — see
[`deploy/README.md`](../deploy/README.md). Those artifacts have not been run on
real hardware yet and say so.

---

## Chat UI only

```bash
cd redstart-nest/src/chat-ui
npm install
npm run dev:redstart      # Vite on :5174, hot-reloads on save
```

This is the fast loop for UI work: Redstart Nest keeps running and serving the API, the chat-ui hot-reloads, and neither a bundle build nor an Electron relaunch is needed. The dev server proxies the API routes (`/v1`, `/props`, `/models`, `/tools`, `/slots`, `/auth`, `/files`, `/redstart`) to a Nest on `http://localhost:19080`; override with `VITE_PUBLIC_SERVER_ORIGIN`.

For component work with no server at all:

```bash
npm run test:client -- --run     # real Chromium, mocked fetch
npm run storybook                # interactive, per-component
```

> **Remember to build before testing in the real app.** Nest and Twig serve the built `dist`, so chat-ui edits are invisible until `npm run build:chat` (from `redstart-nest`). This has bitten the project more than once.

---

## Tests

```bash
cd redstart-nest
npm run test:security     # the full invariant suite — see docs/security.md
npm run typecheck         # tsc --noEmit for the launcher
npm run check:mjs         # node --check across electron/main + shared + bin
```

Two things the suites do not cover, and cannot as they stand:

- **The launcher window has no automated coverage at all.** Nothing opens an
  Electron window in CI, so every change to `src/` is verified by running
  `npm run dev` and looking at it. The daemon behind it is covered thoroughly
  (`test-daemon-smoke.mjs` and the admin suites), which is the half that can be
  driven headlessly.
- **`bin/` is not in the packaged build.** `electron-builder.json`'s `files`
  ships `electron/main` and `dist`, so `bin/nestd.mjs` exists only in a
  checkout. That is fine while there is nothing to install it onto; it matters
  the moment there is.

Running Nest as a service is documented in [`deploy/`](../deploy/README.md),
which states its own gap: none of those artifacts have been run on real
hardware.

Every suite in `test:security` must also appear as a step in `.github/workflows/ci.yml` — `scripts/test-ci-parity.mjs` fails the build otherwise, because a suite that runs locally but not in CI gates nothing. When you add a suite, add it in both places.

---

## Redstart Twig Windows (dev mode)

The Windows client has no dev server — it just loads the built chat-ui. Build the chat-ui first, then:

```bash
cd redstart-nest/src/chat-ui
npm run build

cd ../../../redstart-twig/windows
npm run dev
```

---

## Redstart Twig Android

```bash
cd redstart-nest/src/chat-ui
npm install
npm run build

npx cap sync android
```

Then open `redstart-nest/src/chat-ui/android` in Android Studio and run on a device or emulator.

---

## Building from Source — llama-server binary

> **Just want to use it?** Download the installer from [Releases](../../../releases) — the binaries are already bundled and no extra steps are needed.

Redstart Nest does **not** commit the inference binary or its runtime DLLs — they're large and platform-specific, so the entire `redstart-nest/llama-cpp-turboquant/` tree and `redstart-nest/deps/` are git-ignored. A fresh clone has neither. Building the installer from scratch means assembling two things by hand.

### 1. Build the TurboQuant `llama-server`

Clone [TurboQuant](https://github.com/TheTom/llama-cpp-turboquant) **into `redstart-nest/llama-cpp-turboquant/`** (that exact path — it's where both the dev binary lookup and `electron-builder` expect it) and build it there:

```bash
cd redstart-nest
git clone https://github.com/TheTom/llama-cpp-turboquant.git
# then follow TurboQuant's own CMake build instructions
```

You'll need the **NVIDIA CUDA Toolkit 13.x** and the **Visual Studio C++ build tools**. A successful build produces `llama-server.exe` plus the `ggml-*.dll` / `llama.dll` set at:

```
redstart-nest/llama-cpp-turboquant/build/bin/Release/
```

### 2. Supply the runtime DLLs — `redstart-nest/deps/windows/`

`llama-server.exe` also needs Visual C++ and CUDA **runtime** libraries that the TurboQuant build does **not** produce. Create the git-ignored folder `redstart-nest/deps/windows/` and place these in it:

| DLL(s) | Where to get them |
|---|---|
| `MSVCP140.dll`, `VCRUNTIME140.dll`, `VCRUNTIME140_1.dll`, `VCOMP140.DLL` | Visual C++ Redistributable / your Visual Studio install |
| `cublas64_13.dll`, `cublasLt64_13.dll` | NVIDIA CUDA Toolkit 13.x `bin/` directory |

Without these, the packaged `llama-server.exe` fails to load on any machine that doesn't already have the CUDA 13 / VC++ runtimes installed. (The `64_13` suffix is CUDA major version 13 — match it to the toolkit you built against.)

### 3. Build the installer

```bash
cd redstart-nest
npm install                       # if not already
npm install --prefix src/chat-ui  # the build compiles the chat-ui too
npm run build
```

`npm run build` builds the chat-ui, then runs `electron-builder`, which copies **both** `llama-cpp-turboquant/build/bin/Release/` and `deps/windows/` into the installer's `bin/` folder automatically.

---

## Building installers

### Redstart Nest

Prerequisites: both packages' dependencies installed (`npm install` in `redstart-nest` **and** `npm install --prefix src/chat-ui`), plus the llama-server binary and `deps/windows/` DLLs in place — see [Building from Source](#building-from-source--llama-server-binary).

```bash
cd redstart-nest
npm run build
```

Output: `redstart-nest/release/<version>/Redstart Nest Setup <version>.exe`

The version comes from `package.json`, and `electron-builder` puts the output in
`release/${version}`. Currently `1.0.0-alpha.3` — the project ships as alpha
prereleases, so bump the `-alpha.N` suffix in `redstart-nest/package.json` and
`redstart-twig/windows/package.json` (kept in lockstep) before cutting a build.

### Redstart Twig Windows

```bash
cd redstart-twig/windows
npm run build
```

Output: `redstart-twig/windows/release/<version>/Redstart Twig Setup <version>.exe`

The Windows build script builds the chat-ui first, then packages the Electron app. Both installers are NSIS-based and self-contained.

### Redstart Twig Android

Build an APK in Android Studio:
- **Build → Build App Bundle(s) / APK(s) → Build APK(s)**
- Signed APK goes to `app/build/outputs/apk/release/`
