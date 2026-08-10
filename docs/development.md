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
├── redstart-nest/         # Redstart Nest Electron app (server manager)
│   ├── electron/main/     # Electron main process — gateway, MCP server, providers
│   ├── scripts/           # Security/contract test suites (npm run test:security)
│   ├── src/
│   │   ├── App.tsx        # React UI (the launcher window)
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

**Two frontend frameworks, two jobs.** React owns the launcher window only — the native Electron surface that starts and stops the model, picks folders, and manages accounts, talking to the main process over IPC. SvelteKit owns the chat UI, which is served over HTTP and shared by every client (browser, Twig Windows, Twig Android, Blueprints). They share no state, no routing and no auth code, and neither imports from the other; the boundary is the process/HTTP line.

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
npm run check:mjs         # node --check across electron/main + shared
```

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
`release/${version}`. Currently `1.0.0-alpha.1` — the project ships as alpha
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
