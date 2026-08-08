# Redstart Twig — manual smoke checklist

Twig has no automated test suite. These are the checks that must pass by hand before shipping a
build, and they exist because Twig's local file tools act on **the user's own disk** with no
server-side policy gate over them — Nest's `evaluateToolPolicy` has no reach here.

Run `npm test` first — it covers containment and delete recoverability automatically under plain
node (`scripts/test-fs-tool.mjs`). Everything below is what that suite *cannot* reach: the Electron
shell, the real recycle bin, the packaged layout, and the UI.

Then run against a **dev** launch (`npm run dev` in `windows/`) and again against a **packaged**
build (`npm run build`), because the two resolve module and asset paths differently — and it was
exactly that divergence that let a broken dev import ship unnoticed while the packaged app kept
working off a stale copy.

Use a throwaway folder as the grant root. Never smoke-test against a real working directory.

---

## 0. Build integrity

Packaging was verified on 2026-08-07 (`npx electron-builder --win --dir`): the build completes,
`resources/` has no `fs-tool/` folder, `app.asar` contains `electron/fs/{fs-tool,path-scope,trash}.mjs`,
the preload is unpacked where `main.mjs` looks for it, and `resources/chat-ui` is the current bundle.
What remains is confirming the packaged app actually *runs*.

- [ ] The packaged app launches and reaches the chat UI.
- [ ] **The served UI is current.** Twig serves a chat-ui bundle built separately from it — check
      that Profile has a **Files** tab and the sidebar shows **Profile** (not your username). If it
      does not, the bundle is stale: run `npm run build:chat` from `redstart-nest` and repackage.
      This has caught the project out twice.

## 0b. Caught up with the current chat UI

Twig's whole UI is the shared chat-ui, so "is Twig up to date" is really "is its bundle current".

- [ ] Profile page opens with **Account** and **Files** tabs.
- [ ] Profile → Files lists your server storage, and upload / rename / delete work.
- [ ] The task-mode picker appears in the composer.
- [ ] Settings → Connectors is present.
- [ ] Ask the model to list databases — it should call `sqlite_list_databases` rather than
      reporting that none exist.

## 0c. Starting before the server (the common desktop order)

Turning the laptop on and *then* starting the model used to leave Twig on
"Redstart is nesting" forever — nothing re-scanned, and because no connect was
ever attempted there was no error either, so not even the Retry button appeared.

- [ ] Close Redstart Nest (or stop the model). Launch Twig.
- [ ] The screen reads **"Looking for your server…"** with *"Retrying every 10
      seconds"* underneath — not a silent spinner.
- [ ] Start Redstart Nest and load a model. **Twig connects on its own** within
      ~10 seconds, with no restart and no clicking.
- [ ] Repeat, but leave the server off for two minutes. The screen switches to
      **"No server found"** with **Retry** and **Server settings** buttons.
- [ ] Start the server, click **Retry** → it connects.

## 1. No folder is granted by default

Delete `%APPDATA%\redstart-twig\twig-fs-config.json` first, so this is a true first launch.

- [ ] On launch, **no** `Documents\Redstart-twig` folder is created.
- [ ] Under the chat composer, the folder control reads *"Grant a folder on this PC for local file
      tools"*.
- [ ] Settings → Server shows *"No folder granted — local file tools are disabled."*
- [ ] Ask the model to list files. It should have **no** `fs_*` tools available and should say so —
      not silently call a server-side tool and present the result as if it were this machine.

## 2. Granting a folder

- [ ] Clicking the composer control opens a folder picker.
- [ ] After choosing, the control shows the chosen path in monospace.
- [ ] The eight `fs_*` tools become available **without restarting** the app.
- [ ] Settings → Server shows the same path with a green check.

## 3. Read / write / edit

- [ ] `fs_write_file` creates a file in the granted folder; it appears on disk at the real path.
- [ ] `fs_read_file` reads it back.
- [ ] `fs_edit_file` performs a single find-and-replace; a string occurring twice is **refused**
      with a message pointing at `fs_write_file`.
- [ ] `fs_list_directory` and `fs_search_files` show the file.
- [ ] `fs_write_file` refuses a `.exe` path.

## 4. Deletion is recoverable — the point of the change

- [ ] `fs_delete_file` on a file: it disappears from the folder **and appears in the Windows
      Recycle Bin**, restorable from there. The model's reply says it is recoverable.
- [ ] Restore it from the Recycle Bin; it returns to the granted folder intact.
- [ ] `fs_delete_file` on an **empty** directory: same, recoverable.
- [ ] `fs_delete_file` on a **non-empty** directory: refused, nothing removed, nothing trashed.
- [ ] `fs_delete_file` with path `.` or the granted folder's own absolute path: refused with
      "Refusing to delete the granted folder itself". **The folder still exists.**
