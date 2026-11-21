// Overflow override: context >= PXLITE_FORCE_COLLAPSE_TOKENS (250k) collapses even when
// the normal gates (min messages, min shrink, profitability) would refuse.
import assert from 'node:assert/strict';
import { collapseHistory } from './vendor/pxpipe-proxy/dist/core/history.js';

const mk = (turns, chars) => {
  const m = [];
  for (let i = 0; i < turns; i++) {
    m.push({ role: 'user', content: [{ type: 'text', text: `q${i} ` + 'lorem ipsum dolor '.repeat(Math.ceil(chars / 18)) }] });
    m.push({ role: 'assistant', content: [{ type: 'text', text: `a${i} ` + 'sit amet consectetur '.repeat(Math.ceil(chars / 20)) }] });
  }
  return m;
};
const run = (m, profitable = () => true, o = {}) => collapseHistory(m, profitable, { collapseChunk: 0, keepTail: 4, ...o });
delete process.env.PXLITE_FORCE_COLLAPSE_TOKENS;
delete process.env.PXLITE_MIN_COLLAPSE_MESSAGES;
delete process.env.PXLITE_MIN_SHRINK_TOKENS;

// 1. Small, short history: normal gates refuse.
const small = await run(mk(8, 400));
assert.ok(!(small.info.collapsedTurns > 0), 'small history must not collapse');

// 2. 20 turns (40 msgs < 50) but ~900k chars (~300k tokens): forced.
const big = mk(20, 22000);
const forced = await run(big);
assert.ok(forced.info.collapsedTurns > 0, 'over 250k tokens must collapse: ' + forced.info.reason);
assert.equal(forced.info.forced, true);

// 3. Same history, force disabled: refused by the 50-message gate.
process.env.PXLITE_FORCE_COLLAPSE_TOKENS = '0';
const off = await run(big);
assert.ok(!(off.info.collapsedTurns > 0), 'force=0 restores normal gates: ' + off.info.reason);

// 4. Forced mode ignores the profitability callback.
delete process.env.PXLITE_FORCE_COLLAPSE_TOKENS;
const unprof = await run(big, () => false);
assert.ok(unprof.info.collapsedTurns > 0, 'forced ignores not_profitable');
console.log('ok');
