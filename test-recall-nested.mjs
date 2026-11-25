// Recalling a session must carry what that session had itself recalled (A <- B <- C <- D),
// through the module the proxy actually runs (recall-sessions.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RECALL_INFO, createRecallSessions } from './recall-sessions.mjs';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const turn = (id, n, extra = '') => `<user t="${n}">${id} fact-${n} ${extra}</user>`;

/**
 * A directory of sessions. `sessions[id] = { turns, queries }`; `sid` is the session typing
 * the command. The same pin directory is shared across calls, like the real proxy.
 */
function world(sessions, o = {}) {
  const pinDir = o.pinDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'pxlite-nested-'));
  const loaded = [];
  const make = (sid, extra = {}) =>
    createRecallSessions({
      pinDir,
      maxChars: o.maxChars ?? 200_000,
      context: async () => ({ client: 'opencode', sid, dir: 'D:\\X' }),
      list: async () =>
        Object.entries(sessions)
          .filter(([id]) => id !== sid)
          .map(([id, s], i) => ({ source: 'opencode', id, title: s.title ?? id, when: s.when ?? 100 - i })),
      load: async (c) => {
        loaded.push(c.id);
        const s = sessions[c.id];
        if (!s) throw new Error(`no session ${c.id}`);
        if (s.broken) throw new Error('unreadable');
        return { turns: s.turns, queries: s.queries ?? [] };
      },
      // One page per 1000 chars. The last page is the text itself (the image cap keeps the
      // last pages), so a test can read exactly what was sent.
      render: async (text) => {
        const n = Math.max(1, Math.ceil(text.length / 1000));
        return Array.from({ length: n }, (_, i) => ({ png: Buffer.from(i === n - 1 ? text : 'p') }));
      },
      maxImages: 1000,
      ...extra,
    });
  const say = async (sid, command, extra) => {
    const r = make(sid, extra);
    const body = { model: 'gpt-6.1-terra', prompt_cache_key: sid, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: command }] }] };
    const out = await r.apply(body, new Headers());
    const images = (out?.input[0].content ?? []).filter((p) => p.type === 'input_image');
    const text = images.length ? Buffer.from(images.at(-1).image_url.split(',')[1], 'base64').toString('utf8') : null;
    return { out, text, note: out?.input[0].content[0].text, info: out?.[RECALL_INFO] };
  };
  return { pinDir, loaded, say };
}

const pinOf = (pinDir, sid, query) => JSON.parse(fs.readFileSync(path.join(pinDir, `${sha(`${sid}\0${query}`)}.json`), 'utf8'));

test('three recalls in a row: D gets C, and through it B and A, oldest first', async () => {
  const sessions = {
    ses_a: { title: 'alpha', turns: [turn('A', 0, 'port=4711')] },
    ses_b: { title: 'beta', turns: [turn('B', 0, 'recall alpha'), turn('B', 1, 'hash=9f3c')] },
    ses_c: { title: 'gamma', turns: [turn('C', 0, 'recall beta'), turn('C', 1, 'path=D:/x/y.mjs')] },
  };
  const w = world(sessions);
  // The user really does it in order: B recalls A, C recalls B, D recalls C.
  const b = await w.say('ses_b', 'recall alpha');
  assert.equal(b.info.status, 'injected');
  assert.deepEqual(b.info.nested, []);
  const c = await w.say('ses_c', 'recall beta');
  assert.deepEqual(c.info.nested.map((n) => [n.id, n.depth]), [['ses_a', 1]]);
  const d = await w.say('ses_d', 'recall gamma');

  // Every level's exact values reach D.
  for (const fact of ['port=4711', 'hash=9f3c', 'path=D:/x/y.mjs']) assert.ok(d.text.includes(fact), `missing ${fact}`);
  // Older context first: A inside B, B before C's own turns.
  const at = (s) => d.text.indexOf(s);
  assert.ok(at('port=4711') < at('hash=9f3c') && at('hash=9f3c') < at('path=D:/x/y.mjs'));
  assert.match(d.text, /<recalled-session id="ses_b" title="beta" via="recall beta">/);
  assert.match(d.text, /<recalled-session id="ses_a" title="alpha" via="recall alpha">/);
  assert.equal((d.text.match(/<recalled-session /g) ?? []).length, (d.text.match(/<\/recalled-session>/g) ?? []).length);
  assert.match(d.note, /had itself loaded 2 earlier session\(s\)/);
  // The event row says so, with ids and sizes only.
  assert.deepEqual(d.info.nested.map((n) => [n.id, n.depth]), [['ses_b', 1], ['ses_a', 2]]);
  assert.equal(d.info.source, 'opencode');
  assert.equal(d.info.turns_cut, 0);
  assert.equal(d.info.pages_cut, 0);
  assert.equal(d.info.chars, d.text.length);
  assert.ok(!JSON.stringify(d.info).includes('port=4711'), 'event info must not carry transcript text');
  // Not JSON-visible: the upstream request must not change.
  assert.ok(!JSON.stringify(d.out).includes('"nested"'));
});

