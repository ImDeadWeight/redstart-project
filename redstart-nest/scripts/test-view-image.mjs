// =============================================================================
// view_image suite — daemon/image-info.mjs, view_image in documents-tool.mjs,
// daemon/linked-images.mjs and its use in task-ports.mjs.
// =============================================================================
// What has to hold:
//   - an image is what its BYTES say: a .png holding text is refused
//   - view_image reads only inside the caller's own documents folder (or this
//     chat's workspace), and returns a link, never the bytes
//   - a run on the server shows linked images to a vision model with the same
//     limits as chat-ui (4 images, 4 MB each), only inside the caller's folder,
//     and nothing at all to a model that cannot see
//
// No network, no llama-server. Run:  node scripts/test-view-image.mjs
// =============================================================================

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const results = []

async function test(name, fn) {
  try {
    const detail = await fn()
    results.push({ name, pass: true })
    console.log(`  ok  - ${name}${detail ? `  (${detail})` : ''}`)
  } catch (err) {
    results.push({ name, pass: false, err })
    console.log(`FAIL  - ${name}\n        ${err.message}`)
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg) }

const { sniffImageType, imageSize, inspectImageFile } = await import('../daemon/image-info.mjs')
const { callTool, VIEW_IMAGE_MAX_BYTES } = await import('../daemon/documents-tool.mjs')
const { linkedImagePaths, linkedImageParts, modelHasVision, MAX_IMAGES } = await import('../daemon/linked-images.mjs')
const { toolsPort } = await import('../daemon/task-ports.mjs')
const { formatMcpToolResult } = await import('../../shared/agent-core/tool-result.mjs')
const { userScopePath } = await import('../daemon/user-scope.mjs')

// --- Headers only: enough for the sniffer and the size reader. ---
function png(w, h, pad = 0) {
  const b = Buffer.alloc(33 + pad)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20)
  return b
}
function jpeg(w, h) {
  // SOI, an APP0 segment to skip, then SOF0 with height/width.
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.from('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0])
  const sof = Buffer.alloc(19); sof[0] = 0xff; sof[1] = 0xc0; sof.writeUInt16BE(17, 2); sof[4] = 8; sof.writeUInt16BE(h, 5); sof.writeUInt16BE(w, 7)
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof])
}
function gif(w, h) { const b = Buffer.alloc(16); b.write('GIF89a', 0, 'latin1'); b.writeUInt16LE(w, 6); b.writeUInt16LE(h, 8); return b }
function webpX(w, h) {
  const b = Buffer.alloc(30); b.write('RIFF', 0, 'latin1'); b.write('WEBP', 8, 'latin1'); b.write('VP8X', 12, 'latin1')
  b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3); return b
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-view-image-'))
const docsRoot = path.join(base, 'Documents')
fs.mkdirSync(docsRoot)
const account = null // auth off: the scope is the fixed local one
const userRoot = path.join(docsRoot, userScopePath(account))
fs.mkdirSync(userRoot, { recursive: true })
const put = (rel, buf) => { const p = path.join(userRoot, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, buf); return p }

const cfg = { documents: { enabled: true, outputDir: docsRoot } }
const view = (p, ctx = {}) => callTool('view_image', { path: p }, cfg, { account, ...ctx })
const textOf = (r) => r.content.filter(c => c.type === 'text').map(c => c.text).join('\n')

// ---------------------------------------------------------------------------
console.log('\n-- what an image is --')

await test('🔍 the type comes from the bytes, for all four formats', () => {
  assert(sniffImageType(png(1, 1)) === 'image/png', 'png')
  assert(sniffImageType(jpeg(1, 1)) === 'image/jpeg', 'jpeg')
  assert(sniffImageType(gif(1, 1)) === 'image/gif', 'gif')
  assert(sniffImageType(webpX(1, 1)) === 'image/webp', 'webp')
  assert(sniffImageType(Buffer.from('MZ\x90\0 not an image at all')) === null, 'an exe sniffed as an image')
  assert(sniffImageType(Buffer.from('short')) === null, 'a short buffer sniffed as an image')
})

await test('the pixel size comes from the header', () => {
  for (const [buf, w, h] of [[png(1024, 768), 1024, 768], [jpeg(640, 480), 640, 480], [gif(32, 16), 32, 16], [webpX(1920, 1080), 1920, 1080]]) {
    const s = imageSize(buf)
    assert(s?.width === w && s?.height === h, `${sniffImageType(buf)}: ${JSON.stringify(s)}`)
  }
})

