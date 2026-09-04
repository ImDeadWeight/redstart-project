# Tool namespacing contract

**Status:** binding. Enforced by `redstart-nest/scripts/test-tool-namespacing.mjs`, which runs in
`npm run test:security`.

Every tool name the model can see comes from one of two places, and the name has to say which.

---

## The rule

| Source | Naming | Example |
|---|---|---|
| A **Redstart Nest capability** | the provider's own names, unprefixed | `read_text_file`, `vault_search`, `postgres_query` |
| A **client application** | prefixed with the app's namespace | `fs_read_file` (Twig), `ys_*`, `bp_*`, `gh_*` |
| An installed **plugin** | `<plugin-id>__<tool-name>` — double underscore | `comfyui_mcp__enqueue_workflow` |

**Plugins use a third naming scheme, not the client-app one.** A single underscore is a client-app prefix; a plugin's namespace is a **double** underscore, deliberately — many built-in tool names already contain a single underscore (`read_text_file`, `postgres_query`), so a single-underscore plugin prefix would be ambiguous the moment `capabilityForTool()` tried to parse it back out. The registry also refuses a plugin id containing `__` at install time, and refuses one that collides with a built-in capability id, a client-app id, or a built-in tool name outright — so a plugin can never produce a name that reads as belonging to either of the other two sources.

Reserved app prefixes:

| Prefix | App |
|---|---|
| `fs_` | Redstart Twig — local file tools (historical; `twig_` would be clearer, but renaming a shipped tool set costs more than it buys) |
| `ys_` | Yellowscript |
| `bp_` | Blueprints |
| `gh_` | Greenhouse |

**No client-app tool name may equal a Nest tool name.** That is the part the test enforces; the
rest is convention the test cannot check.

---

## Why this is a contract and not a style preference

Nest's gateway is **provenance-blind**. `enforceToolAllowList` sees
`parsed.tools[].function.name` and nothing else — there is no field saying which app or server
contributed each tool, and adding one would mean changing the OpenAI completions payload that every
client and llama-server already agree on. So a ban is a flat name match across every source
simultaneously.

That has a consequence people find surprising: **a ban cannot be scoped to one app.** If
Yellowscript shipped a `read_file`, banning it would also strip Nest's `read_file` from every
request, for every client, on that profile. The namespace is the only thing making a ban targetable.

The failure mode is not hypothetical. Nest's File System capability *used* to use `fs_*` names —
the same as Twig's local tools — and the chat-ui relied on that collision to shadow the remote tools
with the local ones so the model would not see two filesystems at once. The FS MCP migration renamed
Nest's side to the upstream names. The collision disappeared, the shadowing silently stopped
happening, and nothing failed: no error, no test, no log line. The model was simply handed two
complete filesystem APIs pointing at two different computers, with nothing in either tool's
description saying which machine it acted on.

Two rules come out of that:

1. **A safety property expressed as a naming coincidence is not a safety property.** Precedence is
   now keyed on capability identity carried in `_meta` on `tools/list`, not on spelling
   (`mcp-server.mjs` → `annotateTool`, consumed by `tools.svelte.ts`).
2. **Namespaces still have to hold**, because bans genuinely cannot work any other way.

---

## Adding tools to a client app

1. Prefix every name with the app's namespace.
2. Register the app in `CLIENT_APPS` in `redstart-nest/electron/main/tools-definitions.mjs`, listing
   every tool name. This is what lets an admin ban the app's whole set by naming the app, and it is
   what the collision test checks against.
3. Run `npm run test:security` in `redstart-nest`. A collision fails the build.

Registering the app also makes it appear in **Tools → Banned Tools** automatically.

## Adding tools to a Nest capability

1. Use the provider's natural names — no prefix. Local models call standard names
   (`read_text_file`, `write_file`) far more reliably than bespoke schemas, which is why the
   filesystem capability moved to the upstream server in the first place.
2. Add every name to `CAPABILITY_TOOL_NAMES[<capability>]` **and** classify each in `TOOL_CLASSES`.
   The permission gate reads `classifyTool()`, and an unclassified tool defaults to `read` — for a
   mutating tool that is a silent privilege escalation. `test-tool-policy.mjs` fails if a capability
   tool is missing a classification.

## If a name has to collide

Don't. If a client app genuinely needs a tool that does what a Nest tool does, the answer is
usually that it should call the Nest one. If it truly must run locally — the Twig case, where the
whole point is acting on the user's own machine rather than the server's — the local one takes the
app prefix and both remain individually nameable.

---

## Names are not labels

The rules above are about the **name**, which is the identity: what the model is
sent, what it calls, and what a ban matches. None of it is about what a person
reads in a list.

Those are now two separate fields, because a name that has to stay targetable by
a flat string match is a bad label. A tool row in the chat-ui shows, in order of
preference:

1. the server's own MCP `title`, when it published one;
2. the name with its namespace prefix removed — **only** where the row already
   sits under a header naming its source;
3. the name, unchanged.

`toolDisplayName()` (`src/chat-ui/src/lib/stores/tools/tool-display.ts`) is the
only place that decides this, and it is pure.

Two consequences worth stating plainly, because both are easy to undo by
accident:

- **A label is never an identity.** Two plugins may each expose a `search`, and
  after the prefix is stripped both rows read "search". They stay distinct
  entries with distinct keys under different headers, and both are still called,
  matched and banned by their full names. Nothing may key a decision on the
  displayed string.
- **The prefix may only be dropped when something else names the source.** Nest
  serves every installed plugin through its ONE built-in MCP server, so grouping
  by server alone puts every plugin in a single bucket and leaves the prefix as
  the only signal of ownership. What makes stripping it safe is
  `_meta['redstart/source']` — the plugin's admin-reviewed display name, stamped
  by `plugin-provider.mjs` and honoured only for Nest-provisioned servers — which
  lets the UI give each plugin its own group header.

A publisher-supplied `title` is untrusted text. It is sanitised in
`validatePlugin()`, which runs on every read, and the real name stays visible in
**Settings → Tools**, which is the surface where a server-side ban appears.
