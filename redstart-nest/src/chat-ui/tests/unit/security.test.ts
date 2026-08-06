import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest'
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync, symlinkSync } from 'fs'
import { join, sep } from 'path'
import { tmpdir } from 'os'
import { AttachmentType } from '$lib/enums'

const TEST_DIR = join(tmpdir(), 'redstart-security-tests')

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
  mkdirSync(TEST_DIR, { recursive: true })
})

vi.mock('electron', () => ({
  app: {
    getPath: (name) => {
      if (name === 'userData') return TEST_DIR
      if (name === 'documents') return join(TEST_DIR, 'documents')
      return TEST_DIR
    },
  },
}))

const ACCOUNTS_PATH = join(TEST_DIR, 'accounts.json')

function writeAccounts(data) {
  writeFileSync(ACCOUNTS_PATH, JSON.stringify(data, null, 2), 'utf8')
}

// ---------------------------------------------------------------------------
// accounts-storage.mjs
// ---------------------------------------------------------------------------

describe('accounts-storage', () => {
  it('defaults authRequired to true', async () => {
    const { defaults } = await import('$lib/../../../../electron/main/accounts-storage.mjs')
    expect(defaults()).toEqual({ authRequired: true, accounts: [] })
  })

  it('normalizes missing authRequired to true on read', async () => {
    writeAccounts({ accounts: [] })
    const { read } = await import('$lib/../../../../electron/main/accounts-storage.mjs')
    const data = read()
    expect(data.authRequired).toBe(true)
  })

  it('preserves existing authRequired value', async () => {
    writeAccounts({ authRequired: false, accounts: [] })
    const { read } = await import('$lib/../../../../electron/main/accounts-storage.mjs')
    const data = read()
    expect(data.authRequired).toBe(false)
  })

  it('setAuthRequired persists true', async () => {
    const { setAuthRequired, getAuthRequired } = await import('$lib/../../../../electron/main/accounts-storage.mjs')
    setAuthRequired(true)
    expect(getAuthRequired()).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// auth.mjs — core authentication
// ---------------------------------------------------------------------------

describe('auth.mjs', () => {
  async function loadAuth() {
    const mod = await import('$lib/../../../../electron/main/auth.mjs')
    return mod
  }

  async function setupAccounts(overrides = {}) {
    const { setAuthRequired, insertAccount } = await import('$lib/../../../../electron/main/accounts-storage.mjs')
    setAuthRequired(true)
    if (overrides.account) {
      await insertAccount(overrides.account)
    }
  }

  it('rejects unauthenticated requests when auth is required', async () => {
    await setupAccounts()
    const { authenticate } = await loadAuth()
    const result = authenticate({ socket: { remoteAddress: '127.0.0.1' }, headers: {} })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('unauthorized')
  })

  it('rejects unauthenticated requests from LAN addresses', async () => {
    await setupAccounts()
    const { authenticate } = await loadAuth()
    const result = authenticate({ socket: { remoteAddress: '192.168.1.50' }, headers: {} })
    expect(result.ok).toBe(false)
  })

  it('accepts valid bearer token', async () => {
    const { hashPassword, login } = await loadAuth()
    const pw = hashPassword('testpass')
    const account = {
      id: 'acc-1',
      username: 'admin',
      role: 'owner',
      passwordHash: pw.passwordHash,
      passwordSalt: pw.passwordSalt,
      apiKeyHash: 'abc123',
      apiKeyPrefix: 'abc12345',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdBy: null,
      status: 'active',
    }
    await setupAccounts({ account })
    const loginResult = login('admin', 'testpass')
    expect(loginResult.ok).toBe(true)
    expect(loginResult.token).toBeDefined()

    const { authenticate } = await loadAuth()
    const authResult = authenticate({
      socket: { remoteAddress: '192.168.1.50' },
      headers: { authorization: `Bearer ${loginResult.token}` },
    })
    expect(authResult.ok).toBe(true)
    expect(authResult.account?.username).toBe('admin')
  })

  it('accepts valid API key as bearer token', async () => {
    const { hashPassword, generateApiKey, hashApiKey } = await loadAuth()
    const pw = hashPassword('testpass')
    const apiKey = generateApiKey()
    const account = {
      id: 'acc-2',
      username: 'apiuser',
      role: 'user',
      passwordHash: pw.passwordHash,
      passwordSalt: pw.passwordSalt,
      apiKeyHash: hashApiKey(apiKey),
      apiKeyPrefix: apiKey.slice(0, 8),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdBy: null,
      status: 'active',
    }
    await setupAccounts({ account })
    const { authenticate } = await loadAuth()
    const authResult = authenticate({
      socket: { remoteAddress: '10.0.0.5' },
      headers: { authorization: `Bearer ${apiKey}` },
    })
    expect(authResult.ok).toBe(true)
    expect(authResult.account?.username).toBe('apiuser')
  })

  it('rejects invalid bearer token', async () => {
    await setupAccounts()
    const { authenticate } = await loadAuth()
    const result = authenticate({
      socket: { remoteAddress: '192.168.1.50' },
      headers: { authorization: 'Bearer invalid-token' },
    })
    expect(result.ok).toBe(false)
  })

  it('localhost is NOT exempt from authentication', async () => {
    await setupAccounts()
    const { authenticate } = await loadAuth()
    const result = authenticate({ socket: { remoteAddress: '127.0.0.1' }, headers: {} })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('unauthorized')
  })

  it('IPv6 localhost is NOT exempt from authentication', async () => {
    await setupAccounts()
    const { authenticate } = await loadAuth()
    const result = authenticate({ socket: { remoteAddress: '::1' }, headers: {} })
    expect(result.ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Beacon payload — minimal info only
// ---------------------------------------------------------------------------

describe('beacon payload', () => {
  it('returns only the app identity marker, running, and port — no version, auth, or server URLs', async () => {
    const { startBeaconServer, stopBeaconServer } = await import('$lib/../../../../electron/main/beacon.mjs')

    // Bind an ephemeral port (0) so this test never collides with a running
    // Redstart instance already holding the real beacon port 8765.
    const server = await startBeaconServer(
      () => true,
      () => 19080,
      0,
    )
    const boundPort = server.address().port

    const result = await new Promise((resolve, reject) => {
      const http = require('http')
      http.get(`http://127.0.0.1:${boundPort}`, (res) => {
        let data = ''
        res.on('data', chunk => data += chunk)
        res.on('end', () => {
          try {
            resolve(JSON.parse(data))
          } catch (e) {
            reject(e)
          }
        })
      }).on('error', reject)
    })

    // The `app` marker is an intentional identity string (already public via
    // mDNS) so clients can positively identify a Redstart Nest; it is NOT a
    // config leak. The security contract is that nothing beyond these three
    // fields — no version, auth state, MCP URLs, or LAN IP — is disclosed.
    expect(result).toEqual({ app: 'redstart-nest', running: true, port: 19080 })
    expect(Object.keys(result)).toHaveLength(3)

    stopBeaconServer(server)
  })
})

// ---------------------------------------------------------------------------
// auth.mjs — sessions, roles, and account management
// ---------------------------------------------------------------------------

describe('auth.mjs — sessions and roles', () => {
  async function loadAuth() {
    const mod = await import('$lib/../../../../electron/main/auth.mjs')
    return mod
  }

  async function createTestAccount(username = 'testuser', role = 'user') {
    const { setAuthRequired, insertAccount } = await import('$lib/../../../../electron/main/accounts-storage.mjs')
    setAuthRequired(true)
    const { hashPassword } = await loadAuth()
    const pw = hashPassword('testpass')
    const account = {
      id: crypto.randomUUID(),
      username,
      role,
      passwordHash: pw.passwordHash,
      passwordSalt: pw.passwordSalt,
      apiKeyHash: 'abc123',
      apiKeyPrefix: 'abc12345',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdBy: null,
      status: 'active',
    }
    return insertAccount(account)
  }

  it('login returns token and user on valid credentials', async () => {
    await createTestAccount('alice', 'owner')
    const { login, authenticate } = await loadAuth()
    const result = login('alice', 'testpass')
    expect(result.ok).toBe(true)
    expect(result.token).toBeDefined()
    expect(result.user?.username).toBe('alice')
    expect(result.user?.role).toBe('owner')

    const auth = authenticate({
      socket: { remoteAddress: '10.0.0.1' },
      headers: { authorization: `Bearer ${result.token}` },
    })
    expect(auth.ok).toBe(true)
    expect(auth.account?.role).toBe('owner')
  })

  it('login rejects wrong password', async () => {
    await createTestAccount('bob')
    const { login } = await loadAuth()
    const result = login('bob', 'wrongpass')
    expect(result.ok).toBe(false)
    expect(result.error).toBe('Invalid username or password')
  })

  it('login rejects disabled account', async () => {
    const { setAuthRequired, insertAccount } = await import('$lib/../../../../electron/main/accounts-storage.mjs')
    setAuthRequired(true)
    const { hashPassword } = await loadAuth()
    const pw = hashPassword('testpass')
    const account = {
      id: crypto.randomUUID(),
      username: 'charlie',
      role: 'user',
      passwordHash: pw.passwordHash,
      passwordSalt: pw.passwordSalt,
      apiKeyHash: 'def456',
      apiKeyPrefix: 'def45678',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdBy: null,
      status: 'disabled',
    }
    await insertAccount(account)
    const { login } = await loadAuth()
    const result = login('charlie', 'testpass')
    expect(result.ok).toBe(false)
    expect(result.error).toBe('This account has been disabled')
  })

  it('logout revokes session', async () => {
    await createTestAccount('dave')
    const { login, logout, authenticate } = await loadAuth()
    const { token } = login('dave', 'testpass')

    const before = authenticate({
      socket: { remoteAddress: '10.0.0.1' },
      headers: { authorization: `Bearer ${token}` },
    })
    expect(before.ok).toBe(true)

    logout({ headers: { authorization: `Bearer ${token}` } })

    const after = authenticate({
      socket: { remoteAddress: '10.0.0.1' },
      headers: { authorization: `Bearer ${token}` },
    })
    expect(after.ok).toBe(false)
  })

  it('revokeSessionsForAccount invalidates all sessions', async () => {
    const { hashPassword, createOwner, revokeSessionsForAccount } = await loadAuth()
    const pw = hashPassword('ownerpass')
    const owner = {
      id: crypto.randomUUID(),
      username: 'owner',
      role: 'owner',
      passwordHash: pw.passwordHash,
      passwordSalt: pw.passwordSalt,
      apiKeyHash: 'ownerkey',
      apiKeyPrefix: 'ownerkey1',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdBy: null,
      status: 'active',
    }
    await createTestAccount('user1', 'user')
    const { login, authenticate } = await loadAuth()

    // Create a session for user1
    const user1Login = login('user1', 'testpass')
    const user1Token = user1Login.token

    // Revoke all sessions for user1
    const user1Record = await (await import('$lib/../../../../electron/main/accounts-storage.mjs')).findByUsername('user1')
    revokeSessionsForAccount(user1Record.id)

    const after = authenticate({
      socket: { remoteAddress: '10.0.0.1' },
      headers: { authorization: `Bearer ${user1Token}` },
    })
    expect(after.ok).toBe(false)
  })

  it('role hierarchy: owner can create admin and user', async () => {
    await createTestAccount('owner', 'owner')
    const { login, createAccount, listAccounts } = await loadAuth()
    const ownerLogin = login('owner', 'testpass')

    const adminResult = createAccount({ id: ownerLogin.user.id, role: 'owner' }, { username: 'admin1', password: 'adminpass', role: 'admin' })
    expect(adminResult.ok).toBe(true)

    const userResult = createAccount({ id: ownerLogin.user.id, role: 'owner' }, { username: 'user1', password: 'userpass', role: 'user' })
    expect(userResult.ok).toBe(true)
  })

  it('role hierarchy: admin can create user but not admin', async () => {
    await createTestAccount('owner', 'owner')
    await createTestAccount('admin', 'admin')
    const { login, createAccount } = await loadAuth()

    const adminLogin = login('admin', 'testpass')

    const userResult = createAccount({ id: adminLogin.user.id, role: 'admin' }, { username: 'user1', password: 'userpass', role: 'user' })
    expect(userResult.ok).toBe(true)

    const adminResult = createAccount({ id: adminLogin.user.id, role: 'admin' }, { username: 'admin2', password: 'adminpass', role: 'admin' })
    expect(adminResult.ok).toBe(false)
  })

  it('role hierarchy: user cannot create any account', async () => {
    await createTestAccount('regular', 'user')
    const { login, createAccount } = await loadAuth()
    const userLogin = login('regular', 'testpass')

    const result = createAccount({ id: userLogin.user.id, role: 'user' }, { username: 'newuser', password: 'pass', role: 'user' })
    expect(result.ok).toBe(false)
  })

  it('password hashing uses scrypt and verification is timing-safe', async () => {
    const { hashPassword, verifyPassword } = await loadAuth()
    const pw = hashPassword('secret')
    expect(pw.passwordHash).toBeDefined()
    expect(pw.passwordSalt).toBeDefined()
    expect(pw.passwordHash.length).toBe(128) // 64 bytes = 128 hex chars
    expect(verifyPassword('secret', pw.passwordHash, pw.passwordSalt)).toBe(true)
    expect(verifyPassword('wrong', pw.passwordHash, pw.passwordSalt)).toBe(false)
  })

  it('API key generation produces unique keys with rst_ prefix', async () => {
    const { generateApiKey, hashApiKey } = await loadAuth()
    const key1 = generateApiKey()
    const key2 = generateApiKey()
    expect(key1.startsWith('rst_')).toBe(true)
    expect(key1).not.toBe(key2)
    expect(hashApiKey(key1)).toBeDefined()
    expect(hashApiKey(key1)).not.toBe(hashApiKey(key2))
  })

  it('createOwner rejects duplicate owners', async () => {
    await createTestAccount('existing', 'owner')
    const { createOwner } = await loadAuth()
    const result = createOwner({ username: 'newowner', password: 'pass' })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('An owner account already exists')
  })
})

// ---------------------------------------------------------------------------
// filesystem-mcp-provider.mjs — File System capability containment gate
// ---------------------------------------------------------------------------
// The File System capability is served by @modelcontextprotocol/server-filesystem
// as a stdio child; tool behavior is covered end-to-end at the service boundary
// by scripts/test-mcp-capabilities.mjs + test-provider-conformance.mjs. What is
// unit-tested here is OUR half of the defense-in-depth: containmentError, the
// gate every path argument passes through before a call reaches the child.

describe('filesystem provider containment gate', () => {
  let rootDir: string

  beforeEach(() => {
    rootDir = join(TEST_DIR, 'workspace')
    mkdirSync(rootDir, { recursive: true })
    mkdirSync(join(rootDir, 'src'), { recursive: true })
    writeFileSync(join(rootDir, 'README.md'), '# Hello\n')
  })

  async function gate(args: Record<string, unknown>, root = rootDir) {
    const { containmentError } = await import('$lib/../../../../electron/main/filesystem-mcp-provider.mjs')
    return containmentError(root, args)
  }

  describe('contained paths pass', () => {
    it('allows a relative path inside the root', async () => {
      expect(await gate({ path: 'README.md' })).toBeNull()
    })

    it('allows nested relative paths', async () => {
      expect(await gate({ path: 'src/index.ts' })).toBeNull()
    })

    it('allows an absolute path inside the root', async () => {
      expect(await gate({ path: join(rootDir, 'README.md') })).toBeNull()
    })

    it('allows a paths array where every entry is contained', async () => {
      expect(await gate({ paths: ['README.md', 'src/index.ts'] })).toBeNull()
    })

    it('ignores non-path arguments entirely', async () => {
      expect(await gate({ content: '../../etc/passwd', pattern: 'C:/Windows', dryRun: true })).toBeNull()
    })

    it('ignores non-string values under path keys', async () => {
      expect(await gate({ path: 42, source: null, paths: [7, true] })).toBeNull()
    })

    it('returns null for missing or non-object args', async () => {
      expect(await gate(null as unknown as Record<string, unknown>)).toBeNull()
      expect(await gate(undefined as unknown as Record<string, unknown>)).toBeNull()
    })
  })

  describe('escapes are blocked', () => {
    async function expectBlocked(args: Record<string, unknown>) {
      const result = await gate(args)
      expect(result).not.toBeNull()
      expect(result!.isError).toBe(true)
      expect(result!.content[0].text).toContain('outside')
    }

    it('blocks ../ traversal in path', async () => {
      await expectBlocked({ path: '../../etc/passwd' })
    })

    it('blocks traversal hidden mid-path', async () => {
      await expectBlocked({ path: 'src/../../outside.txt' })
    })

    it('blocks absolute paths outside the root', async () => {
      await expectBlocked({ path: join(TEST_DIR, 'outside-root', 'file.txt') })
    })

    // Drive-qualification is a Windows concept. path.resolve treats "C:/..." as
    // absolute there, so it escapes the root and must be refused. On POSIX a
    // colon is an ordinary filename character, so the identical string is a
    // relative path that genuinely lives inside the root — asserting a block
    // there would be asserting a bug. Production is Windows and CI is Linux, so
    // both halves are pinned rather than skipping one platform.
    it('refuses a drive-qualified path on win32, treats it as contained on posix', async () => {
      const args = { path: 'C:/Windows/system.ini' }
      if (process.platform === 'win32') {
        await expectBlocked(args)
      } else {
        expect(await gate(args)).toBeNull()
      }
    })

    it('blocks escapes via move_file source and destination', async () => {
      await expectBlocked({ source: '../../etc/passwd', destination: 'copy.txt' })
      await expectBlocked({ source: 'README.md', destination: '../../exfil.txt' })
    })

    it('blocks a paths array where any one entry escapes', async () => {
      await expectBlocked({ paths: ['README.md', '../../etc/passwd'] })
    })

    it('reports every offending path in the error text', async () => {
      const result = await gate({ source: '../a.txt', destination: '../b.txt' })
      expect(result).not.toBeNull()
      expect(result!.isError).toBe(true)
      expect(result!.content[0].text).toContain('../a.txt')
      expect(result!.content[0].text).toContain('../b.txt')
    })

    it('blocks symlink escape (if symlink exists)', async () => {
      mkdirSync(join(TEST_DIR, 'outside-symlink'), { recursive: true })
      try {
        symlinkSync(join(TEST_DIR, 'outside-symlink'), join(rootDir, 'symlink-out'))
      } catch {
        return // symlink creation needs privileges on some Windows setups
      }
      await expectBlocked({ path: 'symlink-out/README.md' })
    })
  })

  describe('config faults throw (setup error, not treated as attack)', () => {
    it('throws when no root is configured', async () => {
      await expect(gate({ path: 'README.md' }, null as unknown as string)).rejects.toThrow()
    })
  })
})

// ---------------------------------------------------------------------------
// File path marker parsing — chat UI download button support
// ---------------------------------------------------------------------------

describe('file path marker parsing', () => {
  function parseFileMarkers(text: string): string[] {
    const paths: string[] = []
    for (const line of text.split('\n')) {
      const match = line.match(/^\[FILE:\s*([^\]]+)\]/)
      if (match) paths.push(match[1])
    }
    return paths
  }

  it('extracts file path from [FILE: ...] marker', () => {
    const input = '[FILE: scripts/hello.py]\nWritten to: scripts/hello.py\n\nprint("hello")'
    const paths = parseFileMarkers(input)
    expect(paths).toEqual(['scripts/hello.py'])
  })

  it('returns empty array when no file markers present', () => {
    const paths = parseFileMarkers('Search completed. No results found.')
    expect(paths).toEqual([])
  })

  it('extracts multiple file paths from multiple markers', () => {
    const input = '[FILE: a.txt]\n[FILE: b.txt]\nDone.'
    const paths = parseFileMarkers(input)
    expect(paths).toEqual(['a.txt', 'b.txt'])
  })

  it('ignores [Attachment saved: ...] markers', () => {
    const input = '[FILE: docs/note.md]\n[Attachment saved: chart.png]\nDone.'
    const paths = parseFileMarkers(input)
    expect(paths).toEqual(['docs/note.md'])
  })
})

// ---------------------------------------------------------------------------
// Gateway /files/download endpoint
// ---------------------------------------------------------------------------

describe('gateway /files/download endpoint', () => {
  const TEST_PORT = 19999
  let gatewayPort: number
  let authToken: string

  beforeAll(async () => {
    const gw = await import('$lib/../../../../electron/main/tools-gateway.mjs')
    await gw.startGateway(TEST_PORT, {
      fileSystem: { enabled: true, rootDir: join(TEST_DIR, 'workspace') },
      // Documents has its own root: create_document writes here, and a browser
      // client must be able to download what it produced.
      documents: { enabled: true, outputDir: join(TEST_DIR, 'docs-out') },
      webFetch: { enabled: false },
    })
    gatewayPort = gw.getGatewayPort(TEST_PORT)!
    expect(gatewayPort).toBe(TEST_PORT)
  }, 30000)

  afterAll(async () => {
    const gw = await import('$lib/../../../../electron/main/tools-gateway.mjs')
    gw.stopGateway()
  })

  beforeEach(async () => {
    const auth = await import('$lib/../../../../electron/main/auth.mjs')
    const owner = auth.createOwner({ username: 'dladmin', password: 'dlpass' })
    expect(owner.ok).toBe(true)
    const login = auth.login('dladmin', 'dlpass')
    expect(login.ok).toBe(true)
    authToken = login.token

    const workspace = join(TEST_DIR, 'workspace')
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, 'README.md'), '# Hello\n\nThis is a test file.\n')

    const docsOut = join(TEST_DIR, 'docs-out')
    mkdirSync(docsOut, { recursive: true })
    writeFileSync(join(docsOut, 'purchase-log.md'), '# Purchase Log\n\nCreated by create_document.\n')
  })

  async function authFetch(path: string): Promise<Response> {
    return fetch(`http://127.0.0.1:${gatewayPort}${path}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    })
  }

  it('requires authentication', async () => {
    const res = await fetch(`http://127.0.0.1:${gatewayPort}/files/download?path=README.md`)
    expect(res.status).toBe(401)
  })

  it('rejects missing path parameter', async () => {
    const res = await authFetch('/files/download')
    expect(res.status).toBe(400)
  })

  it('blocks paths outside the root', async () => {
    const res = await authFetch('/files/download?path=../../etc/passwd')
    expect(res.status).toBe(403)
  })

  it('streams an existing file with auth', async () => {
    const res = await authFetch('/files/download?path=README.md')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/octet-stream')
    expect(res.headers.get('content-disposition')).toContain('README.md')
    const text = await res.text()
    expect(text).toContain('# Hello')
  })

  // A document created by create_document lives under the documents root, not
  // the file-system root. Serving only the latter made every created document
  // undownloadable from a browser client.
  it('streams a file from the documents folder', async () => {
    const res = await authFetch('/files/download?path=purchase-log.md')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toContain('purchase-log.md')
    expect(await res.text()).toContain('Created by create_document')
  })

  it('404s a contained path with no file behind it', async () => {
    const res = await authFetch('/files/download?path=no-such-file.md')
    expect(res.status).toBe(404)
  })
})

