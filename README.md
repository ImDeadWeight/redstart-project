<p align="center">
  <img src="beaver-dam/public/beaver.svg" alt="Beaver logo" width="120" />
</p>

# Beaver

**A local LLM ecosystem for home/office use.** Run a model on your PC to use it as a coding agent or chat with it from any device on your home network — phone, laptop, or another desktop — with no cloud, no subscriptions, and no data leaving your house.

---

## Contents
- [Mission](#mission)
- [What Is Beaver?](#what-is-beaver)
- [How It Works](#how-it-works)
- [Using as a Coding Agent](#using-as-a-coding-agent-kilo-code--continue-etc)
- [Tested Configuration](#tested-configuration)
- [Requirements](#requirements)
- [Installation](#installation-end-users)
- [Development Setup](#development-setup)
- [Building Installers](#building-installers)
- [Roadmap](#roadmap)
- [Alternatives](#alternatives-worth-knowing-about)
- [Acknowledgements](#acknowledgements)

---

> **AI Assistance Disclosure**
> This project was built with significant help from [Claude Code](https://claude.ai/code) (Anthropic). The architecture, design decisions, and goals are the author's own. The implementation was a collaborative process between the author and an AI coding assistant. This is disclosed upfront because it is honest, not because it is something to hide.

---

## Screenshots

| Beaver Dam — server launcher | Chat UI |
|---|---|
| ![Beaver Dam launcher](docs/screenshot-beaver-dam.png) | ![Chat UI](docs/screenshot-chat-ui.png) |

---

## Origin

Beaver Dam started as a personal frustration fix. Running llama.cpp meant remembering and typing out long command-line arguments every time — model path, context size, GPU layers, port, host. I wanted a UI where I could save those settings and hit a button.

The primary use case was a **local coding agent**: point Kilo Code (or any OpenAI-compatible coding extension) at a locally running model and have a capable AI assistant that works without a subscription and never sends code off-device. Everything else — the Android app, the QR code, the Windows client — grew from wanting that same server accessible on my phone from the couch.

The privacy angle is not an afterthought. My background is in social work, where you routinely handle information that genuinely should not leave the room. The idea of pasting case notes or client details into a cloud AI product is uncomfortable but workloads in the field are often challenging making tools like llm workflows for documentation helpful. Running a model locally means the data stays on the machine — no API calls phoning home, no training pipeline, no terms of service to read carefully or settings to change.

I named it beaver in part because of how much it relies on llama and because a beaver builds a dam which felt like a fitting metaphor for keeping your AI use contained.

---

## Mission

Cloud AI services are priced to create dependency. A tool starts accessible, workflows get built around it, and then pricing changes — because it can. OpenAI, Microsoft Copilot, Google Gemini have all adjusted tiers, changed what's included, or shifted terms of service since launch. A small organization that builds its operations around any of them has no leverage and no guarantee those costs are stable next year.

Beaver's answer to that is simple: **own the hardware, run free software, pay once.**

A gaming PC with a capable GPU is a capital expense. It depreciates, but you own it. The model weights are a file you download. The software is open source. Nothing about any of that changes next year because a company decided to restructure its pricing.

**The liability problem is concrete, not abstract.**

For individuals and organizations in regulated fields, the question isn't just cost — it's whether cloud AI can be used at all without professional exposure:

- **Social work** — client confidentiality is a licensing requirement. Information leaving your network, even to a "secure" third-party service, is a legally uncomfortable position depending on jurisdiction.
- **Legal** — attorney-client privilege attaches to communications. Routing client details through a third-party API creates privilege questions most attorneys don't want to litigate.
- **Healthcare-adjacent** — HIPAA business associate agreements exist for this reason. Most cloud AI providers don't offer them outside enterprise tiers small organizations can't afford.
- **Education** — FERPA covers student records. Same problem.

For these organizations the question isn't "is cloud AI convenient?" It's "can we use it without liability?" For many the honest answer is no, or not without legal review they also can't afford.

**Local AI removes that question entirely.** If the data never leaves the building, there is no transmission, no third-party, no terms-of-service clause to parse. The model runs on your hardware. Your data stays on your hardware.

**Why open source matters here specifically.**

Beyond cost, open source software can be audited. In regulated industries that matters — you can verify what the software does and doesn't send. It can't be discontinued by a vendor decision. It can't be acquired and repriced. It doesn't lock you into a relationship with a company that may not exist in five years.

**The hardware case for small organizations.**

Grants fund capital expenditures. A purpose-built AI server is a line item in a capital grant application — something a foundation or government program can fund once. A recurring SaaS subscription competes with salaries and direct services every year and is harder to justify to funders.

The long-term goal of this project — a **Beaver Box**, a dedicated appliance that sits in the office and just works — is designed around this reality. A single hardware purchase, free software, zero ongoing cost. Staff on any device connect to it the way they'd connect to a printer. That's the shape a solution needs to take for a 6-person social work agency, a small legal aid clinic, or a community health provider that genuinely cannot afford enterprise AI and genuinely cannot send client data to the cloud.

The project isn't there yet. But that's the direction.

---

## What Is Beaver?

Beaver is a small ecosystem of apps built around [llama.cpp](https://github.com/ggerganov/llama.cpp) and [TurboQuant](https://github.com/TheTom/llama-cpp-turboquant). The core idea: your home PC probably has a GPU capable of running a decent LLM locally. Beaver makes it easy to start a model on that PC and reach it from any device on your home network.

There are three components:

| App | Platform | Role |
|---|---|---|
| **Beaver Dam** | Windows (Electron) | Server manager — loads and runs the model, broadcasts its location on the LAN |
| **Beaver Log** | Android (Capacitor) | Mobile client — scans for Beaver Dam automatically, or connect via QR code |
| **Beaver Log** | Windows (Electron) | Desktop client — same chat UI as Android, for connecting from another PC |

All three share the same [SvelteKit](https://kit.svelte.dev/) chat frontend, which is a modified fork of the upstream llama.cpp web UI.

---

## How It Works

```
[ GPU PC ]                          [ Phone / Laptop / VS Code ]
  Beaver Dam                           Beaver Log  /  Kilo Code
  ├─ llama-server (llama.cpp)       ├─ Scans LAN on port 8765
  ├─ Beacon on :8765                ├─ Finds Beaver Dam automatically
  └─ Chat UI + OpenAI API :8080     └─ Or connect manually to http://IP:8080
```

**Discovery:** Beaver Dam broadcasts a JSON beacon on port 8765. Beaver Log (both Android and Windows) scans the local subnet on startup and connects automatically if a running server is found. No configuration required.

**QR Connect:** Beaver Dam displays a QR code in the UI when network mode is on. Scanning it with the Android camera opens Beaver Log and connects to the server in one tap via a `beaver://connect` deep link.

**OpenAI-compatible API:** llama-server exposes `/v1/chat/completions` and related endpoints, so any tool that accepts a custom OpenAI base URL can use Beaver Dam as its backend — including coding agents, scripts, and API clients.

**Browser access:** When Beaver Dam is running, the chat UI is also accessible directly in any browser at `http://127.0.0.1:8080` (or `http://<LAN-IP>:8080` in network mode). No app required.

**HTTP only:** The LAN connection uses plain HTTP. HTTPS with self-signed certificates was tried and abandoned — Android WebView rejects them without manual cert trust, which is too much friction for a home tool. Proper transport security is on the roadmap, likely via a lightweight CA or certificate pinning approach, and becomes more important as the project moves toward small business use.

---

## Using as a Coding Agent (Kilo Code / Continue / etc.)

Since llama-server speaks the OpenAI API, any coding extension that accepts a custom base URL works out of the box.

**Kilo Code (VS Code extension):**
1. Open VS Code → Kilo Code settings
2. Set **API Provider** to `OpenAI Compatible`
3. Set **Base URL** to `http://127.0.0.1:8080/v1` (or your LAN IP if connecting from another machine)
4. Set **API Key** to any non-empty string (llama-server ignores it, but most clients require the field)
5. Set **Model** to the name of your loaded model (e.g. `Qwen3.6-35B-A3B-UD-Q3_K_XL`)

The same pattern applies to [Continue](https://continue.dev/), [Aider](https://aider.chat/), or any tool with OpenAI-compatible configuration.

---

## Tested Configuration

This is the hardware and model used during development. Results will vary by GPU, quantization level, and task type.

| | |
|---|---|
| **CPU** | AMD Ryzen 7 7700X |
| **GPU** | NVIDIA RTX 3060 12 GB |
| **RAM** | 32 GB DDR5 |
| **Model** | [Qwen3.6-35B-A3B-UD-Q3_K_XL](https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF) |
| **Speed** | ~25–30 tokens/sec on light coding tasks and summarization |

The Qwen 3.6 model is a 35B Mixture-of-Experts architecture with only ~3B parameters active at a time, which is why it fits and runs well on a 12 GB card. The TurboQuant Q3_K_XL quantization keeps quality high while staying within VRAM budget.

### Finding GGUF Models

The easiest source is [Hugging Face](https://huggingface.co). For the model above:

> **[unsloth/Qwen3.6-35B-A3B-GGUF](https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF)**

Download the `.gguf` file that matches your VRAM. The `Q3_K_XL` variant tested here weighs around 16 GB on disk but loads comfortably into 12 GB of VRAM with GPU layers set appropriately.

[Unsloth](https://huggingface.co/unsloth) and [bartowski](https://huggingface.co/bartowski) are both reliable sources for well-quantized GGUF files across many model families.

---

## Requirements

### Beaver Dam (server)
- Windows 10/11
- A GPU with at least 6 GB VRAM (NVIDIA recommended; llama.cpp supports CUDA and Vulkan)
- A GGUF model file

### Beaver Log Android
- Android 10 or later
- On the same Wi-Fi network as the Beaver Dam PC

### Beaver Log Windows
- Windows 10/11
- On the same network as the Beaver Dam PC (or on the same machine)

---

## Installation (End Users)

### Beaver Dam
1. Download `Beaver Dam Setup 1.0.0.exe` from [Releases](../../releases)
2. Run the installer — Windows Defender may warn about an unsigned binary, click **More info → Run anyway**
3. Open Beaver Dam, point it at a `.gguf` model file, and click **Start Server**
4. Turn on **Local network** mode to make the server reachable from other devices

### Beaver Log (Android)
1. Download `beaver-chat-ui.apk` from [Releases](../../releases)
2. On your phone, allow installation from unknown sources (Settings → Apps → Special app access → Install unknown apps)
3. Install the APK
4. Open the app — it scans automatically, or scan the QR code in Beaver Dam to connect

### Beaver Log (Windows)
1. Download `Beaver Log Setup 1.0.0.exe` from [Releases](../../releases)
2. Install and open — it scans your network automatically

---

## Development Setup

### Prerequisites
- [Node.js](https://nodejs.org/) 20+
- [Android Studio](https://developer.android.com/studio) (for Android builds only)
- [Java 17+](https://adoptium.net/) (for Android builds only)

### Repository Layout

```
beaver-project/
├── beaver-dam/          # Beaver Dam Electron app (server manager)
│   ├── electron/        # Electron main process
│   ├── src/
│   │   ├── App.tsx      # React UI (the launcher window)
│   │   └── chat-ui/     # SvelteKit chat frontend (shared with all clients)
│   │       └── android/ # Capacitor Android project
│   └── electron-builder.json
└── beaver-log/          # Beaver Log client apps
    └── windows/         # Beaver Log Windows Electron app
```

### Beaver Dam (dev mode)

```bash
cd beaver-dam
npm install
npm run dev
```

This starts Vite (React launcher UI), the SvelteKit chat-ui dev server, and Electron concurrently.

> **Note:** In dev mode the chat-ui runs on its own port (`:5174`). The `--path` flag that serves it through llama-server only applies in production builds.

### Chat UI only

```bash
cd beaver-dam/src/chat-ui
npm install
npm run dev:beaver
```

### Beaver Log Windows (dev mode)

The Windows client has no dev server — it just loads the built chat-ui. Build the chat-ui first, then:

```bash
cd beaver-dam/src/chat-ui
npm run build

cd ../../../windows
npm run dev
```

### Beaver Log Android

```bash
cd beaver-dam/src/chat-ui
npm install
npm run build

npx cap sync android
```

Then open `beaver-dam/src/chat-ui/android` in Android Studio and run on a device or emulator.

---

## Building from Source — llama-server Binary

> **Just want to use it?** Download the installer from [Releases](../../releases) — the binaries are already bundled and no extra steps are needed.

For contributors building the installer from scratch: Beaver Dam bundles `llama-server.exe` and its supporting DLLs (compiled from [TurboQuant](https://github.com/TheTom/llama-cpp-turboquant)) at build time. These are not committed to this repository. You need to build TurboQuant first and place the output at `beaver-dam/llama-cpp-turboquant/build/bin/Release/`.

Follow [TurboQuant's build instructions](https://github.com/TheTom/llama-cpp-turboquant) — you will need the NVIDIA CUDA Toolkit and Visual Studio C++ build tools. Once built, `npm run build` picks up the binaries automatically.

---

## Building Installers

### Beaver Dam

```bash
cd beaver-dam
npm run build
```

Output: `beaver-dam/release/1.0.0/Beaver Dam Setup 1.0.0.exe`

### Beaver Log Windows

```bash
cd windows
npm run build
```

Output: `windows/release/1.0.0/Beaver Log Setup 1.0.0.exe`

The Windows build script builds the chat-ui first, then packages the Electron app. Both installers are NSIS-based and self-contained.

### Beaver Log Android

Build an APK in Android Studio:
- **Build → Build App Bundle(s) / APK(s) → Build APK(s)**
- Signed APK goes to `app/build/outputs/apk/release/`

---

## Configuration

Beaver Dam stores its configuration at:

```
C:\Users\<you>\AppData\Roaming\beaver\profiles.json
```

Settings saved per profile:
- Model path
- Context size, batch size, thread count
- GPU layers
- Port (default: 8080)
- Network mode (localhost vs LAN)

There is currently no UI to manage multiple profiles — the file can be edited directly if needed.

---

## Ports Used

| Port | Purpose |
|---|---|
| 8080 | llama-server (default, configurable in Beaver Dam) |
| 8765 | Beacon server — Beaver Dam identity broadcast |

Both ports are local only unless network mode is enabled on port 8080. Port 8765 always binds to `0.0.0.0` so LAN clients can discover the server.

---

## Known Limitations

- **Unsigned installers** — both installers will trigger Windows Defender SmartScreen. This is expected for unsigned binaries distributed outside the Microsoft Store. A code signing certificate would resolve this.
- **Android sideload required** — the app is not on the Play Store. Installation requires enabling "unknown sources."
- **No authentication** — the llama-server API has no auth. Anyone on your home network can use it. Do not expose port 8080 to the public internet.
- **Single profile active at a time** — Beaver Dam manages one running model at a time.
- **Windows only for server** — Beaver Dam is Windows-only. The client apps (Beaver Log) can run anywhere, but the server manager requires Windows because it shells out to a Windows llama.cpp binary.
- **Tokens/min display is unreliable** — the tok/min counter shown in the Beaver Dam header is a known bug. The number it displays is not accurate. This is a known issue and will be fixed in a future update.

---

## Roadmap

This is an honest work-in-progress. The project started as a personal home tool and is evolving toward a private AI solution for small organizations. The roadmap reflects that shift in priority.

### Working Now
- [x] Start/stop llama.cpp model from a GUI
- [x] LAN network mode with automatic port binding
- [x] Beacon-based zero-configuration device discovery
- [x] Android app with automatic LAN scan on launch
- [x] QR code deep link — scan to open app and auto-connect
- [x] Windows desktop client (Beaver Log)
- [x] Shared SvelteKit chat UI across all clients
- [x] Server log displayed in Beaver Dam UI (piped mode)
- [x] OpenAI-compatible API for use with coding agents (Kilo Code, Continue, etc.)
- [x] Direct browser access to chat UI at `http://127.0.0.1:8080`

### Phase 2 — Small Office Ready
Making Beaver usable in a small workplace rather than just on one person's home network.

- [ ] Basic user authentication — staff accounts and an admin role so not everyone can change settings or restart the model
- [ ] Per-user conversation history — currently all sessions share the same interface
- [ ] Admin interface accessible from any device on the network — manage the server without touching the host PC
- [ ] Auto-restart on crash — if the model dies at 9am Monday, it recovers without manual intervention
- [ ] Signed installers — removes the Windows Defender SmartScreen warning, looks professional in a workplace setting
- [ ] macOS support — many non-profits and small agencies run Macs

### Phase 3 — The Beaver Box (Office Appliance)
The long-term goal: a purpose-built machine that sits in the office and runs the model headlessly. No monitor, no babysitting — staff connect to it the way they'd connect to a printer, from any device on the network.

- [ ] Headless / service mode — Beaver Dam runs as a background service with no launcher window required
- [ ] Web-based admin UI — manage everything from a browser on any device on the network
- [ ] Linux support — run on a dedicated mini PC, NAS, or low-power server
- [ ] Auto-start on boot
- [ ] Document querying (RAG) — staff can upload policy manuals, templates, and reference documents and query against them
- [ ] iOS client (Beaver Log for iPhone)
- [ ] Model library management — browse, download, and switch models from any client device

### Honest Shortcoming
The reliability bar for a small business is materially higher than for a personal home project. If this is running in a social work office and the server crashes mid-day, staff need it to recover on its own — not wait for someone technical to fix it. That kind of robustness requires systems and operations experience that is currently a gap in this project. It is acknowledged here openly rather than papered over. Contributions from developers with reliability or infrastructure background are particularly welcome.

---

## Acknowledgements

- [llama.cpp](https://github.com/ggerganov/llama.cpp) — the inference engine that makes all of this possible
- [TurboQuant](https://github.com/TheTom/llama-cpp-turboquant) — the llama.cpp build and quantization tooling used here; the included `llama-server.exe` comes from this project
- [Unsloth](https://huggingface.co/unsloth) — pre-quantized GGUF models including the Qwen 3.6 model used during development
- [llama.cpp web UI](https://github.com/ggerganov/llama.cpp/tree/master/examples/server) — the upstream chat UI that the Beaver chat frontend is forked from

---

## License

See [LICENSE.txt](beaver-dam/LICENSE.txt).

---

## Alternatives Worth Knowing About

If you just want to run a model on a single PC, these are more mature options:

- **[LM Studio](https://lmstudio.ai/)** — polished GUI, built-in model browser, downloads GGUFs directly, OpenAI-compatible server. Windows/Mac/Linux.
- **[Jan](https://jan.ai/)** — similar to LM Studio, fully open source.
- **[Ollama](https://ollama.com/)** — CLI-first but extremely simple (`ollama run qwen3`), large ecosystem of community UIs built on top.

All three can technically be reached from other devices on your LAN if you manually configure them to bind to `0.0.0.0` — but you are then on your own for finding the IP address and entering it in whatever client you use. None have a mobile app that discovers the server automatically, and none have a QR-to-connect flow.

Beaver's niche is making the **home network experience feel like a first-class feature** rather than a manual network configuration exercise. If single-PC use is all you need, LM Studio is probably the better starting point.

---

## Author

Patrick Carswell — this is my first major development project, built to solve a personal problem: running a local AI on existing home hardware without sending data to the cloud. My background is in social work, not software, so some of the architecture decisions here reflect learning-by-doing as much as deliberate design. The codebase reflects that honestly.
