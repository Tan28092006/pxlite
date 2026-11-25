// node --test test-history-transcript.mjs — needs vendor/ (junction to ~/.pxpipe-lite/vendor).
//
// Collapsed Claude turns become images, and the images drop tool output. history-transcript.mjs
// keeps a text copy on disk and puts ONE pointer line in the history message so the agent can
// rg the file when an image is unclear. A changing line in that place would break the prompt
// cache on every request, so these tests pin: the line is constant, it starts only on a request
// that rewrites those bytes anyway, and it survives a proxy restart mid-epoch.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHistoryTranscript, transcriptNote, turnText } from './history-transcript.mjs';

process.env.PXPIPE_MODELS ??= 'claude-opus-5-5';
const core = new URL('./vendor/pxpipe-proxy/dist/core/', import.meta.url).href;
const { transformRequest } = await import(core + 'transform.js');
const { HISTORY_SYNTHETIC_INTRO } = await import(core + 'history.js');

let seed = 23;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const WORDS = 'the proxy reads cache prefix and writes image chunk for history when tail grows beyond limit then agent calls tool again to check result of previous step'.split(' ');
const prose = (n) => Array.from({ length: n }, () => WORDS[Math.floor(rnd() * WORDS.length)]).join(' ');
const code = (lines) => Array.from({ length: lines }, (_, i) => `  const v${i} = compute(${prose(4).replace(/ /g, ', ')}); // ${prose(5)}`).join('\n');
const token = (r) => `TOKEN_R${String(r).padStart(4, '0')}_X`;

function conversation(first, rounds) {
  const m = [{ role: 'user', content: [{ type: 'text', text: first }] }];
  for (let r = 0; r < rounds; r++) {
    const id = 'toolu_' + String(r).padStart(4, '0');
    m.push({ role: 'assistant', content: [{ type: 'text', text: prose(40) }, { type: 'tool_use', id, name: 'Read', input: { file_path: `/repo/src/file${r}.js` } }] });
    m.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `${token(r)}\n${code(30 + Math.floor(rnd() * 70))}` }] });
  }
  return m;
}
const SYSTEM = [{ type: 'text', text: 'You are a coding agent. ' + prose(900), cache_control: { type: 'ephemeral' } }];
const TOOLS = [{ name: 'Read', description: prose(200), input_schema: { type: 'object', properties: { file_path: { type: 'string' } } } }];
const tmpDir = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxlite-transcript-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
};

/** One request of `n` messages through the real Claude transform. */
async function run(all, n, hook) {
  const messages = structuredClone(all.slice(0, n));
  messages.at(-1).content.at(-1).cache_control = { type: 'ephemeral' };
  const body = { model: 'claude-opus-5-5', max_tokens: 1024, system: structuredClone(SYSTEM), tools: structuredClone(TOOLS), messages };
  const out = await transformRequest(new TextEncoder().encode(JSON.stringify(body)), { model: 'claude-opus-5-5', emitRecoverable: false, historyTranscript: hook });
  const req = JSON.parse(new TextDecoder().decode(out.body));
  const hist = req.messages.find((m) => Array.isArray(m.content) && m.content[0]?.type === 'text' && m.content[0].text === HISTORY_SYNTHETIC_INTRO);
  const blocks = hist?.content ?? [];
  const noteAt = blocks.findIndex((b) => b.type === 'text' && b.text.startsWith('[Text copy of the earlier turns'));
  const lastImage = blocks.findLastIndex((b) => b.type === 'image');
  return {
    n, collapsed: !!hist, noteAt, lastImage, blockCount: blocks.length,
    note: noteAt >= 0 ? blocks[noteAt].text : null,
    images: blocks.filter((b) => b.type === 'image').map((b) => b.source.data.length + ':' + b.source.data.slice(0, 64)).join('|'),
    withoutNote: JSON.stringify(blocks.filter((_, i) => i !== noteAt)),
  };
}

