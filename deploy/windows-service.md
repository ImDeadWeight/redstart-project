# Redstart Nest as a Windows service (level 3)

**PARTLY VERIFIED.** The daemon itself is proven: `node bin/nestd.mjs --dir
<dir>` boots with no Electron, mints a bootstrap token, binds the control plane,
and accepts bootstrap and login — `scripts/test-daemon-smoke.mjs` runs exactly
that on every commit. **What has never been run on a real machine is everything
around it**: the service registration, the account and ACL steps, the restart
policy, and the secrets re-key. Read each command before running it; they need an
elevated prompt and they change how the box boots.

**This is a source install, not the desktop installer's output.** The NSIS
installer packages the Electron app (`electron/main` + `dist`) and does not ship
`bin/nestd.mjs`, `scripts/`, or a `node_modules` a plain `node` could resolve.
The service therefore runs from a checkout with dependencies installed, which is
also what the eventual Linux packaging will do — the same entry point, the same
`--dir` contract, and no Electron in the picture. Do not point `sc.exe` at
`C:\Program Files\Redstart Nest`; nothing under it is a headless daemon.

**This is not the Windows desktop install.** The desktop app runs as you, at
[level 2](#why-two-levels) — it outlives its window, starts at login, and needs
none of this. A service runs without anyone logged in, survives logout, and
starts at boot. It is what a dedicated box wants and what a laptop does not.

The account question — which identity the service runs as — is the part not to
improvise on. Section 2 states the rule and the reason.

---

## Why two levels

| | Level 2 (desktop) | Level 3 (service) |
|---|---|---|
| Runs as | you | a virtual service account |
| Starts at | login | boot |
| Survives logout | no | yes |
| Secrets protected by | DPAPI, your account | a key file + full-disk encryption |
| Needs the migration below | no | **yes** |

The migration is the reason this is a procedure rather than a checkbox. DPAPI
ciphertext is bound to the user account that wrote it: **a service account
cannot decrypt secrets your desktop install stored.** They must be re-encrypted
while you are still logged in as the original user. Skip it and every stored
credential is silently unreadable afterwards — Postgres connection strings,
external MCP keys, plugin environment values.

---

## 1. Re-key the secrets — do this FIRST, as the original user

While still logged in as the account that has been running Redstart:

```
cd <the Redstart Nest source checkout — see step 3>
npx electron scripts/rekey-secrets.mjs -- ^
  --source "%APPDATA%\redstart" ^
  --target "C:\ProgramData\Redstart\config"
```

That is a **dry run**. It writes nothing. Read the output:

- `secrets found` / `readable now` should match. If they do, continue.
- Anything under `CANNOT BE READ` will be left exactly as it is and must be
  re-entered by hand in the new install. That is normal if a credential was
  stored under a Windows account that no longer exists; it is not a reason to
  stop.

When the numbers look right, run it again with `--apply`.

**`npx electron`, not `node`.** The secrets were written by DPAPI, which only
Electron's `safeStorage` can reach, and only as the user who wrote them on the
machine that wrote them. Run it under plain `node` and it refuses rather than
reporting everything as unreadable — which would look exactly like a corrupted
install.

**Your existing install is not touched.** The migration copies; it never moves
or deletes. If anything below goes wrong, the old directory is still there and
still works.

---

## 2. Create the service account and give it the directory

Redstart runs under a **virtual service account** — `NT SERVICE\RedstartNest`.
Windows creates it implicitly when the service is registered with that name; it
has no password, cannot log in interactively, and its SID is what the ACL below
grants.

**Never LocalSystem.** It is more privileged than your own account, and Nest
spawns a user-configurable binary and runs third-party plugin code. Under
LocalSystem a plugin escape or a path-scope bug is full machine compromise
instead of a contained one. This is the single most important line on the page.

```
:: The nest directory. Nest derives config\ and data\ from it and refuses to
:: start if the two overlap.
mkdir C:\ProgramData\Redstart

:: Grant the service account, and nobody else new, full control of that tree.
icacls "C:\ProgramData\Redstart" /grant "NT SERVICE\RedstartNest:(OI)(CI)F"

:: Remove inherited access for ordinary users. The config subtree holds
:: accounts.json and the secret key; it should not be readable by every account
:: on the box.
icacls "C:\ProgramData\Redstart" /inheritance:r ^
  /grant "SYSTEM:(OI)(CI)F" ^
  /grant "Administrators:(OI)(CI)F" ^
  /grant "NT SERVICE\RedstartNest:(OI)(CI)F"
```

Run this **after** step 1 has written the directory, or adjust the paths so the
migration writes into an already-ACL'd tree.

---

## 3. Place the source tree and the server binary

The service runs the daemon out of a checkout. Put it somewhere the service
account can read and ordinary users cannot write — `C:\Redstart\app` below —
and install dependencies as an administrator:

```
git clone <your remote> C:\Redstart\app
cd C:\Redstart\app\redstart-nest
npm ci
npm run build      :: produces dist/ and src/chat-ui/dist, both of which the
                   :: daemon serves; without it the admin page 404s
```

**The llama-server binary is not in the checkout.** The desktop installer gets
it from `extraResources`, which is an Electron mechanism the headless daemon has
no access to. `nestd` looks for it in the nest directory instead:

```
mkdir C:\ProgramData\Redstart\config\bin
copy <your build>\llama-server.exe C:\ProgramData\Redstart\config\bin\
copy <your build>\*.dll           C:\ProgramData\Redstart\config\bin\
```

`<config>\bin` is checked on every platform, and on a service install it is the
only candidate that can match — the packaged branch needs `process.resourcesPath`
(Electron only) and the development branch needs a `llama-cpp-turboquant` build
tree. A Linux package install has the same fallback plus `/usr/lib/redstart/bin`.

Skip this and Nest starts, serves the admin panel, and refuses to launch a model
with no binary found — which is a survivable state, not a broken one, and the
admin panel will say so.

---

## 4. Register the service

```
sc.exe create RedstartNest ^
  binPath= "\"C:\Program Files\nodejs\node.exe\" \"C:\Redstart\app\redstart-nest\bin\nestd.mjs\" --dir \"C:\ProgramData\Redstart\"" ^
  DisplayName= "Redstart Nest" ^
  start= auto ^
  obj= "NT SERVICE\RedstartNest"

sc.exe description RedstartNest "Local LLM host and control plane."
```

Note the spaces after `binPath=` and `obj=` — `sc.exe` requires them and fails
confusingly without.

---

## 5. The restart policy

The equivalent of systemd's `Restart=on-failure` with a give-up threshold.
Restart after 5 seconds for the first two failures, then stop trying; the
failure count resets after an hour of running cleanly.

```
sc.exe failure RedstartNest reset= 3600 actions= restart/5000/restart/5000//
```

**This depends on Redstart's exit codes and they are not incidental:**

| Exit | Means | The supervisor should |
|---|---|---|
| `0` | a human meant it — the admin UI's Shut Down, or a stop | leave it down |
| `1` | it crashed, or could not bind the control plane | bring it back |

`sc.exe failure` acts on unexpected termination only, so a clean exit 0 is
already respected. The empty third action (`//` at the end) is what makes it
give up rather than restarting forever — a service that resurrects every time
it is killed is its own outage, and one that stops leaves something legible in
`sc.exe query`.

---

## 6. Start it, and check

```
sc.exe start RedstartNest
sc.exe query RedstartNest
```

Then, from the box:

- `http://127.0.0.1:19083/` should serve the admin page.
- Signing in should work with the same owner account as before.
- **Check the secrets that were re-keyed.** Open a capability that uses one
  (Postgres, or an external MCP server with an API key) and confirm it still
  connects. This is the step that catches a migration problem while the old
  install is still sitting there intact.

---

## 7. Only then, tidy up

Once the service works and the credentials check out:

- Turn off **Start at login** in the desktop app (Network panel), or uninstall
  it. Two Redstarts fighting over port 19083 is a confusing failure — the
  second one to start simply loses the bind.
- Keep the old `%APPDATA%\redstart` directory until you are confident. It is
  the whole rollback plan: point the desktop app back at it and nothing was
  lost.

---

## What you have signed up for

**"Shut down" in the admin UI now means down until someone with access to this
machine starts it again.** There is no remote start — the thing that would
answer the request is the thing being stopped. On a box in a cupboard, that is
a walk.

**Secrets are protected by a key file next to the data it protects.** Anyone
who can read `C:\ProgramData\Redstart\config` can read the credentials. That is
deliberate (design §3.1) and it is meaningful only with **BitLocker or an
equivalent underneath it** — which is the right tool for the job it is actually
doing, protecting a drive that leaves the box. If this machine is not
encrypted, encrypt it.

**Put a reverse proxy in front before exposing the control plane.** Nest speaks
plain HTTP by design; see `deploy/Caddyfile`.
