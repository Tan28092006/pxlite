// node --test test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { analyze, isDataLike } from './classify.mjs';
import { RotatingLog } from './rotlog.mjs';
import { classifyCompaction, decodeRequestBody, isCompactionRequest, stripCacheBreakpoints } from './compat.mjs';
import zlib from 'node:zlib';

test('vendored atlases cover every Vietnamese letter (no [U+...] escapes)', async () => {
  const core = new URL('./vendor/pxpipe-proxy/dist/core/', import.meta.url).href;
  const vi = 'àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ';
  const letters = [...vi + vi.toUpperCase()];
  const render = await import(core + 'render.js');
  assert.equal(render.escapeMissingGlyphs(letters.join('')), letters.join(''));
  for (const f of ['atlas-gray.js', 'atlas-gray-jbmono14.js']) {
    const { atlasGrayRank } = await import(core + f);
    assert.deepEqual(letters.filter((c) => atlasGrayRank(c.codePointAt(0)) < 0), [], f);
  }
});

test('recall: inserts only the turns the latest compaction hid, never older eras', async () => {
  const { createRecall, RECALL_INTRO } = await import('./recall.mjs');
  const { responsesItemsToTurns } = await import(new URL('./vendor/pxpipe-proxy/dist/core/openai-history.js', import.meta.url).href);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxlite-recall-'));
  const rendered = [];
  const r = createRecall({ dir, toTurns: responsesItemsToTurns, minItems: 3, minChars: 60, render: async (text) => { rendered.push(text); return [{ png: new Uint8Array([1, 2, 3]) }]; } });
  const user = (t) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text: t }] });
  const asst = (t) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: t }] });
  const dev = { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'You are OpenCode.' }] };
  const call = (id) => ({ type: 'function_call', call_id: id, name: 'read', arguments: '{"path":"a.py"}' });
  const out = (id, o) => ({ type: 'function_call_output', call_id: id, output: o });
  const req = (input, key = 'ses_1') => ({ model: 'gpt-6.1-terra', prompt_cache_key: key, input: [dev, ...input] });
  const recallAt = (b) => b.input.findIndex((it) => it.content?.[0]?.text === RECALL_INTRO);

  // Era 1 grows normally: nothing injected.
  const era1 = [user('ERA1 decide: use openai_base_url, drop the custom provider'), asst('ERA1 ok, provider block removed'), call('c1'), out('c1', 'file text '.repeat(30))];
  assert.equal(await r.apply(req(era1.slice(0, 2))), null);
  assert.equal(await r.apply(req(era1)), null);
  // OpenCode pruning an old tool output keeps its call_id: not a compaction.
  assert.equal(await r.apply(req([...era1.slice(0, 3), out('c1', '[Old tool result content cleared]'), user('ERA1 last ask')])), null);
  // A revert drops recent turns without adding anything ahead: not a compaction.
  assert.equal(await r.apply(req([era1[0]])), null);
  assert.equal(r.stats.compactionsSeen, 0);
  await r.apply(req([...era1, user('ERA1 last ask')]));

  // Client-side compaction (OpenCode): summary first, the last ask kept.
  const sum1 = user('SUMMARY1 of what happened');
  const after1 = await r.apply(req([sum1, user('ERA1 last ask')]));
  assert.equal(r.stats.compactionsSeen, 1);
  assert.equal(recallAt(after1), 2, 'recall sits right after the summary');
  assert.equal(after1.input[2].content[1].type, 'input_image');
  assert.equal(after1.input[3].content[0].text, 'ERA1 last ask');
  assert.match(rendered.at(-1), /ERA1 decide: use openai_base_url/);
  assert.doesNotMatch(rendered.at(-1), /SUMMARY1/);

  // Next request in the same compacted shape: injected again, rendered once.
  const n = rendered.length;
  const era2 = [sum1, user('ERA1 last ask'), asst('ERA2 work: switched terra to 14px profile'), user('ERA2 more'), asst('ERA2 answer '.repeat(8))];
  assert.equal(recallAt(await r.apply(req(era2))), 2);
  assert.equal(rendered.length, n);

  // Server-side compaction item later: only era 2 is recalled; era 1 and summary 1 are not.
  const after2 = await r.apply(req([{ type: 'compaction', id: 'cmp_9', encrypted_content: 'opaque' }, user('ERA3 start')]));
  assert.equal(r.stats.compactionsSeen, 2);
  assert.equal(after2.input.filter((it) => it.content?.[0]?.text === RECALL_INTRO).length, 1);
  assert.equal(after2.input[1].type, 'compaction');
  assert.equal(recallAt(after2), 2);
  assert.match(rendered.at(-1), /ERA2 work/);
  assert.doesNotMatch(rendered.at(-1), /ERA1 decide|SUMMARY1/);

  // A subagent sharing the parent's cache key but with its own prompt is a separate
  // stream: its first requests are not mistaken for the parent's turns vanishing.
  const sub = { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'You are the hoh-developer subagent.' }] };
  const before = r.stats.compactionsSeen;
  assert.equal(await r.apply({ model: 'gpt-6.1-sol-fast', prompt_cache_key: 'ses_1', input: [sub, user('SUBTASK do X')] }), null);
  assert.equal(r.stats.compactionsSeen, before);
  // …and the parent keeps its recall afterwards.
  assert.equal(recallAt(await r.apply(req([{ type: 'compaction', id: 'cmp_9', encrypted_content: 'opaque' }, user('ERA3 start'), asst('ERA3 more')]))), 2);

  // No session key, or a fresh session: untouched.
  assert.equal(await r.apply({ model: 'gpt-6.1-terra', input: [user('x')] }), null);
  assert.equal(await r.apply(req([user('SUMMARY elsewhere'), user('x')], 'ses_2')), null);
  fs.rmSync(dir, { recursive: true });
});