test('a fourth level is not followed (depth 2), and the note does not claim it', async () => {
  const sessions = {
    ses_z: { title: 'zero', turns: [turn('Z', 0, 'deepest=1')] },
    ses_a: { title: 'alpha', turns: [turn('A', 0, 'a=1')], queries: ['zero'] },
    ses_b: { title: 'beta', turns: [turn('B', 0, 'b=1')], queries: ['alpha'] },
    ses_c: { title: 'gamma', turns: [turn('C', 0, 'c=1')], queries: ['beta'] },
  };
  const d = await world(sessions).say('ses_d', 'recall gamma');
  assert.ok(d.text.includes('a=1') && d.text.includes('b=1') && d.text.includes('c=1'));
  assert.ok(!d.text.includes('deepest=1'));
  assert.deepEqual(d.info.nested.map((n) => n.id), ['ses_b', 'ses_a']);
});

test('the owner index names the exact session even when the query now matches a newer one', async () => {
  const sessions = {
    ses_old: { title: 'vault plan', when: 10, turns: [turn('OLD', 0, 'old=yes')] },
    ses_b: { title: 'beta', when: 50, turns: [turn('B', 0, 'b=1')] },
  };
  const w = world(sessions);
  await w.say('ses_b', 'recall vault');
  // A newer session with a matching title appears afterwards; B never saw it.
  sessions.ses_new = { title: 'vault redo', when: 99, turns: [turn('NEW', 0, 'new=yes')] };
  const d = await w.say('ses_d', 'recall beta');
  assert.ok(d.text.includes('old=yes'));
  assert.ok(!d.text.includes('new=yes'));
});

test('the index still works after the pin itself was pruned', async () => {
  const sessions = {
    ses_a: { title: 'alpha', turns: [turn('A', 0, 'a=1')] },
    ses_b: { title: 'beta', turns: [turn('B', 0, 'b=1')] },
  };
  const w = world(sessions);
  await w.say('ses_b', 'recall'); // bare: nothing in the transcript names A
  fs.unlinkSync(path.join(w.pinDir, `${sha('ses_b\0')}.json`));
  const d = await w.say('ses_d', 'recall beta');
  assert.ok(d.text.includes('a=1'));
  assert.deepEqual(d.info.nested.map((n) => n.id), ['ses_a']);
});

test('a session from before the index: typed query, and the pin for a bare recall', async () => {
  const sessions = {
    ses_a: { title: 'alpha', turns: [turn('A', 0, 'a=1')] },
    ses_e: { title: 'epsilon', turns: [turn('E', 0, 'e=1')] },
    ses_b: { title: 'beta', turns: [turn('B', 0, 'b=1')], queries: ['alpha'] },
  };
  const w = world(sessions);
  // Legacy pin for a bare recall typed in B: only the pin knows it was E.
  fs.writeFileSync(path.join(w.pinDir, `${sha('ses_b\0')}.json`), JSON.stringify({ source: 'opencode', id: 'ses_e', title: 'epsilon', when: 1, text: 'x' }));
  const d = await w.say('ses_d', 'recall beta');
  assert.ok(d.text.includes('a=1') && d.text.includes('e=1') && d.text.includes('b=1'));
  assert.deepEqual(d.info.nested.map((n) => n.id).sort(), ['ses_a', 'ses_e']);
});

test('a long session cannot push out what it had recalled, and the cut is reported', async () => {
  const big = Array.from({ length: 400 }, (_, i) => turn('C', i, 'x'.repeat(480)));
  const sessions = {
    ses_a: { title: 'alpha', turns: [turn('A', 0, 'root-cause=cache_key')] },
    ses_b: { title: 'beta', turns: [turn('B', 0, 'decision=keep-horizon-36')], queries: ['alpha'] },
    ses_c: { title: 'gamma', turns: big, queries: ['beta'] },
  };
  const d = await world(sessions, { maxChars: 40_000 }).say('ses_d', 'recall gamma');
  assert.ok(d.text.length <= 40_000 + 200, `budget exceeded: ${d.text.length}`);
  assert.ok(d.text.includes('root-cause=cache_key') && d.text.includes('decision=keep-horizon-36'));
  // C's newest turn is there, its oldest is not, and the row says how many were dropped.
  assert.ok(d.text.includes('C fact-399 '));
  assert.ok(!d.text.includes('C fact-0 '));
  assert.ok(d.info.turns_cut > 0);
  assert.match(d.text, new RegExp(`\\[\u2026 ${d.info.turns_cut} earlier turn\\(s\\) not shown \u2026\\]`));
});

