# Running Redstart Nest as an appliance

Everything here is for **level 3**: Redstart running as a service on a box
nobody is logged into, starting at boot and surviving logout. A Windows desktop
install needs none of it.

| File | What it is |
|---|---|
| `redstart-nest.service` | systemd unit — Linux |
| `windows-service.md` | the SCM procedure — Windows |
| `Caddyfile` | the reverse proxy that terminates TLS in front, for both planes — **LAN only** |
| `front-door/` | browser access from the internet, through a VPS relay that never decrypts |

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
- **This is the private door for the satellite apps.** Twig, Yellowscript and
  Blueprints on your own devices reach Nest over the tailnet at
  `http://<machine>:19080`, exactly as they do on a LAN. They cannot use the
  front door below. If you use plain WireGuard instead of Tailscale, connect
  each device **straight to the Nest machine**, never through the front door's
  VPS as a hub. A hub decrypts both tunnels, so that inner plain HTTP would be
  readable on the VPS.

## The front door: a browser on a machine you do not control

**UNVERIFIED.** Every file in `front-door/` was written from its software's
documentation. None has been run, and the syntax has not been checked.

For a work computer, or anything else where you cannot install a VPN, only a
browser is available. Every way to reach a home server from a bare browser
puts something on the public internet; the choice is what that something is,
and who can read the traffic. This shape answers both:

```
work browser ──TLS──▶ VPS :443   haproxy.cfg: raw TCP + PROXY v2, holds no keys
               ──WireGuard──▶ home Caddy   front-door/Caddyfile, tunnel address only
               ──▶ Authelia (passkey or TOTP)   authelia/configuration.yml
               ──▶ Nest :19080 / :19082 on loopback, and Nest's own login
```

- **Only you can read the content.** TLS ends on your machine. The VPS
  forwards ciphertext; it learns that someone connected, when, and how much
  data moved, never what was said.
- **Your home IP stays private, and the router stays closed.** DNS points at the
  VPS, and home opens the tunnel outbound, so this works behind CGNAT too.
- **Two walls.** Authelia, which is widely deployed and reviewed, faces the
  internet. Nest's login is behind it.
- **Browser only.** The satellite apps use the private door above.

### What goes where

| Machine | Runs | From |
|---|---|---|
| VPS | WireGuard, HAProxy | `wireguard/wg-vps.conf`, `haproxy.cfg` |
| Home | WireGuard, Caddy, Authelia, Nest | `wireguard/wg-home.conf`, `front-door/Caddyfile`, `authelia/` |

The addresses in the files (`10.66.0.1` for the VPS, `10.66.0.2` for home)
are placeholders that have to agree with each other.
`scripts/test-deploy-configs.mjs` checks that they do, so change them
everywhere at once.

### Procedure

1. **A domain, and two names in it.** `chat.example.com` and
   `auth.example.com`, both as A records pointing at the **VPS's** public IP.
   If your DNS is on Cloudflare, set both to **DNS only (grey cloud)**. Proxied
   (orange) puts Cloudflare in the middle, decrypting, which is what this
   design avoids.
2. **CAA, so nobody else can get a certificate for your names.** The names
   point at the VPS, so whoever controls the VPS could otherwise pass Let's
   Encrypt's HTTP check for them. After Caddy's first successful issuance, take
   your ACME account URI from Caddy's storage and publish:

   ```
   example.com.  CAA 0 issue "letsencrypt.org; accounturi=<your ACME account URI>; validationmethods=dns-01"
   ```

   Certificate authorities that honour RFC 8657 then refuse any account but
   yours, and any validation method but DNS.
3. **The VPS.** Install WireGuard and HAProxy. Then:
   - Lock SSH to keys only.
   - Turn on automatic security updates.
   - Allow exactly three things in the firewall. With ufw:

   ```
   ufw default deny incoming
   ufw allow 22/tcp
   ufw allow 443/tcp
   ufw allow 51820/udp
   ufw enable
   ```

4. **The tunnel.** Generate a key pair on each end, fill in both
   `wireguard/*.conf`, and bring the tunnel up on both machines. From home,
   `ping 10.66.0.1` should answer.
