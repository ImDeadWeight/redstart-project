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
├── redstart-nest/         # Redstart Nest (server manager)
│   ├── bin/nestd.mjs      # The daemon's entrypoint (headless, or --shell-pipe under the shell)
│   ├── daemon/            # The daemon: gateway, MCP server, providers, control plane
│   │   ├── admin/         # The control plane's HTTP routes (auth, api, events, cors)
│   │   ├── gateway/       # The data plane's non-proxied routes
│   │   └── ipc/           # Handler bodies, one module per namespace
│   ├── scripts/           # Security/contract test suites (npm run test:security)
│   ├── src/
│   │   ├── App.tsx        # React UI (the launcher — a browser page, served by :19083)
│   │   ├── api/http.ts    # The launcher's HTTP client for the control plane
│   │   └── chat-ui/       # SvelteKit chat frontend (shared with all clients)
│   │       └── android/   # Capacitor Android project (Redstart Twig for Android)
│   └── shell/             # The desktop shell (Tauri, Rust): window, tray, updater, installer
├── shared/                # Code shared between Nest and Twig main processes
│   └── mcp-stdio-process.mjs   # stdio MCP child-process supervisor
└── redstart-twig/         # Redstart Twig client apps
    └── windows/           # Redstart Twig Windows Electron app
        ├── electron/fs/   # Twig's own local file tools (fs_*) — see below
        └── SMOKE.md       # Manual checklist for what the suites cannot reach