test('a long nested session is trimmed to its share and keeps its newest turns', async () => {
  const bigB = Array.from({ length: 300 }, (_, i) => turn('B', i, 'y'.repeat(480)));
  const sessions = {
    ses_b: { title: 'beta', turns: bigB },
    ses_c: { title: 'gamma', turns: [turn('C', 0, 'c=1')], queries: ['beta'] },
  };
  const d = await world(sessions, { maxChars: 40_000 }).say('ses_d', 'recall gamma');
  const inner = /<recalled-session id="ses_b"[^>]*>\n([\s\S]*?)\n<\/recalled-session>/.exec(d.text)[1];
  assert.ok(inner.length <= 10_000 + 100, `nested share exceeded: ${inner.length}`); // a quarter of 40k
  assert.ok(inner.includes('B fact-299 '));
  assert.ok(d.text.includes('c=1'));
  assert.equal(d.info.turns_cut, 0); // C itself is whole
  assert.ok(d.info.nested[0].turns_cut > 0); // B is not, and the row says it
});

test('a compaction summary stays first, ahead of the nested sessions', async () => {
  const sessions = {
    ses_a: { title: 'alpha', turns: [turn('A', 0, 'a=1')] },
    ses_c: { title: 'gamma', turns: ['<earlier-summary>goal: ship v2</earlier-summary>', turn('C', 5, 'c=5')], queries: ['alpha'] },
  };
  const d = await world(sessions).say('ses_d', 'recall gamma');
  assert.ok(d.text.startsWith('<earlier-summary>goal: ship v2</earlier-summary>'));
  assert.ok(d.text.indexOf('a=1') < d.text.indexOf('c=5'));
});

test('cycles and self references end, and nothing is attached twice', async () => {
  const sessions = {
    ses_a: { title: 'alpha', turns: [turn('A', 0, 'a=1')], queries: ['beta', 'alpha'] },
    ses_b: { title: 'beta', turns: [turn('B', 0, 'b=1')], queries: ['alpha', 'alpha', 'delta'] },
  };
  // D is also what B "recalled": the current session must never be attached to itself.
  sessions.ses_d = { title: 'delta', turns: [turn('D', 0, 'd=1')] };
  const d = await world(sessions).say('ses_d', 'recall beta');
  assert.equal((d.text.match(/a=1/g) ?? []).length, 1);
  assert.equal((d.text.match(/b=1/g) ?? []).length, 1);
  assert.ok(!d.text.includes('d=1'));
});

test('an unreadable nested session is skipped, the recall itself still works', async () => {
  const sessions = {
    ses_a: { title: 'alpha', broken: true, turns: [] },
    ses_b: { title: 'beta', turns: [turn('B', 0, 'b=1')], queries: ['alpha', 'no such session'] },
  };
  const w = world(sessions);
  const warn = console.warn;
  console.warn = () => {};
  let d;
  try {
    d = await w.say('ses_d', 'recall beta');
  } finally {
    console.warn = warn;
  }
  assert.equal(d.info.status, 'injected');
  assert.ok(d.text.includes('b=1'));
  assert.deepEqual(d.info.nested, []);
  assert.doesNotMatch(d.note, /had itself loaded/);
});

test('the pin fixes the nested content: a later request sends the same bytes', async () => {
  const sessions = {
    ses_a: { title: 'alpha', turns: [turn('A', 0, 'a=1')] },
    ses_b: { title: 'beta', turns: [turn('B', 0, 'b=1')], queries: ['alpha'] },
  };
  const w = world(sessions);
  const first = await w.say('ses_d', 'recall beta');
  sessions.ses_a.turns.push(turn('A', 1, 'a=changed'));
  sessions.ses_b.turns.push(turn('B', 1, 'b=changed'));
  const second = await w.say('ses_d', 'recall beta'); // a new proxy process, same pin directory
  assert.equal(JSON.stringify(second.out), JSON.stringify(first.out)); // cache prefix intact
  assert.deepEqual(second.info, first.info);
  assert.deepEqual(pinOf(w.pinDir, 'ses_d', 'beta').nested.map((n) => n.id), ['ses_a']);
});

test('the image cap is reported when it drops leading pages', async () => {
  const sessions = { ses_a: { title: 'alpha', turns: Array.from({ length: 30 }, (_, i) => turn('A', i, 'z'.repeat(480))) } };
  const d = await world(sessions).say('ses_d', 'recall alpha', { maxImages: 5 });
  assert.equal(d.info.pages, 5);
  assert.ok(d.info.pages_cut > 0);
});

test('a miss is reported as such', async () => {
  const d = await world({ ses_a: { title: 'alpha', turns: [turn('A', 0)] } }).say('ses_d', 'recall nothing-like-this');
  assert.equal(d.info.status, 'no_match');
});