5. **The home firewall: from the tunnel, 443 and nothing else.** This is not
   optional. Anything on the home machine listening on all interfaces answers
   on the tunnel address too. If Nest's network mode is on, that includes the
   gateway on 19080 in plain HTTP, and a compromised VPS could walk around
   Authelia straight to Nest's login.
   - Windows, assuming the tunnel is named `wg-home`. Block rules beat allow
     rules, so this overrides any rule network mode added:

     ```powershell
     New-NetFirewallRule -DisplayName "Redstart front door: 443 from the VPS" -Direction Inbound -InterfaceAlias wg-home -Protocol TCP -LocalPort 443 -RemoteAddress 10.66.0.1 -Action Allow
     New-NetFirewallRule -DisplayName "Redstart front door: block other TCP" -Direction Inbound -InterfaceAlias wg-home -Protocol TCP -LocalPort 1-442,444-65535 -Action Block
     New-NetFirewallRule -DisplayName "Redstart front door: block UDP" -Direction Inbound -InterfaceAlias wg-home -Protocol UDP -Action Block
     ```

   - Linux, with nftables, in the input chain:

     ```
     iifname "wg0" ip saddr 10.66.0.1 tcp dport 443 accept
     iifname "wg0" drop
     ```

   Leave IP forwarding **off** on the home machine (the default on both
   platforms), so the tunnel cannot be used as a route into the rest of your
   network.
6. **Authelia.** Write the three secret files. Hash a password into
   `users_database.yml`. Start Authelia with the three `_FILE` variables set.
7. **Caddy.** The certificate comes over DNS, so Caddy needs a build that
   includes your DNS provider's module. Standard downloads do not include one.
   Build it with `xcaddy`, or pick the module on Caddy's download page. Set the
   provider's API token as an environment variable, scoped to DNS edits on
   this one zone, and run `front-door/Caddyfile`. Then do step 2.
8. **Nest.** The control plane stays on loopback. Network mode can stay as it
   is for the LAN; the firewall in step 5 is what keeps it off the tunnel.
9. **A work account.** In Nest, create a separate account for the work machine,
   with a role that withholds File System, destructive operations and anything
   else you would not want reachable from a machine you do not control. Sign out
   when you are done there.

### Checklist

- [ ] From outside, `https://chat.example.com` shows **Authelia's** login, not
      Nest's. Nest's should appear only after passing it.
- [ ] `https://auth.example.com` has a valid certificate, with no warning.
- [ ] Three wrong Authelia passwords from one network get **that** address
      banned, and you can still sign in from another. That proves the PROXY
      protocol is carrying real client addresses.
- [ ] From the VPS: `nc -zv 10.66.0.2 443` connects, and
      `nc -zv 10.66.0.2 19080` and `nc -zv 10.66.0.2 19083` do **not**. That
      proves the firewall. Use a port check rather than curl here: a bare
      request carries no PROXY header and no hostname, so its answer says
      nothing either way.
- [ ] Signed in, `/redstart/mcp-servers` advertises
      `https://chat.example.com/mcp`, and the built-in tools connect.
- [ ] A long reply streams token by token, and a slow first token (a large
      prompt) is not cut off.
- [ ] The CAA record is published, and a CAA checker shows it.
- [ ] The control plane is not reachable through the front door by any path.

### Things to know

- **The VPS provider sees metadata.** When you connect, from which addresses,
  and how much moves. Not the content. Pick a provider you are comfortable
  knowing that.
- **The work network sees the hostname.** It is sent unencrypted at the start of
  every TLS connection (SNI). Pick a dull name.
- **Your employer may decrypt everything anyway.** A managed machine can
  inspect HTTPS with its own root certificate, and can record the screen.
  Nothing on your side changes that.
- **Authelia is now the thing to keep updated.** It is what the internet talks
  to first.
- **Long, silent requests are the untested edge.** HAProxy's idle limits are
  set to an hour, but nothing has measured a real model's slowest first token
  through this path.

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