test('turnText keeps tool input and tool output, and skips thinking-only messages', () => {
  const names = new Map([['toolu_1', 'Bash']]);
  assert.match(turnText({ role: 'assistant', content: [{ type: 'text', text: 'checking' }, { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'rg -uu foo' } }] }, 4, names),
    /^<assistant t="4">\nchecking\n\[tool_use Bash\] \{"command":"rg -uu foo"\}\n<\/assistant>/);
  assert.match(turnText({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: true, content: [{ type: 'text', text: 'exit 2: abc123' }, { type: 'image', source: {} }] }] }, 5, names),
    /^<user t="5">\n\[tool_result Bash \(error\)\]\nexit 2: abc123\n\[image\]\n<\/user>/);
  assert.equal(turnText({ role: 'assistant', content: [{ type: 'thinking', thinking: 'secret', signature: 's' }] }, 6, names), '');
});

test('the pointer starts only on a first collapse or a checkpoint, then never changes', (t) => {
  const dir = tmpDir(t);
  const all = conversation('unit conversation', 40);
  const ht = createHistoryTranscript({ dir });
  const file = ht.fileFor('k');

  // Proxy first sees a conversation that is already collapsed: adding a line now would
  // rewrite cached bytes, so it waits.
  assert.deepEqual(ht.note({ key: 'k', messages: all.slice(0, 31), from: 1, to: 11 }), { note: null, state: 'waiting' });
  assert.deepEqual(ht.note({ key: 'k', messages: all.slice(0, 33), from: 1, to: 11 }), { note: null, state: 'waiting' });
  assert.equal(fs.existsSync(file), false);

  // Checkpoint: the bytes after the last image are rewritten anyway.
  const started = ht.note({ key: 'k', messages: all.slice(0, 35), from: 1, to: 21 });
  assert.equal(started.state, 'started');
  assert.equal(started.note, transcriptNote(file));
  const text1 = fs.readFileSync(file, 'utf8');
  for (let r = 0; r < 10; r++) assert.equal(text1.split(token(r)).length - 1, 1, `round ${r} once`);
  assert.equal(text1.includes(token(10)), false, 'a turn that is still live text is not in the file');

  assert.deepEqual(ht.note({ key: 'k', messages: all.slice(0, 37), from: 1, to: 21 }), { note: started.note, state: 'steady' });
  assert.equal(fs.readFileSync(file, 'utf8'), text1);

  // Next checkpoint appends; nothing already written is touched.
  const appended = ht.note({ key: 'k', messages: all.slice(0, 45), from: 1, to: 31 });
  assert.deepEqual(appended, { note: started.note, state: 'appended' });
  const text2 = fs.readFileSync(file, 'utf8');
  assert.ok(text2.startsWith(text1));
  for (let r = 0; r < 15; r++) assert.equal(text2.split(token(r)).length - 1, 1, `round ${r} once`);

  // A proxy restart mid-epoch must not drop the line.
  const restarted = createHistoryTranscript({ dir });
  assert.deepEqual(restarted.note({ key: 'k', messages: all.slice(0, 47), from: 1, to: 31 }), { note: started.note, state: 'steady' });

  // Same key, different conversation (a compaction replaced the history): rebuild, same line.
  const other = conversation('unit conversation', 40);
  other[1].content[1].id = 'toolu_other';
  assert.deepEqual(restarted.note({ key: 'k', messages: other.slice(0, 47), from: 1, to: 31 }), { note: started.note, state: 'rewritten' });

  // Short side requests on the same key (title, probe) do not arm the pointer for another key.
  const fresh = createHistoryTranscript({ dir });
  fresh.note({ key: 'side', messages: all.slice(0, 2), from: 0, to: 0 });
  assert.equal(fresh.note({ key: 'side', messages: all.slice(0, 41), from: 1, to: 21 }).state, 'waiting');
});

test('a disk failure never changes or fails a request', (t) => {
  const dir = tmpDir(t);
  const blocked = path.join(dir, 'not-a-dir');
  fs.writeFileSync(blocked, 'x');
  const ht = createHistoryTranscript({ dir: blocked });
  const all = conversation('disk failure', 30);
  ht.note({ key: 'k', messages: all.slice(0, 21), from: 0, to: 0 });
  assert.deepEqual(ht.note({ key: 'k', messages: all.slice(0, 31), from: 1, to: 11 }), { note: null, state: 'error' });
  assert.equal(ht.stats().errors, 1);
});

