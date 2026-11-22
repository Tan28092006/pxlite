// Events-log diagnostics: the tool-collapse `report` and `history_tuning`. No API, pure logic.
// node --test test-event-diagnostics.mjs — needs vendor/ (built from overlay/).
import assert from 'node:assert/strict';
import test from 'node:test';
import { createToolCollapse } from './collapse-tools.mjs';
import { GATE_ENV_OFF, withEnv } from './lib-test-env.mjs';

// Host env must not skew results: gates cleared everywhere; the short test history also needs the profit gates at 0.
const GATES_ZERO = { ...GATE_ENV_OFF, PXLITE_MIN_SHRINK_TOKENS: 0, PXLITE_MIN_COLLAPSE_MESSAGES: 0 };
const core = new URL('./vendor/pxpipe-proxy/dist/core/', import.meta.url).href;
const { transformRequest } = await import(core + 'transform.js');
const { toTrackEvent } = await import(core + 'tracker.js');
const { markCacheDead, recordFreezeStep } = await import(core + 'session-state.js');

// ---- tool-collapse report ------------------------------------------------------------------

const big = (c, n = 3000) => `${c} head\n` + 'line of output\n'.repeat(n / 15) + 'done ok';
function convo(n) {
  const messages = [{ role: 'user', content: 'start' }];
  for (let i = 0; i < n; i++) {
    messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: 'ls' } }] });
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: big(`out${i}`) }] });
  }
  return { messages };
}
const clone = (o) => JSON.parse(JSON.stringify(o));
const collapsedIn = (b) => b.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((x) => x.type === 'tool_result' && String(x.content).includes('pxlite: older output collapsed')).length;

test('report without a session key: has_key false, nothing collapsed, body untouched', () => {
  const tc = createToolCollapse({ keepTail: 20 });
  const b = convo(60);
  const before = JSON.stringify(b);
  const report = {};
  assert.equal(tc.apply(b, { sessionKey: null, report }), 0);
  assert.deepEqual(report, { has_key: false, n: 121, boundary: 0, collapsed: 0 });
  assert.equal(JSON.stringify(b), before);
});

test('report on first sight: boundary = n - keepTail, collapsed matches the body and the return value', () => {
  const tc = createToolCollapse({ keepTail: 20 });
  const b = convo(60);
  const report = {};
  const ret = tc.apply(b, { sessionKey: 's', report });
  assert.equal(report.has_key, true);
  assert.equal(report.n, 121);
  assert.equal(report.boundary, 101);
  assert.ok(report.collapsed > 0);
  assert.equal(report.collapsed, ret);
  assert.equal(report.collapsed, collapsedIn(b));
});

test('report between chunks keeps the old boundary; a paying chunk moves it by whole steps', () => {
  let t = 0;
  const tc = createToolCollapse({ keepTail: 20, chunk: 50, minGainChars: 1000, now: () => t });
  const full = convo(200);
  const first = {};
  tc.apply(clone({ messages: full.messages.slice(0, 80) }), { sessionKey: 's', report: first });
  assert.equal(first.boundary, 60); // 80 - 20
  t += 10_000;
  const small = {};
  tc.apply(clone({ messages: full.messages.slice(0, 100) }), { sessionKey: 's', report: small });
  assert.equal(small.n, 100);
  assert.equal(small.boundary, 60); // target 80 is only 20 past the checkpoint, below one chunk
  t += 10_000;
  const jump = {};
  tc.apply(clone({ messages: full.messages.slice(0, 200) }), { sessionKey: 's', report: jump });
  assert.equal(jump.boundary, 160); // target 180: 60 + 2 * 50
  assert.ok(jump.collapsed > small.collapsed);
});

test('report when the gain is too small: boundary does not move and says so', () => {
  let t = 0;
  const tc = createToolCollapse({ keepTail: 20, chunk: 50, minGainChars: 10_000_000, now: () => t });
  const full = convo(200);
  tc.apply(clone({ messages: full.messages.slice(0, 80) }), { sessionKey: 's' });
  t += 10_000;
  const report = {};
  tc.apply(clone({ messages: full.messages.slice(0, 300) }), { sessionKey: 's', report });
  assert.equal(report.n, 300);
  assert.equal(report.boundary, 60);
});

test('report reads the Responses `input` array as well as `messages`; a body with neither reports n 0', () => {
  const tc = createToolCollapse({ keepTail: 4 });
  const input = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));
  const r1 = {};
  tc.apply({ input }, { sessionKey: 'r', report: r1 });
  assert.deepEqual(r1, { has_key: true, n: 10, boundary: 6, collapsed: 0 });
  const r2 = {};
  assert.equal(tc.apply({ model: 'x' }, { sessionKey: 'r', report: r2 }), 0);
  assert.deepEqual(r2, { has_key: true, n: 0, boundary: 0, collapsed: 0 });
});

