// Checks for the harness's own fixture tasks (scripts/test-agent-bench.mjs).
// A check is (finalText, workspaceFiles, events) => { pass, reason }.

export function answerFile(_text, files) {
  return files['out/answer.txt'] === '42'
    ? { pass: true, reason: 'out/answer.txt holds 42' }
    : { pass: false, reason: `out/answer.txt is ${JSON.stringify(files['out/answer.txt'] ?? null)}` }
}

export function saysSeven(text) {
  return /\b7\b/.test(text) ? { pass: true, reason: 'the answer names 7' } : { pass: false, reason: 'no 7 in the answer' }
}

export function neverPasses() {
  return { pass: false, reason: 'by design' }
}

export function throws() {
  throw new Error('check exploded')
}

// ctx.createdFiles: files the run made outside its workspace (create_document).
export function briefCreated(_text, _files, _events, ctx) {
  const entry = Object.entries(ctx.createdFiles).find(([p]) => /brief\.md$/.test(p))
  return entry && entry[1].includes('# Brief')
    ? { pass: true, reason: `${entry[0]} created` }
    : { pass: false, reason: `no brief.md among ${JSON.stringify(Object.keys(ctx.createdFiles))}` }
}

// Phase 1: the answer the bench gave reached the model as a choice.
export function choseDraftB(text) {
  return text.includes('The user chose: draft_b.md')
    ? { pass: true, reason: 'the choice reached the model' }
    : { pass: false, reason: `no choice in ${JSON.stringify(text)}` }
}
