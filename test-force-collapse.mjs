// Overflow override: context >= PXLITE_FORCE_COLLAPSE_TOKENS (180k) collapses even when
// the normal gates (min messages, min shrink, profitability) would refuse.
import assert from 'node:assert/strict';
import test from 'node:test';
import { collapseHistory } from './vendor/pxpipe-proxy/dist/core/history.js';
import { GATE_ENV_OFF, withEnv } from './lib-test-env.mjs';

const mk = (turns, chars) => {
  const m = [];
  for (let i = 0; i < turns; i++) {
    m.push({ role: 'user', content: [{ type: 'text', text: `q${i} ` + 'lorem ipsum dolor '.repeat(Math.ceil(chars / 18)) }] });
    m.push({ role: 'assistant', content: [{ type: 'text', text: `a${i} ` + 'sit amet consectetur '.repeat(Math.ceil(chars / 20)) }] });
  }
  return m;
};
const run = (m, profitable = () => true, o = {}) => collapseHistory(m, profitable, { collapseChunk: 0, keepTail: 4, ...o });
const big = mk(20, 22000); // 40 msgs (< 50) but ~900k chars (~300k tokens)

test('small, short history: normal gates refuse', () =>
  withEnv(GATE_ENV_OFF, async () => {
    const small = await run(mk(8, 400));
    assert.ok(!(small.info.collapsedTurns > 0), 'small history must not collapse');
  }));

test('over 180k tokens with < 50 messages: forced collapse', () =>
  withEnv(GATE_ENV_OFF, async () => {
    const forced = await run(big);
    assert.ok(forced.info.collapsedTurns > 0, 'over 180k tokens must collapse: ' + forced.info.reason);
    assert.equal(forced.info.forced, true);
  }));

test('PXLITE_FORCE_COLLAPSE_TOKENS=0 disables force: 50-message gate applies', () =>
  withEnv({ ...GATE_ENV_OFF, PXLITE_FORCE_COLLAPSE_TOKENS: 0 }, async () => {
    const off = await run(big);
    assert.ok(!(off.info.collapsedTurns > 0), 'force=0 restores normal gates: ' + off.info.reason);
  }));

test('forced mode ignores the profitability callback', () =>
  withEnv(GATE_ENV_OFF, async () => {
    const unprof = await run(big, () => false);
    assert.ok(unprof.info.collapsedTurns > 0, 'forced ignores not_profitable');
  }));
