# Groups: what each person can do, granted rather than withheld — plan

**Created:** 2026-11-13
**Status:** design record. Nothing here is built. Decisions D1–D14 were agreed
in discussion on 2026-11-13; §11 lists the questions still open. Write the
implementation record (`groups-implementation.md`) against the tree as it is
when work starts, and correct this file from it rather than letting the two
drift.
**Scope:** USER permissions — what an account may do and reach. Not the
model-side machinery: approval rules, tool classes, standing grants, the
approval ledger, profile bans and client-side tool toggles are untouched by
this plan and are named in §0 only so the boundary is clear.
**Origin:** the permission system grew one restriction at a time. Every
account starts at Full Access and is narrowed by the profile, the capability
config, its role and its surface list. Each layer is a veto, so the only way to
answer "why can't Alice use Documents?" is to check all of them, and the model
cannot express the things the roadmap needs next: sharing a project, a shared
document space for search (rag 5b), or per-account access to a shared folder
(roadmap "Folder access grants"). All three need a "who" that can be given
something. This plan flips the model so access is granted, and builds that
"who" as it does.

---

## 0. What exists today

The people side is three things:

- **Tier** — `owner | admin | user` (`accounts-storage.mjs`, `auth.mjs
  canManage`). Who manages whom. Hardcoded. Stored as `tier`, mirrored as
  `role` because Twig, Blueprints and Yellowscript read the old name from the
  login response (`accounts-storage.mjs normalizeAccount`).
- **Role** — `roles-storage.mjs`, one per account (`account.roleId`, null →
  built-in Full Access). A permission set that may only NARROW the server's
  config: `capabilities`, `webSourceIds`, `allowWhitelistBypass`,
  `allowWebSearchEngine`, `maxFetchTokens`, `fileSystem.{allowWrite,
  allowDestructive}`, `surfaces`, `admin.{manageAccounts, manageRoles,
  managePromptBlocks, manageOrgWorkflows}`. Absent field = inherit; empty
  array = nothing. Built-ins: Full Access (`{}`) and Restricted.
- **Ownership** — projects, workflows, memories, approvals and conversations
  are keyed by `memoryKey(account)`; projects decide access only in
  `projects-storage.mjs canRead / canWrite` (owner-only, `members: []`
  reserved). Personal files are structurally per-account (`user-scope.mjs`).

Where it is decided, and the reason the blast zone is containable — every
enforcement point goes through four functions:

| Function | File | Called from |
|---|---|---|
| `resolveEffectiveConfig(account, config, role)` | `permissions.mjs` | `tools-gateway.mjs` (completions proxy), `mcp-server.mjs` (tools/list, tools/call) |
| `canDo(account, permission)` → `can()` | `auth.mjs` → `permissions.mjs` | `gateway/auth-routes.mjs`, `workflow-routes.mjs`, `prompt-routes.mjs`, `assertNoEscalation` |
| `surfacePermitted(account, surface)` → `allowsSurface()` | same | `tools-gateway.mjs`, `mcp-server.mjs`, `task-runner.mjs` |
| `mayAccessControlPlane(account)` | `permissions.mjs` | `admin-listener.mjs`, `admin/auth-routes.mjs` — **not changed by this plan** |

The safety property is `scripts/test-roles.mjs`: over randomised config × role
pairs, nothing `narrowConfig` returns is more permissive than its input.

Configured in: chat-ui **Settings → Accounts** (`SettingsChatAccountsTab.svelte`,
337 lines) and **Settings → Roles** (`SettingsChatRolesTab.svelte`, 509 lines),
over `/auth/accounts*` and `/auth/roles*` (`gateway/auth-routes.mjs`).

Out of scope, named so nobody folds them in: approval rules and standing grants
(`approval-grants.mjs`, `tools-definitions.mjs approvalRule`), the approval
ledger, profile tool bans, chat-ui's per-browser tool disable, `authRequired`.