test('apply without a report still works (callers that do not log)', () => {
  const tc = createToolCollapse({ keepTail: 20 });
  assert.ok(tc.apply(convo(60), { sessionKey: 'n' }) > 0);
});

// ---- tracker mapping ------------------------------------------------------------------------

const ev = (info) => ({ method: 'POST', path: '/v1/messages', status: 200, durationMs: 1, info });

test('toTrackEvent writes history_tuning in snake_case, only when the history path ran', () => {
  const out = toTrackEvent(ev({ historyTuning: { cold: true, imageBudget: 3, minFreezeStep: 12 } }));
  assert.deepEqual(out.history_tuning, { cold: true, image_budget: 3, min_freeze_step: 12 });
  assert.ok(!('history_tuning' in toTrackEvent(ev({}))));
});
test('reasoning output usage is preserved as a subset, and absence is not reported as zero', () => {
  const out = toTrackEvent({ ...ev({}), usage: { input_tokens: 1000, output_tokens: 300, reasoning_output_tokens: 250 } });
  assert.equal(out.reasoning_output_tokens, 250);
  assert.equal(out.output_tokens, 300);
  assert.ok(!('reasoning_output_tokens' in toTrackEvent({ ...ev({}), usage: { output_tokens: 300 } })));
});

// ---- end to end through transformRequest ------------------------------------------------------

const line = (i, j) => `Turn ${i} line ${j}: the build log shows step ${i * 7 + j} finished; next we compare cache reads against writes for request ${i}.`;
const text = (i, n) => Array.from({ length: n }, (_, j) => line(i, j)).join('\n');
const H1 = { type: 'ephemeral', ttl: '1h' };

/** `tag` makes the first user message unique, so each test gets its own session in the in-memory store. */
function claudeBody(turns, tag) {
  const messages = [];
  for (let i = 0; i < turns; i++) {
    messages.push({ role: 'user', content: [{ type: 'text', text: (i === 0 ? `${tag} ` : '') + text(i, 12) }] });
    messages.push({ role: 'assistant', content: [{ type: 'text', text: text(i + 1000, 12) }] });
  }
  messages.push({ role: 'user', content: [{ type: 'text', text: 'current question', cache_control: { ...H1 } }] });
  return {
    model: 'claude-opus-5-5',
    max_tokens: 100,
    system: [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }, { type: 'text', text: text(9999, 300), cache_control: { ...H1 } }],
    messages,
  };
}
const run = async (body) => (await transformRequest(new TextEncoder().encode(JSON.stringify(body)), { model: 'claude-opus-5-5' })).info;

test('history_tuning follows the session: new session warm, markCacheDead makes the next request cold, a pinned floor shows up', () => withEnv(GATES_ZERO, async () => {
  const body = claudeBody(30, 'diag-session-A');

  const first = await run(body);
  assert.equal(first.historyReason, 'collapsed');
  const sha = first.firstUserSha8;
  assert.ok(sha, 'session identity is needed for the store');
  assert.equal(first.historyTuning.cold, false, 'a session never seen counts as warm');
  assert.equal(first.historyTuning.minFreezeStep, 0, 'nothing pinned yet');
  assert.ok(Number.isInteger(first.historyTuning.imageBudget) && first.historyTuning.imageBudget >= 1);
  assert.ok(first.collapsedImages <= first.historyTuning.imageBudget, 'budget is a ceiling on history pages');
  assert.deepEqual(toTrackEvent(ev(first)).history_tuning, {
    cold: false,
    image_budget: first.historyTuning.imageBudget,
    min_freeze_step: 0,
  });

  markCacheDead(sha);
  const cold = await run(body);
  assert.equal(cold.historyTuning.cold, true);
  assert.equal(cold.historyPackFill, true, 'cold is the same flag as packFill');
  assert.equal(toTrackEvent(ev(cold)).history_tuning.cold, true);

  const warmAgain = await run(body);
  assert.equal(warmAgain.historyTuning.cold, false, 'the dead-cache mark is consumed by one request');

  recordFreezeStep(sha, 777);
  const pinned = await run(body);
  assert.ok(pinned.historyTuning.minFreezeStep >= 777);
  assert.ok(toTrackEvent(ev(pinned)).history_tuning.min_freeze_step >= 777);
}));