test('recall: keeps the most recent turns within the budget and trims long tool output', async () => {
  const { fitRecent, itemsToTranscript } = await import('./recall.mjs');
  assert.equal(fitRecent(['a'.repeat(50), 'b'.repeat(50), 'c'.repeat(50)], 110), '[… 1 earlier turn(s) not shown …]\n\n' + 'b'.repeat(50) + '\n\n' + 'c'.repeat(50));
  const toTurns = (items) => items.map((it) => ({ text: it.output ?? it.arguments }));
  const t = itemsToTranscript([{ type: 'function_call_output', output: 'x'.repeat(5000) }, { type: 'function_call', arguments: 'a'.repeat(1000) }], toTurns, { maxCallChars: 100 });
  assert.equal(t[0], '', 'tool output dropped');
  assert.ok(t[1].length < 200 && t[1].includes('900 chars omitted'), 'tool call squeezed');
  const [ins] = itemsToTranscript([{ type: 'message', role: 'user' }], () => [{ text: '<user t="0">\nInstructions from: D:\\repo\\AGENTS.md\n# Rules\n' + 'rule\n'.repeat(300) + '</user>' }]);
  assert.equal(ins, '<user t="0">\nInstructions from: D:\\repo\\AGENTS.md [contents omitted, still loaded]\n</user>');
  const [sh] = itemsToTranscript([{ type: 'message', role: 'user' }], () => [{ text: '<user t="0">\n<shell id="sh_1" state="completed" command="pytest">' + 'log '.repeat(500) + '</shell>\nthen fix it\n</user>' }]);
  assert.match(sh, /<shell id="sh_1" state="completed" command="pytest"> \[shell output omitted\]<\/shell>\nthen fix it/);
  assert.doesNotMatch(sh, /log log/);
  // End to end: the recall keeps asks and tool calls, never tool output.
  const { createRecall } = await import('./recall.mjs');
  const { responsesItemsToTurns } = await import(new URL('./vendor/pxpipe-proxy/dist/core/openai-history.js', import.meta.url).href);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxlite-recall-'));
  let seen = '';
  const r = createRecall({ dir, toTurns: responsesItemsToTurns, minItems: 2, minChars: 10, render: async (s) => { seen = s; return [{ png: new Uint8Array(1) }]; } });
  const user = (s) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text: s }] });
  const era = [user('FIRST ASK keep me'), { type: 'function_call', call_id: 'k', name: 'read_file', arguments: '{"path":"a.py"}' }, { type: 'function_call_output', call_id: 'k', output: 'y'.repeat(1400) }, user('LAST ASK')];
  await r.apply({ model: 'gpt-6.1-sol', prompt_cache_key: 's', input: era });
  await r.apply({ model: 'gpt-6.1-sol', prompt_cache_key: 's', input: [user('SUMMARY'), user('LAST ASK')] });
  assert.match(seen, /FIRST ASK keep me/);
  assert.match(seen, /read_file/);
  assert.doesNotMatch(seen, /yyyy/);
  fs.rmSync(dir, { recursive: true });
});

