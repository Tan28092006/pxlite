// node --test test-history-cut.mjs
// Where the Claude history collapse cuts: not too late (first cut), not too early (token floor on
// the verbatim tail), and never backwards (a cut that moves back re-keys every cached block after it).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const core = pathToFileURL(path.join(ROOT, 'vendor/pxpipe-proxy/dist/core/')).href;
const H = await import(core + 'history.js');
const { collapseHistory, clearLastCuts, verbatimTailTokens, HISTORY_SYNTHETIC_INTRO } = H;

const ENV = ['PXLITE_KEEP_TAIL_TOKENS', 'PXLITE_FIRST_CUT_EXTEND', 'PXLITE_STICKY_CUT', 'PXLITE_MIN_COLLAPSE_MESSAGES', 'PXLITE_MIN_SHRINK_TOKENS', 'PXLITE_FORCE_COLLAPSE_TOKENS', 'PXLITE_TOOL_ROUND_KEEP_TAIL', 'PXLITE_TOOL_ROUND_CUT', 'PXLITE_MIN_CUT_MOVE', 'PXLITE_CACHE_TTL'];
async function withEnv(env, fn) {
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  Object.assign(process.env, { PXLITE_MIN_SHRINK_TOKENS: '0', ...env });
  clearLastCuts();
  try { return await fn(); }
  finally { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } clearLastCuts(); }
}

const filler = (n, tag) => Array.from({ length: n }, (_, i) => `line ${i} of ${tag}: the proxy checks the cache prefix`).join('\n');
/** One agent conversation: `lead` leading user messages (OpenCode + claude-auth sends the relocated
 *  system prompt as its own user message, so the real prompt is the second), then tool rounds. */
function conversation({ lead = 1, rounds = 120, resultLines = () => 40 } = {}) {
  const m = [];
  if (lead === 2) m.push({ role: 'user', content: [{ type: 'text', text: 'You are an agent running in a harness. Standing rules follow.' }] });
  m.push({ role: 'user', content: [{ type: 'text', text: 'Audit the cache policy and fix what is wrong.' }] });
  for (let r = 0; r < rounds; r++) {
    const id = 'toolu_' + String(r).padStart(4, '0');
    m.push({ role: 'assistant', content: [{ type: 'text', text: `Step ${r}: checking the next file.` }, { type: 'tool_use', id, name: 'Read', input: { file_path: `/repo/src/file${r}.js` } }] });
    m.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: filler(resultLines(r), 'file' + r) }] });
  }
  return m;
}
/** The request an agent would send after `n` messages (always ends on a user message). */
function requestAt(all, n) {
  let k = Math.min(n, all.length);
  while (k > 1 && all[k - 1].role !== 'user') k--;
  return structuredClone(all.slice(0, k));
}
const always = () => true;
async function collapse(messages, opts = {}) {
  const r = await collapseHistory(messages, always, { protectedPrefix: 1, cols: 100, stickyKey: 'conv-1', ...opts });
  const hist = r.messages.find((x) => Array.isArray(x.content) && x.content[0]?.type === 'text' && x.content[0].text === HISTORY_SYNTHETIC_INTRO);
  const images = hist ? hist.content.filter((b) => b.type === 'image').map((b) => crypto.createHash('sha1').update(b.source.data).digest('hex').slice(0, 10)) : [];
  return { info: r.info, images, turns: r.info.collapsedTurns, reason: r.info.reason, tail: hist ? r.messages.length - r.messages.indexOf(hist) - 1 : messages.length };
}
const table = (rows) => { if (process.env.PXLITE_TEST_TABLE) console.log(rows.map((r) => '    ' + r).join('\n')); };

