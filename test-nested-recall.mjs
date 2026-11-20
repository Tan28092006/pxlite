// Nested recall proof: no API, no vendor build. Fake renderer captures the transcript that would become images.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSessionRecall, nestedRecallQueries } from './recall-session.mjs';
import { openCodeTurns, nestedRecallQueries as ocQueries, createOpenCodeSessionRecall } from './recall-opencode-session.mjs';

const line = (o) => JSON.stringify(o) + '\n';
const user = (t) => line({ type: 'user', message: { role: 'user', content: t } });
const asst = (t) => line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: t }] } });
// Bulk the transcript drops (tool output) – this is what makes recall cheap.
const bulk = (id) => line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'LOG '.repeat(3000) }] } });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nested-'));
  const proj = path.join(root, 'proj');
  fs.mkdirSync(proj);
  const write = (id, body, age) => {
    const f = path.join(proj, `${id}.jsonl`);
    fs.writeFileSync(f, body);
    const t = new Date(Date.now() - age * 1000);
    fs.utimesSync(f, t, t);
    return f;
  };
  const prompts = (tag) => [1, 2, 3].map((i) => user(`${tag} question ${i}`) + asst(`${tag} answer ${i}`) + bulk(`${tag}${i}`)).join('');
  write('aaaaaaaa-0000', prompts('ALPHA') + asst('ALPHA-FINAL-DECISION use sqlite'), 300);
  write('bbbbbbbb-0000', user('recall aaaaaaaa') + asst('loaded alpha') + prompts('BETA') + asst('BETA-FINAL-DECISION ship friday'), 200);
  write('cccccccc-0000', prompts('GAMMA'), 100);
  write('dddddddd-0000', user('recall cccccccc') + asst('x') + prompts('DELTA'), 150);
  write('current0-0000', user('hi'), 1);
  return { root, proj };
}

const body = (sid, text) => ({
  model: 'claude-x',
  metadata: { user_id: JSON.stringify({ session_id: sid }) },
  messages: [{ role: 'user', content: [{ type: 'text', text }] }],
});

test('nestedRecallQueries only reads typed user recall lines', () => {
  const buf = user('recall aaaa') + asst('recall bbbb') + user('please recall cccc now') + user('recall') + user('x\nrecall dddd\ny');
  assert.deepEqual(nestedRecallQueries(buf), ['aaaa', 'dddd']);
  assert.deepEqual(ocQueries([{ type: 'user', text: 'recall ses_A' }, { type: 'assistant', content: [] }, { type: 'user', text: 'recall' }]), ['ses_A']);
});

test('Claude: recalling B also brings A (nested), compactly, with no API call', async () => {
  const { root, proj } = fixture();
  let transcript = '';
  let renders = 0;
  const r = createSessionRecall({
    root, pinFile: path.join(root, 'pins.json'), maxChars: 200_000,
    render: async (t) => { renders++; transcript = t; return [{ png: Buffer.from('png') }]; },
  });
  const out = await r.apply(body('current0-0000', 'recall bbbbbbbb'));
  assert.ok(out, 'recall injected');
  assert.equal(renders, 1, 'one render pass for the whole chain');
  for (const needle of ['BETA question 1', 'BETA-FINAL-DECISION', 'ALPHA question 3', 'ALPHA-FINAL-DECISION', '<recalled-session id="aaaaaaaa-0000"']) {
    assert.ok(transcript.includes(needle), `missing ${needle}`);
  }
  assert.ok(transcript.indexOf('ALPHA-FINAL-DECISION') < transcript.indexOf('BETA-FINAL-DECISION'), 'older session first');
  assert.ok(!transcript.includes('LOG LOG'), 'tool output is not carried');
  const raw = ['aaaaaaaa-0000', 'bbbbbbbb-0000'].reduce((n, id) => n + fs.statSync(path.join(proj, `${id}.jsonl`)).size, 0);
  console.log(`  [claude] raw jsonl of A+B: ${raw} chars -> recall transcript: ${transcript.length} chars (${(100 * transcript.length / raw).toFixed(1)}%)`);
  assert.ok(transcript.length < raw / 5, 'transcript is far smaller than raw logs');
});

test('Claude: unrelated recall (C, no nested) does not drag in other sessions; cycles are safe', async () => {
  const { root, proj } = fixture();
  let transcript = '';
  const r = createSessionRecall({ root, pinFile: path.join(root, 'pins.json'), render: async (t) => { transcript = t; return [{ png: Buffer.from('p') }]; } });
  await r.apply(body('current0-0000', 'recall cccccccc'));
  assert.ok(transcript.includes('GAMMA question 1') && !transcript.includes('ALPHA') && !transcript.includes('recalled-session'));
  // A recalls B and B recalls A.
  fs.appendFileSync(path.join(proj, 'aaaaaaaa-0000.jsonl'), user('recall bbbbbbbb'));
  const r2 = createSessionRecall({ root, pinFile: path.join(root, 'pins2.json'), render: async (t) => { transcript = t; return [{ png: Buffer.from('p') }]; } });
  await r2.apply(body('current0-0000', 'recall bbbbbbbb'));
  assert.equal(transcript.split('<recalled-session id="aaaaaaaa-0000"').length - 1, 1, 'A included once, no loop');
});

test('Claude: nested budget is capped so the main session keeps its share', async () => {
  const { root } = fixture();
  let transcript = '';
  const r = createSessionRecall({ root, pinFile: path.join(root, 'pins.json'), maxChars: 2000, render: async (t) => { transcript = t; return [{ png: Buffer.from('p') }]; } });
  await r.apply(body('current0-0000', 'recall bbbbbbbb'));
  assert.ok(transcript.length <= 2200, `bounded (${transcript.length})`);
  assert.ok(transcript.includes('BETA-FINAL-DECISION'), 'most recent turns of the main session survive');
});

test('OpenCode: recalling B also brings A, SendMessage kept in transcript', async () => {
  const S = (id, title, t) => ({ id, title, location: { directory: 'D:/x' }, time: { updated: t } });
  const sessions = [S('ses_C', 'c', 3), S('ses_B', 'bbb', 2), S('ses_A', 'aaa', 1)];
  const msgs = {
    ses_B: [
      { type: 'user', text: 'recall ses_A' },
      { type: 'assistant', content: [{ type: 'text', text: 'BETA-FINAL-DECISION' }, { type: 'tool', name: 'SendMessage', state: { input: { to: 'agent1', summary: 'fix', message: 'rewrite the report' } } }] },
    ],
    ses_A: [{ type: 'user', text: 'ALPHA question' }, { type: 'assistant', content: [{ type: 'text', text: 'ALPHA-FINAL-DECISION' }] }],
  };
  let transcript = '';
  const r = createOpenCodeSessionRecall({
    pinDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ocpin-')), list: async () => sessions, messages: async (id) => msgs[id],
    render: async (t) => { transcript = t; return [{ png: Buffer.from('p') }]; },
  });
  const out = await r.apply({ model: 'm', prompt_cache_key: 'ses_C', input: [{ role: 'user', content: 'recall ses_B' }] });
  assert.ok(out);
  for (const n of ['ALPHA-FINAL-DECISION', 'BETA-FINAL-DECISION', '[SendMessage to agent1: fix] rewrite the report', '<recalled-session id="ses_A"']) assert.ok(transcript.includes(n), n);
  assert.ok(openCodeTurns(msgs.ses_B).length);
});