test('claude recall: latest era only, no tool output or reminders, root-guarded, idempotent', async () => {
  const { createClaudeRecall, CLAUDE_RECALL_INTRO, CLAUDE_SUMMARY_MARKER, asReminder } = await import('./recall-claude.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pxlite-cc-'));
  const file = path.join(root, 'proj', 'ses.jsonl');
  fs.mkdirSync(path.dirname(file));
  const u = (content, extra = {}) => ({ type: 'user', message: { role: 'user', content }, ...extra });
  const a = (content) => ({ type: 'assistant', message: { role: 'assistant', content } });
  const boundary = { type: 'system', subtype: 'compact_boundary' };
  fs.writeFileSync(file, [
    u('ERA1 old ask'), a([{ type: 'text', text: 'ERA1 old answer' }]), boundary,
    u('summary 1', { isCompactSummary: true }),
    u('ERA2 ask: switch Codex to openai_base_url <system-reminder>REMINDER</system-reminder>'),
    a([{ type: 'thinking', thinking: 'THINKING' }, { type: 'text', text: 'ERA2 done, provider block removed' }, { type: 'tool_use', name: 'Edit', input: { file_path: 'config.toml', old_string: 'x'.repeat(500) } }]),
    u([{ type: 'tool_result', tool_use_id: 't', content: 'TOOL OUTPUT' }]),
    u('SKILL BODY', { isMeta: true }),
    { ...a([{ type: 'text', text: 'SIDECHAIN' }]), isSidechain: true },
    boundary,
    u('ERA3 live, after the boundary'),
  ].map((e) => JSON.stringify(e)).join('\n'));
  let seen = '';
  const r = createClaudeRecall({ root, render: async (t) => { seen = t; return [{ png: new Uint8Array([1]) }]; } });
  const summary = `${CLAUDE_SUMMARY_MARKER} that ran out of context.\nread the full transcript at: ${file}\n`;
  const body = { model: 'claude-opus-5-5', messages: [{ role: 'user', content: [{ type: 'text', text: summary }] }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'next' }] };
  const out = await r.apply(body);
  const c = out.messages[0].content;
  assert.equal(c[1].text, asReminder(CLAUDE_RECALL_INTRO), "intro rides in a system-reminder so pxpipe keeps the message and its images");
  assert.equal(c[2].type, 'image');
  assert.match(seen, /ERA2 ask: switch Codex to openai_base_url/);
  // Everything is imaged, in order; the edit is kept as a one-line path, not its content.
  assert.match(seen, /ERA2 done, provider block removed/);
  assert.match(seen, /\[Edit\] config\.toml/);
  assert.equal(c[3].text, (await import('./recall.mjs')).RECALL_OUTRO, 'no text turns between the images and the outro');
  const everything = seen + c.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  for (const bad of [/ERA1/, /summary 1/, /REMINDER/, /THINKING/, /TOOL OUTPUT/, /SKILL BODY/, /SIDECHAIN/, /ERA3/, /x{300}/]) assert.doesNotMatch(everything, bad);
  assert.ok(CLAUDE_RECALL_INTRO.length <= 280, 'intro fits pxpipe opening-turn preview');
  assert.equal(await r.apply(out), null, 'already injected');
  // A transcript path outside the root is never read.
  const outside = { ...body, messages: [{ role: 'user', content: [{ type: 'text', text: `${CLAUDE_SUMMARY_MARKER}\nread the full transcript at: ${path.join(os.tmpdir(), 'x.jsonl')}` }] }] };
  assert.equal(await r.apply(outside), null);
  assert.equal(r.stats.noTranscript, 1);
  fs.rmSync(root, { recursive: true });
});

test('claude recall: one line per tool call and every assistant text kept, tool output and code dropped, all imaged', async () => {
  const { createClaudeRecall, CLAUDE_SUMMARY_MARKER } = await import('./recall-claude.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pxlite-cc2-'));
  const file = path.join(root, 'ses.jsonl');
  const u = (content) => ({ type: 'user', message: { role: 'user', content } });
  const a = (content) => ({ type: 'assistant', message: { role: 'assistant', content } });
  const read = { type: 'tool_use', name: 'Read', input: { file_path: 'a.py' } };
  const bash = { type: 'tool_use', name: 'Bash', input: { command: 'ls -la SECRETCMD' } };
  const edit = (f) => ({ type: 'tool_use', name: 'Edit', input: { file_path: f, old_string: 'OLDCODE', new_string: 'NEWCODE' } });
  const res = u([{ type: 'tool_result', tool_use_id: 't', content: 'OUT' }]);
  fs.writeFileSync(file, [
    u('OLD ask'),
    a([{ type: 'text', text: 'LEADIN let me check' }]), a([read]), res, a([bash]), res,
    a([edit('src/x.py')]), res, a([edit('src/x.py')]), res, a([edit('src/y.py')]), res,
    a([{ type: 'text', text: 'FINAL answer one' }]),
    u('SECOND ask'), a([{ type: 'text', text: 'FINAL answer two' }]),
    { type: 'system', subtype: 'compact_boundary' },
  ].map((e) => JSON.stringify(e)).join('\n'));
  const summary = `${CLAUDE_SUMMARY_MARKER} that ran out of context.\nread the full transcript at: ${file}\n`;
  const body = { model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: [{ type: 'text', text: summary }] }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'next' }] };

  let imaged = '';
  const r = createClaudeRecall({ root, render: async (t) => { imaged = t; return [{ png: new Uint8Array([1]) }]; } });
  const c = (await r.apply(body)).messages[0].content;
  assert.equal(c[2].type, 'image', 'every turn is imaged');
  assert.ok(!c.some((b, i) => i > 1 && b.type === 'text' && /FINAL|SECOND ask/.test(b.text)), 'no turn stays as text');
  for (const kept of [/OLD ask/, /LEADIN let me check/, /\[Read\] a\.py/, /\[Bash\] ls -la SECRETCMD/, /FINAL answer one/, /SECOND ask/, /FINAL answer two/, /\[Edit\] src\/x\.py/, /\[Edit\] src\/y\.py/]) assert.match(imaged, kept);
  assert.equal(imaged.match(/\[Edit\] src\/x\.py/g).length, 1, 'same file listed once');
  for (const gone of [/OLDCODE/, /NEWCODE/, /\[tool_use/, /\bOUT\b/]) assert.doesNotMatch(imaged, gone);
  assert.ok(imaged.indexOf('LEADIN') < imaged.indexOf('[Read] a.py') && imaged.indexOf('[Edit] src/y.py') < imaged.indexOf('FINAL answer one'), 'calls and texts stay in order');
  assert.ok(imaged.indexOf('OLD ask') < imaged.indexOf('SECOND ask'), 'order kept');
  fs.rmSync(root, { recursive: true });
});

