// =============================================================================
// Seed realistic fixture content into the live capability folders.
// =============================================================================
// The folder-scoped capabilities (SQLite, Vault, Git, File System) are only
// worth switching on if there is something behind them — a capability pointed
// at an empty folder still costs its tool schemas in every request's context
// while being able to answer nothing. This script fills those folders with one
// small, INTERNALLY CONSISTENT dataset so the tools can be exercised for real
// from the app, including questions that require crossing two capabilities.
//
// Roots are read from the live tools.json (never hardcoded), so this runs on
// any machine where the capabilities have been provisioned.
//
// Everything written lives under a "riverside-books" namespace (or is prefixed
// RB-) so it is trivially distinguishable from real user content, and --clean
// removes exactly what was created.
//
// Run:    node scripts/seed-capability-fixtures.mjs
// Clean:  node scripts/seed-capability-fixtures.mjs --clean
// =============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import initSqlJs from 'sql.js'

const CLEAN = process.argv.includes('--clean')

// The fixture namespace. One directory name / file stem, used everywhere, so
// --clean is an exact inverse of the seed rather than a guess.
const NS = 'riverside-books'

// ---------------------------------------------------------------------------
// Locate the live capability config
// ---------------------------------------------------------------------------

function toolsJsonPath() {
  if (process.env.REDSTART_TOOLS_JSON) return process.env.REDSTART_TOOLS_JSON
  const appData =
    process.env.APPDATA ||
    (process.platform === 'darwin'
      ? path.join(process.env.HOME || '', 'Library', 'Application Support')
      : path.join(process.env.HOME || '', '.config'))
  return path.join(appData, 'redstart', 'tools.json')
}

