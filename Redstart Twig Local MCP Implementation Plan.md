# Redstart Twig — Local MCP Servers (stdio) Implementation Plan

## Goal

Give the **Twig desktop variant** the Claude Desktop capability: spawn local
stdio MCP servers (`npx @modelcontextprotocol/server-filesystem`, custom
servers, anything published) as child processes, and let the shared chat-ui
consume their tools exactly like any other MCP connection.

Two Twig variants, one codebase:

| Variant | Runtime | Local MCP |
|---|---|---|
| Phone (Android APK / PWA) | Capacitor / browser | **No** — cannot spawn processes; works as today |
| Desktop (`redstart-twig/windows/`) | Electron shell | **Yes** — this plan |

**Redstart Nest requires zero changes.** The gateway's `disabledTools`
name-strip still applies to local tool names at completion time (org policy
hook), and everything else about Nest is untouched.

---

## Grounding — what exists today (verified in code)

1. **Twig desktop is a thin Electron shell** (`redstart-twig/windows/electron/main.mjs`,
   358 lines): serves the shared chat-ui over a local HTTP port, beacon-scans
   for Nest, and already exposes an IPC surface via preload
   (`window.redstartTwigAPI` with `network` and `fs` namespaces).
2. **A local-tool precedent already exists.** `redstartTwigAPI.fs` is a
   bespoke bridge: main-process handlers (`fs:get-tools`, `fs:execute`,
   `fs:pick-root`) expose OpenAI-shaped fs tools against a user-granted
   folder; the chat-ui routes them via `ToolSource.LOCAL_FS`
   (`agentic.svelte.ts:798`, `tools.svelte.ts:87`, `utils/twig.ts`). This
   plan **generalizes** that pattern from one hand-rolled tool family to any
   MCP server — via the standard protocol instead of a custom surface.
3. **The transport seam is single and clean.** `MCPService.createTransport`
   (`services/mcp.service.ts`) returns `{ transport, type, stopPhaseLogging }`
   and the SDK `Client` accepts any object implementing its `Transport`
   interface. The WebSocket branch shows the exact shape a new branch takes.
   `MCPTransportType` (`enums/mcp.enums.ts`) currently: `WEBSOCKET`,
   `STREAMABLE_HTTP`, `SSE`.
4. **Config helpers were just extracted** to `stores/mcp/mcp-config.ts`
   (`parseServerSettings`, `buildServerConfig`, `buildMcpClientConfig`) —
   the stdio entry type slots into that module, not the store.
5. **Known landmine:** `mcpStore.syncServersFromHost()` **replaces** the whole
   `mcpServers` settings value with the Nest-fetched list on every sync. It
   would silently delete local stdio entries. Must become a merge.
6. **URL assumptions to audit:** `buildServerConfig` returns `undefined`
   without `entry.url`; `getServerLabel` falls back to `server.url`;
   `detectMcpTransportFromUrl` runs on every entry. Each needs a stdio branch
   or guard.

---

## Architecture

```
Twig Desktop (Electron)
│
├─ main process — MCP PROCESS MANAGER (new: electron/mcp-manager.mjs)
│    · reads twig-mcp.json (local file, never synced)
│    · spawns each configured server as a child process
│    · owns lifecycle: start, kill-on-quit, crash restart w/ backoff
│    · pipes newline-delimited JSON-RPC: child.stdout → renderer,
│      renderer → child.stdin  (dumb pipe — NO protocol logic here)
│
├─ preload — window.redstartTwigAPI.mcp (new surface, ~30 lines)
│    list() / start(id) / stop(id) / send(id, line) / onMessage(id, cb)
│
└─ renderer — shared chat-ui
     · IpcStdioTransport implements the SDK Transport interface over
       that bridge (new: services/mcp-stdio-transport.ts, ~80 lines)
     · MCPService.createTransport gains a STDIO branch
     · mcp.svelte.ts host loop: UNCHANGED — a local server is just
       another connection; tools flow as ToolSource.MCP
     · agentic loop: UNCHANGED
```

Why this shape:

- **All MCP protocol logic stays in the renderer** where it already lives
  (client, handshake, capabilities, reconnect). The main process is a pipe +
  process supervisor — small, auditable, no protocol drift between two hosts.
- **stdio is process-bound**: no open localhost port, no auth question. The
  child talks only to the process that spawned it.
- **Feature-gating is free**: on phone/web `window.redstartTwigAPI.mcp` does
  not exist → the UI never offers local servers, `createTransport` can never
  be asked for stdio. Same chat-ui build everywhere (mirrors the existing
  `twigFsApi()` null-on-phone pattern).

### Config file (the `claude_desktop_config.json` analog)