test('claude recall runs only for models pxpipe images (config scope)', async () => {
  const { isPxpipeSupportedModel } = await import(new URL('./vendor/pxpipe-proxy/dist/core/applicability.js', import.meta.url).href);
  const prev = process.env.PXPIPE_MODELS;
  process.env.PXPIPE_MODELS = 'claude-fable-5,claude-opus-5-5,claude-sonnet-5-5,gemini,gpt-6.1-sol,gpt-6.1-terra';
  try {
    assert.equal(isPxpipeSupportedModel('claude-sonnet-5-5'), true);
    assert.equal(isPxpipeSupportedModel('claude-opus-5-5'), true);
    assert.equal(isPxpipeSupportedModel('claude-haiku-5-5'), false);
  } finally {
    if (prev === undefined) delete process.env.PXPIPE_MODELS;
    else process.env.PXPIPE_MODELS = prev;
  }
});

test('compaction request is detected only when the last message carries the summary instruction', () => {
  const enc = (o) => new TextEncoder().encode(JSON.stringify(o));
  const ask = 'Your task is to create a detailed summary of the conversation so far, paying close attention';
  const hist = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: [{ type: 'text', text: 'hello' }] }];
  assert.equal(isCompactionRequest(enc({ messages: [...hist, { role: 'user', content: [{ type: 'text', text: ask }] }] })), true);
  assert.equal(isCompactionRequest(enc({ messages: [...hist, { role: 'user', content: ask }] })), true);
  // Shape seen from Claude Code 2026-11: a trailing role "system" message after the ask.
  assert.equal(isCompactionRequest(enc({ messages: [...hist, { role: 'user', content: [{ type: 'text', text: 'ctx' }, { type: 'text', text: ask }] }, { role: 'system', content: 'reminders' }] })), true);
  assert.equal(isCompactionRequest(enc({ messages: [...hist, { role: 'user', content: ask }, { role: 'assistant', content: 'done' }, { role: 'system', content: 'x' }] })), false);
  // The phrase quoted earlier in history (a session about compaction) is not a compaction request.
  assert.equal(isCompactionRequest(enc({ messages: [{ role: 'user', content: ask }, ...hist, { role: 'user', content: 'next' }] })), false);
  assert.equal(isCompactionRequest(enc({ messages: hist })), false);
  assert.equal(isCompactionRequest(new TextEncoder().encode('not json ' + ask)), false);
  // Summary instruction carried in the system prompt.
  assert.equal(isCompactionRequest(enc({ system: [{ type: 'text', text: ask }], messages: hist })), true);
  // A quoted marker earlier in history is reported by position, never by content.
  const quoted = classifyCompaction(enc({ messages: [{ role: 'user', content: ask }, ...hist, { role: 'user', content: 'next' }] }));
  assert.deepEqual(quoted, { compact: false, where: 'msg-3-from-end:user' });
  assert.deepEqual(classifyCompaction(enc({ messages: hist })), { compact: false, where: null });
});

test('compressed request bodies are decoded, unknown encodings left alone', () => {
  const json = Buffer.from('{"model":"gpt-6.1-terra","input":[]}');
  assert.equal(decodeRequestBody('zstd', zlib.zstdCompressSync(json)).toString(), json.toString());
  assert.equal(decodeRequestBody('gzip', zlib.gzipSync(json)).toString(), json.toString());
  assert.equal(decodeRequestBody('identity', json), null);
  assert.equal(decodeRequestBody(undefined, json), null);
});

