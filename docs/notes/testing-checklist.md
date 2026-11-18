# What still needs a person to use it

Started 2026-11-17 from the architecture review (`master-plan.md`).
Every item here is built and passes its automated suites, but no record says
a person has used it in the running app, on a real model, or on the real
platform. Some have been done and not written down: tick those first.

**How to use this file.** Tick an item when it has been done, and add the date
and one line of what happened (`2026-11-18: works` or `2026-11-18: card shows
the wrong name, fixed in abc1234`). A failure goes in the line, and the fix or
the gap goes into the item's implementation doc as usual. Delete an item only
if the feature itself is removed. Tracked in git (re-included in
`.gitignore`), so it can be ticked from any machine; pull first.

Before an app test: restart Nest on the build under test, and run
`npm run build:chat` in `redstart-nest/` if the chat UI changed (the UI is
served from the built bundle).

---

## 1. Possibly done already: confirm and tick

- [ ] **Projects** (PR #38): create a project, chats nested under it, project
  instructions followed, deleting a project moves its chats out. The user
  reported "working well" on 2026-11-10; tick if that covered all four.
- [ ] **Background tasks** (Phase 3.9): `/task`, the bar, a question, an
  approval, Cancel, closing and reopening mid-task. Clicked 2026-11-12,
  "works"; one bug fixed in e1e44b7. Confirm the redesigned question card
  (choice list, pick then Send) in the real app, not only the vite render.
- [ ] **ask_user, several questions** (D43/D44): a live 4-question quiz ran
  on Ornith with the old stacked card. Confirm the **tab** layout in the
  running app.
- [ ] **New mascot icons** (PR #37, alpha.11): the installed Nest and Twig
  show the new bird in the taskbar, tray and installer. Known gap: Twig's
  chat UI still shows the nest bird.
- [ ] **Auto-update, Nest** (Tauri updater): an installed alpha updated itself
  to a later one on quit. Tick if any alpha since alpha.6 has done this.

## 2. Use it in the running app

### Memory (Phase 8, chat-tooling Phase 3)
- [ ] Suggest mode: a suggestion of each kind (add, update, merge, forget);
  Save, Dismiss, Undo after Save.
- [ ] Automatic mode: Undo of an update and of a merge.
- [ ] Settings → Memory: grouping by kind, editing kind and why, a guidance
  with no why is refused.
- [ ] `/remember guidance: x because y`, `/remember state: z`, and
  `/remember guidance: x` (refused).
- [ ] A background task that ends with memory on produces a suggestion (8.5).
- [ ] Tools tab → Memory card: the review-thinking switch is saved and takes
  effect.
- [ ] Judgement, not mechanism: over a week of normal use on Ornith, note
  which suggestions were worth keeping and which were noise. The memory bench
  has Ornith at 27/32 (think off) and 30 (think on); real use is the check
  the bench cannot do.

### Approvals (Phase 2)
- [ ] "Always allow" set **on a card** (not via the one-time import), then
  seen in force from a second browser.
- [ ] After a Deny, a third delete attempt gets the new denied text and the
  model does not retry blindly.
- [ ] Launcher → Activity: the decisions just made appear.

### Asking and planning (Phase 1)
- [ ] A multi-step request in the chat produces the plan checklist, ticks
  steps off as it goes, and the completion nudge fires once if it answers
  with steps open.

### Workflows (PR #37)
- [ ] The Workflows page (sidebar, after New chat): create a personal
  workflow with an argument; run it with `/` in a chat.
- [ ] An org workflow made by an admin is visible to a user account; a user
  account cannot create one.
- [ ] The same workflow from Twig.

### Chat tooling (PR #34)
- [ ] Tools tab → Python card: install the runtime from the admin UI; a real
  model chooses `run_python`; a chart comes back as an image.
- [ ] Rendered tool results: a created `.docx`/`.pdf` downloads; an image
  renders, in the Nest window (WebView2), in Twig, and in a phone browser.
- [ ] Document search: the rebuild button; a question answered with numbered
  citations that open the right file.
- [ ] Web search with SearXNG or Brave configured; off really means off
  (the tool is absent and the prompt does not claim it).
- [ ] Settings → Roles: create a role that withholds a capability and check
  the account it is given cannot use it.

### Skills and AGENTS.md (master plan Phase 5)
- [ ] First start after the update: existing workflows are still on the
  Workflows page and still run with `/`; `workflows.json` is still on disk,
  and `skills/` holds a folder per workflow.
- [ ] In a chat, ask for a task one saved workflow describes, without `/`.
  The model calls `use_skill` with its name and follows it.
- [ ] A skill with a `.py` file (import one): loading it puts the script
  in the conversation's workspace under `skills/<name>/`, and the model
  runs it with `run_python`.
- [ ] Workflows page: Export a workflow (a `.zip` downloads), Import that
  zip into a second account, and import a `SKILL.md` from another agent's
  skills folder.
- [ ] Project page: AGENTS.md download, then load an AGENTS.md into the
  instructions, check it, Save.

### Tool retrieval: the catalog (master plan 3.3)
- [ ] With retrieval on: "remember that I prefer X" in an ordinary chat
  saves (the memory tools are core, in every list).
- [ ] With retrieval on (master plan Phase 1): Kilo Code or Continue on an
  account-wide API key gets its whole tool list (Tools tab, "last completion":
  nothing removed by retrieval), while the chat UI on the same Nest gets the
  catalog list. Repeat the chat-UI half with login off.
- [ ] The catalog (master plan Phase 3.1, 3.3): Tools tab → retrieval on
  (there is no "How" select any more). In a chat, ask for something only a
  deferred tool does (list the File System folder, look at a Git repo). The
  model should call search_tools, then call_tool, and the answer should be
  right.
- [ ] The Tools tab's retrieval card, with the search model not yet
  downloaded: the status says search_tools matches by keyword, and the
  catalog still applies (File System tools are not in the list).
- [ ] Through call_tool, a write (write_file in the File System folder)
  shows the approval card **named as write_file**, not call_tool. Approve
  once: it runs. Ask again: the card comes back. "Always allow": the next
  one runs without a card. Deny: nothing is written.
- [ ] The same write from a background task parks it on "waiting for
  approval" naming write_file, and runs after the approval.
- [ ] Tools tab → Catalog-only tools: untick Git and save. With retrieval
  on, git_status is in the list again (the first tool chosen can be a Git
  tool without a search).

### Coding on a small model (never tried)
- [ ] A multi-step programming task on Ornith in the chat, using
  `run_python` and created files: write a small module, test it, fix what
  fails. Note where it stalls. This decides whether S5 / Phase 9 work is
  worth it for coding, or whether coding stays Yellowscript's.

## 3. Bench runs owed (need a model loaded)

- [ ] Simplification S1.1: arms A, B, C on Ornith ×3 (replaces B1 to B7).
- [ ] p2-delete-confirmed: `--tasks "scripts/agent-bench/tasks/p2-*.json"`
  with File System destructive operations on.
- [ ] D43: one Phase 1 run with `--plan tool`, against the last Phase 1 rows;
  watch `argsProblem` on ask_user and the p1 "should not ask" tasks.
- [ ] 8.4: the agent bench with guidance memories on the bench account.
- [ ] 8.3: the 35B memory bench with `--think on --think-budget 8192`.
- [ ] A task that compacts, against a real model (Phase 3 gap).

## 4. Installers and platforms

- [ ] **Twig installer** (PR #36): a clean install on Windows; it finds Nest
  on the LAN and signs in; the granted folder's `fs_*` tools work.
- [ ] **Twig over an Electron Twig**: the installer replaces the old app and
  keeps its settings.
- [ ] **Twig auto-update**: an installed Twig updates on close; Settings →
  Server "Restart to update".
- [ ] **Nest over an Electron Nest** (the bridge installer, T3): secrets
  still decrypt after the move. Needs a machine with an old install, not the
  user's real one.
- [ ] **macOS, Nest and Twig**: never run on a Mac. Install, launch, start a
  model, chat from another device.
- [ ] **Phone browser** against the chat UI, with the QR code: login, chat,
  a file download, an approval card.

## 5. Real hardware (deployment)

- [ ] `deploy/`: the systemd unit on a Linux box, headless `nestd`, crash
  and restart behaviour.
- [ ] The Windows SCM service procedure.
- [ ] The Caddyfile in front of the control plane, and the data-plane TLS
  gap (`deployment-validation-plan.md`).
- [ ] The tray, autostart and first-close notice on a packaged build (no
  automated coverage of the UI half).

## Dropped

- Phase 4 click test and p4 bench run: the Nest terminal was removed
  2026-11-17 (master plan Phase 2). The p4 tasks stay in the bench as
  workaround measures.
