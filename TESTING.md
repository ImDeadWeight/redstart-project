# Trying Phase 8 by hand

Phase 8 split Redstart Nest into a daemon and two entrypoints: the Electron
desktop app, and `bin/nestd.mjs` with no UI at all. The automated suites cover
the daemon thoroughly and cover the desktop window not at all — everything
below is the part a person has to look at.

Ordered by how much you learn per minute. Stop whenever you've had enough; each
section stands alone.

Prerequisites: nothing running on `19083`, `19080` or `8765` before you start.

---

## 1. The desktop app still works (2 min)

The one that would be embarrassing to get wrong, since ~400 lines moved out of
`index.mjs` and no automated test opens a window.

```
cd redstart-nest
npm run dev
```

Expect: the launcher window opens, you are signed in (or see the login screen),
and the Server tab behaves as it always has.

**Already verified from here:** the main process boots windowless
(`npm run daemon:electron`), starts the logger, beacon, admin listener, tray
and port-80 proxy, serves the admin bundle, and reads your real
DPAPI-encrypted `tools.json` — so the Phase 8A.1 secrets seam works against
actual Windows `safeStorage`. What has *not* been seen is the window itself.

---

## 2. The headless daemon (5 min) — the point of the whole phase

```
cd redstart-nest
npm run daemon
```

That starts Redstart with **no Electron, no window, no tray**, using a
throwaway nest directory at `redstart-nest/.redstart-daemon/` (gitignored —
delete it whenever you like). It does not touch your normal install.

Expect:

```
[app] logger_started
Redstart Nest beacon listening on port 8765
[admin] bootstrap_token_created
[admin] listener_started {"port":19083,"loopback":true}
Redstart Nest daemon running — ...\.redstart-daemon
```

Then, in a browser: **http://127.0.0.1:19083/**

It is a fresh install, so it will ask you to create an owner. The setup code it
wants is in `.redstart-daemon/config/bootstrap-token.txt` — on an appliance
that file is what gets printed on a label on the chassis.

Things worth poking at while you are in there:

- **Settings → the startup toggle is gone.** Deliberate: there is no login item
  on a headless daemon, so the control reports itself unsupported rather than
  showing an off switch that can never be turned on.
- **The folder picker** greys out anything the daemon cannot read and refuses
  to let you choose it. On Windows as yourself that will rarely fire — it is
  there for a service account.
- **Ctrl-C stops it**, and so does Shut Down in the admin UI.

## 3. From your phone (2 min)

While the daemon from step 2 is running, set the control plane's bind address
to your LAN address (Network panel), then open `http://<this box's IP>:19083/`
on your phone. That is the actual deliverable of the whole headless-admin-plane
pass: administering Redstart from a device that is not this one.

## 4. Load a model headlessly (10 min)

Also from step 2's daemon. The binary resolves already — the smoke test
confirms it finds your `llama-cpp-turboquant/build/bin/Release/llama-server.exe`
— but the models folder is fresh and empty.

1. Settings → point the models folder at your existing one.
2. Server tab → pick a model → Launch.
3. Watch the log stream and the tokens/sec readout in the browser.

If that works, a browser on any device just started and monitored a model on a
machine with no Redstart window open anywhere. Nothing automated covers this
end to end — the suites stop at "the daemon can find a binary to launch".

---

## 5. The Phase 7 things nobody has ever verified

These have been carried as known gaps since Phase 7 and need a human on
Windows. Quick, and each is a real behaviour:

- **Close the launcher window with a model loaded.** The model should stay
  loaded and the tray icon should stay put. You should get a one-time notice
  explaining that, and only once, ever.
- **The tray menu** — Open Redstart, Stop model, Quit Redstart.
- **Start at login** — turn it on, sign out and back in, and check Redstart
  comes back with a tray icon and no window.
- **Shut Down in the admin UI** actually stops the daemon.

## 6. The re-key dry run — safe, and closes a real gap (2 min)

Completely non-destructive: it writes nothing and touches nothing. It is worth
running because the safeStorage → keyfile path is the one thing in Phase 8B
that unit tests can only simulate — they use a stand-in provider, because real
DPAPI ciphertext needs your Windows account.

```
cd redstart-nest
npx electron scripts/rekey-secrets.mjs -- --source "%APPDATA%\redstart" --target "%TEMP%\rekey-test"
```

Expect a count of secrets found and how many are readable. If those numbers
match, the conversion path works against real DPAPI data and the gap is closed.
Anything under `CANNOT BE READ` is worth telling me about.

Do **not** add `--apply` unless you actually intend to convert to a service
install — and even then it only writes a new directory and leaves the original
alone.

---

## Where the honest gaps are

- **`deploy/` has never been run.** The systemd unit, the Windows service
  procedure and the Caddyfile were written from the design and reviewed, never
  executed. Nobody has converted a real install and confirmed the credentials
  still work afterwards.
- **The desktop window has no automated coverage**, which is why section 1
  exists.
- **`bin/` is not in the packaged build** (`electron-builder.json`'s `files`),
  so `nestd` ships only in a checkout. Fine for now; it matters when there is
  something to install it onto.