test('cache breakpoints are stripped for the ChatGPT backend, other bodies untouched', () => {
  const req = { model: 'gpt-6.1-sol', input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'data:', prompt_cache_breakpoint: { mode: 'explicit' } }] }], prompt_cache_breakpoint: { mode: 'explicit' } };
  const out = JSON.parse(new TextDecoder().decode(stripCacheBreakpoints(new TextEncoder().encode(JSON.stringify(req)))));
  assert.equal(JSON.stringify(out).includes('prompt_cache_breakpoint'), false);
  assert.equal(out.input[0].content[0].type, 'input_image');
  assert.equal(stripCacheBreakpoints('{"a":1}'), '{"a":1}');
  const stream = new ReadableStream();
  assert.equal(stripCacheBreakpoints(stream), stream);
});

const asRead = (lines) => lines.map((l, i) => String(i + 1).padStart(6) + '\t' + l).join('\n');
const repeat = (n, f) => Array.from({ length: n }, (_, i) => f(i));

test('python code with line-number prefixes may be imaged', () => {
  const code = asRead(repeat(300, (i) => (i % 5 === 0 ? `def step_${i}(x, y):` : `    return compute(x, y, scale=self.scale)  # keep shape`)));
  assert.equal(analyze(code).reason, null);
});

test('vietnamese markdown prose may be imaged', () => {
  const md = repeat(200, () => 'Kỷ luật bắt buộc khi viết code: chạy test, đọc log, ghi lại quyết định trong file kế hoạch.').join('\n');
  assert.equal(isDataLike(md), false);
});

test('json results stay text', () => {
  const json = asRead(repeat(200, (i) => `  "seed_${i}": {"oa": 0.${9000 + i}, "f1": 0.${8000 + i}},`));
  assert.equal(analyze(json).reason !== null, true);
});

test('json config with few numbers stays text via key density', () => {
  const json = asRead(repeat(200, (i) => `  "option_name_${'abc'[i % 3]}": "some string value",`));
  assert.equal(analyze(json).reason, 'json');
});

test('csv rows stay text', () => {
  const csv = repeat(200, (i) => `${i},pavia_u,${(i * 0.37).toFixed(3)},${i * 11},ok`).join('\n');
  assert.notEqual(analyze(csv).reason, null);
});

test('log with timestamps stays text', () => {
  const log = repeat(200, (i) => `2026-11-15T07:${String(i % 60).padStart(2, '0')}:00Z worker started job queue drained successfully`).join('\n');
  assert.notEqual(analyze(log).reason, null);
  // Timestamps alone are enough even when the rest of the line is long prose.
  const wordy = repeat(200, () => `2026-11-15 07:00 the worker finished reading the configuration and started the scheduler loop again`).join('\n');
  assert.equal(analyze(wordy).reason, 'log');
});

test('git log hashes stay text', () => {
  const hashes = repeat(100, (i) => `${(0xabc1230 + i * 7919).toString(16)}f9e feat(nc32): update pipeline docs and rerun`).join('\n');
  assert.equal(analyze(hashes).reason, 'hex');
});

test('prose with one dense numeric table stays text', () => {
  const prose = repeat(120, () => 'Phần này mô tả thiết kế thí nghiệm và lý do chọn đường cơ sở cổ điển.');
  const table = repeat(25, (i) => `| ${i} | 0.${8100 + i} | 0.${7200 + i} | ${1000 + i} |`);
  assert.notEqual(analyze([...prose, ...table, ...prose].join('\n')).reason, null);
});

test('rotating log caps size and keeps one backup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxlite-'));
  const file = path.join(dir, 'events.jsonl');
  const log = new RotatingLog(file, { maxBytes: 1000, maxAgeDays: 14 });
  for (let i = 0; i < 100; i++) log.write({ i, pad: 'x'.repeat(40) });
  assert.ok(fs.statSync(file).size <= 1000);
  assert.ok(fs.statSync(file.replace('.jsonl', '.1.jsonl')).size <= 1000);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['events.1.jsonl', 'events.jsonl']);
  fs.rmSync(dir, { recursive: true });
});

test('rotating log deletes files older than maxAgeDays at startup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxlite-'));
  const file = path.join(dir, 'events.jsonl');
  fs.writeFileSync(file, '{"old":true}\n');
  const old = new Date(Date.now() - 20 * 86_400_000);
  fs.utimesSync(file, old, old);
  const log = new RotatingLog(file, { maxBytes: 1000, maxAgeDays: 14 });
  assert.equal(fs.existsSync(file), false);
  log.write({ fresh: true });
  assert.equal(fs.readFileSync(file, 'utf8'), '{"fresh":true}\n');
  fs.rmSync(dir, { recursive: true });
});

test('rotating log rotates an oversized file at startup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxlite-'));
  const file = path.join(dir, 'events.jsonl');
  fs.writeFileSync(file, 'x'.repeat(5000));
  const log = new RotatingLog(file, { maxBytes: 1000, maxAgeDays: 14 });
  assert.equal(log.size, 0);
  assert.equal(fs.statSync(file.replace('.jsonl', '.1.jsonl')).size, 5000);
  fs.rmSync(dir, { recursive: true });
});