```

**Two frontend frameworks, two jobs.** React owns the launcher — the surface that starts and stops the model, configures capabilities and manages accounts. SvelteKit owns the chat UI, served on the data plane and shared by every client (browser, Twig Windows, Twig Android, Blueprints). They share no state, no routing and no auth code, and neither imports from the other.

**The launcher talks HTTP, not IPC.** The launcher has to be servable to a browser, so it reaches the daemon only over HTTP: `src/api/http.ts` implements the `RedstartAPI` surface against `POST /admin/api/<namespace>/<method>` on the control plane, and the desktop window and a browser on another machine are the same client over the same transport. The one exception is window chrome: inside the Tauri shell the page's own minimise/maximise/close call Tauri's window API, which `shell/capabilities/window-controls.json` allows for the admin origin only. `scripts/test-admin-api.mjs` holds the two halves together: every method the type declares must have a route, and every route must be gated.

**One daemon, two ways in.** `bin/nestd.mjs` starts the daemon either headless or under the desktop shell (`--shell-pipe`, see `bin/shell-mode.mjs`); what differs is what is injected. Paths come from `platform-paths.mjs` and crypto from `secrets.mjs`, both fail-closed seams. Under the shell, the paths and the OSCrypt key arrive in `hello`; headless, they come from a directory and a key file. The test suites still stub a module named `electron` for a few legacy imports in test helpers; nothing in `daemon/` imports it.

**Twig owns its local file tools.** Twig's `fs_*` tools act on a folder on the *user's* machine and live in `redstart-twig/windows/electron/fs/`. They keep the `fs_*` prefix rather than adopting the upstream server's names, so the model — and an admin writing a tool ban — can tell Twig's local filesystem from Nest's server-side one. Only `path-scope.mjs` is duplicated between the apps; it is kept in sync by hand, and both copies say so.

**Chat-ui state.** `chat.svelte.ts` is a thin facade over focused sub-stores in `lib/stores/chat/` (UI state, runtime state, message repo, send pipeline, message ops, helpers). Dependencies flow one way and the public API is unchanged.

---

## Redstart Nest (dev mode)

The launcher and the chat-ui are **two separate npm packages** — you must install both:

```bash
cd redstart-nest
npm install                       # launcher, daemon and Tauri CLI deps
npm install --prefix src/chat-ui  # the SvelteKit chat-ui is its own package
node scripts/stage-node.mjs       # the pinned Node 26 the shell runs the daemon on
npm run dev
```

This starts Vite (React launcher UI), the SvelteKit chat-ui dev server, and the Tauri shell in debug (`cargo run` in `shell/`, via `scripts/dev-shell.mjs`), whose window loads Vite. It needs a Rust toolchain (`rustup`, stable). A debug shell runs this checkout's `bin/nestd.mjs`, uses your real `%APPDATA%\redstart` unless `REDSTART_CONFIG_DIR` points elsewhere, and never touches the login item or the updater. (`npm install` in `redstart-nest` does **not** install the chat-ui's dependencies — `npm run dev` launches the chat-ui dev server via `--prefix src/chat-ui`, so its `node_modules` must exist first.)

> **Note:** In dev mode the chat-ui runs on its own port (`:5174`). The `--path` flag that serves it through llama-server only applies in production builds.

> **Starting a model in dev:** the launcher UI runs fine without the inference binary, but **Start Server** needs `llama-server.exe`. In dev it's looked up at `redstart-nest/llama-cpp-turboquant/build/bin/Release/llama-server.exe` (or point at a custom path in Settings). See [Building the llama-server binary](#building-from-source--llama-server-binary) to produce it.

---

## The daemon, without the desktop shell

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

No window, no desktop session, no shell. The control plane comes up on
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

This is the fast loop for UI work: Redstart Nest keeps running and serving the API, the chat-ui hot-reloads, and neither a bundle build nor a shell restart is needed. The dev server proxies the API routes (`/v1`, `/props`, `/models`, `/tools`, `/slots`, `/auth`, `/files`, `/redstart`) to a Nest on `http://localhost:19080`; override with `VITE_PUBLIC_SERVER_ORIGIN`.

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
npm run check:mjs         # node --check across daemon + shared + bin
```

Two things the suites do not cover, and cannot as they stand:

- **The launcher window has no automated coverage at all.** Nothing opens the
  Tauri window in CI, so every change to `src/` is verified by running
  `npm run dev` and looking at it. The daemon behind it is covered thoroughly
  (`test-daemon-smoke.mjs`, `test-shell-pipe.mjs` and the admin suites), and
  the shell's Rust has unit tests (`cargo test` in `shell/`, run by CI on
  Windows and macOS). The tray and the window are checked by hand.
- **The installer itself is not exercised in CI.** The release workflow builds
  it, and `test-packaging.mjs` checks the staging script and Tauri config
  statically. Installing it, and the bridge from an Electron-era install, were
  run by hand (see the implementation notes).

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

> **Released installers don't build it at all.** The [release workflow](#releases) downloads TurboQuant+'s own prebuilt release (`windows-x64-cuda12.4`, `macos-arm64-metal`), checks it against a pinned SHA-256, and stages it into the same paths described below — so a source build and a downloaded one are interchangeable as far as `stage-shell-bundle.mjs` is concerned. Its `Stage llama-server` steps are also the quickest way to get a working binary locally without a CUDA toolchain.
>
> On **macOS** the layout is `llama-cpp-turboquant/build/bin/` (no `Release/` — that is an MSVC convention), holding `llama-server` and the `lib*.dylib` set beside it, and there is no `deps/` folder: Metal is a system framework.

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

`npm run build` builds the chat-ui and the launcher, then `scripts/stage-shell-bundle.mjs` copies **both** `llama-cpp-turboquant/build/bin/Release/` and `deps/windows/` into the staged `resources/bin/`, and `tauri build` packages it.

---

## Building installers

### Redstart Nest

Prerequisites: both packages' dependencies installed (`npm install` in `redstart-nest` **and** `npm install --prefix src/chat-ui`), a Rust toolchain, plus the llama-server binary and `deps/windows/` DLLs in place (see [Building from Source](#building-from-source--llama-server-binary)). The updater signature needs the signing key in the environment, `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Without them the build fails, so an installer that cannot be updated never comes out of it.

```bash
cd redstart-nest
npm run build
```

`npm run build` runs, in order:
- the chat-ui and launcher builds;
- the npm and Rust licence lists;
- `stage-node.mjs` (the pinned Node 26);
- `stage-shell-bundle.mjs`, which assembles `shell/bundle/resources/`: Node, the daemon with its production `node_modules`, `shared/`, the chat-ui, `bin/` and `elevate.exe`;
- `tauri build`.