function readRoots() {
  const p = toolsJsonPath()
  if (!fs.existsSync(p)) {
    console.error(`No tools.json at ${p}\nStart Redstart Nest once so it provisions the capability folders, then re-run.`)
    process.exit(1)
  }
  const caps = JSON.parse(fs.readFileSync(p, 'utf8')).capabilities || {}
  return {
    sqlite: caps.sqlite?.rootDir || null,
    vault: caps.vault?.rootDir || null,
    git: caps.git?.rootDir || null,
    fileSystem: caps.file_system?.rootDir || null,
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const created = []
const skipped = []

function writeFixture(fullPath, content) {
  fs.mkdirSync(path.dirname(fullPath), { recursive: true })
  fs.writeFileSync(fullPath, content, 'utf8')
  created.push(fullPath)
}

function removeIfPresent(fullPath) {
  if (!fs.existsSync(fullPath)) return
  fs.rmSync(fullPath, { recursive: true, force: true })
  created.push(fullPath)
}

// ---------------------------------------------------------------------------
// The dataset — one bookstore, described from four different angles so the
// capabilities can be cross-referenced (a vault note names a SKU that exists in
// the database; a repo script reads that same database).
// ---------------------------------------------------------------------------

const BOOKS = [
  // sku,        title,                         author,              genre,      price, stock, supplier_id
  ['RB-1001', 'The Salt Path',                 'Raynor Winn',        'Memoir',     9.99, 14, 1],
  ['RB-1014', 'Piranesi',                      'Susanna Clarke',     'Fiction',   12.50,  3, 1],
  ['RB-1027', 'Braiding Sweetgrass',           'Robin Wall Kimmerer','Nature',    14.00, 22, 2],
  ['RB-1043', 'The Overstory',                 'Richard Powers',     'Fiction',   11.25,  0, 2],
  ['RB-1055', 'Entangled Life',                'Merlin Sheldrake',   'Science',   13.75,  8, 2],
  ['RB-1068', 'A Short History of Nearly Everything', 'Bill Bryson', 'Science',    8.99, 31, 3],
  ['RB-1072', 'Wolf Hall',                     'Hilary Mantel',      'Fiction',   10.50,  6, 1],
  ['RB-1090', 'The Hidden Life of Trees',      'Peter Wohlleben',    'Nature',    12.00,  2, 2],
  ['RB-1103', 'Sapiens',                       'Yuval Noah Harari',  'History',   15.99, 18, 3],
  ['RB-1118', 'The Dig',                       'John Preston',       'Fiction',    8.50,  0, 4],
  ['RB-1124', 'Underland',                     'Robert Macfarlane',  'Nature',    13.20, 11, 2],
  ['RB-1136', 'Thinking, Fast and Slow',       'Daniel Kahneman',    'Science',   14.50,  5, 3],
]

const SUPPLIERS = [
  [1, 'Wentworth Trade',    'orders@wentworth-trade.example',  'Mon/Thu',  14],
  [2, 'Greenline Books',    'hello@greenline.example',         'Wed',      21],
  [3, 'Castlegate Wholesale', 'trade@castlegate.example',      'Tue/Fri',   7],
  [4, 'Ashby & Sons',       'accounts@ashbyandsons.example',   'Monthly',  35],
]

const ORDERS = [
  [5001, '2026-06-14', 2, 'received'],
  [5002, '2026-06-28', 1, 'received'],
  [5003, '2026-07-12', 3, 'received'],
  [5004, '2026-07-30', 2, 'pending'],
  [5005, '2026-08-03', 4, 'pending'],
]

const ORDER_ITEMS = [
  [5001, 'RB-1027', 20], [5001, 'RB-1055', 10], [5001, 'RB-1124', 12],
  [5002, 'RB-1001', 15], [5002, 'RB-1014', 6],
  [5003, 'RB-1068', 30], [5003, 'RB-1103', 20], [5003, 'RB-1136', 8],
  [5004, 'RB-1043', 15], [5004, 'RB-1090', 10],
  [5005, 'RB-1118', 12],
]

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

async function seedSqlite(root) {
  const dbPath = path.join(root, `${NS}.db`)
  if (CLEAN) return removeIfPresent(dbPath)

  const SQL = await initSqlJs()
  const db = new SQL.Database()

  db.run(`
    CREATE TABLE suppliers (
      id            INTEGER PRIMARY KEY,
      name          TEXT NOT NULL,
      contact_email TEXT NOT NULL,
      delivery_days TEXT,
      lead_time_days INTEGER NOT NULL
    );
    CREATE TABLE books (
      sku         TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      author      TEXT NOT NULL,
      genre       TEXT NOT NULL,
      price       REAL NOT NULL,
      stock       INTEGER NOT NULL DEFAULT 0,
      supplier_id INTEGER NOT NULL REFERENCES suppliers(id)
    );
    CREATE TABLE orders (
      id          INTEGER PRIMARY KEY,
      ordered_on  TEXT NOT NULL,
      supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
      status      TEXT NOT NULL
    );
    CREATE TABLE order_items (
      order_id INTEGER NOT NULL REFERENCES orders(id),
      sku      TEXT NOT NULL REFERENCES books(sku),
      quantity INTEGER NOT NULL,
      PRIMARY KEY (order_id, sku)
    );
    CREATE VIEW out_of_stock AS
      SELECT b.sku, b.title, b.author, s.name AS supplier, s.lead_time_days
      FROM books b JOIN suppliers s ON s.id = b.supplier_id
      WHERE b.stock = 0;
  `)

  const insert = (sql, rows) => {
    const stmt = db.prepare(sql)
    for (const row of rows) { stmt.run(row); stmt.reset() }
    stmt.free()
  }
  insert('INSERT INTO suppliers VALUES (?,?,?,?,?)', SUPPLIERS)
  insert('INSERT INTO books VALUES (?,?,?,?,?,?,?)', BOOKS)
  insert('INSERT INTO orders VALUES (?,?,?,?)', ORDERS)
  insert('INSERT INTO order_items VALUES (?,?,?)', ORDER_ITEMS)

  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(dbPath, Buffer.from(db.export()))
  db.close()
  created.push(dbPath)
}

// ---------------------------------------------------------------------------
// Vault — markdown notes. Deliberately mixes both tag forms (YAML frontmatter
// `tags:` and inline #tags) and uses subfolders, since vault_search/vault_tags
// handle each differently.
// ---------------------------------------------------------------------------

const NOTES = {
  'index.md': `---
tags: [reference, shop]
---

# Riverside Books — working notes

Shop notebook. Stock figures live in the database (\`${NS}.db\`), not here —
these notes are the context around them: who we buy from, what we decided, and why.

- [[suppliers/greenline]] — our nature/science supplier, slow but reliable
- [[suppliers/ashby-and-sons]] — the problem account
- [[decisions/2026-07-restock-policy]] — current restock rule
- [[meetings/2026-08-04-stock-review]] — most recent review
`,

  'suppliers/greenline.md': `---
tags: [supplier, nature]
---

# Greenline Books

Supplier ID 2. Contact: hello@greenline.example. Delivery Wednesdays,
21-day lead time — the longest of the three active suppliers, which is why
anything from Greenline needs reordering well before it hits zero.

Everything in our Nature section comes from Greenline, plus most Science.
Notable: RB-1043 (The Overstory) and RB-1090 (The Hidden Life of Trees) are
both Greenline lines and both currently critical. #restock #priority

Terms: 35% trade discount, sale-or-return on hardbacks only.
`,

  'suppliers/ashby-and-sons.md': `---
tags: [supplier, problem]
---

# Ashby & Sons

Supplier ID 4. Monthly delivery only, 35-day lead time. We keep exactly one
line with them — RB-1118 (The Dig) — because it sells steadily around the
Sutton Hoo exhibition and nobody else stocks it at trade.

Order 5005 went in on 3 August and has not been acknowledged. This is the third
time. #problem #followup

Recommendation: move RB-1118 to Castlegate if they will take it, and close the
Ashby account at year end.
`,

  'suppliers/wentworth-trade.md': `---
tags: [supplier, fiction]
---

# Wentworth Trade

Supplier ID 1. Mon/Thu delivery, 14-day lead time. General fiction and memoir.

Reliable, no outstanding issues. RB-1014 (Piranesi) is down to 3 copies and
moves fast in autumn — worth a standing order. #restock
`,

  'decisions/2026-07-restock-policy.md': `# Restock policy (from July 2026)

Agreed 12 July. Supersedes the old "reorder at 5 copies" rule, which did not
account for how differently our suppliers behave.

The rule is now lead-time-aware:

- Reorder point = expected weekly sales x (lead time in days / 7) + 2 copies buffer.
- In practice: Castlegate lines (7 days) reorder at ~4, Wentworth (14 days) at ~6,
  Greenline (21 days) at ~9, Ashby (35 days) at ~14.
- Anything at zero stock is escalated the same day, regardless of supplier.

The database view \`out_of_stock\` exists to make that last check one query.

#policy #restock
`,

  'meetings/2026-08-04-stock-review.md': `---
tags:
  - meeting
  - restock
---

# Stock review — 4 August 2026

Present: PC, JM.

Went through everything at or near zero:

- **RB-1043 The Overstory** — zero. Greenline, 21-day lead time. On order 5004
  (placed 30 July, still pending). Realistically back on shelf early September.
- **RB-1118 The Dig** — zero. Ashby, order 5005 unacknowledged. See
  [[suppliers/ashby-and-sons]]. Agreed to chase once more, then substitute.
- **RB-1090 The Hidden Life of Trees** — 2 left, Greenline. Below the 9-copy
  reorder point from [[decisions/2026-07-restock-policy]]. Add to next order.
- **RB-1014 Piranesi** — 3 left, Wentworth. Below its 6-copy point. Add.

Action: JM to raise one combined Greenline order covering RB-1043 top-up,
RB-1090 and RB-1055. PC to chase Ashby. #followup
`,

  'meetings/2026-06-20-genre-mix.md': `---
tags: [meeting, planning]
---

# Genre mix review — 20 June 2026

Nature and Science are carrying the shop; Fiction is flat. Titles like
RB-1027 (Braiding Sweetgrass) and RB-1124 (Underland) turn over faster than
anything in Fiction except RB-1014.

Considered dropping History entirely — decided against, RB-1103 (Sapiens)
alone justifies the shelf.

No changes to supplier arrangements. #planning
`,
}

function seedVault(root) {
  const base = path.join(root, NS)
  if (CLEAN) return removeIfPresent(base)
  for (const [rel, content] of Object.entries(NOTES)) {
    writeFixture(path.join(base, ...rel.split('/')), content)
  }
}

// ---------------------------------------------------------------------------
// Git — a real repository with history AND a dirty working tree, so git_status,
// git_log and git_diff each have something to report. A clean repo makes two of
// the three tools look broken.
// ---------------------------------------------------------------------------

const REPORT_V1 = `import sqlite3

DB = "riverside-books.db"


def low_stock(limit=5):
    con = sqlite3.connect(DB)
    rows = con.execute(
        "SELECT sku, title, stock FROM books WHERE stock < ? ORDER BY stock",
        (limit,),
    ).fetchall()
    con.close()
    return rows


if __name__ == "__main__":
    for sku, title, stock in low_stock():
        print(f"{sku}  {title}  ({stock} left)")
`

const REPORT_V2 = `import sqlite3

DB = "riverside-books.db"

# Lead-time-aware reorder points, per the July 2026 restock policy.
REORDER_POINTS = {7: 4, 14: 6, 21: 9, 35: 14}


def low_stock():
    con = sqlite3.connect(DB)
    rows = con.execute(
        """
        SELECT b.sku, b.title, b.stock, s.name, s.lead_time_days
        FROM books b JOIN suppliers s ON s.id = b.supplier_id
        ORDER BY b.stock
        """
    ).fetchall()
    con.close()
    return [r for r in rows if r[2] < REORDER_POINTS.get(r[4], 5)]


if __name__ == "__main__":
    for sku, title, stock, supplier, lead in low_stock():
        print(f"{sku}  {title}  ({stock} left, {supplier}, {lead}d)")
`

// The uncommitted edit git_diff will show.
const REPORT_DIRTY = REPORT_V2.replace(
  'if __name__ == "__main__":',
  `def to_csv(rows):
    return "\\n".join(",".join(str(c) for c in r) for r in rows)


if __name__ == "__main__":`
)

function git(cwd, args) {
  execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Riverside Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Riverside Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    },
  })
}