- [ ] Delete something, then ask the model to delete the item now inside `.trash/` (only reachable
      if the OS bin was bypassed): refused, not permanently removed.

### 4b. Fallback path

Hard to trigger on a normal local disk — the recycle bin usually works. If you can grant a folder on
a network share or a removable drive where `shell.trashItem` fails:

- [ ] Delete lands in a `.trash/<timestamp>/` folder inside the granted root, preserving the
      original relative path, and the reply says where to find it.
- [ ] Nothing is ever permanently removed when the bin is unavailable.

## 5. Containment — the model cannot escape the grant

Each of these must be **refused**, with nothing created, read, or deleted outside the granted root:

- [ ] `fs_read_file` with `../../Windows/System32/drivers/etc/hosts`
- [ ] `fs_write_file` with an absolute path outside the root (`C:\Windows\Temp\pwned.txt`)
- [ ] `fs_write_file` with a drive-qualified path on another volume
- [ ] Create a junction/symlink inside the granted folder pointing outside it
      (`mklink /J link C:\Windows`), then `fs_read_file link\win.ini` — refused, because containment
      resolves symlinks rather than trusting the lexical path.
- [ ] `fs_delete_file` on a symlink inside the root that points to a file **inside** the root:
      the **link** goes to the bin; the target file is still there.

## 6. Machine identity, and the two filesystems

This is the reason the local-folder capability needs its own checks: with a folder granted, Twig and
Redstart Nest each offer a complete filesystem, on different computers.

- [ ] Every `fs_*` description names Redstart Twig / "the user's own computer".
- [ ] With a folder granted, ask "write notes.md" in a conversation where the model has previously
      used server-side tools. It should write locally and say which machine it wrote to.
- [ ] **With a folder granted**, the model is offered the eight `fs_*` tools and **not** Nest's
      server-side file tools (`read_text_file`, `write_file`, `edit_file`, …). Only one filesystem
      at a time — that is the precedence rule, and it is keyed on capability identity rather than
      tool names.
- [ ] **With no folder granted**, the reverse: no `fs_*` tools, and Nest's file tools *are* offered.
      Server-created files still arrive as downloads.
- [ ] Documents, Vault, Git and SQLite stay available in both cases — precedence applies only to
      the filesystem capability, which is the only one Twig has an equivalent for.

## 6b. Deletion is never "always allowed"

- [ ] Ask the model to delete a file. The prompt offers **Allow once** and **Deny** only — no
      "Always allow" and no dropdown. This is the one delete in the system that no server-side
      policy can reach, because it runs on this machine.
- [ ] Approve a delete, then ask for another. It asks again.

## 6d. Files tab — two machines, one explorer

Profile -> Files shows a tab per place files live. Inside Twig with a folder
granted that includes **This computer**, alongside the server's own spaces.

- [ ] With a folder granted, a **This computer** tab appears; with none, it does
      not (there is no local folder to browse).
- [ ] It lists the granted folder's contents, navigates into subfolders, and Up
      works.
- [ ] Rename, New folder, and drag-to-move all work, and the moved file really
      moves on disk.
- [ ] Delete sends the item to the **Recycle Bin**, same as the server tab.
- [ ] **Upload and Download are absent on this tab** — the files are already on
      this machine, so there is nothing to transfer. They are still present on
      the server tabs.
- [ ] Dragging a file in from Explorer does nothing on this tab (no upload
      concept) but still uploads on a server tab.

## 6e. The model can tell the two apart

- [ ] With a folder granted, ask *"what files do I have access to locally?"*.
      The answer should distinguish the folder on **this computer** from the
      documents / databases / notes / repositories on the **server** — not lump
      them together as "everything is stored locally on this machine".
- [ ] Ask *"where would you save a file if I said save it to my desktop?"* — it
      should reach for the local `fs_*` tools, not the server's.

## 6c. Window chrome

The frameless window draws its own title bar, so two things have to line up that
the automated tests cannot see.

- [ ] **The bar is one colour end to end.** The strip behind the minimise /
      maximise / close buttons is drawn by Windows, the rest by the app. They used
      to be different (`#09090b` vs the app's actual `#060606`), showing as a
      slightly lighter band on the right. The shell now takes the colour from the
      renderer, so any future theme change follows automatically.
- [ ] **Nothing is clipped by the top strip.** In particular the sidebar toggle:
      it is absolutely positioned against the viewport, so it ignores the body
      padding that offsets everything else and used to sit half-under the 32px
      drag strip.
- [ ] Dragging the top strip moves the window; double-clicking it maximises.

## 7. Local MCP servers (unchanged by this work, but easy to break)

- [ ] Servers in `%APPDATA%\redstart-twig\twig-mcp.json` still appear in Settings → Server.
- [ ] Starting one connects and its tools appear.
- [ ] Closing the app stops the child processes (check Task Manager for orphans).
