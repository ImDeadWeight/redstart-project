# Running Redstart Nest as an appliance

Everything here is for **level 3**: Redstart running as a service on a box
nobody is logged into, starting at boot and surviving logout. A Windows desktop
install needs none of it.

| File | What it is |
|---|---|
| `redstart-nest.service` | systemd unit — Linux |
| `windows-service.md` | the SCM procedure — Windows |
| `Caddyfile` | the reverse proxy that terminates TLS in front |

**None of it has been run on a real box.** These artifacts were written from the
design's requirements and reviewed, not executed — there is no appliance
hardware yet, and installing a service needs an elevated prompt. Treat them as
a careful first draft: read each command before running it, and expect to
correct something.

---

## The shape

```
                     :443
  [ browser ] ─────────────▶ [ Caddy ]
                                 │  plain HTTP, loopback only
                                 ▼
                          :19083  Redstart Nest — control plane
                                  (admin UI, configuration, process control)
                          :19080  gateway — inference and tools, with the
                                  model process behind it on 19081
```

Nest does not do TLS at any layer, and that is settled rather than missing
(design §3.3). The proxy in front handles certificates and renewal properly;
building a worse version of that inside Nest was considered and rejected.

## Where state lives

Nest takes one directory and derives two subtrees from it:

```
/var/lib/redstart/          <- --dir points here
├── config/                 Nest's own state: accounts, roles, tools, plugins,
│                           profiles, settings, logs, and secret.key
└── data/                   the folder-scoped capabilities' content
```

They must be separate, and Nest **refuses to start** if they overlap. Two
reasons, and both fail silently if they merge: a backup can no longer express
the difference between "my settings" (small, always wanted) and "my files"
(large, restores differently); and the last-resort reset below would sit
adjacent to a user's documents, which is a foot-gun for someone moving fast
during an incident — exactly when that path gets used.

## First run

The daemon generates a **bootstrap token** the first time it starts on a unit,
and writes it to `config/bootstrap-token.txt`. That token is the only way to
create the first owner account:

```
POST /admin/bootstrap  { token, username, password }
```

On a desktop install the launcher reads that file for you and you never see a
token. On an appliance, it is printed on a label on the chassis — a router, and
for the same reason: physical possession of the box confers ownership, stated
plainly rather than pretended otherwise.

**Never bake a token into an image.** It is generated per unit, on that unit's
first run. A shared factory token is the default-password failure, and the label
has to match the box it is stuck to.

The same route also **resets a forgotten owner password**, keeping accounts,
roles, client keys and tool configuration. That is the entire gain over a wipe,
and it is why the token is not optional.

## Recovery, in order of how much you lose

1. **Forgotten owner password** — `POST /admin/bootstrap` with the token off the
   label. Everything except the owner credential survives.
2. **Lost the label too** — read `config/bootstrap-token.txt` off the disk. It
   is plaintext, deliberately: anyone who can read that directory can rewrite
   `accounts.json` anyway, so hashing it would cost the setup flow and buy
   nothing against the only threat that reaches it.
3. **Last resort** — stop the daemon, delete `config/accounts.json`, start it
   again, re-bootstrap. This is the recessed reset button. It is also why
   `config/` and `data/` are separate trees.

## Converting an existing desktop install

Follow `windows-service.md`. The order matters and step 1 is not skippable:
**re-key the secrets while still logged in as the original user**, because DPAPI
ciphertext cannot be decrypted by a service account and the failure is silent.

Linux has no equivalent problem — a headless install has used the key file from
the start.

## What to check after any level-3 install

- The admin page loads and you can sign in.
- A capability holding a **credential** still works (Postgres, or an external
  MCP server with an API key). This is what catches a migration problem while
  the old install is still intact.
- `systemctl status redstart-nest` / `sc.exe query RedstartNest` says running.
- Stopping it from the admin UI leaves it stopped, and it comes back after a
  crash. Those are different exit codes and the supervisor config depends on
  them being different.

## Things to know before exposing it

**"Shut down" means down until someone with access to the machine starts it
again.** There is no remote start; the thing that would answer the request is
the thing being stopped.

**Secrets are protected by a key file beside the data it protects.** Anyone who
can read `config/` can read the credentials. Deliberate (design §3.1), and
meaningful only with full-disk encryption underneath — LUKS+TPM2, or BitLocker
on Windows. **If the box is not encrypted, encrypt it before it holds anything
you care about.** TPM-backed FDE protects a drive that leaves the box, not a box
that is carried away whole; that is the same limit every laptop has without a
pre-boot PIN, and it is consistent with the token-on-the-chassis decision rather
than a gap in it.

**Do not forward the control-plane port through a router.** That single act is
what turns a low-risk deployment into a box in the population the internet scans
continuously. A VPN or a management VLAN reached through the bind address is the
supported shape; the admin UI warns when the control plane is not on loopback,
and the warning is worth reading rather than dismissing.
