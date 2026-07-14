> **📦 This project has moved.** Beaver is being renamed to **American Redstart** (unrelated naming conflict with an established beaver-named project in the same space). Active development now happens at **[github.com/ImDeadWeight/redstart-project](https://github.com/ImDeadWeight/redstart-project)** — this repo is kept in place so existing links keep working, but it will not receive further updates. Please update your bookmarks/links when convenient.

<p align="center">
  <img src="beaver-dam/public/beaver.svg" alt="Beaver logo" width="120" />
</p>

# Beaver

**Not affiliated with Microsoft's obeaver, which I found out about after publishing this project**

**A local LLM ecosystem for home/office use.** Run a model on your PC to use it as a coding agent or chat with it from any device on your home network — phone, laptop, or another desktop — with no cloud, no subscriptions, and no data leaving your house.

---

## Contents
- [Mission](#mission)
- [What Is Beaver?](#what-is-beaver)
- [How It Works](#how-it-works)
- [Tools & MCP](#tools--mcp)
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
> This project was developed using Claude Code as an AI pair programmer. I designed the product, architecture, user experience, and technical direction, while using Claude to accelerate implementation, debugging, and code generation. All design decisions and final technical choices were made by me.

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

I named it beaver due to its reliance on Llama.cpp, another animal named ai tool, and because beaver builds a dam — which felt like a fitting metaphor for keeping your AI use contained.

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

Beaver is a small ecosystem of apps built around [TurboQuant+](https://github.com/TheTom/llama-cpp-turboquant), a production-grade fork of [llama.cpp](https://github.com/ggerganov/llama.cpp) that adds advanced weight and KV-cache quantization. The core idea: your home PC probably has a GPU capable of running a decent LLM locally. Beaver makes it easy to start a model on that PC and reach it from any device on your home network.

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
[ GPU PC ]                              [ Phone / Laptop / VS Code ]
  Beaver Dam                               Beaver Log  /  Kilo Code
  ├─ Gateway     :8080 (public)        ├─ Scans LAN on port 8765
  │   └─ Injects Beaver context        ├─ Finds Beaver Dam automatically
  ├─ llama-server :8081 (localhost)    └─ Connects to http://IP:8080
  ├─ MCP server   :8082 (web_fetch)
  └─ Beacon      :8765
```

**Discovery:** Beaver Dam broadcasts a JSON beacon on port 8765. Beaver Log (both Android and Windows) scans the local subnet on startup and connects automatically if a running server is found. No configuration required.

**QR Connect:** Beaver Dam displays a QR code in the UI when network mode is on. Scanning it with the Android camera opens Beaver Log and connects to the server in one tap via a `beaver://connect` deep link.

**OpenAI-compatible API:** llama-server exposes `/v1/chat/completions` and related endpoints, so any tool that accepts a custom OpenAI base URL can use Beaver Dam as its backend — including coding agents, scripts, and API clients.

**Browser access:** When Beaver Dam is running, the chat UI is also accessible directly in any browser at `http://127.0.0.1:8080` (or `http://<LAN-IP>:8080` in network mode). No app required.

**HTTP only:** The LAN connection uses plain HTTP. HTTPS with self-signed certificates was tried and abandoned — Android WebView rejects them without manual cert trust, which is too much friction for a home tool. Proper transport security is on the roadmap, likely via a lightweight CA or certificate pinning approach, and becomes more important as the project moves toward small business use.

---

## Tools & MCP

Beaver Dam includes a built-in [Model Context Protocol](https://spec.modelcontextprotocol.io/) (MCP) server that gives the model access to live web content from approved sources — Wikipedia, GitHub, AP News, legal references, arXiv, PubMed, and others. This is off by default and configured per profile.

### Architecture

When the server starts, Beaver Dam launches three services alongside the AI model:

| Service | Port | Role |
|---|---|---|
| Gateway | `:8080` | Public-facing; injects Beaver identity + tool context into every completions request |
| llama-server | `:8081` | Inference engine; localhost-only, not reachable from LAN |
| MCP server | `:8082` | Exposes the `web_fetch` tool to the chat-ui via the MCP SSE protocol |

The chat-ui's built-in agentic loop handles the full tool call cycle: it sees the `web_fetch` tool available via the MCP server, the model emits a tool call when it needs to look something up, the chat-ui executes the fetch through the MCP server, and the result feeds back into the next model turn — all with full streaming preserved.

### Whitelist Enforcement

The whitelist is enforced **at the MCP server level** — not just as a system prompt advisory. A request to a domain that is not on the approved list never leaves the machine. The MCP server validates every URL before the network call goes out and returns an `Access denied` error to the model if the domain is not whitelisted.

The gateway also injects the approved source list into the system context of every conversation, so the model knows which domains are available and can make appropriate tool calls without guessing.

A law firm might approve only the specific legal databases their practice relies on, scoped to their local jurisdiction. Large models can conflate laws from different states when synthesizing across multiple sources; a whitelist restricted to one jurisdiction's databases reduces that risk at the source — and technical enforcement at the MCP layer means a jailbreak attempt in the prompt cannot override it.

### Source Groups

Tools are organized into **source groups** — named collections of web sources that can be activated together. The built-in groups are:

| Group | Sources |
|---|---|
| General Knowledge | Wikipedia, AP News |
| Developer | GitHub, MDN Web Docs, Stack Overflow |
| News | AP News, BBC, Reuters |
| Legal (US) | Cornell LII, Congress.gov, Wikipedia |
| Research | arXiv, PubMed, Wikipedia |

These are proof-of-concept defaults. In practice, an organization defines their own groups from the sources they actually trust and control. A custom group for a specific use case — say, a healthcare provider's internal knowledge base plus PubMed — can be created in the UI and exported for deployment across multiple Beaver installations. Groups can be combined; their tool lists merge when multiple are active simultaneously.

### External MCP Servers

The **Tools** card in Beaver Dam also supports connecting to MCP servers running on **other devices**. An admin can enter any MCP SSE endpoint URL (e.g. `http://10.0.0.5:9000/sse`) and Beaver Dam will treat it as an additional tool source alongside the built-in server. This enables a few patterns:

- **Dedicated MCP appliance** — the MCP server runs on a separate machine (a small server, NAS, or the future Beaver Box) with more generous network access policies, separate from the AI model host
- **Shared company tool server** — one MCP server on the network serves multiple Beaver Dam installations without each needing its own whitelist configuration
- **Specialized tool sets** — a legal practice might run a separate MCP server that connects to their document management system or jurisdiction-specific databases

The Beaver Dam beacon (port 8765) advertises both the built-in MCP server URL and any active external servers, so Beaver Log clients and other devices on the LAN can discover the full tool set automatically.

### Configuring in Beaver Dam

The **Tools** card appears in the main configuration panel between the model settings and the command preview. It has two sections:

**Web Sources** (top, toggle to enable/disable):
- Enable or disable source groups with checkboxes
- Toggle individual sources independently
- Create custom source groups from any combination of built-in or custom sources
- Add custom sources by URL and description
- Set the per-fetch token budget (default: 2000 tokens per fetch)

**External MCP Servers** (bottom, always visible):
- Shows the built-in Beaver MCP URL (`http://localhost:8082/sse`) when enabled
- Add external MCP servers by name and SSE URL
- Test connectivity to any configured server with a single click
- Remove servers that are no longer needed

All settings are saved with the active profile — different profiles can have different tool configurations.

### Performance

Each tool call adds 2–5 seconds of latency. The model's response appears after all fetches complete. Context sizes below 8192 tokens are flagged with a warning since fetched content competes with conversation history. Beaver Dam shows a red warning below 4096 tokens where tool use is likely to break the context entirely.

### Storage

User-defined tools, groups, and external MCP server configurations are stored in `tools.json` in the Electron userData directory alongside `profiles.json`. Built-in sources and groups are hardcoded and can be toggled off per-profile but not deleted.

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

**The model:** Qwen3.6-35B-A3B is an Alibaba model with a hybrid Gated DeltaNet and Gated Attention architecture, 256 experts with 8 routed and 1 shared active at a time — totalling ~3B active parameters out of 35B. That's why it fits and runs at useful speed on a 12 GB card that would be completely unusable with a dense 35B model.

**The quantization:** The `UD` prefix stands for Unsloth Dynamic — [Unsloth AI](https://huggingface.co/unsloth) applies different quantization levels to different layers intelligently rather than a flat bit-depth across the whole model. This gives meaningfully better output quality at the same file size compared to a standard K-quant. Credit to Unsloth for the conversion and for making this model accessible in GGUF format.

### Finding GGUF Models

The easiest source is [Hugging Face](https://huggingface.co). For the model above:

> **[unsloth/Qwen3.6-35B-A3B-GGUF](https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF)**

Unsloth provides multiple quantization variants. The `UD-Q3_K_XL` tested here fits comfortably in 12 GB of VRAM. Higher quantizations (Q4 and above) are available if you have more VRAM or are willing to offload some layers to system RAM.

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
- Port (default: 8080) — MCP server uses `port + 2` automatically
- Network mode (localhost vs LAN)
- Web source configuration (enabled/disabled, active source groups, per-fetch token budget)

User-defined tools, groups, and external MCP server connections are stored separately in:

```
C:\Users\<you>\AppData\Roaming\beaver\tools.json
```

The `tools.json` schema:
```json
{
  "tools": [ { "id": "...", "name": "...", "baseUrl": "...", "description": "..." } ],
  "groups": [ { "id": "...", "name": "...", "description": "...", "toolIds": ["..."] } ],
  "externalServers": [ { "id": "...", "name": "...", "url": "...", "enabled": true } ]
}
```

Profile management (save, load, delete) is available directly in the Beaver Dam UI.

---

## Ports Used

| Port | Purpose |
|---|---|
| 8080 | Gateway — public-facing; all clients connect here (default, configurable in Beaver Dam) |
| 8081 | llama-server — internal only, bound to `127.0.0.1`; not reachable from LAN |
| 8082 | MCP server — built-in web_fetch tool endpoint; LAN-accessible when network mode is on |
| 8765 | Beacon — Beaver Dam identity broadcast, always bound to `0.0.0.0` for LAN discovery |

Ports 8080 and 8082 are LAN-accessible when network mode is on (Beaver Dam adds Windows Firewall inbound rules automatically for both). Port 8081 is localhost only regardless of network mode. All three shift together if you change the configured port — llama-server is always `configured-port + 1`, and the MCP server is always `configured-port + 2`.

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
- [x] Built-in MCP server — exposes `web_fetch` tool via Model Context Protocol SSE transport; whitelist enforced at the server level (non-whitelisted URLs never leave the machine)
- [x] Source groups — named bundles of web sources (General Knowledge, Developer, News, Legal US, Research) with per-profile activation; custom groups and sources supported
- [x] External MCP server management — connect to MCP servers on other devices; beacon advertises all active MCP endpoints for auto-discovery

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
