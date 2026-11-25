// node --test test-conversation-key.mjs — needs vendor/ (junction to ~/.pxpipe-lite/vendor).
//
// A main thread and its subagents can open with the same first user message. Cut and freeze state
// used to be keyed by that message's hash alone, so concurrent threads overwrote each other's cut:
// moves "from" another thread's length, sticky refused, cached image blocks rewritten. The host now
// passes a per-thread conversationKey; these tests pin that threads stay independent.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

process.env.PXPIPE_MODELS ??= 'claude-opus-5-5';
const core = new URL('./vendor/pxpipe-proxy/dist/core/', import.meta.url).href;
const { transformRequest } = await import(core + 'transform.js');
const { HISTORY_SYNTHETIC_INTRO } = await import(core + 'history.js');

const FIRST = 'Same opening prompt for every thread.';
const WORDS = 'the proxy reads cache prefix and writes image chunk for history when tail grows beyond limit then agent calls tool again to check result of previous step'.split(' ');
const prose = (rnd, n) => Array.from({ length: n }, () => WORDS[Math.floor(rnd() * WORDS.length)]).join(' ');
const SYSTEM = [{ type: 'text', text: 'You are a coding agent. ' + prose(Math.random, 900), cache_control: { type: 'ephemeral' } }];
const TOOLS = [{ name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: { file_path: { type: 'string' } } } }];

function conversation(seed, rounds) {
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const m = [{ role: 'user', content: [{ type: 'text', text: FIRST }] }];
  for (let r = 0; r < rounds; r++) {
    const id = `toolu_${seed}_${r}`;
    m.push({ role: 'assistant', content: [{ type: 'text', text: prose(rnd, 40) }, { type: 'tool_use', id, name: 'Read', input: { file_path: `/repo/src/file${r}.js` } }] });
    m.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: Array.from({ length: 40 }, (_, i) => `  const v${i} = ${prose(rnd, 6)};`).join('\n') }] });
  }
  return m;
}

/** One request of `n` messages through the real Claude transform; returns a signature of the cut. */
async function request(all, n, conversationKey) {
  const messages = structuredClone(all.slice(0, n));
  messages.at(-1).content.at(-1).cache_control = { type: 'ephemeral' };
  const body = { model: 'claude-opus-5-5', max_tokens: 1024, system: structuredClone(SYSTEM), tools: structuredClone(TOOLS), messages };
  const out = await transformRequest(new TextEncoder().encode(JSON.stringify(body)), { model: 'claude-opus-5-5', emitRecoverable: false, conversationKey });
  const req = JSON.parse(new TextDecoder().decode(out.body));
  const hist = req.messages.find((m) => Array.isArray(m.content) && m.content[0]?.type === 'text' && m.content[0].text === HISTORY_SYNTHETIC_INTRO);
  const images = (hist?.content ?? []).filter((b) => b.type === 'image').map((b) => crypto.createHash('sha1').update(b.source.data).digest('hex').slice(0, 8));
  return { turns: out.info.collapsedTurns ?? 0, images: images.join(','), moved: out.info.historyCut?.cutMove?.from };
}

const range = (from, to, step) => Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step);

test('threads that open with the same first message keep independent cuts', async () => {
  const A = conversation(11, 60);
  const B = conversation(29, 110);
  const stepsA = range(61, 121, 6);
  const stepsB = range(141, 221, 8);

  const solo = [];
  for (const n of stepsA) solo.push(await request(A, n, 'solo-a'));

  const mixed = [];
  const other = [];
  for (let i = 0; i < stepsA.length; i++) {
    mixed.push(await request(A, stepsA[i], 'mix-a'));
    other.push(await request(B, stepsB[i], 'mix-b'));
  }

  assert.ok(solo.some((r) => r.turns > 0), 'thread A must collapse, or the test proves nothing');
  assert.ok(other.some((r) => r.turns > solo.at(-1).turns), 'thread B is the longer thread');
  assert.deepEqual(mixed.map((r) => [r.turns, r.images]), solo.map((r) => [r.turns, r.images]));
  for (const r of mixed) assert.equal(r.moved, undefined, 'no cut may be reported as moving from another thread\'s length');
});
