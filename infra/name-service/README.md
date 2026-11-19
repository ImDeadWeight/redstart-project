# Redstart name service

Automatic HTTPS names for Redstart Nest installs: `<id>.nest.redstartdevelopment.com`,
pointing at the install's **private** LAN address, with the DNS-01 challenge
Let's Encrypt needs to issue it a certificate. A Cloudflare Worker with a D1
database. Deployed by hand; never shipped in an installer.

**Live since 2026-11-19** at `https://names.redstartdevelopment.com` (D1
`redstart-names`, region WNAM). `node test/live-check.mjs` re-checks it end to end.

The design (routes, invariants, limits) is TLS plan component C12. In short:

| Route | Auth | Does |
|---|---|---|
| `POST /v1/register` | none, 5/hour per network | mint an `id` and a credential (returned once, stored only as SHA-256) |
| `PUT /v1/ip` | `Bearer <id>.<credential>` | publish the LAN address: A (private IPv4 only), AAAA (ULA `fd00::/8` only) |
| `POST /update` | `X-Api-User` / `X-Api-Key` | the acme-dns protocol Caddy's acmedns plugin speaks: set `_acme-challenge.<id>.nest` TXT, keeping the newest two |
| `POST /v1/heartbeat` | Bearer | still here |
| `DELETE /v1/register` | Bearer | remove every record and forget the install |
| `GET /health` | none | `ok` |

**Invariants**, each a test in `test/service.test.mjs`:
- A credential touches only its own `<id>.nest.` records.
- Nothing is ever written outside `<id>.nest.` and `_acme-challenge.<id>.nest.`.
- Every record is **DNS-only** (`proxied: false`). A proxied record would send
  the household's traffic through Cloudflare. The daily job flips any it finds
  back, and reports it.
- Only private addresses are published.

A daily job also forgets installs unseen for 180 days and alerts at 700 zone
records (Cloudflare Free allows 1,000; about 3 per install).

## Privacy

The service stores, per install: the random id, a hash of its credential,
when it registered and was last heard from, the LAN addresses it published,
and the two newest certificate-challenge values. Request logs carry the
caller's public IP transiently (Cloudflare's own logging). No account, no
email, nothing about how Redstart is used, and nothing about conversations:
those never leave the house, and every name points at a private address that
is unreachable from the internet.

## Tests

```
npm test                                   # the suite (Node 22.13+, no install)
node test/caddy-acmedns-interop.mjs        # manual: the REAL Caddy acmedns plugin
                                           # against the service (LE staging; network)
node test/live-check.mjs                   # manual: the DEPLOYED service end to end:
                                           # register, A record in public DNS, a real
                                           # staging certificate, unregister (always)
npm install && npx wrangler d1 migrations apply redstart-names --local && npm run dev
                                           # the Worker under workerd, local D1
```

## Deploying (by hand)

Nothing here is automated, on purpose: it publishes a service on the domain.

1. `npm install` (wrangler, pinned in package.json), then `npx wrangler login`.
2. `npx wrangler d1 create redstart-names`: copy the `database_id` into
   `wrangler.toml`.
3. Copy the zone's **Zone ID** (Cloudflare dashboard → redstartdevelopment.com →
   Overview) into `wrangler.toml`'s `ZONE_ID`.
4. Create an API token: My Profile → API Tokens → *Edit zone DNS* template,
   **Zone Resources: redstartdevelopment.com only**. Then
   `npx wrangler secret put CF_API_TOKEN`. It is never committed or logged.
5. Optional: `npx wrangler secret put ALERT_WEBHOOK`, where housekeeping alerts
   (proxied records found, 700 records) are POSTed.
6. `npx wrangler d1 migrations apply redstart-names --remote`.
7. `npx wrangler deploy`. Cloudflare creates the `names.redstartdevelopment.com`
   record itself (`custom_domain = true`). **Do not add that record by hand.**
8. Check: `curl https://names.redstartdevelopment.com/health` answers `ok`.
   If the custom domain has no certificate, check the zone's CAA records: the
   zone allows only `letsencrypt.org`, and Cloudflare's edge may need its own CA
   added.
9. Before the first real install: in the dashboard, a rate-limiting rule on
   `/v1/register` (the plan's 5/hour) as a second layer over the one in code.
   Then, once real installs use it, the Public Suffix List entry for
   `nest.redstartdevelopment.com` (a `_psl` TXT record and a PR to
   publicsuffix/list). Until then Let's Encrypt allows about 50 new
   certificates a week for the whole domain.