`<userData>/twig-mcp.json`, desktop-only, **never synced from Nest or the
network** — its entries are arbitrary command execution by design, so the
trust boundary is the local disk, same as Claude Desktop:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:\\Users\\me\\Documents"],
      "env": {}
    }
  }
}
```

---

## Phases (one commit each, verification between)

### Phase 1 — Process manager in Twig main (`electron/mcp-manager.mjs`, ~180 lines)

- Read/watch `twig-mcp.json`; validate shape defensively (bad JSON → log +
  empty list, never crash the shell).
- `spawn(command, args, { env: {...process.env, ...cfg.env}, windowsHide: true })`.
  **Windows quirk:** `npx` is `npx.cmd` — resolve via `shell: true` or
  explicit `.cmd` lookup; document the choice inline.
- Frame stdout by newline (buffer partial lines — the classic stdio bug);
  forward each complete line to the renderer via `webContents.send`. Forward
  renderer lines to `child.stdin`. stderr → log file, never the pipe.
- Lifecycle: kill children on `before-quit`; restart on crash with capped
  backoff (mirror the MCP_RECONNECT_* constants' spirit); a wedged child gets
  SIGKILL after a grace period.
- IPC handlers: `mcp-local:list`, `mcp-local:start`, `mcp-local:stop`,
  `mcp-local:send`; event channel `mcp-local:message:<id>`.

### Phase 2 — Preload bridge (`preload.mjs`, +~30 lines)

- New `mcp` namespace on the existing `redstartTwigAPI` contextBridge object,
  wrapping the four invoke channels + message subscription (with an
  unsubscribe to avoid listener leaks on reconnect).

### Phase 3 — Renderer transport (chat-ui, shared code, feature-gated)

- `enums/mcp.enums.ts`: add `STDIO = 'stdio'` to `MCPTransportType`.
- `utils/twig.ts`: type + accessor for the new `mcp` surface
  (`twigMcpApi(): TwigMcpApi | null`) — same pattern as `twigFsApi`.
- **New `services/mcp-stdio-transport.ts`**: `IpcStdioTransport implements
  Transport` — `start()` asks main to spawn + subscribes; `send(msg)`
  serializes one JSON-RPC message per line; incoming lines parse →
  `this.onmessage`; `close()` unsubscribes + asks main to stop. No framing
  logic beyond JSONL (main already delivers whole lines).
- `MCPService.createTransport`: `if (config.transport === MCPTransportType.STDIO)`
  branch — throws a clear error if `twigMcpApi()` is null (defense in depth;
  UI should make this unreachable). Skip the diagnostic-fetch machinery
  (HTTP-only); reuse the phase-log callback shape for connect logs.
- Session-expiry reconnect (`isSessionExpiredError` → HTTP 404) is HTTP-only;
  stdio recovery = process restart, which the manager owns. No change needed,
  but verify `reconnectServer` isn't reachable for stdio entries.

### Phase 4 — Settings model + UI + the sync fix (shared code)

- `types/mcp.d.ts`: extend `MCPServerSettingsEntry` and `MCPServerConfig`
  with optional `transport?: 'stdio'`, `command?: string`, `args?: string[]`,
  `envJson?: string`; `url` becomes optional-for-stdio (keep required for
  network entries).
- `stores/mcp/mcp-config.ts` (the freshly extracted module):
  `buildServerConfig` gains the stdio branch (no URL required; no
  `detectMcpTransportFromUrl`); `parseServerSettings` passes the new fields
  through.
- `getServerLabel` / display paths: fall back to `name ?? command` when there
  is no `url`.
- **Fix the sync clobber:** `syncServersFromHost()` merges — Nest-sourced
  entries (id prefix `redstart-`) are replaced by the fetch; **local entries
  survive**. This is a real bug fix even before stdio ships.
- Settings UI (`SettingsChatServerTab.svelte` area): "Local server (desktop)"
  entry type — command + args fields — rendered only when `twigMcpApi()` is
  non-null. Phone/web users never see it.

### Phase 5 — Verification

- **Gates (every phase):** chat-ui `npx tsc --noEmit` stays at the
  pre-existing baseline (538, 0 in touched files); full `npm run
  test:security` green (274 checks); `check:mjs` for the Electron-side files.
- **New unit tests (vitest, chat-ui):** IpcStdioTransport against a mock
  bridge — one message per line, message split across chunks is NOT possible
  by contract (main frames), malformed JSON line → error surfaced not crash,
  close() unsubscribes. Plus `buildServerConfig` stdio-entry cases and the
  `syncServersFromHost` merge behavior.
- **Manual smoke (desktop):** `twig-mcp.json` pointing at
  `npx -y @modelcontextprotocol/server-everything` (the reference test
  server) → connect, tools/list appears in the picker, execute a tool, kill
  the child manually → manager restarts it → reconnect works, quit Twig → no
  orphan processes in Task Manager.

---

## Decisions taken (flag if you disagree)

1. **JSONL-over-IPC, not a localhost HTTP bridge.** A localhost bridge would
   mean implementing the StreamableHTTP *server* side in Twig main and opens
   a port any local process can hit. The IPC pipe is smaller and
   process-bound.
2. **Line framing lives in main; renderer receives whole messages.** One
   place to get the classic partial-line bug right, with a unit-testable
   contract on the renderer side.
3. **The existing `LOCAL_FS` bespoke bridge stays as-is.** It works, ships,
   and has UI. Once stdio MCP lands, `server-filesystem` makes it redundant —
   fold it into a follow-up migration (and delete `ToolSource.LOCAL_FS`)
   only after the stdio path has proven itself. Not in this plan's scope.
4. **Config file is desktop-local and hand-editable, plus minimal UI.** No
   Nest-side registry for local servers — spawning commands from
   network-synced config would be a remote-code-execution channel.
5. **`stopPhaseLogging` / health-check flow reuses the normal connect path** —
   a stdio health check spawns (or reuses) the child like any connection.

## Risks

| Risk | Mitigation |
|---|---|
| Orphan child processes | kill on `before-quit` + `child.unref()` avoided; smoke test checks Task Manager |
| Windows `npx.cmd` spawn failures | explicit shell handling in Phase 1; smoke test uses npx specifically |
| Local entries clobbered by Nest sync | Phase 4 merge fix + unit test |
| A stdio entry reaching phone builds | double gate: UI hidden without bridge API AND createTransport throws |
| Renderer/main listener leaks across reconnects | unsubscribe contract in Phase 2/3 + unit test |

## Effort

Phases 1–2 are Twig-only (~210 lines, no shared-code risk). Phases 3–4 touch
shared chat-ui code (~250 lines including the merge fix) behind feature gates.
Sequenced so each phase is independently committable and the shared-code
changes land only after the Twig-side pipe is proven with a manual echo test.
