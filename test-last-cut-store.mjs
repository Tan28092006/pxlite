// node --test test-last-cut-store.mjs
// The one-way cut survives a proxy restart: after a restart the cut must not move backwards
// (a cut that moves back re-keys every cached block after it).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const H = await import(pathToFileURL(path.join(ROOT, 'vendor/pxpipe-proxy/dist/core/history.js')).href);
const { collapseHistory, clearLastCuts, configureLastCutStore, flushLastCuts } = H;

const filler = (n, tag) => Array.from({ length: n }, (_, i) => `line ${i} of ${tag}: the proxy checks the cache prefix`).join('\n');
function conversation(rounds = 120) {
  const m = [{ role: 'user', content: [{ type: 'text', text: 'Audit the cache policy and fix what is wrong.' }] }];
  for (let r = 0; r < rounds; r++) {
    const id = 'toolu_' + String(r).padStart(4, '0');
    m.push({ role: 'assistant', content: [{ type: 'text', text: `Step ${r}: checking the next file.` }, { type: 'tool_use', id, name: 'Read', input: { file_path: `/repo/src/file${r}.js` } }] });
    m.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: filler(40, 'file' + r) }] });
  }
  return m;
}
const requestAt = (all, n) => { let k = Math.min(n, all.length); while (k > 1 && all[k - 1].role !== 'user') k--; return structuredClone(all.slice(0, k)); };
const collapse = (messages, stickyKey = 'conv-1') => collapseHistory(messages, () => true, { protectedPrefix: 1, cols: 100, stickyKey }).then((r) => r.info.collapsedTurns ?? 0);
const memoryStore = (text) => ({ text, load() { return this.text; }, save(t) { this.text = t; } });
// the client prunes old tool output in the tail: same messages, much less text
const pruned = (all) => { const p = requestAt(all, 133); for (let i = 100; i < p.length; i++) for (const b of p[i].content) if (b.type === 'tool_result') b.content = '[Old tool result content cleared]'; return p; };

async function withFloor(fn) {
  const saved = { f: process.env.PXLITE_KEEP_TAIL_TOKENS, s: process.env.PXLITE_MIN_SHRINK_TOKENS };
  process.env.PXLITE_KEEP_TAIL_TOKENS = '6000'; process.env.PXLITE_MIN_SHRINK_TOKENS = '0';
  clearLastCuts();
  try { return await fn(); }
  finally { configureLastCutStore(undefined); clearLastCuts(); for (const [k, v] of [['PXLITE_KEEP_TAIL_TOKENS', saved.f], ['PXLITE_MIN_SHRINK_TOKENS', saved.s]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

test('a restart does not pull the cut back: the cut is restored from the store', async () => {
  const all = conversation();
  await withFloor(async () => {
    const store = memoryStore(undefined);
    assert.equal(configureLastCutStore(store), 0);
    const before = await collapse(requestAt(all, 131));
    assert.ok(before >= 90, `checkpoint made with a heavy tail (${before} turns)`);
    flushLastCuts();
    const saved = store.text;
    assert.ok(saved && JSON.parse(saved).cuts.length === 1);
    configureLastCutStore(undefined);

    // CONTROL: restart without the store. The token floor now holds the cut back one chunk.
    clearLastCuts();
    const lost = await collapse(pruned(all));
    assert.ok(lost < before, `control: without the store the cut moves back ${before} -> ${lost}`);

    clearLastCuts();
    assert.equal(configureLastCutStore(memoryStore(saved)), 1);
    const kept = await collapse(pruned(all));
    assert.equal(kept, before);
  });
});

test('entries idle for more than a day are not restored, and an unreadable store is ignored', async () => {
  const all = conversation();
  await withFloor(async () => {
    const store = memoryStore(undefined);
    configureLastCutStore(store);
    await collapse(requestAt(all, 131));
    flushLastCuts();
    const saved = store.text;
    configureLastCutStore(undefined);
    clearLastCuts();
    assert.equal(configureLastCutStore(memoryStore(saved), Date.now() + 25 * 3_600_000), 0);
    configureLastCutStore(undefined);
    for (const bad of ['{not json', '{"format":2,"cuts":[]}', '{"format":1,"cuts":[{"key":"k","len":"x","cut":1,"at":1}]}', '']) {
      assert.equal(configureLastCutStore(memoryStore(bad)), 0, `ignored: ${bad.slice(0, 20)}`);
      configureLastCutStore(undefined);
    }
  });
});

test('each conversation key keeps its own restored cut', async () => {
  const all = conversation();
  await withFloor(async () => {
    const store = memoryStore(undefined);
    configureLastCutStore(store);
    const a = await collapse(requestAt(all, 131), 'thread-a');
    flushLastCuts();
    configureLastCutStore(undefined);
    clearLastCuts();
    configureLastCutStore(memoryStore(store.text));
    assert.equal(await collapse(pruned(all), 'thread-a'), a);
    const other = await collapse(pruned(all), 'thread-b');
    assert.ok(other < a, `a thread that was never cut is not given thread-a's cut (${other} vs ${a})`);
  });
});
