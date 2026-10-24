# Running Redstart Nest as an appliance

Everything here is for **level 3**: Redstart running as a service on a box
nobody is logged into, starting at boot and surviving logout. A Windows desktop
install needs none of it.

| File | What it is |
|---|---|
| `redstart-nest.service` | systemd unit — Linux |
| `windows-service.md` | the SCM procedure — Windows |
| `Caddyfile` | the reverse proxy that terminates TLS in front, for both planes |

**None of it has been run on a real box.** These artifacts were written from the
design's requirements and reviewed, not executed — there is no appliance
hardware yet, and installing a service needs an elevated prompt. Treat them as
a careful first draft: read each command before running it, and expect to
correct something.

---

## The shape

```
                     :443 (admin)
                     :8443 (chat)
  [ browser ] ─────────────▶ [ Caddy ]
                                 │  plain HTTP, loopback only
                                 ▼
                          :19083  Redstart Nest — control plane
                                  (admin UI, configuration, process control)
                          :19080  gateway — the chat UI and inference, with
                                  the model process behind it on 19081
                          :19082  built-in MCP server, routed as /mcp on
                                  the chat site
```

Nest does not do TLS at any layer, and that is settled rather than missing
(design §3.3). The proxy in front handles certificates and renewal properly;
building a worse version of that inside Nest was considered and rejected.

Both planes go behind it. The gateway is what people use every day: logins,
session tokens, conversations and tool calls. A proxy that covered only the
admin UI would encrypt the rarely used half. Leave **network mode off** so the
proxy is the only route in. Network mode binds the gateway and MCP server to
every interface, and they then answer in the clear beside it.

**The built-in tools follow the proxy.** The chat UI connects to the MCP server
from the browser, at a URL the gateway advertises. Behind a proxy that sets
`X-Forwarded-Proto`, the gateway advertises the proxy's own origin plus `/mcp`
rather than `http://<host>:19082/mcp`. The proxy has to route `/mcp` to 19082
for that URL to work. See the Caddyfile's "TOOLS IN THE CHAT UI" note.

## Remote access for a few people: Tailscale Serve

**UNVERIFIED.** Written from Tailscale's documented behaviour; nobody has run
it against Nest yet.

For one household or a handful of people who need Nest away from home, this
replaces both Caddy and port forwarding, and it works on a Windows desktop
install as well as at level 3. Every device joins your tailnet. Nest stays on
loopback, nothing on the router is opened, and Tailscale terminates HTTPS with
a real certificate for the machine's `*.ts.net` name, so there is no
click-through warning.

Prerequisites, in the Tailscale admin console: **MagicDNS** on, and **HTTPS
certificates** enabled. Then, on the Nest machine:

```
tailscale serve --bg 19080
tailscale serve --bg --set-path /mcp http://127.0.0.1:19082/mcp
tailscale serve status
```

The chat UI is then at `https://<machine>.<tailnet>.ts.net` from any device on
the tailnet. `tailscale serve reset` undoes it.

Things to know:

- **Serve, not Funnel.** Serve is reachable only from your tailnet. Funnel
  publishes the same thing to the whole internet, which is the port forward
  this section exists to avoid.
- **The `/mcp` mapping is the part most likely to need correcting.** Check it
  with `curl -i https://<machine>.<tailnet>.ts.net/mcp`. A `401` means the
  request reached the MCP server and was refused for having no credential,
  which is correct. A `404` means the path was rewritten on the way. The same
  check applies to the Caddy block.
- **The built-in tools depend on what Serve forwards.** Nest advertises the
  `ts.net` origin only if Serve sends `X-Forwarded-Proto`, plus either the
  original `Host` or `X-Forwarded-Host`. Signed in, open `/redstart/mcp-servers`:
  the built-in entry should read `https://<machine>.<tailnet>.ts.net/mcp`. An
  `http://…:19082` URL there means Serve sent neither header, and the tools
  will not connect.
- **The machine name becomes public.** The certificate is logged in public
  Certificate Transparency logs, which publishes `<machine>.<tailnet>.ts.net`.
  It does not make the machine reachable; it does make the name known.
- **Every caller arrives from loopback**, as behind Caddy, so the login rate
  limit is one shared bucket.
- **Leave the control plane on loopback** and administer Nest from the machine
  itself. If you need it remotely, set `adminBindHost` to the machine's
  Tailscale address. That is the VPN-interface case the bind address exists
  for, and it is plain HTTP inside the tunnel, which Tailscale encrypts.

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
