import assert from 'node:assert/strict';
import { collapseHistory, estimateCollapseShrinkTokens } from './vendor/pxpipe-proxy/dist/core/history.js';
const mk = (n, size) => { const m = [{ role: 'user', content: 'go' }];
  for (let i = 0; i < n; i++) { m.push({ role: 'assistant', content: [{ type: 'tool_use', id: 'u' + i, name: 'Bash', input: { command: 'ls' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u' + i, content: 'x'.repeat(size) }] }); } return m; };
const run = (m, o = {}) => collapseHistory(m, () => true, { collapseChunk: 50, keepTail: 4, ...o });
// below 50 messages: no collapse (old floor of 10 is gone)
let r = await run(mk(15, 5000)); assert.equal(r.info.collapsedTurns, 0); assert.equal(r.info.reason, 'prefix_too_short');
// plenty of messages but little text: skipped as low_shrink
r = await run(mk(60, 20)); assert.equal(r.info.reason, 'low_shrink'); assert.ok(r.info.estShrinkTokens < 25000);
// big outputs: collapses
r = await run(mk(60, 3000)); assert.ok(r.info.collapsedTurns > 0, r.info.reason);
assert.ok(r.info.estShrinkTokens >= 25000);
// incremental: a large warm image prefix makes the same range fall under the gate
const e0 = estimateCollapseShrinkTokens(mk(60, 3000), 0, 100, 100000, 0);
const e1 = estimateCollapseShrinkTokens(mk(60, 3000), 0, 100, 100000, 14000);
assert.ok(e1 < e0 * 0.2, `${e1} vs ${e0}`);
// env overrides
process.env.PXLITE_MIN_SHRINK_TOKENS = '0'; r = await run(mk(60, 20)); assert.ok(r.info.collapsedTurns > 0);
process.env.PXLITE_MIN_COLLAPSE_MESSAGES = '11'; r = await run(mk(15, 5000)); assert.ok(r.info.collapsedTurns > 0, r.info.reason);
console.log('ok');