Small finding while reading: `auth.mjs deleteRole`'s comment says the members'
sessions are revoked; the code does not revoke them. Harmless, because sessions
carry no authority and every request re-reads the account, but the comment is
wrong. Fix it when `deleteRole` is replaced (Phase 2).

---

## 1. Goals and non-goals

**Goals**

1. Access is **granted**. An account can do what its groups grant, within what
   the server has turned on, and nothing else.
2. "What can this person do, and why?" has **one answer on one screen**, with
   the group each item comes from.
3. A **principal** — an account or a group — that later work (project sharing,
   shared document spaces, folder grants) grants resources to, with no second
   migration.
4. **Usable by a non-specialist** (mission.md: a parent in a household, an
   office manager in a social work practice).
5. **No one's access changes on upgrade.** Proven by a test, not asserted.

**Non-goals**

- Per-account overrides. Access comes from groups only (D3).
- Deny rules. "Everyone except Bob" is expressed by Bob's groups (D4).
- A policy language or a Zanzibar-style engine. Three sharing levels (D12)
  cover the mission; the principal shape keeps the door open.
- Changing tiers, the control plane, approvals, or the auth-off posture.

---

## 2. Decisions

- **D1. Flip to granted access.** Effective access = server limit ∩ (union of
  the account's groups' grants). Chosen over keeping restrict-only roles
  (option A) and over adding sharing beside roles (option B), because the
  groups are the principals that sharing needs, and because a new account
  starting from a safe baseline is need-to-know by default — the same rule
  Redstart already applies to what leaves the machine ("exactly what an
  administrator turns on", mission.md).
- **D2. Tier stays, unchanged.** It answers a different question (who
  administers whom). Admin permissions granted by a group still only count for
  admin-tier accounts; a group cannot make a User an admin.
- **D3. Groups only, no per-account overrides.** An override is the point at
  which "why can Bob do that?" stops having a one-line answer.
- **D4. No deny.** Restricting someone means changing their groups. Disabling
  an account (`status: 'disabled'`) remains the hard stop.
- **D5. The Owner is never narrowed** (anti-lockout, as today). Owners are not
  group members and do not appear in member lists.
- **D6. Auth off keeps its meaning:** `account === null` is served the server
  limit, unnarrowed, exactly as `resolveEffectiveConfig` does today. Groups do
  not apply with login off; the People page says so.
- **D7. "Everyone" is a built-in group every non-owner account belongs to.**
  Membership is implicit (not stored, cannot be removed). Its grants are
  editable; it cannot be deleted or renamed.
- **D8. On a fresh install, Everyone grants the basics that stay on the
  machine and belong to the user:** chat, `memory`, `documents`,
  `document_search` (projects are not gated, as today). It grants nothing that
  reaches out (web, scholar, external MCP, plugins) and none of the shared
  stores (postgres, sqlite, vault, git), no file-system writes, no admin
  permissions, and the `nest-chat` and `twig` apps. A new account is useful at
  once; reach is handed out on purpose.
- **D9. No wildcards. A grant names what it grants.** A plugin, web source or
  app added later reaches nobody until a group is given it. To keep that from
  being a chore, every flow that adds one (plugin install, custom web source,
  external MCP server) ends with "Which groups get this?". This is a
  deliberate change from today, where Full Access covers future plugins; the
  upgrade (§5) expands Full Access to what exists at that moment.
- **D10. Several groups per account.** People in small offices wear more than
  one hat. Because grants only add, overlapping membership is safe.
- **D11. Name: Groups.** Retires "role", which today means two things (tier's
  old name, and the capability set).
- **D12. Sharing levels, when resource grants arrive: Viewer / Editor /
  Owner**, granted to an account or a group. Not built here (§9).
- **D13. Starter groups at first-run setup.** "Household" creates Adults and
  Kids; "Office" creates Staff and Supervisors; "Skip" creates nothing beyond
  Everyone. Presets only — ordinary editable groups afterwards.
- **D14. One People page** replaces Accounts and Roles (§7).

---

## 3. The model

### 3.1 Storage

`<config>/groups.json`, through `json-store.mjs` like every other store:

```json
{
  "version": 1,
  "groups": [
    {
      "id": "uuid",
      "name": "Case workers",
      "description": "",
      "grants": {
        "capabilities": ["memory", "documents", "document_search", "vault"],
        "webSourceIds": ["wikipedia", "congress"],
        "openWeb": false,
        "webSearchEngine": false,
        "maxFetchTokens": null,
        "fileSystem": { "write": false, "destructive": false },
        "apps": ["nest-chat", "twig"],
        "anyAppKey": false,
        "admin": []
      },
      "createdAt": "…", "updatedAt": "…"
    }
  ]
}
```

- Every field is required and explicit. A missing field reads as granting
  nothing (fail closed) — the opposite of a role, where missing meant inherit.
- `openWeb`: may fetch any public URL **when the server's whitelist is off**.
  Without it, the account is held to its granted `webSourceIds` whatever the
  server setting. This exists because today's Full Access with the server
  whitelist off reaches any public URL, and the upgrade must not change that
  (§5).
- `maxFetchTokens: null` = up to the server limit.
- `anyAppKey`: may hold an account-wide API key, which carries no app
  identity. Today that is allowed exactly when the role does not restrict
  surfaces (`auth.mjs regenerateApiKey`); it becomes its own readable grant.
- `admin`: a subset of `ADMIN_PERMISSIONS`, renamed in Phase 2:
  `manageRoles` → `manageGroups`.
- Everyone is stored in the same file with `builtIn: true` and the fixed id
  `everyone`, so its grants are editable like any group's.

`accounts.json` gains `groupIds: string[]` (Everyone not listed). `roleId` is
kept, read-only, until Phase 6 so a downgrade still finds it.

### 3.2 Combining groups

One pure function, `combineGrants(groups) → permissions`, produces a permission
set **in the shape `narrowConfig` already reads**. That is the central design
choice: `narrowConfig`, `can` and `allowsSurface` survive, and with them the
restrict-only proof that nothing exceeds the server limit.

| Group field | Combined | Becomes (narrowConfig input) |
|---|---|---|
| `capabilities` | union | `capabilities: [...]` |
| `webSourceIds`, `openWeb` | union; any `openWeb` | `openWeb` → `webSourceIds: null` (inherit server whitelist); else `webSourceIds: [...]` and `allowWhitelistBypass: false` |
| `webSearchEngine` | any | `allowWebSearchEngine` |
| `maxFetchTokens` | max; any `null` wins | `maxFetchTokens` (`null` → inherit) |
| `fileSystem.write / destructive` | any | `fileSystem.allowWrite / allowDestructive` |
| `apps`, `anyAppKey` | union; any | `surfaces: [...]`; `anyAppKey` is read by key issuance, not by `allowsSurface` |
| `admin` | union | `admin: { perm: true, … }` (explicit, so omitted = false) |

Then, unchanged:

```
resolveEffectiveConfig(account, config)
  account === null      → config                      (D6)
  account.tier owner    → config                      (D5)
  else                  → narrowConfig(config, combineGrants(groupsOf(account)))
```

`resolveEffectiveConfig` loses its `role` parameter; its callers pass
`groupsFor(account)` instead of `roleFor(account)` (three call sites). `canDo`
and `surfacePermitted` keep their signatures.

### 3.3 Escalation

`assertNoEscalation` (auth.mjs) carries over and widens to every act that can
hand out an admin permission: creating or editing a group, adding an account
to a group, and **adding a member to a group from the group's side**. An admin
may not grant, through any of these, an admin permission they do not hold.
Editing the Everyone group's `admin` field is Owner-only.

---

## 4. Invariants and tests

`scripts/test-groups.mjs`, randomised like `test-roles.mjs` (same seed
reporting, same counterexample output). `test-roles.mjs` keeps running
unchanged against `narrowConfig` until Phase 6.

- **P1 — never above the server limit.** For any config and any set of groups,
  the effective config is no more permissive than the config on any field.
  (Inherited from narrowConfig; asserted again end to end through
  `combineGrants`.)
- **P2 — adding only adds.** For any groups G and any extra group g,
  effective(G ∪ {g}) ⊇ effective(G) on every field; removing a group never
  widens. This is the property that makes multiple groups (D10) safe, and the
  one most likely to break on the web fields — `openWeb` and the
  whitelist-forcing branch in narrowConfig are where to aim the generator.
- **P3 — the upgrade changes nothing.** For any accounts.json + roles.json +
  config, every account's effective config, `canDo` answer for each admin
  permission, and `surfacePermitted` answer for each surface are identical
  before and after migration. Run over generated files AND a fixture copied
  from a real install.
- **P4 — fail closed.** A group with a missing or malformed `grants` field
  grants nothing; an account whose `groupIds` name a deleted group resolves as
  if that id were absent.
- **P5 — escalation.** No sequence of group edits and membership changes by an
  admin leaves any account holding an admin permission the actor lacked.
  (Sequence fuzz, not single calls.)

Existing suites that change, not just pass: `test-auth.mjs`,
`test-admin-listener.mjs`, `test-workflows.mjs`, `test-web-search-engine.mjs`,
`test-memory.mjs`, `test-document-search.mjs`, `test-mcp-capabilities.mjs`,
`test-contracts.mjs`, `test-gateway-routes.mjs` (they construct roles).

---

## 5. The upgrade

Runs once, on first read of groups.json when it does not exist and roles.json
or any `roleId` does. Same pattern as the tier migration in
`accounts-storage.mjs read()`.

1. Copy `accounts.json` and `roles.json` to `*.pre-groups.json`. Abort the
   migration (keep serving roles) if the copy fails.
2. Everyone is created granting **nothing** — upgraded installs do not get the
   D8 baseline, because adding it would widen Restricted members.
3. Each user-defined role becomes a group with the same id and name. Its
   permissions are expanded against what exists now:
   - absent `capabilities` → every capability id present (built-ins + installed
     plugins);
   - absent `webSourceIds` → every source id, plus `openWeb` unless
     `allowWhitelistBypass === false`;
   - absent `surfaces` → every `SURFACE_IDS` entry, plus `anyAppKey: true`;
   - absent `admin` → all four permissions;
   - `allowWebSearchEngine !== false` → `webSearchEngine: true`;
   - `fileSystem.allowWrite !== false` → `write: true`, likewise destructive;
   - `maxFetchTokens` carried as is (`null` if absent).
4. Built-in **Full Access** becomes a group named "Full access" with step 3
   applied to `{}`; built-in **Restricted** becomes "Restricted" from its
   permission set. Neither is built-in afterwards.
5. Each non-owner account gets `groupIds: [<its role's group>]`; `roleId: null`
   or dangling → Full access.
6. Write groups.json, then accounts.json (the reverse leaves accounts pointing
   at groups that do not exist, which P4 resolves as "nothing" — safe, but a
   lockout; this order leaves unused groups instead).
7. `logEvent('auth', 'groups_migrated', { groups, accounts })`.

P3 is what makes this safe. The visible change after upgrade is D9: a plugin
installed later is not in "Full access" until someone adds it.

---

## 6. API and contract

Gateway routes (`gateway/auth-routes.mjs`), admin-tier, each gated on its
`canDo` permission as today:

| Route | Replaces | Gate |
|---|---|---|
| `GET /auth/groups` → `{ groups, capabilityIds, webSources, apps, adminPermissions, canEdit }` | `GET /auth/roles` | admin tier |
| `POST /auth/groups`, `PUT /auth/groups/:id`, `DELETE /auth/groups/:id` | `POST/DELETE /auth/roles…` | `manageGroups` |
| `PUT /auth/groups/:id/members` `{ add: [], remove: [] }` | — | `manageGroups` + `canManage` per account |
| `PUT /auth/accounts/:id/groups` `{ groupIds }` | `PUT /auth/accounts/:id/role` | `manageAccounts` |
| `GET /auth/accounts/:id/access` → effective access with the group behind each item | — | `manageAccounts` |
| `GET /auth/me/access` | — | any account (your own) |
| `POST /auth/groups/preview` `{ groupIds }` → effective access | — | `manageGroups` ("View as") |

`/auth/roles*` answer `410 Gone` with a pointer for one release, then go.

Login and `/auth/me` responses gain `groupIds`; `roleId` and the `role` mirror
of `tier` stay until Phase 6. **Twig, Blueprints and Yellowscript each hold a
copy of this shape** — check each for `role` and `roleId` before Phase 6 and
ship their reads of `tier` first.

Logging (`logEvent`, scalars only, per security.md): `group_saved`,
`group_deleted`, `group_members_changed { group, added, removed }`,
`account_groups_changed { username, groups }`, `groups_migrated`. These answer
"who had access to what, when" for a regulated office.

---

## 7. The People page

Settings → **People** replaces Accounts and Roles. Two views, one page.

**Accounts view** (default)
- List: name, tier, group chips, status, last login. Filter by group.
- Detail panel: tier; groups (add / remove here); **Can use** — the effective
  access, each item tagged with the group it comes from ("Documents · from
  Case workers"), and anything the server has turned off shown as such
  ("Web search · off on this server") so a missing item is never a mystery;
  keys; reset password; disable; delete.

**Groups view**
- List with member counts; Everyone first, marked built-in.
- Editor: what the group grants, in plain words grouped as *Tools*, *Web*,
  *Files*, *Apps*, *Administration*; members, editable here too.
- **View as**: pick any set of groups and see the resulting access.

**Rules for the page**
- Nothing the server has off is offered as grantable without saying so.
- Admin permissions render only for admin-tier members; the editor says
  "applies to admin accounts only".
- With login off, the page explains that groups take effect once login is on.
- First-run starter choice (D13) lives in the Owner setup flow, after the Owner
  account is created.

Retire `SettingsChatRolesTab.svelte`; rebuild `SettingsChatAccountsTab.svelte`
as `SettingsPeople*`. `auth.svelte.ts` reads `tier` only.

---

## 8. Blast zone

| Area | Change |
|---|---|
| `roles-storage.mjs` (170) | replaced by `groups-storage.mjs` |
| `permissions.mjs` (299) | add `combineGrants`; `resolveEffectiveConfig` takes groups; rename `manageRoles`; `narrowConfig`, `can`, `allowsSurface`, `mayAccessControlPlane` unchanged |
| `auth.mjs` (711) | role functions → group functions; escalation widened; key issuance reads `anyAppKey` |
| `accounts-storage.mjs` (177) | `groupIds`, migration hook |
| `gateway/auth-routes.mjs` (236) | routes per §6 |
| `tools-gateway.mjs`, `mcp-server.mjs` | one argument each |
| `task-runner.mjs`, `workflow-routes.mjs`, `prompt-routes.mjs` | none (call `surfacePermitted` / `canDo`) |
| chat-ui | People page (~800 lines new, ~850 retired); `auth.svelte.ts`; `canEdit` consumers unchanged |
| Plugin install, custom source, external MCP flows | "Which groups get this?" step (D9) |
| Tests | new `test-groups.mjs`; nine suites updated (§4) |
| Docs | security.md Roles → Groups, configuration.md, roadmap.md, mission.md's "grants are still server-wide" line, README screenshots |
| Other repos | Twig, Blueprints, Yellowscript: read `tier`, not `role` (Phase 6 gate) |

---

## 9. What this is groundwork for (not in this plan)

Resource grants — `{ resource, principal: { kind: 'account' | 'group', id },
level: 'viewer' | 'editor' | 'owner' }` — reuse the principals built here:

- **Project sharing:** `projects-storage canRead / canWrite` consult grants;
  `members: []` is replaced by them.
- **Shared document spaces (rag 5b):** `document-index` rows already carry a
  nullable `grant_id`.
- **Folder access grants (roadmap):** shared capability roots, read-only by
  default.

The hard part, recorded so it is not rediscovered: a project's files, index
and memory live in the **owner's** per-account storage (`user-scope.mjs`), so
a member's search runs against their own index, which does not contain them.
Sharing needs project-owned storage (outside any one `user_files/<scope>`),
not just a grant row. That is the first decision of the resource-grants plan.

---

## 10. Phases

Each phase ships on its own and leaves the tree working.

1. **Core, dark.** `groups-storage.mjs`, `combineGrants`, `test-groups.mjs`
   P1, P2, P4. Nothing reads groups yet. *Exit:* suites green; P2 holds over
   10k cases.
2. **Migration + switch-over.** §5 with P3; `resolveEffectiveConfig` and
   `canDo` read groups; escalation P5; `manageRoles` → `manageGroups`; fix the
   stale `deleteRole` comment. *Exit:* P3 green on generated data and on a
   real install's fixture; full `test:security` green.
3. **API.** §6 routes, access endpoints, logging; `/auth/roles*` → 410.
4. **People page.** §7. Screenshot-checked against the chat-ui's existing
   settings at desktop and phone width.
5. **Grant-on-add flows and first-run starters.** D9's "Which groups get
   this?" in plugin install, custom source and external MCP; D13 in Owner
   setup; D8 baseline for fresh installs.
6. **Cleanup.** After Twig, Blueprints and Yellowscript read `tier`: drop the
   `role` mirror, `roleId`, `roles-storage.mjs`, `test-roles.mjs` (its
   narrowConfig cases move into `test-groups.mjs`), and the `*.pre-groups.json`
   copies after one release.
7. Docs throughout; security.md's Roles section is rewritten in Phase 2, not
   at the end.

---

## 11. Open questions

1. **Does Everyone's baseline include `python`?** It runs in WASM with no
   network and only the conversation's workspace, so it stays on the machine,
   but it is code execution. Leaning: no, granted on purpose.
2. **Where does the People page live long term?** It is admin work on the
   data-plane gateway inside the chat UI today. Fine for now; revisit if the
   launcher grows an admin surface over the control plane.
3. **Group-scoped admins** ("may manage members of Case workers only"). Not
   needed for the mission's sizes; the shape allows it later.
4. **Account limits per group** (fetch budgets are the only numeric grant
   today). Leave until a second numeric grant exists.
5. **Downgrade.** `roleId` survives to Phase 6 and the pre-groups copies exist,
   so a downgrade within one release works; after Phase 6 it does not. Say so
   in the release notes.

---

## 12. Risks

- **A widening slips through `combineGrants`.** The web fields are the
  trap: the role model expressed "open web" as an absent list, the group model
  as `openWeb`. P1 and P2 target them; review them by hand as well.
- **Migration lockout.** Mitigated by write order (§5.6), P4 resolving
  dangling ids to nothing rather than to everything, the pre-groups copies,
  and the Owner being exempt from groups entirely — the Owner can always log
  in and fix it.
- **D9 friction.** If "Which groups get this?" is skipped, a new plugin
  silently reaches no one. The flow must make "no groups" a visible choice,
  not a default the admin clicks past.
- **Client contract.** Removing `role` before the other apps read `tier`
  makes every admin look like a user in those apps (the confusing direction,
  per the accounts-storage comment). Phase 6 is gated on it for that reason.
