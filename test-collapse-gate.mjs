// Claude-path collapse gates: min messages (50), min shrink (25k tokens), and their env overrides.
import assert from 'node:assert/strict';
import test from 'node:test';
import { collapseHistory, estimateCollapseShrinkTokens } from './vendor/pxpipe-proxy/dist/core/history.js';
import { GATE_ENV_OFF, withEnv } from './lib-test-env.mjs';

const mk = (n, size) => {
  const m = [{ role: 'user', content: 'go' }];
  for (let i = 0; i < n; i++) {
    m.push(
      { role: 'assistant', content: [{ type: 'tool_use', id: 'u' + i, name: 'Bash', input: { command: 'ls' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u' + i, content: 'x'.repeat(size) }] },
    );
  }
  return m;
};
const run = (m, o = {}) => collapseHistory(m, () => true, { collapseChunk: 50, keepTail: 4, ...o });

test('below 50 messages: no collapse (old floor of 10 is gone)', () =>
  withEnv(GATE_ENV_OFF, async () => {
    const r = await run(mk(15, 5000));
    assert.equal(r.info.collapsedTurns, 0);
    assert.equal(r.info.reason, 'prefix_too_short');
  }));

test('many messages but little text: skipped as low_shrink', () =>
  withEnv(GATE_ENV_OFF, async () => {
    const r = await run(mk(60, 20));
    assert.equal(r.info.reason, 'low_shrink');
    assert.ok(r.info.estShrinkTokens < 25000, `estShrinkTokens=${r.info.estShrinkTokens}`);
  }));

test('many messages with big outputs: collapses', () =>
  withEnv(GATE_ENV_OFF, async () => {
    const r = await run(mk(60, 3000));
    assert.ok(r.info.collapsedTurns > 0, r.info.reason);
    assert.ok(r.info.estShrinkTokens >= 25000, `estShrinkTokens=${r.info.estShrinkTokens}`);
  }));

test('incremental: a large warm image prefix drops the same range under the gate', () => {
  const e0 = estimateCollapseShrinkTokens(mk(60, 3000), 0, 100, 100000, 0);
  const e1 = estimateCollapseShrinkTokens(mk(60, 3000), 0, 100, 100000, 14000);
  assert.ok(e1 < e0 * 0.2, `${e1} vs ${e0}`);
});

test('PXLITE_MIN_SHRINK_TOKENS=0 lets a low-shrink history collapse', () =>
  withEnv({ ...GATE_ENV_OFF, PXLITE_MIN_SHRINK_TOKENS: 0 }, async () => {
    const r = await run(mk(60, 20));
    assert.ok(r.info.collapsedTurns > 0, r.info.reason);
  }));

test('PXLITE_MIN_COLLAPSE_MESSAGES=11 lets a 31-message history collapse', () =>
  withEnv({ ...GATE_ENV_OFF, PXLITE_MIN_SHRINK_TOKENS: 0, PXLITE_MIN_COLLAPSE_MESSAGES: 11 }, async () => {
    const r = await run(mk(15, 5000));
    assert.ok(r.info.collapsedTurns > 0, r.info.reason);
  }));