test('first cut: an OpenCode-shaped conversation collapses at the first chunk instead of waiting for the second', async () => {
  const all = conversation({ lead: 2 });
  const run = async (env) => withEnv({ PXLITE_KEEP_TAIL_TOKENS: '0', ...env }, async () => {
    const rows = [];
    for (let n = 55; n <= 115; n += 2) { const r = await collapse(requestAt(all, n)); rows.push({ n: requestAt(all, n).length, turns: r.turns, reason: r.reason, images: r.images }); }
    return rows;
  });
  const fixed = await run({});
  const old = await run({ PXLITE_FIRST_CUT_EXTEND: '0' });
  table(fixed.map((r, i) => `${String(r.n).padStart(4)} msgs | now: ${String(r.turns).padStart(3)} turns ${(r.reason ?? 'collapsed').padEnd(16)} | switch off: ${String(old[i].turns).padStart(3)} turns ${old[i].reason ?? 'collapsed'}`));
  const firstFixed = fixed.find((r) => r.turns > 0), firstOld = old.find((r) => r.turns > 0);
  // CONTROL: with the walk-forward switched off the same conversation is refused until the second chunk.
  assert.ok(firstOld.n >= 111, `control: without the fix the first collapse comes at ${firstOld.n} messages`);
  assert.equal(old.filter((r) => r.n < firstOld.n && r.n >= 65).every((r) => r.reason === 'prefix_too_short'), true);
  assert.ok(firstFixed.n <= 65, `first collapse at ${firstFixed.n} messages`);
  assert.ok(firstFixed.turns >= 50);
});

test('first cut: once made, the same pages are sent on every later request until the next chunk', async () => {
  const all = conversation({ lead: 2 });
  await withEnv({ PXLITE_KEEP_TAIL_TOKENS: '0' }, async () => {
    let ref;
    for (let n = 65; n <= 109; n += 2) {
      clearLastCuts(); // every request recomputed from scratch, as after a proxy restart
      const r = await collapse(requestAt(all, n));
      assert.ok(r.turns > 0, `collapsed at ${n}`);
      ref ??= r;
      assert.deepEqual(r.images, ref.images, `pages changed at ${n} messages`);
      assert.equal(r.turns, ref.turns);
    }
  });
});

test('first cut: a conversation that already cut cleanly is not moved by the walk-forward', async () => {
  const all = conversation({ lead: 1 });
  const at = async (env) => withEnv({ PXLITE_KEEP_TAIL_TOKENS: '0', ...env }, async () => (await collapse(requestAt(all, 75))));
  const now = await at({}), off = await at({ PXLITE_FIRST_CUT_EXTEND: '0' });
  assert.ok(now.turns >= 50);
  assert.deepEqual(now.images, off.images);
  assert.equal(now.info.firstCutExtended, undefined);
});

test('token floor: a checkpoint that would leave too little text is held back one chunk, then made', async () => {
  // rounds 46..62 are one-line results, so the 12 messages behind the 100-message grid point are light
  const all = conversation({ lead: 1, resultLines: (r) => (r >= 46 && r <= 62 ? 1 : 40) });
  await withEnv({ PXLITE_KEEP_TAIL_TOKENS: '6000' }, async () => {
    const rows = [];
    for (let n = 105; n <= 171; n += 2) {
      const msgs = requestAt(all, n);
      const r = await collapse(msgs);
      rows.push({ n: msgs.length, turns: r.turns, held: r.info.tailHeld === true, tailTok: verbatimTailTokens(msgs, 1 + r.turns), images: r.images });
    }
    table(rows.map((r) => `${String(r.n).padStart(4)} msgs | collapsed ${String(r.turns).padStart(3)} | verbatim tail ~${String(r.tailTok).padStart(6)} tok${r.held ? ' | held back' : ''}`));
    const held = rows.filter((r) => r.held);
    assert.ok(held.length >= 2, 'the light tail holds the checkpoint back');
    const adv = rows.find((r) => r.turns >= 90);
    assert.ok(adv, 'the checkpoint is made once the tail is heavy enough');
    assert.ok(adv.n > 113, `held past the plain grid point (made at ${adv.n} messages)`);
    for (let i = 1; i < rows.length; i++) {
      // one-way: turns never decrease
      assert.ok(rows[i].turns >= rows[i - 1].turns, `cut moved back at ${rows[i].n}`);
      // a held request sends exactly the pages of the previous cut (still a cache read)
      if (rows[i].held) assert.deepEqual(rows[i].images, rows[i - 1].images, `pages changed while held at ${rows[i].n}`);
      // every checkpoint that is made leaves at least the floor in text
      if (rows[i].turns > rows[i - 1].turns) assert.ok(rows[i].tailTok >= 6000, `tail after the checkpoint at ${rows[i].n} is ${rows[i].tailTok} tokens`);
    }
  });
  // CONTROL: without the floor the same conversation checkpoints into a tail under the floor.
  await withEnv({ PXLITE_KEEP_TAIL_TOKENS: '0' }, async () => {
    const msgs = requestAt(all, 113);
    const r = await collapse(msgs);
    assert.ok(r.turns >= 90, 'control: plain grid cut');
    assert.ok(verbatimTailTokens(msgs, 1 + r.turns) < 6000, 'control: the tail it leaves is under the floor');
  });
});

