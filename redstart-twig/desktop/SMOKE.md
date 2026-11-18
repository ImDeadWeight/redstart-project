# Redstart Twig — manual smoke checklist

Twig has no automated test suite. These are the checks that must pass by hand before shipping a
build, and they exist because Twig's local file tools act on **the user's own disk** with no
server-side policy gate over them — Nest's `evaluateToolPolicy` has no reach here.

Run `npm test` first. It covers containment and delete recoverability under plain node
(`scripts/test-fs-tool.mjs`) and the pipe contract with the real twigd (`scripts/test-twigd.mjs`), and
`cargo test` in `shell/` covers the chat-ui protocol and the bridge allowlist. Everything below is what
those cannot reach: the window, the real recycle bin, the packaged layout, the installer, the updater, and
the UI.

Then run against a **dev** launch (`npm run dev` in `windows/`, after building the chat-ui; set
`TWIG_CONFIG_DIR` to a throwaway folder) and again against a **packaged** build (`npm run build`, or the
exe in `shell/target/release`, which runs the packaged layout), because the two resolve module and
asset paths differently. It was exactly that divergence that once let a broken dev import ship unnoticed
while the packaged app kept working off a stale copy.

Use a throwaway folder as the grant root. Never smoke-test against a real working directory.

---

## 0. Build integrity

Verified on 2026-11-05 (Windows): `npm run build` makes a signed 31.75 MiB NSIS installer, and the exe in
`shell/target/release` started twigd on `resources\node\node.exe` from `resources\app\twigd`. The
installer itself has not been run.

- [ ] The packaged app launches and reaches the chat UI.
- [ ] **The served UI is current.** Twig serves a chat-ui bundle built separately from it. Check
      that Settings → Server has an **Updates** block. If it does not, the bundle is stale: run
      `npm run build:chat` and repackage. This has caught the project out twice.
- [ ] **Settings survive a restart.** Change a chat setting, close Twig, open it again: it is
      still set. (Electron Twig lost them every launch: a new port was a new origin.)

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

Delete `%APPDATA%\redstart-twig-windows\twig-fs-config.json` first, so this is a true first launch.

- [ ] On launch, **no** `Documents\Redstart-twig` folder is created.
- [ ] Under the chat composer, the folder control reads *"Grant a folder on this PC for local file
      tools"*.
- [ ] Settings → Server shows *"No folder granted — local file tools are disabled."*
- [ ] Ask the model to list files. It should have **no** `fs_*` tools available and should say so —
      not silently call a server-side tool and present the result as if it were this machine.

## 2. Granting a folder

- [ ] Clicking the composer control opens a folder picker (the shell's own dialog).
- [ ] Cancelling the picker leaves the grant as it was.
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
a network share or a removable drive where the recycle bin refuses the path:

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

The window has no OS frame on Windows: the page draws the title bar and its buttons.

- [ ] Minimise, maximise/restore and close work, and the maximise icon flips to restore.
- [ ] **The buttons are there on every screen**, including "Looking for your server…" and "No
      server found". They sit above the loading screen. If they ever vanish, a Twig with no server can
      be neither moved nor closed.
- [ ] Dragging the bar moves the window; double-clicking it maximises.
- [ ] Nothing is clipped by the bar, in particular the sidebar toggle and the icon rail.
- [ ] F12 opens DevTools.
- [ ] A link in a chat answer opens in the default browser, not in a new Twig window.
- [ ] **Scrollbars are dark everywhere**: the chat list, a long answer, Settings, an open dropdown.
- [ ] macOS: the traffic lights sit over the bar's left end, with no Windows buttons drawn.

## 7. Local MCP servers (unchanged by this work, but easy to break)

- [ ] Servers in `%APPDATA%\redstart-twig-windows\twig-mcp.json` still appear in Settings → Server.
- [ ] Starting one connects and its tools appear.
- [ ] Closing the app stops the child processes (check Task Manager for orphans, including
      `node.exe` children of an `npx` server).

## 8. Installing over Electron Twig (once)

Needs a machine with an Electron Twig (1.0.0-alpha.9 or earlier) installed. Not this dev box's real
setup unless you mean it.

- [ ] Per-user Electron install: the Tauri installer removes it silently and installs into the same
      folder (`%LOCALAPPDATA%\Programs\Redstart Twig`). A taskbar pin still opens Twig.
- [ ] Only one **Redstart Twig** remains in Settings → Apps.
- [ ] The granted folder and local MCP servers are still there.
- [ ] All-users Electron install: a UAC prompt appears for its uninstaller. Accept it, and only the new
      Twig remains. Decline it, and both are installed (expected; the old one is removed by hand).

## 9. Updates

Needs two releases cut by the workflow, the second newer than the installed one.

- [ ] Settings → Server → Updates shows the running version and the automatic-check switch, on.
- [ ] **Check now** finds the newer release, shows "Downloading…", then "ready", and a toast says so.
- [ ] Nothing restarts on its own. Close Twig: a passive installer runs, and the next launch is the new
      version.
- [ ] With an update ready, **Restart to update** installs and reopens Twig.
- [ ] With a local MCP server running, closing still installs (its process is gone first).
- [ ] Switch automatic checks off, restart Twig, and wait over a minute: no check happens
      (`%APPDATA%\redstart-twig-windows\shell\redstart.log` has no `update` lines). Check now still works.
- [ ] A dev run says it does not update itself.