test('history collapse over the byte budget is trimmed to fit, not skipped whole (patches/history-byte-trim.patch)', async () => {
  process.env.PXPIPE_MODELS = 'claude-opus-5-5';
  const lib = await import(new URL('./vendor/pxpipe-proxy/dist/core/library.js', import.meta.url).href);
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789_/.-';
  const words = Array.from({ length: 300 }, () => Array.from({ length: 3 + Math.floor(rnd() * 8) }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join(''));
  const para = (n) => Array.from({ length: n }, () => words[Math.floor(rnd() * words.length)]).join(' ');
  const messages = Array.from({ length: 100 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: [{ type: 'text', text: `turn ${i}: ${para(380)}` }] }));
  const run = async (maxImageBytes) => {
    const body = { model: 'claude-opus-5-5', max_tokens: 1000, system: [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }], messages };
    const options = { emitRecoverable: false };
    if (maxImageBytes) options.maxImageBytes = maxImageBytes;
    const r = await lib.transformAnthropicMessages({ body: new TextEncoder().encode(JSON.stringify(body)), model: 'claude-opus-5-5', options });
    const out = JSON.parse(new TextDecoder().decode(r.body));
    let bytes = 0;
    for (const m of out.messages) for (const c of Array.isArray(m.content) ? m.content : []) if (c.type === 'image') bytes += Buffer.from(c.source.data, 'base64').length;
    return { r, bytes };
  };
  const free = await run(undefined);
  assert.equal(free.r.info.historyReason, 'collapsed');
  assert.ok(!free.r.info.historyByteTrims, 'no trim when the budget is not binding');
  const limit = Math.floor(free.bytes * 0.6);
  const tight = await run(limit);
  assert.equal(tight.r.info.historyReason, 'collapsed', 'collapsed instead of image_bytes skip');
  assert.ok(tight.r.info.historyByteTrims > 0);
  assert.ok(tight.bytes <= limit, `${tight.bytes} bytes must fit ${limit}`);
  assert.ok(tight.r.info.collapsedTurns > 0 && tight.r.info.collapsedTurns < free.r.info.collapsedTurns);
});

test('history collapse keeps one line per tool call, every text, failures and subagent reports; drops tool output (patches/pxlite-vendor.patch)', async () => {
  const { messagesToHistorySegments } = await import(new URL('./vendor/pxpipe-proxy/dist/core/history.js', import.meta.url).href);
  const msgs = [
    { role: 'user', content: [{ type: 'text', text: 'please fix the parser' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'LEADIN I will check the file first' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'src/a.py' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'RESULT-SECRET line one' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'LEADIN2 editing now' }, { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: 'src/a.py', old_string: 'OLD-BODY', new_string: 'NEW-BODY' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'edited ok' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'pytest -q', description: 'Run tests' } }, { type: 'tool_use', id: 't4', name: 'Read', input: { file_path: 'src/a.py' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't3', is_error: true, content: 'FAILED test_parse - KeyError' }, { type: 'tool_result', tool_use_id: 't4', content: 'RESULT-SECRET again' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't5', name: 'Agent', input: { description: 'audit', subagent_type: 'Explore', prompt: 'check callers' } }, { type: 'tool_use', id: 't6', name: 'ToolSearch', input: { query: 'select:X' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't5', content: [{ type: 'text', text: 'AGENT-REPORT two callers' }] }, { type: 'tool_result', tool_use_id: 't6', content: 'schema' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'FINAL-ANSWER the parser is fixed' }] },
  ];
  const { text } = messagesToHistorySegments(msgs, msgs.length, 0);
  for (const kept of ['LEADIN I will check', 'LEADIN2 editing now', '[Read] src/a.py', '[Edit] src/a.py', '[Bash] Run tests: pytest -q', '[Bash error] FAILED test_parse - KeyError',
    '[Subagent Explore] audit: check callers', '[Message from subagent]\nAGENT-REPORT two callers', 'FINAL-ANSWER']) assert.ok(text.includes(kept), `${kept} must be rendered`);
  assert.equal(text.split('[Read] src/a.py').length - 1, 1, 'a file read twice is listed once');
  for (const gone of ['RESULT-SECRET', 'OLD-BODY', 'NEW-BODY', 'tool_result', '[tool_use', 'edited ok', 'ToolSearch', 'schema']) assert.ok(!text.includes(gone), `${gone} must not be rendered`);
});

test('a compaction summary in the first message stays whole after history collapse (patches/pxlite-vendor.patch)', async () => {
  process.env.PXPIPE_MODELS = 'claude-opus-5-5';
  const lib = await import(new URL('./vendor/pxpipe-proxy/dist/core/library.js', import.meta.url).href);
  const middle = 'MIDDLE-SECRET-47';
  const summary = `This session is being continued from a previous conversation. Summary:\n${'alpha beta gamma '.repeat(300)}${middle}\n${'delta epsilon zeta '.repeat(300)}`;
  for (const withReminder of [true, false]) {
    const first = [...(withReminder ? [{ type: 'text', text: '<system-reminder>rules</system-reminder>' }] : []), { type: 'text', text: summary }];
    const messages = [{ role: 'user', content: first }];
    for (let i = 1; i < 70; i++) messages.push({ role: i % 2 ? 'assistant' : 'user', content: [{ type: 'text', text: `turn ${i} ${'lorem ipsum dolor sit amet '.repeat(40)}` }] });
    const body = { model: 'claude-opus-5-5', max_tokens: 100, system: [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }], messages };
    const r = await lib.transformAnthropicMessages({ body: new TextEncoder().encode(JSON.stringify(body)), model: 'claude-opus-5-5', options: { emitRecoverable: false } });
    const out = JSON.parse(new TextDecoder().decode(r.body));
    assert.equal(r.info.historyReason, 'collapsed');
    const kept = out.messages[0].content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    assert.ok(kept.includes(middle), `summary middle survives (reminder=${withReminder})`);
  }
});

