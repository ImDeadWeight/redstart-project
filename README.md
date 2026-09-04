<p align="center">
  <img src="redstart-nest/public/redstart.svg" alt="Redstart logo" width="120" />
</p>

# Redstart

**A local AI server for a household or small team.** Redstart Nest runs local models on hardware you own and exposes them to the applications you work in — chat from your phone or laptop, query your data, or drive a coding agent in your IDE. You choose the models, decide which applications and users can connect, and control what those tools can reach.

LM Studio, Jan and Ollama are model runners — very good ones — aimed at getting a model going on the PC in front of you. Redstart is the layer after that: accounts, tool policy and network discovery, so the model on the GPU box is usable from every device in the house. [How it compares](#alternatives-worth-knowing-about).

**Documentation:** [Mission](docs/mission.md) · [Architecture](docs/architecture.md) · [Security](docs/security.md) · [Capabilities](docs/capabilities.md) · [Configuration](docs/configuration.md) · [Development](docs/development.md) · [Testing](TESTING.md) · [Deployment](deploy/README.md) · [Roadmap](docs/roadmap.md)

---

> **AI Assistance Disclosure**
> This project was developed using Claude Code as an AI pair programmer. I designed the product, architecture, user experience, and technical direction, while using Claude to accelerate implementation, debugging, and code generation. All design decisions and final technical choices were made by me.

---

## Screenshots

**Redstart Nest — server launcher**

| Configuration | Models | Tools | Server |
|---|---|---|---|
| ![Nest configuration tab](docs/screenshot-redstart-nest.png) | ![Nest models tab — local storage and Hugging Face browser](docs/screenshot-nest-models.png) | ![Nest tools tab — capabilities like web access, Postgres, Documents, SQLite, Vault](docs/screenshot-nest-tools.png) | ![Nest server tab — live server terminal](docs/screenshot-nest-server.png) |

**Redstart Twig / chat UI**

| Login | Chat | Settings — General | Settings — Tools | Settings — Accounts |
|---|---|---|---|---|
| ![Login screen](docs/screenshot-login.png) | ![Chat UI](docs/screenshot-chat-ui.png) | ![Settings — General](docs/screenshot-chat-settings-general.png) | ![Settings — Tools, per-tool enable and always-allow](docs/screenshot-chat-settings-tools.png) | ![Settings — Accounts, with per-account roles](docs/screenshot-chat-settings-accounts.png) |

| Settings — Roles | Settings — System Prompt | Settings — Connectors | Your account | Your files |
|---|---|---|---|---|
| ![Settings — Roles](docs/screenshot-chat-settings-roles.png) | ![Settings — System Prompt](docs/screenshot-chat-settings-system-prompt.png) | ![Settings — Connectors, per-app API keys](docs/screenshot-chat-settings-connectors.png) | ![Your account page](docs/screenshot-chat-account.png) | ![Your files on the server](docs/screenshot-chat-files.png) |

---

## What Nest does

**Redstart Nest is the server.** It runs the model, and it owns the four things a
model on its own doesn't have: who may use it, what it may reach, how devices
find it, and who may administer it. Everything else — Twig, a browser, a coding
agent — is a client that connects and gets whatever the admin configured once.

- **Runs the model.** llama.cpp on your hardware, bound to loopback, driven from a launcher that handles model files, GPU offload and the server lifecycle. Closing the window doesn't stop it; it keeps serving from the tray.
- **Serves every device on the network.** Nest broadcasts a beacon, so Twig finds it with no configuration and a phone camera can open the chat UI from a QR code. The chat UI is served by Nest itself, so any browser works with nothing installed.
- **Owns accounts and roles.** Login is on by default with no localhost exemption, roles are assigned per account, and each account's files are structurally isolated from every other's.
- **Owns the tool policy.** Capabilities and plugins are configured once on the server and apply to every client. Each client authenticates with a per-connector key that carries its own *surface*, so the server knows which app is calling from the credential rather than from a header it could fake.
- **Keeps control separate from chat.** The admin plane is a different port, a different lifetime and a different login: signing in to the chat UI does not give you process control.
- **Controls egress explicitly, and will tell you.** Nothing about a conversation leaves by default; what can leave is exactly what an admin turned on, and `GET /egress` returns the live answer.

### Redstart Twig

The chat client that ships in this repo — a lightweight app that finds Nest on
the LAN and signs in, with no hostname to type. **Windows works. The Android
build is out of date and paused** ([see note](#redstart-twig-android)); a phone
browser against the chat UI is the working substitute in the meantime.

Since llama-server speaks the OpenAI API, [coding agents](#using-as-a-coding-agent-kilo-code--continue--etc) and any other OpenAI-compatible application are clients too, with no Redstart-specific code.

---

## How it works

```
[ GPU PC ]                              [ Phone / Laptop / VS Code / Browser ]
  Redstart Nest                            Redstart Twig  /  Kilo Code
  ├─ Gateway     :19080 (LAN in network mode) ├─ Scans LAN on port 8765
  │   └─ Injects Redstart context      ├─ Finds Redstart Nest automatically
  ├─ llama-server :19081 (localhost)   └─ Connects to http://IP:19080
  ├─ MCP server   :19082 (web_fetch, web_search, Postgres, Documents, SQLite, Vault, Git, File System, Scholar)
  ├─ Admin plane :19083 (the launcher UI, in a browser — owner only, loopback by default)
  └─ Beacon      :8765
```

The chat UI is reachable in any browser at `http://127.0.0.1:19080`, and at the Nest machine's LAN address once network mode is on — no app required.

**Two planes, two lifetimes.** 19080/19081/19082 exist because a model is running and go away when it stops. **19083 is the control plane** — it binds when Redstart Nest starts and stays up whether or not a model is, because a plane whose lifetime is tied to the thing it controls cannot be used to start that thing. It serves the same launcher interface in a browser, so the box can be administered from another device, and it authenticates separately: signing in to the chat UI does *not* give you process control. It listens on loopback unless you deliberately move it.

Details: [Architecture](docs/architecture.md) · [Capabilities](docs/capabilities.md) · [Security](docs/security.md)

---

## Control, not isolation

Inference is local and architecturally so — llama-server runs on your machine, bound to loopback, and nothing about a conversation is transmitted anywhere by default. What *can* leave is exactly what an administrator turns on: approved web domains, academic search, an external tool server on another host, or an installed [plugin](docs/capabilities.md#plugins) configured with a credential. Each is an explicit, auditable choice.

The honest one-line version is **local inference with administrator-controlled egress**, and the server will tell you the live answer — `GET /egress` returns which domains are approved, which tool servers are remote, and which local stores exist. See [Security → What actually leaves the machine](docs/security.md#what-actually-leaves-the-machine).

Accounts are **on by default** with no localhost exemption, and each account's files are structurally isolated from every other's. **Do not expose the gateway port to the public internet.**

---

## Requirements

**Redstart Nest (server)**
- Windows 10/11
- A GPU with at least 6 GB VRAM (NVIDIA recommended; llama.cpp supports CUDA and Vulkan)
- A GGUF model file

**Redstart Twig (Android)** — Android 10 or later, on the same Wi-Fi network as the Nest PC. **Not currently working** — [see note](#redstart-twig-android).

**Redstart Twig (Windows)** — Windows 10/11, on the same network as the Nest PC (or on the same machine).

---

## Installation

> **Alpha software.** Releases are published as prereleases and versioned
> `1.0.0-alpha.N`. Expect rough edges, and do not run this where losing data or
> exposing a service would matter.

### Redstart Nest
1. Download the latest `Redstart Nest Setup 1.0.0-alpha.N.exe` from [Releases](../../releases)
2. Run the installer — Windows Defender may warn about an unsigned binary, click **More info → Run anyway**
3. Open Redstart Nest. It opens on a setup screen asking for this machine's **setup code** and the Owner credential you want. On the host itself the code is filled in for you; it also lives in plain text at `bootstrap-token.txt` in Nest's config folder. Login is required by default, so until an Owner exists no device — including a browser on this PC — can sign in to the chat UI. (Home users who don't want accounts can flip **Require login** off afterwards.)

   The setup code is a **recovery credential, not a password** — it is deliberately stored in plain text and meant to be readable by whoever has physical access to the box, like the sticker on the bottom of a router. It is also the way back in if the Owner password is lost: the same screen re-keys the Owner account, which signs out every existing session.
4. Point it at a `.gguf` model file and click **Start Server**
5. In **Configuration → Network**, turn on **Local network** mode to make the server reachable from other devices — each person signs in with an account the Owner/Admins create. The same panel shows the addresses to browse to, including a QR code to scan from a phone

**Closing the window does not stop the server.** Redstart Nest keeps running in the tray so the model stays available to everyone else on the network; reopening the window reconnects to the daemon that was already running. To actually stop it, use **Shut down** in the launcher or **Quit Redstart** in the tray menu.

**Administering it from another device** is off by default. The same Network panel has a second switch for the admin panel itself — separate from the one above, because making the chat UI reachable and making *process control* reachable are different decisions. Turn it on and the launcher interface is available at `http://<nest-ip>:19083`, Owner account only.

### Redstart Twig (Android)

> **Currently out of date and not working.** The Android client has fallen behind
> the server and has not been rebuilt against recent Nest changes; the published
> APK should not be relied on. This is paused, not abandoned — returning to it is
> planned, but it is not being worked on right now.
>
> **In the meantime, use a phone browser instead.** The chat UI is served directly
> by Nest, so browsing to `http://<nest-ip>:19080` — or scanning the QR code in
> **Configuration → Network** — gives you the same interface on Android with no app
> installed. Redstart Twig for Windows is unaffected and works normally.

1. Download `redstart-twig.apk` from [Releases](../../releases)
2. On your phone, allow installation from unknown sources (Settings → Apps → Special app access → Install unknown apps)
3. Install the APK
4. Open the app — it finds the server automatically by scanning the LAN for the beacon on port 8765; no hostname or QR code needed

### Redstart Twig (Windows)
1. Download the latest `Redstart Twig Setup 1.0.0-alpha.N.exe` from [Releases](../../releases)
2. Install and open — it scans your network automatically

---

## Using as a coding agent (Kilo Code / Continue / etc.)

Since llama-server speaks the OpenAI API, any coding extension that accepts a custom base URL works out of the box.

**Kilo Code (VS Code extension):**
1. Open VS Code → Kilo Code settings
2. Set **API Provider** to `OpenAI Compatible`
3. Set **Base URL** to `http://127.0.0.1:19080/v1` (or your LAN IP if connecting from another machine)
4. Set **API Key** to your account's `rst_` API key (when login is on, which is the default); when login is off, any non-empty string works
5. Set **Model** to the name of your loaded model (e.g. `Qwen3.6-35B-A3B-UD-Q3_K_XL`)

The same pattern applies to [Continue](https://continue.dev/), [Aider](https://aider.chat/), or any tool with OpenAI-compatible configuration.

---

## Tested configuration

This is the hardware and model used during development. Results will vary by GPU, quantization level, and task type.

| | |
|---|---|
| **CPU** | AMD Ryzen 7 7700X |
| **GPU** | NVIDIA RTX 3060 12 GB |
| **RAM** | 32 GB DDR5 |
| **Model** | [Qwen3.6-35B-A3B-UD-Q3_K_XL](https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF) |
| **Speed** | ~25–30 tokens/sec on light coding tasks and summarization; 41–45 tokens/sec generating a 5-page report (29s total) after letting llama-server's own `--fit` auto-size GPU/CPU offload instead of a fixed manual split |

**The model:** Qwen3.6-35B-A3B is an Alibaba model with a hybrid Gated DeltaNet and Gated Attention architecture, 256 experts with 8 routed and 1 shared active at a time — totalling ~3B active parameters out of 35B. That's why it fits and runs at useful speed on a 12 GB card that would be completely unusable with a dense 35B model.

**The quantization:** The `UD` prefix stands for Unsloth Dynamic — [Unsloth AI](https://huggingface.co/unsloth) applies different quantization levels to different layers intelligently rather than a flat bit-depth across the whole model. This gives meaningfully better output quality at the same file size compared to a standard K-quant.

**Finding GGUF models:** [Hugging Face](https://huggingface.co) is the easiest source — [unsloth](https://huggingface.co/unsloth) and [bartowski](https://huggingface.co/bartowski) are both reliable for well-quantized GGUF files across many model families. The `UD-Q3_K_XL` tested here fits comfortably in 12 GB of VRAM.

---

## Known limitations

The short list; the [full set is in the roadmap](docs/roadmap.md#known-limitations).

- **Twig for Android is out of date and not working** — the Android client hasn't been rebuilt against recent server changes. Use a phone browser against the chat UI instead. Paused, not abandoned; see [the note above](#redstart-twig-android).
- **Unsigned installers** — both will trigger Windows Defender SmartScreen.
- **Windows is the only supported server platform** — the daemon itself runs headless under plain Node and `deploy/` carries a systemd unit, but the installer, the bundled llama.cpp binary and the port-80 proxy are all Windows, and none of the Linux artifacts has been run on real hardware yet.
- **The deployment artifacts are a first draft** — `deploy/` (systemd, Windows SCM, Caddy) was written from the design and reviewed, not executed. Read each command before running it.
- **HTTP only on the LAN** — self-signed TLS was tried and abandoned; Android WebView rejects it. For a deployment that needs TLS, `deploy/Caddyfile` terminates it in front of Nest.
- **mDNS / `redstart.local` has been retired** — Android's resolver never answered `.local` lookups for browser navigation, so the name failed on the platform most clients are. Use the IP or the QR code; Twig's beacon scan never needed a name.
- **Shared capabilities are all-or-nothing** — Vault, Git, SQLite and Postgres are shared across every account, with no per-account grants yet.

---

## Development

```bash
cd redstart-nest
npm install
npm install --prefix src/chat-ui   # the chat-ui is its own package
npm run dev
```

To run the server without Electron — no window, no desktop session:

```bash
npm run daemon          # boots the daemon under plain Node, in ./.redstart-daemon
npm run daemon:status
npm run daemon:stop
```

Full setup, repo layout, test commands and installer builds: [Development](docs/development.md). Manual verification checklists: [Testing](TESTING.md). Running it as a service: [Deployment](deploy/README.md).

---

## Alternatives worth knowing about

If you just want to run a model on a single PC, these are more mature options:

- **[LM Studio](https://lmstudio.ai/)** — polished GUI, built-in model browser, downloads GGUFs directly, OpenAI-compatible server. Windows/Mac/Linux.
- **[Jan](https://jan.ai/)** — similar to LM Studio, fully open source.
- **[Ollama](https://ollama.com/)** — CLI-first but extremely simple (`ollama run qwen3`), large ecosystem of community UIs built on top.

All three can technically be reached from other devices on your LAN if you manually configure them to bind to `0.0.0.0` — but you are then on your own for finding the IP address and entering it in whatever client you use. None have a mobile app that discovers the server automatically, and none have a QR-to-connect flow.

Redstart's niche is the thing those don't try to be: a server for a group of people rather than a runner for one PC. Making the **home network experience a first-class feature** instead of a manual network-configuration exercise, and treating **accounts, tool policy and egress control as the product** rather than something bolted on afterwards, is the whole distinction. If single-PC use is all you need, LM Studio is probably the better starting point.

---

## Direction

Nest's own roadmap — folder access grants, crash recovery, signed installers,
document querying, macOS — is in [Roadmap](docs/roadmap.md), along with the
limitations it hasn't cleared yet.

Beyond Nest and Twig, the same server is what these are being built against.
They live in their own repos and are **not** required to use Redstart:

| App | Platform | Role | Status |
|---|---|---|---|
| **[Redstart Blueprints](https://github.com/ImDeadWeight/redstart-blueprints)** | Windows (Electron) | Local-first SQL data workbench with optional AI assistance | In progress |
| **[Redstart Yellowscript](https://github.com/ImDeadWeight/redstart-yellowscript)** | VS Code extension | A coding agent that talks to a local Nest instead of a cloud | In progress |
| **[Redstart Greenhouse](https://github.com/ImDeadWeight/redstart-greenhouse)** | Windows (Electron) | Project management, built the way Blueprints is built | Planned, not started |

What makes that plausible rather than aspirational is that the integration
points are contracts, not conventions: a client authenticates with a
per-connector key carrying its own surface, and tool names are namespaced per
app (`bp_*`, `ys_*`, `gh_*` — see [tool namespacing](docs/tool-namespacing.md)),
so a new client is a credential and a namespace rather than a change to the
server. See [Architecture](docs/architecture.md) for the full picture.

---

## Acknowledgements

- [llama.cpp](https://github.com/ggerganov/llama.cpp) — the inference engine that makes all of this possible
- [TurboQuant](https://github.com/TheTom/llama-cpp-turboquant) — the llama.cpp build and quantization tooling used here; the included `llama-server.exe` comes from this project
- [Unsloth](https://huggingface.co/unsloth) — pre-quantized GGUF models including the Qwen 3.6 model used during development
- [llama.cpp web UI](https://github.com/ggerganov/llama.cpp/tree/master/examples/server) — the upstream chat UI that the Redstart chat frontend is forked from

---

## License

See [LICENSE.txt](redstart-nest/LICENSE.txt).

---

## Author

Patrick Carswell — this is my first major development project, built to solve a personal problem: running a local AI on existing home hardware without sending data to the cloud. My background is in social work, not software, so some of the architecture decisions here reflect learning-by-doing as much as deliberate design. The codebase reflects that honestly.