test('token floor: never holds back by more than one chunk, however light the conversation', async () => {
  const all = conversation({ lead: 1, rounds: 150, resultLines: () => 1 }); // every message is tiny
  await withEnv({ PXLITE_KEEP_TAIL_TOKENS: '6000' }, async () => {
    for (const n of [121, 171, 221, 271]) {
      const msgs = requestAt(all, n);
      const r = await collapse(msgs);
      assert.ok(r.turns > 0, `collapsed at ${n}`);
      assert.ok(msgs.length - (1 + r.turns) <= 12 + 2 * 50, `${msgs.length - 1 - r.turns} messages left verbatim at ${n}`);
    }
  });
});

test('token floor: the first collapse waits for a heavy enough tail, and a forced collapse ignores the floor', async () => {
  const light = conversation({ lead: 1, resultLines: () => 1 });
  await withEnv({ PXLITE_KEEP_TAIL_TOKENS: '6000' }, async () => {
    const r = await collapse(requestAt(light, 65));
    assert.equal(r.turns, 0);
    assert.equal(r.reason, 'tail_floor');
  });
  await withEnv({ PXLITE_KEEP_TAIL_TOKENS: '6000', PXLITE_FORCE_COLLAPSE_TOKENS: '1' }, async () => {
    const r = await collapse(requestAt(light, 65));
    assert.ok(r.turns > 0, 'over the context limit the floor does not apply');
  });
});

test('token floor: a tail that gets lighter after the checkpoint does not pull the cut back', async () => {
  const all = conversation({ lead: 1 });
  await withEnv({ PXLITE_KEEP_TAIL_TOKENS: '6000' }, async () => {
    const a = await collapse(requestAt(all, 131));
    assert.ok(a.turns >= 90, `checkpoint made with a heavy tail (${a.turns} turns)`);
    // the client clears old tool output in the tail (OpenCode prune): same messages, much less text
    const pruned = requestAt(all, 133);
    for (let i = 100; i < pruned.length; i++) for (const b of pruned[i].content) if (b.type === 'tool_result') b.content = '[Old tool result content cleared]';
    assert.ok(verbatimTailTokens(pruned, 100) < 6000);
    const b = await collapse(pruned);
    assert.equal(b.turns, a.turns);
    assert.deepEqual(b.images, a.images);
  });
});