function seedGit(root) {
  const repo = path.join(root, `${NS}-reports`)
  if (CLEAN) return removeIfPresent(repo)

  fs.rmSync(repo, { recursive: true, force: true })
  fs.mkdirSync(repo, { recursive: true })
  git(repo, ['init', '-q', '-b', 'main'])

  fs.writeFileSync(path.join(repo, 'README.md'), `# Riverside stock reports\n\nSmall scripts that read the shop database and print what needs reordering.\n`)
  git(repo, ['add', '.'])
  git(repo, ['commit', '-q', '-m', 'Add README'])

  fs.writeFileSync(path.join(repo, 'stock_report.py'), REPORT_V1)
  git(repo, ['add', '.'])
  git(repo, ['commit', '-q', '-m', 'Add low-stock report with a flat threshold'])

  fs.writeFileSync(path.join(repo, 'stock_report.py'), REPORT_V2)
  git(repo, ['add', '.'])
  git(repo, ['commit', '-q', '-m', 'Use lead-time-aware reorder points per the July policy'])

  // Leave the tree dirty on purpose: one modified tracked file (git_diff) and
  // one untracked file (git_status).
  fs.writeFileSync(path.join(repo, 'stock_report.py'), REPORT_DIRTY)
  fs.writeFileSync(path.join(repo, 'NOTES.txt'), 'TODO: export the low-stock list as CSV for the Greenline order.\n')

  created.push(repo)
}

