// Over-cap user prompts (pasted logs) are rendered into history images. Two kinds of
// padding must not cost image rows: runs of numbered-empty / repeated lines, and the same
// harness notice pasted again and again inside one chunk.
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.PXPIPE_MODELS ??= 'claude-opus-5-5';
const core = new URL('./vendor/pxpipe-proxy/dist/core/', import.meta.url).href;
const { transformRequest } = await import(core + 'transform.js');
const { HISTORY_SYNTHETIC_INTRO, collapseJunkLines } = await import(core + 'history.js');

let seed = 11;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const WORDS = 'proxy cache prefix image chunk history tail tool result agent check step failed passed restart session'.split(' ');
const prose = (n) => Array.from({ length: n }, () => WORDS[Math.floor(rnd() * WORDS.length)]).join(' ');
const SYSTEM = [{ type: 'text', text: 'You are a coding agent. ' + prose(300), cache_control: { type: 'ephemeral' } }];
const TOOLS = [{ name: 'Read', description: 'read', input_schema: { type: 'object', properties: { file_path: { type: 'string' } } } }];

const realLines = (n, tag) => Array.from({ length: n }, (_, i) => `${tag} ${i}: ${prose(14)}`).join('\n');
const junk = (from, n) => Array.from({ length: n }, (_, i) => `${from + i}:`).join('\n');

function conversation(rounds, pastes) {
  seed = 11;
  const m = [{ role: 'user', content: [{ type: 'text', text: 'start the task' }] }];
  for (let r = 0; r < rounds; r++) {
    const id = 'toolu_' + String(r).padStart(4, '0');
    m.push({ role: 'assistant', content: [{ type: 'text', text: prose(30) }, { type: 'tool_use', id, name: 'Read', input: { file_path: `/f${r}.js` } }] });
    const content = [{ type: 'tool_result', tool_use_id: id, content: `out ${r}\n${prose(60)}` }];
    if (pastes[r]) content.push({ type: 'text', text: pastes[r] });
    m.push({ role: 'user', content });
  }
  return m;
}

async function historyImages(pastes, rounds = 260) {
  const messages = conversation(rounds, pastes);
  messages.at(-1).content.at(-1).cache_control = { type: 'ephemeral' };
  const body = { model: 'claude-opus-5-5', max_tokens: 1024, system: SYSTEM, tools: TOOLS, messages };
  const out = await transformRequest(new TextEncoder().encode(JSON.stringify(body)), { model: 'claude-opus-5-5', emitRecoverable: false });
  const req = JSON.parse(new TextDecoder().decode(out.body));
  const hist = req.messages.find((m) => Array.isArray(m.content) && m.content[0]?.type === 'text' && m.content[0].text === HISTORY_SYNTHETIC_INTRO);
  assert.ok(hist, 'the conversation collapsed');
  const imgs = hist.content.filter((b) => b.type === 'image');
  return { count: imgs.length, bytes: imgs.reduce((s, b) => s + b.source.data.length, 0), images: imgs.map((b) => b.source.data).join('|') };
}

test('a paste padded with numbered-empty lines renders exactly like its collapsed form', async () => {
  const head = realLines(40, 'head');
  const tail = realLines(40, 'tail');
  const raw = `${head}\n${junk(158247, 6000)}\n${tail}`;
  const collapsed = collapseJunkLines(raw);
  assert.ok(collapsed.length > 2000 && collapsed.length < raw.length / 3);
  const a = await historyImages({ 20: raw });
  const b = await historyImages({ 20: collapsed });
  assert.equal(a.images, b.images);
});

test('the same long notice pasted three times in a chunk costs one image set, not three', async () => {
  const notice = realLines(700, 'notice');
  const base = (await historyImages({})).bytes;
  const once = (await historyImages({ 20: notice })).bytes - base;
  const thrice = (await historyImages({ 20: notice, 40: notice, 60: notice })).bytes - base;
  const distinct = (await historyImages({ 20: realLines(700, 'a'), 40: realLines(700, 'b'), 60: realLines(700, 'c') })).bytes - base;
  assert.ok(once > 0, 'the paste is imaged at all');
  assert.ok(thrice < distinct * 0.6, `extra bytes: dup ${thrice} vs distinct ${distinct}`);
  assert.ok(thrice < once * 1.3, `extra bytes: dup ${thrice} vs once ${once}`);
});

test('two requests over the same history produce identical images', async () => {
  const notice = realLines(120, 'notice');
  const a = await historyImages({ 20: notice, 40: notice });
  const b = await historyImages({ 20: notice, 40: notice });
  assert.equal(a.images, b.images);
});