test('one-way cut: leaving the tool chain does not move the cut back', async () => {
  // rounds, then the agent answers in plain text and the user replies twice without tools
  const base = requestAt(conversation({ lead: 1, rounds: 60 }), 113);
  const chat = [
    { role: 'assistant', content: [{ type: 'text', text: 'Done. The policy is fixed.' }] },
    { role: 'user', content: [{ type: 'text', text: 'thanks, what changed?' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Two thresholds.' }] },
    { role: 'user', content: [{ type: 'text', text: 'ok' }] },
  ];
  const run = async (env) => withEnv({ PXLITE_KEEP_TAIL_TOKENS: '0', ...env }, async () => {
    const inChain = await collapse(structuredClone(base));
    const afterChat = await collapse(structuredClone([...base, ...chat]));
    return { inChain, afterChat };
  });
  const off = await run({ PXLITE_STICKY_CUT: '0' });
  const now = await run({});
  table([`in chain: ${now.inChain.turns} turns | after plain chat: now ${now.afterChat.turns}, switch off ${off.afterChat.turns}`]);
  // CONTROL: the stricter out-of-chain boundary search lands before the cut the previous request used.
  assert.ok(off.afterChat.turns < off.inChain.turns, `control: ${off.inChain.turns} -> ${off.afterChat.turns}`);
  assert.ok(now.afterChat.turns >= now.inChain.turns);
  assert.deepEqual(now.afterChat.images.slice(0, now.inChain.images.length), now.inChain.images);
  assert.equal(now.afterChat.info.stickyCut, true);
});

test('one-way cut: a different, shorter conversation under the same key is not affected', async () => {
  await withEnv({ PXLITE_KEEP_TAIL_TOKENS: '0' }, async () => {
    const long = await collapse(requestAt(conversation({ lead: 1, rounds: 120 }), 215));
    assert.ok(long.turns >= 190);
    const other = conversation({ lead: 1, rounds: 60, resultLines: () => 25 });
    const withMemory = await collapse(requestAt(other, 75));
    clearLastCuts();
    const fresh = await collapse(requestAt(other, 75));
    assert.equal(withMemory.turns, fresh.turns);
    assert.deepEqual(withMemory.images, fresh.images);
  });
});

test('one-way cut: a later grid cell is still a real checkpoint', async () => {
  const full = conversation({ lead: 1, rounds: 120 });
  await withEnv({ PXLITE_KEEP_TAIL_TOKENS: '0' }, async () => {
    const a = await collapse(requestAt(full, 113));
    const b = await collapse(requestAt(full, 221));
    assert.ok(b.turns >= a.turns + 40, `${a.turns} -> ${b.turns}`);
    assert.notEqual(b.info.stickyCut, true);
  });
});

test('warm cache: a small forward move of the cut is held, a cold cache or a big move goes through', async () => {
  const all = conversation({ lead: 1, rounds: 200 });
  const t0 = 1_000_000;
  const run = (env, nowOf) => withEnv({ PXLITE_KEEP_TAIL_TOKENS: '0', PXLITE_CACHE_TTL: '1h', ...env }, async () => {
    const a = await collapse(requestAt(all, 113), { now: () => t0 });
    const b = await collapse(requestAt(all, 163), { now: () => nowOf });
    return { a, b };
  });
  // grid step is 50 messages; a minimum move above that holds the cut while the cache is warm
  const warm = await run({ PXLITE_MIN_CUT_MOVE: '1000' }, t0 + 60_000);
  assert.ok(warm.a.turns > 0);
  assert.equal(warm.b.turns, warm.a.turns, 'cut held');
  assert.deepEqual(warm.b.images, warm.a.images, 'same pages, so the same cache entry');
  assert.equal(warm.b.info.stickyCut, true);
  assert.ok(warm.b.info.cutMove.held > 0, 'the log says how far the cut would have moved');
  // the same step after the cache expired: the prefix is rewritten anyway, so the cut moves
  const cold = await run({ PXLITE_MIN_CUT_MOVE: '1000' }, t0 + 2 * 3600_000);
  assert.ok(cold.b.turns > cold.a.turns, 'cold cache moves');
  assert.equal(cold.b.info.cutMove.held, undefined);
  // default minimum is half a chunk: a 50-message step is a real checkpoint and goes through
  const dflt = await run({}, t0 + 60_000);
  assert.ok(dflt.b.turns > dflt.a.turns, 'a full grid step is not held');
  // switch: PXLITE_MIN_CUT_MOVE=0 never holds
  const off = await run({ PXLITE_MIN_CUT_MOVE: '0' }, t0 + 60_000);
  assert.ok(off.b.turns > off.a.turns);
});