// ---------------------------------------------------------------------------
// File System — material for read/write/edit/search/tree. Includes a deliberate
// bug in a Python file, so "find and fix it" exercises read + edit rather than
// just read.
// ---------------------------------------------------------------------------

const WORKSPACE = {
  'README.md': `# Riverside workspace

Scratch space for shop scripts and config. The stock database lives in the
SQLite capability folder, not here.

- \`config/shop.json\` — opening hours and reorder defaults
- \`scripts/price_check.py\` — margin calculator (has a known bug)
- \`scripts/tidy_titles.py\` — normalises title capitalisation
`,

  'config/shop.json': `{
  "name": "Riverside Books",
  "opening_hours": {
    "mon": "09:30-17:30",
    "tue": "09:30-17:30",
    "wed": "09:30-17:30",
    "thu": "09:30-19:00",
    "fri": "09:30-17:30",
    "sat": "09:00-18:00",
    "sun": "closed"
  },
  "reorder_buffer_copies": 2,
  "trade_discount": 0.35,
  "vat_rate": 0.0
}
`,

  'scripts/price_check.py': `"""Margin calculator for trade-discounted stock.

Known bug: the margin is calculated against the retail price instead of the
cost price, so every title reports the same margin regardless of discount.
"""

TRADE_DISCOUNT = 0.35


def cost_price(retail):
    return retail * (1 - TRADE_DISCOUNT)


def margin(retail):
    # BUG: should divide by retail - cost, not by retail alone.
    return (retail - cost_price(retail)) / retail


if __name__ == "__main__":
    for title, retail in [("Piranesi", 12.50), ("Sapiens", 15.99)]:
        print(f"{title}: {margin(retail):.1%}")
`,

  'scripts/tidy_titles.py': `"""Normalise book titles to title case, leaving small words lowercase."""

SMALL_WORDS = {"a", "an", "and", "of", "the", "in", "on", "to", "for"}


def tidy(title):
    words = title.strip().split()
    out = []
    for i, word in enumerate(words):
        lower = word.lower()
        out.append(lower if i > 0 and lower in SMALL_WORDS else lower.capitalize())
    return " ".join(out)


if __name__ == "__main__":
    for raw in ["the HIDDEN life of TREES", "a short history OF nearly everything"]:
        print(tidy(raw))
`,

  'notes/handover.txt': `Handover notes
==============

The Greenline order (5004) is still pending as of 5 August. If it has not
arrived by the 12th, chase Wednesday delivery directly rather than emailing.

Ashby have not acknowledged order 5005 at all. Escalate.
`,
}