test('session recall: picks by name/id, pins the choice, attaches before the command, reports a miss', async () => {
  const { createSessionRecall, pickSession, SESSION_RECALL_MARK } = await import('./recall-session.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxlite-rs-'));
  const root = path.join(dir, 'projects');
  const proj = path.join(root, 'd--demo');
  fs.mkdirSync(proj, { recursive: true });
  const user = (t) => JSON.stringify({ type: 'user', message: { role: 'user', content: t } });
  const asst = (t) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: t }] } });
  const session = (id, title, mtime, prompts) => {
    const lines = [user(`${title} first prompt`), ...Array.from({ length: prompts }, (_, i) => [asst(`answer ${i} ${'x'.repeat(400)}`), user(`prompt ${i} ${'y'.repeat(400)}`)]).flat(), JSON.stringify({ type: 'ai-title', aiTitle: title, sessionId: id })];
    const f = path.join(proj, `${id}.jsonl`);
    fs.writeFileSync(f, lines.join('\n') + '\n');
    fs.utimesSync(f, mtime / 1000, mtime / 1000);
  };
  const now = Date.now();
  // padding keeps every file above the 6000-byte floor, as real transcripts are
  const pad = 'z'.repeat(7000);
  session('aaaaaaaa-1111-4111-8111-111111111111', `Cabbage fixed band study ${pad}`.slice(0, 40), now - 5000, 8);
  session('bbbbbbbb-2222-4222-8222-222222222222', 'Pxpipe proxy work', now - 4000, 8);
  session('cccccccc-3333-4333-8333-333333333333', 'one shot ok', now - 3000, 0); // a -p style run: no real prompts
  session('dddddddd-4444-4444-8444-444444444444', 'current session', now - 1000, 2);
  const rendered = [];
  const sr = createSessionRecall({ root, pinFile: path.join(dir, 'pins.json'), render: async (t) => { rendered.push(t); return [{ png: new Uint8Array([1, 2, 3]) }]; } });
  const SID = 'dddddddd-4444-4444-8444-444444444444';
  const req = (cmd, extra = []) => ({ model: 'm', metadata: { user_id: JSON.stringify({ session_id: SID }) }, messages: [{ role: 'user', content: [{ type: 'text', text: '<system-reminder>rules</system-reminder>' }, { type: 'text', text: cmd }] }, ...extra] });
  const hdr = new Headers({ 'x-claude-code-session-id': SID });
  const noteOf = (r) => r?.messages[0].content.find((b) => b.text?.includes(SESSION_RECALL_MARK))?.text ?? '';

  // no query: latest earlier session with real prompts; the one-shot and the current session are skipped
  const a = await sr.apply(req('recall'), hdr);
  const blocks = a.messages[0].content;
  assert.equal(blocks.at(-1).text, 'recall', 'the command stays last');
  assert.ok(blocks.some((b) => b.type === 'image'));
  assert.ok(noteOf(a).includes('Pxpipe proxy work'), 'note names the session');
  assert.ok(noteOf(a).startsWith('<system-reminder>'), 'note is a reminder so pxpipe protects the message');
  assert.ok(/prompt 7/.test(rendered.at(-1)));
  // same request again, and a newer session appearing meanwhile: identical bytes (pinned)
  session('eeeeeeee-5555-4555-8555-555555555555', 'Newer session', Date.now(), 8);
  assert.equal(JSON.stringify(await sr.apply(req('recall'), hdr)), JSON.stringify(a));
  // by words and by id prefix
  assert.ok(noteOf(await sr.apply(req('recall cabbage band'), hdr)).includes('Cabbage fixed band'));
  assert.ok(noteOf(await sr.apply(req('recall bbbbbbbb'), hdr)).includes('Pxpipe proxy work'));
  // a miss: no images, a note with the recent sessions, the one-shot is not among them
  const miss = await sr.apply(req('recall zzz qqq'), hdr);
  assert.ok(!miss.messages[0].content.some((b) => b.type === 'image'));
  assert.ok(noteOf(miss).includes('no earlier session matched') && noteOf(miss).includes('Newer session') && !noteOf(miss).includes('one shot ok'));
  // the last command wins; ordinary prose never triggers; no session id means no recall
  const later = await sr.apply(req('recall', [{ role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, { role: 'user', content: [{ type: 'text', text: 'recall bbbbbbbb' }] }]), hdr);
  assert.ok(noteOf(later).includes('Pxpipe proxy work'));
  assert.equal(await sr.apply(req('please recall the plan'), hdr), null);
  assert.equal(await sr.apply({ ...req('recall'), metadata: {} }, new Headers()), null);
  assert.equal(pickSession([], 'x'), null);
});

