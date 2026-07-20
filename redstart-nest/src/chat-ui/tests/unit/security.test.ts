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
// fs-tool.mjs — file system capability
// ---------------------------------------------------------------------------

describe('fs-tool', () => {
  let rootDir: string

  beforeEach(() => {
    rootDir = join(TEST_DIR, 'workspace')
    mkdirSync(rootDir, { recursive: true })
    mkdirSync(join(rootDir, 'src'), { recursive: true })
    mkdirSync(join(rootDir, 'docs'), { recursive: true })
    writeFileSync(join(rootDir, 'README.md'), `# Hello\n\nThis is a test file.\n`.repeat(500))
    writeFileSync(join(rootDir, 'src', 'index.ts'), 'export const x = 1;\n')
    writeFileSync(join(rootDir, 'docs', 'notes.txt'), 'Some notes here.\n')
  })

  async function callTool(name: string, args: Record<string, unknown>, cfg = { fileSystem: { enabled: true, rootDir } }) {
    const { callTool: call } = await import('$lib/../../../../electron/main/fs-tool.mjs')
    return call(name, args, cfg)
  }

  describe('toolDefs', () => {
    it('returns no tools when disabled', async () => {
      const { toolDefs } = await import('$lib/../../../../electron/main/fs-tool.mjs')
      expect(toolDefs({ fileSystem: { enabled: false } })).toEqual([])
    })

    it('returns 8 tools when enabled', async () => {
      const { toolDefs } = await import('$lib/../../../../electron/main/fs-tool.mjs')
      const defs = toolDefs({ fileSystem: { enabled: true, rootDir } })
      expect(defs).toHaveLength(8)
      expect(defs.map(d => d.name)).toEqual([
        'fs_read_file',
        'fs_write_file',
        'fs_edit_file',
        'fs_list_directory',
        'fs_search_files',
        'fs_get_file_info',
        'fs_create_directory',
        'fs_delete_file',
      ])
    })

    it('each tool has name, description, and inputSchema', async () => {
      const { toolDefs } = await import('$lib/../../../../electron/main/fs-tool.mjs')
      const defs = toolDefs({ fileSystem: { enabled: true, rootDir } })
      for (const def of defs) {
        expect(def.name).toBeTruthy()
        expect(def.description).toBeTruthy()
        expect(def.inputSchema).toEqual({ type: 'object', properties: expect.any(Object), required: expect.any(Array) })
      }
    })
  })

  describe('fs_read_file', () => {
    it('reads a file within the root', async () => {
      const result = await callTool('fs_read_file', { path: 'README.md' })
      expect(result.isError).toBeFalsy()
      expect(result.content[0].text).toContain('# Hello')
    })

    it('rejects paths outside the root', async () => {
      const result = await callTool('fs_read_file', { path: '../../etc/passwd' })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('outside')
    })

    it('rejects missing files', async () => {
      const result = await callTool('fs_read_file', { path: 'nonexistent.txt' })
      expect(result.isError).toBe(true)
    })

    it('rejects missing path argument', async () => {
      const result = await callTool('fs_read_file', {})
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('Missing required argument')
    })

    it('truncates long files with pagination hint', async () => {
      const result = await callTool('fs_read_file', { path: 'README.md' })
      expect(result.isError).toBeFalsy()
      expect(result.content[0].text).toContain('showing first')
    })
  })

  describe('fs_write_file', () => {
    it('creates a new file', async () => {
      const result = await callTool('fs_write_file', { path: 'newfile.txt', content: 'hello world' })
      expect(result.isError).toBeFalsy()
      expect(result.content[0].text).toContain('Written to')
      expect(readFileSync(join(rootDir, 'newfile.txt'), 'utf8')).toBe('hello world')
    })

    it('overwrites existing files', async () => {
      const result = await callTool('fs_write_file', { path: 'README.md', content: 'REPLACED' })
      expect(result.isError).toBeFalsy()
      expect(readFileSync(join(rootDir, 'README.md'), 'utf8')).toBe('REPLACED')
    })

    it('creates parent directories', async () => {
      const result = await callTool('fs_write_file', { path: 'deep/nested/file.txt', content: 'nested' })
      expect(result.isError).toBeFalsy()
      expect(existsSync(join(rootDir, 'deep', 'nested', 'file.txt'))).toBe(true)
    })

    it('rejects paths outside the root', async () => {
      const result = await callTool('fs_write_file', { path: '../../outside.txt', content: 'bad' })
      expect(result.isError).toBe(true)
    })

    it('rejects binary extensions', async () => {
      const result = await callTool('fs_write_file', { path: 'malware.exe', content: 'fake exe' })
      expect(result.isError).toBe(true)
    })

    it('rejects missing arguments', async () => {
      const result = await callTool('fs_write_file', { path: 'test.txt' })
      expect(result.isError).toBe(true)
    })
  })

  describe('fs_edit_file', () => {
    it('replaces a string exactly once', async () => {
      writeFileSync(join(rootDir, 'README.md'), 'UNIQUE_MARKER placeholder text\n')
      const result = await callTool('fs_edit_file', { path: 'README.md', find: 'UNIQUE_MARKER', replace: 'REPLACED' })
      expect(result.isError).toBeFalsy()
      expect(result.content[0].text).toContain('Edited 1 occurrence')
      expect(readFileSync(join(rootDir, 'README.md'), 'utf8')).toContain('REPLACED')
    })

    it('rejects when string appears multiple times', async () => {
      const result = await callTool('fs_edit_file', { path: 'README.md', find: 'test', replace: 'X' })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('appears')
    })

    it('rejects when string not found', async () => {
      const result = await callTool('fs_edit_file', { path: 'README.md', find: 'ZZZNONE', replace: 'X' })
      expect(result.isError).toBe(true)
    })

    it('rejects paths outside the root', async () => {
      const result = await callTool('fs_edit_file', { path: '../../etc/hostname', find: 'x', replace: 'y' })
      expect(result.isError).toBe(true)
    })
  })

  describe('fs_list_directory', () => {
    it('lists root directory', async () => {
      const result = await callTool('fs_list_directory', {})
      expect(result.isError).toBeFalsy()
      expect(result.content[0].text).toContain('README.md')
      expect(result.content[0].text).toContain('src/')
      expect(result.content[0].text).toContain('docs/')
    })

    it('lists subdirectory', async () => {
      const result = await callTool('fs_list_directory', { path: 'src' })
      expect(result.isError).toBeFalsy()
      expect(result.content[0].text).toContain('index.ts')
    })

    it('rejects paths outside the root', async () => {
      const result = await callTool('fs_list_directory', { path: '../../' })
      expect(result.isError).toBe(true)
    })
  })

  describe('fs_search_files', () => {
    it('finds files by name substring', async () => {
      const result = await callTool('fs_search_files', { pattern: '.md' })
      expect(result.isError).toBeFalsy()
      expect(result.content[0].text).toContain('README.md')
    })

    it('finds files by path substring', async () => {
      const result = await callTool('fs_search_files', { pattern: 'src' })
      expect(result.isError).toBeFalsy()
      expect(result.content[0].text).toContain('src')
      expect(result.content[0].text).toContain('index.ts')
    })

    it('returns empty for no matches', async () => {
      const result = await callTool('fs_search_files', { pattern: 'ZZZNOMATCH' })
      expect(result.isError).toBeFalsy()
      expect(result.content[0].text).toContain('No files matching')
    })

    it('requires pattern argument', async () => {
      const result = await callTool('fs_search_files', {})
      expect(result.isError).toBe(true)
    })
  })

  describe('fs_get_file_info', () => {
    it('returns metadata for a file', async () => {
      const result = await callTool('fs_get_file_info', { path: 'README.md' })
      expect(result.isError).toBeFalsy()
      const info = JSON.parse(result.content[0].text)
      expect(info.type).toBe('file')
      expect(info.size).toBeGreaterThan(0)
      expect(info.path).toBe('README.md')
    })

    it('returns metadata for a directory', async () => {
      const result = await callTool('fs_get_file_info', { path: 'src' })
      expect(result.isError).toBeFalsy()
      const info = JSON.parse(result.content[0].text)
      expect(info.type).toBe('directory')
    })

    it('rejects paths outside the root', async () => {
      const result = await callTool('fs_get_file_info', { path: '../../etc' })
      expect(result.isError).toBe(true)
    })
  })

  describe('fs_create_directory', () => {
    it('creates a new directory', async () => {
      const result = await callTool('fs_create_directory', { path: 'newdir' })
      expect(result.isError).toBeFalsy()
      expect(result.content[0].text).toContain('Created directory')
      expect(statSync(join(rootDir, 'newdir')).isDirectory()).toBe(true)
    })

    it('creates nested directories', async () => {
      const result = await callTool('fs_create_directory', { path: 'a/b/c' })
      expect(result.isError).toBeFalsy()
      expect(statSync(join(rootDir, 'a', 'b', 'c')).isDirectory()).toBe(true)
    })

    it('rejects existing paths', async () => {
      const result = await callTool('fs_create_directory', { path: 'src' })
      expect(result.isError).toBe(true)
    })

    it('rejects paths outside the root', async () => {
      const result = await callTool('fs_create_directory', { path: '../../outside' })
      expect(result.isError).toBe(true)
    })
  })

  describe('fs_delete_file', () => {
    it('deletes a file', async () => {
      const result = await callTool('fs_delete_file', { path: 'docs/notes.txt' })
      expect(result.isError).toBeFalsy()
      expect(result.content[0].text).toContain('Deleted')
      expect(existsSync(join(rootDir, 'docs', 'notes.txt'))).toBe(false)
    })

    it('deletes an empty directory', async () => {
      mkdirSync(join(rootDir, 'emptydir'))
      const result = await callTool('fs_delete_file', { path: 'emptydir' })
      expect(result.isError).toBeFalsy()
      expect(existsSync(join(rootDir, 'emptydir'))).toBe(false)
    })

    it('refuses to delete non-empty directories', async () => {
      const result = await callTool('fs_delete_file', { path: 'src' })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('not empty')
    })

    it('rejects missing files', async () => {
      const result = await callTool('fs_delete_file', { path: 'nonexistent.txt' })
      expect(result.isError).toBe(true)
    })

    it('rejects paths outside the root', async () => {
      const result = await callTool('fs_delete_file', { path: '../../etc/passwd' })
      expect(result.isError).toBe(true)
    })
  })

  describe('path containment', () => {
    it('blocks absolute paths', async () => {
      const outsidePath = join(TEST_DIR, 'outside-root', 'file.txt')
      const result = await callTool('fs_read_file', { path: outsidePath })
      expect(result.isError).toBe(true)
    })

    it('blocks Windows drive-qualified paths', async () => {
      const result = await callTool('fs_read_file', { path: 'C:/Windows/system.ini' })
      expect(result.isError).toBe(true)
    })

    it('blocks symlink escape (if symlink exists)', async () => {
      try {
        symlinkSync(join(TEST_DIR, 'outside-symlink'), join(rootDir, 'symlink-out'))
      } catch {
        return
      }
      const result = await callTool('fs_read_file', { path: 'symlink-out/README.md' })
      expect(result.isError).toBe(true)
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
})