function seedFileSystem(root) {
  const base = path.join(root, NS)
  if (CLEAN) return removeIfPresent(base)
  for (const [rel, content] of Object.entries(WORKSPACE)) {
    writeFixture(path.join(base, ...rel.split('/')), content)
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const roots = readRoots()
const jobs = [
  ['SQLite', roots.sqlite, seedSqlite],
  ['Vault', roots.vault, seedVault],
  ['Git', roots.git, seedGit],
  ['File System', roots.fileSystem, seedFileSystem],
]

for (const [label, root, seed] of jobs) {
  if (!root) {
    skipped.push(`${label}: no folder configured in tools.json`)
    continue
  }
  const before = created.length
  await seed(root)
  const n = created.length - before
  console.log(`${CLEAN ? 'removed' : 'seeded'}  ${label.padEnd(12)} ${root}${n ? ` (${n} item${n === 1 ? '' : 's'})` : ' — nothing to remove'}`)
}

for (const note of skipped) console.log(`skipped  ${note}`)

if (!CLEAN) {
  console.log(`
Done. Everything written is under the "${NS}" namespace.
Remove it again with:  node scripts/seed-capability-fixtures.mjs --clean

Next: enable SQLite in the Tools window, then tick SQLite / Vault / Git /
File System under "Local Capabilities" for the profile you launch — a
capability needs BOTH the global enable and the per-profile checkbox.`)
}