Output: `shell/target/release/bundle/nsis/Redstart Nest_<version>_x64-setup.exe` and its `.sig`. The release workflow renames it to `Redstart-Nest-Setup-<version>.exe` and writes the update manifests (`scripts/make-shell-manifests.mjs`).

The version comes from `package.json` (`shell/tauri.conf.json` reads it). Don't bump it by hand — the [release workflow](#releases)
does that on every merge, in `redstart-nest/package.json` and
`redstart-twig/windows/package.json` together (it refuses to run if they
disagree).

On a Mac, `npm run build` produces `shell/target/release/bundle/dmg/*.dmg`
and the updater's `.app.tar.gz`, ad-hoc signed. Nest is Apple Silicon only,
because the only prebuilt Metal binary is arm64.

### Redstart Twig Windows

```bash
cd redstart-twig/windows
npm run build
```

Output: `redstart-twig/windows/release/<version>/Redstart Twig Setup <version>.exe`

The Windows build script builds the chat-ui first, then packages the Electron app (Twig is still Electron). Both Windows installers are NSIS-based and self-contained.

Despite the directory name, the same project builds Twig for macOS: `npm run build -- --mac` produces an `arm64` and an `x64` `.dmg`.

### Releases

[`.github/workflows/release.yml`](../.github/workflows/release.yml) runs whenever a pull request is **merged** into `main` (closing one unmerged does nothing), and can be started by hand from the Actions tab. It:

1. bumps `-alpha.N` in both `package.json` files, commits `chore(release): <version>` to `main` and pushes a matching tag — `1.0.0-alpha.4`, etc.;
2. builds four installers from that tag: Nest and Twig, each for Windows (NSIS `.exe`) and macOS (`.dmg`);
3. publishes one GitHub **prerelease** titled `Nest/Twig <version>` with all of them attached, plus GitHub's generated list of merged PRs.

Things worth knowing:

- **A failed build leaves a tag without a release.** If the failure was transient (a download, a runner), use **Re-run failed jobs** — it keeps the version already chosen; *Re-run all jobs* bumps again and skips a number. If it needs a code change, re-running rebuilds the same broken tag: merge the fix instead, let that cut the next version, and delete the orphaned tag (`git push origin :refs/tags/<version>`).
- **Leaving alpha is a manual step.** The bump only understands `X.Y.Z-alpha.N`; anything else stops the workflow with an error, so set the next version by hand in a PR when it is time for a beta or a 1.0.
- **Nothing is signed with a real identity.** Windows installers are unsigned, as before. macOS apps are ad-hoc signed: Nest by `stage-shell-bundle.mjs` (every Mach-O) plus Tauri's `signingIdentity: "-"`, Twig by [`scripts/mac-adhoc-sign.cjs`](../redstart-nest/scripts/mac-adhoc-sign.cjs). That is enough that Apple Silicon does not call them "damaged", but not enough to pass Gatekeeper without the user's *Open Anyway*.
- **Nest's updates ARE signed**, with the updater key (repo secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`; the public key is in `shell/tauri.conf.json`). Each build job writes a manifest fragment, and the release job merges them into `nest-latest.json`. The Windows job also writes `nest.yml`, which is how Electron-era installs find the bridge installer. Lose the key and no install can be updated again: keep a backup off the machine.
- **Moving the TurboQuant+ pin** means changing `TQP_TAG`, both asset names and both SHA-256 values at the top of the workflow, then re-reading the CUDA DLL entries in [`THIRD-PARTY-NOTICES.md`](../THIRD-PARTY-NOTICES.md) — a new CUDA major renames them. The Windows job's [`check-dll-closure.mjs`](../redstart-nest/scripts/check-dll-closure.mjs) step fails the build if the new set imports a DLL that was not staged.

### Redstart Twig Android

Build an APK in Android Studio:
- **Build → Build App Bundle(s) / APK(s) → Build APK(s)**
- Signed APK goes to `app/build/outputs/apk/release/`