await test('🔍 a .png that is not an image is refused, and so is a non-image extension', () => {
  const fake = put('fake.png', Buffer.from('this is text pretending to be a picture'))
  assert(!inspectImageFile(fake).ok, 'disguised text accepted')
  const exe = put('real-image.exe', png(4, 4))
  assert(!inspectImageFile(exe).ok, 'an .exe accepted for having PNG bytes')
  const svg = put('vector.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))
  assert(!inspectImageFile(svg).ok, 'SVG (script-capable) accepted as an image')
})

// ---------------------------------------------------------------------------
console.log('\n-- view_image --')

await test('🔍 view_image links the file and never puts its bytes in the result', async () => {
  put('photos/bird.png', png(1024, 1024, 500))
  const r = await view('photos/bird.png')
  assert(!r.isError, textOf(r))
  const link = r.content.find(c => c.type === 'resource_link')
  assert(link && link.mimeType === 'image/png' && link.uri.includes('photos%2Fbird.png'), JSON.stringify(link))
  assert(!JSON.stringify(r).includes('base64'), 'bytes in the result')
  assert(/1024×1024 PNG/.test(textOf(r)), textOf(r))
  return textOf(r).split('\n')[0]
})

await test('🔍 view_image cannot leave the caller\'s folder', async () => {
  fs.writeFileSync(path.join(docsRoot, 'shared-root.png'), png(2, 2))
  for (const p of ['../../shared-root.png', path.join(docsRoot, 'shared-root.png'), '..\\..\\shared-root.png']) {
    const r = await view(p)
    assert(r.isError, `${p}: ${textOf(r)}`)
  }
})

await test('a chat\'s own image is found by its bare name', async () => {
  const conv = 'conv-123'
  put(`chats/${conv}/chart.png`, png(800, 600))
  const r = await view('chart.png', { conversationId: conv })
  assert(!r.isError, textOf(r))
  const link = r.content.find(c => c.type === 'resource_link')
  assert(decodeURIComponent(link.uri).endsWith(`chats/${conv}/chart.png`), link.uri)
  const other = await view('chart.png', { conversationId: 'conv-999' })
  assert(other.isError, 'another chat\'s workspace was searched')
})

await test('an image over the limit is still linked, and the model is told it will not see it', async () => {
  put('huge.png', png(8000, 8000, VIEW_IMAGE_MAX_BYTES + 10))
  const r = await view('huge.png')
  assert(!r.isError && /not shown to you/.test(textOf(r)), textOf(r))
})

await test('a non-image is refused with the reason', async () => {
  const r = await view('fake.png')
  assert(r.isError && /not a PNG/.test(textOf(r)), textOf(r))
  const missing = await view('nope.png')
  assert(missing.isError && /not found/i.test(textOf(missing)), textOf(missing))
})

// ---------------------------------------------------------------------------
console.log('\n-- linked images in a run on the server --')

const resultText = (paths) => formatMcpToolResult({ content: paths.map(p => ({ type: 'resource_link', uri: `/files/download?path=${encodeURIComponent(p)}`, name: p, mimeType: p.endsWith('.csv') ? 'text/csv' : 'image/png', size: 10 })) })

await test('the link lines are read back as written', () => {
  const text = resultText(['photos/bird.png', 'data.csv', 'chats/conv-123/chart.png'])
  const paths = linkedImagePaths(text)
  assert(JSON.stringify(paths) === JSON.stringify(['photos/bird.png', 'chats/conv-123/chart.png']), JSON.stringify(paths))
})

await test('🔍 linked images become image parts, at most four, none over 4 MB', () => {
  for (let i = 0; i < 6; i++) put(`many/${i}.png`, png(10, 10))
  const parts = linkedImageParts(resultText([...Array(6).keys()].map(i => `many/${i}.png`)), { documentsRoot: docsRoot, account })
  assert(parts.length === MAX_IMAGES, `${parts.length} parts`)
  assert(parts[0].image_url.url.startsWith('data:image/png;base64,'), parts[0].image_url.url.slice(0, 40))
  assert(linkedImageParts(resultText(['huge.png']), { documentsRoot: docsRoot, account }).length === 0, 'an oversized image was sent')
})

await test('🔍 a link that leaves the caller\'s folder, or is not an image, shows nothing', () => {
  const text = ['[file: ../../shared-root.png, image/png, 1 KB]', '[file: fake.png, image/png, 1 KB]'].join('\n')
  assert(linkedImageParts(text, { documentsRoot: docsRoot, account }).length === 0, 'escaped or fake image sent')
  assert(linkedImageParts(resultText(['photos/bird.png']), { documentsRoot: undefined, account }).length === 0, 'no documents folder, still sent')
})

await test('modelHasVision trusts only /props modalities.vision === true', async () => {
  const fake = (body, ok = true) => async () => ({ ok, json: async () => body })
  assert(await modelHasVision(1, fake({ modalities: { vision: true } })) === true, 'vision model not seen')
  assert(await modelHasVision(1, fake({ modalities: { vision: false } })) === false, 'text model seen as vision')
  assert(await modelHasVision(1, fake({})) === false, 'no modalities seen as vision')
  assert(await modelHasVision(1, fake({ modalities: { vision: true } }, false)) === false, 'an error status seen as vision')
  assert(await modelHasVision(1, async () => { throw new Error('refused') }) === false, 'a refused connection seen as vision')
  assert(await modelHasVision(null, fake({ modalities: { vision: true } })) === false, 'no port seen as vision')
})

await test('🔍 the task runner sends linked images to a vision model, and nothing to one that cannot see', async () => {
  let vision = true
  const pass = {
    task: { id: 't1' },
    seams: { modelHasVision: async () => vision, upstreamPort: () => 19081 },
    turnCtx: { config: cfg, account, clientToolNames: new Set(), switchedOff: () => false },
    approved: new Map(),
  }
  const port = toolsPort(pass)
  assert(typeof port.extraParts === 'function', 'the task tools port has no extraParts')
  const text = resultText(['photos/bird.png'])
  assert((await port.extraParts(text)).length === 1, 'a vision model got no image')
  vision = false
  assert((await port.extraParts(text)).length === 0, 'a text model got an image')
  assert((await port.extraParts('plain text result')).length === 0, 'a result with no link produced parts')
})

// ---------------------------------------------------------------------------

fs.rmSync(base, { recursive: true, force: true })

const passed = results.filter(r => r.pass).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)