test('through the real transform: one constant line after the last image, and the file holds the tool output', async (t) => {
  const dir = tmpDir(t);
  const all = conversation('Please audit the cache policy and fix what is wrong. TRANSCRIPT_E2E_A', 150);
  let ht = createHistoryTranscript({ dir });
  const states = [];
  let last;
  const hook = (a) => {
    const r = ht.note({ key: 'ses_e2e-' + a.conversation, ...a });
    last = { ...r, from: a.from, to: a.to };
    states.push(r.state);
    return r.note;
  };

  const rows = [];
  for (let n = 21; n <= all.length; n += 8) {
    if (n === 181) ht = createHistoryTranscript({ dir }); // proxy restart in the middle of the session
    const r = await run(all, n, hook);
    rows.push({ ...r, ...last });
  }
  const collapsed = rows.filter((r) => r.collapsed);
  const epochs = new Set(collapsed.map((r) => r.to)).size;
  if (process.env.PXLITE_TEST_TABLE) for (const r of rows) console.log(String(r.n).padStart(4), r.state.padEnd(9), 'to=' + r.to, 'note@' + r.noteAt, 'lastImg@' + r.lastImage, 'blocks=' + r.blockCount);
  assert.ok(rows.some((r) => !r.collapsed), 'the session starts uncollapsed');
  assert.ok(epochs >= 3, `needs several checkpoints to mean anything, got ${epochs}`);

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.txt'));
  assert.equal(files.length, 1, 'one transcript file for one conversation');
  const full = path.join(dir, files[0]);

  const note = transcriptNote(full);
  for (const r of rows) {
    if (!r.collapsed) { assert.equal(r.note, null); assert.equal(r.state, 'none'); continue; }
    assert.equal(r.note, note, `request n=${r.n}: the line is present and identical`);
    assert.ok(r.noteAt > r.lastImage, 'the line sits after every history image');
    assert.equal(r.noteAt, r.blockCount - 2, 'directly before the closing banner');
  }
  assert.equal(states.filter((s) => s === 'started').length, 1);
  assert.equal(states.includes('rewritten'), false, 'old turns are never rewritten in a stable conversation');
  assert.equal(states.includes('waiting'), false);
  assert.equal(states.filter((s) => s === 'appended').length, epochs - 1);

  // Inside one epoch the whole history message is byte-identical with the line, exactly when
  // it is byte-identical without it: the line adds no cache break of its own.
  let steadyPairs = 0;
  for (let i = 1; i < collapsed.length; i++) {
    const a = collapsed[i - 1], b = collapsed[i];
    if (a.to !== b.to) continue;
    steadyPairs++;
    assert.equal(a.images, b.images, `n=${a.n}->${b.n}: history images unchanged inside an epoch`);
    assert.equal(a.withoutNote === b.withoutNote, true, `n=${a.n}->${b.n}: history message unchanged inside an epoch`);
  }
  assert.ok(steadyPairs >= 5);

  // The file has exactly the collapsed turns, each once, with the tool output images drop.
  const text = fs.readFileSync(full, 'utf8');
  const { from, to } = collapsed.at(-1);
  for (let i = from; i < to; i++) assert.equal(text.split(`t="${i}">`).length - 1, 1, `turn ${i} is in the file once`);
  assert.equal(text.includes(`t="${to}">`), false, 'live turns are not in the file');
  const firstRound = Math.max(0, Math.ceil((from - 2) / 2)), lastRound = Math.floor((to - 3) / 2);
  for (let r = firstRound; r <= lastRound; r++) assert.equal(text.split(token(r)).length - 1, 1, `tool output of round ${r} is searchable`);
});

test('without the hook the transform output has no pointer line', async () => {
  const all = conversation('Please audit the cache policy and fix what is wrong. TRANSCRIPT_E2E_B', 100);
  const r = await run(all, 201, undefined);
  assert.equal(r.collapsed, true);
  assert.equal(r.note, null);
});