test('claudeTurnsOf keeps images, subagents, skills, errors and notifications', async () => {
  const { claudeTurnsOf } = await import('./recall-claude.mjs');
  const u = (content, extra = {}) => ({ type: 'user', message: { role: 'user', content }, ...extra });
  const a = (content) => ({ type: 'assistant', message: { role: 'assistant', content } });
  const report = 'Some frame text. The report follows:\n  **REPORT-BODY** line one\n  line two';
  const turns = claudeTurnsOf([
    u([{ type: 'image', source: {} }, { type: 'text', text: 'see screenshot' }]),
    u('[Image: source: C:\\tmp\\shot.png]', { isMeta: true }),
    u('SKILL-BODY-TEXT', { isMeta: true }),
    a([{ type: 'tool_use', id: 's1', name: 'Skill', input: { skill: 'workflow', args: 'spec' } }]),
    a([{ type: 'tool_use', id: 'a1', name: 'Agent', input: { description: 'map pricing', subagent_type: 'Explore', prompt: 'look', run_in_background: true } }]),
    u([{ type: 'tool_result', tool_use_id: 'a1', content: 'Async agent launched successfully' }]),
    a([{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'bun test', description: 'Run tests' } }]),
    u([{ type: 'tool_result', tool_use_id: 'b1', is_error: true, content: 'ERROR-LINE: 2 failed' }]),
    a([{ type: 'tool_use', id: 'b2', name: 'Bash', input: { command: 'ls' } }]),
    u([{ type: 'tool_result', tool_use_id: 'b2', content: 'OK-OUTPUT' }]),
    u('x', { isMeta: true, origin: { kind: 'peer', name: 'Explore', body: report } }),
    u('<task-notification><status>completed</status><summary>Agent map pricing done</summary></task-notification>', { origin: { kind: 'task-notification' } }),
    u('The coordinator sent a message: COORD-NOTE', { isMeta: true, origin: { kind: 'coordinator' } }),
    u('y', { isMeta: true, origin: { kind: 'peer', name: 'Plan', handback: true, handbackReportText: 'CLEAN-REPORT' } }),
    { ...a([{ type: 'text', text: 'SIDECHAIN-INNER' }]), isSidechain: true },
    a([{ type: 'text', text: 'done' }]),
  ]);
  const all = turns.join('\n');
  for (const kept of [/\[image\]\nsee screenshot\n\[Image: source: C:\\tmp\\shot\.png\]\n<\/user>/, /\[Skill\] workflow spec/, /\[Subagent Explore, background\] map pricing: look/,
    /\[Bash\] Run tests: bun test/, /\[Bash error\] ERROR-LINE: 2 failed/, /\[Message from Explore\]\n\*\*REPORT-BODY\*\* line one\nline two/, /\[Task notification\] completed — Agent map pricing done/, /\[Message from coordinator\]\nThe coordinator sent a message: COORD-NOTE/, /\[Message from Plan\]\nCLEAN-REPORT/]) assert.match(all, kept);
  for (const gone of [/SKILL-BODY-TEXT/, /OK-OUTPUT/, /Async agent launched/, /SIDECHAIN-INNER/, /The report follows/]) assert.doesNotMatch(all, gone);
  assert.equal(turns.filter((t) => t.startsWith('<user ')).length, 1, 'tool results and harness notes are not user turns');
});

test('fitRecent keeps a leading compaction summary and cuts turns instead', async () => {
  const { fitRecent } = await import('./recall.mjs');
  const sum = `<earlier-summary>\n${'s'.repeat(80)}\n</earlier-summary>`;
  const out = fitRecent([sum, 'a'.repeat(50), 'b'.repeat(50), 'c'.repeat(50)], sum.length + 60);
  assert.ok(out.startsWith(sum));
  assert.match(out, /\[… 2 earlier turn\(s\) not shown …\]/);
  assert.ok(out.endsWith('c'.repeat(50)));
});
