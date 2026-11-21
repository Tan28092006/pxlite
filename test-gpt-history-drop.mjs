// GPT/OpenCode paths: collapsed history drops tool output like the Claude path (no API calls).
import assert from 'node:assert/strict';
const H = await import(new URL('./vendor/pxpipe-proxy/dist/core/openai-history.js', import.meta.url).href);

const big = 'line of tool output\n'.repeat(400);
const chat = [
  { role: 'user', content: 'fix the bug' },
  { role: 'assistant', content: 'looking', tool_calls: [{ id: 'c1', function: { name: 'read', arguments: JSON.stringify({ filePath: '/a/b.js' }) } }] },
  { role: 'tool', tool_call_id: 'c1', content: big },
  { role: 'assistant', content: '', tool_calls: [{ id: 'c2', function: { name: 'bash', arguments: JSON.stringify({ command: 'npm test' }) } }] },
  { role: 'tool', tool_call_id: 'c2', content: 'Error: command failed with exit code 1\n' + big },
  { role: 'assistant', content: '', tool_calls: [{ id: 'c3', function: { name: 'task', arguments: JSON.stringify({ description: 'd', prompt: 'p', subagent_type: 'qa' }) } }] },
  { role: 'tool', tool_call_id: 'c3', content: 'QA report: all fine' },
];

// default (recall-safe): untouched
const plain = H.chatMessagesToTurns(chat);
assert.match(plain[2].text, /line of tool output/);

const t = H.chatMessagesToTurns(chat, { dropTools: true });
assert.equal(t[2].text, '', 'successful read output dropped');
assert.match(t[1].text, /\[read\] \/a\/b\.js/, 'call becomes one line');
assert.doesNotMatch(t[1].text, /tool_use/);
assert.match(t[4].text, /\[bash error\]/, 'failed output kept');
assert.ok(t[4].text.length < 800, 'error is clipped');
assert.match(t[6].text, /Message from subagent/, 'subagent report kept');
assert.deepEqual(t[2].closeIds, ['c1'], 'tool-call pairing preserved');
assert.ok(t[2].rawText.includes('line of tool output'), 'raw text kept for the profit gate');

// Responses rounds
const items = [];
for (let i = 0; i < 12; i++) {
  items.push({ type: 'function_call', call_id: `k${i}`, name: 'read', arguments: JSON.stringify({ filePath: `/f${i}.js` }) });
  items.push({ type: 'function_call_output', call_id: `k${i}`, output: big });
}
let seen = null;
const plan = await H.planResponsesPairCollapse(items, (text, cols, baseline) => { seen = { text, baseline }; return true; }, { keepRecentPairs: 2, minCollapseTokens: 100, freezeChunk: 0, maxImages: 50 });
assert.notEqual(plan.reason, 'below_min_tokens', 'floor counts raw tokens, not stubs');
assert.ok(plan.selectedIndices.length > 0, 'collapsed: ' + plan.reason);
assert.ok(seen.baseline > 1000, 'gate sees raw baseline tokens, got ' + seen.baseline);
assert.doesNotMatch(seen.text, /line of tool output/, 'imaged text has no tool output');
assert.match(seen.text, /\[read\] \/f0\.js/);

// Tail floors mirror Claude: 4 normally, 12 messages / 6 pairs inside a tool chain
const O = await import(new URL('./vendor/pxpipe-proxy/dist/core/openai.js', import.meta.url).href);
const calm = O.pxliteTailFloors([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }]);
assert.equal(calm.keepTail, 4);
assert.equal(calm.keepRecentPairs, 4);
const chainChat = O.pxliteTailFloors(chat);
assert.equal(chainChat.keepTail, 12, 'chat tool chain keeps 12');
const chainResp = O.pxliteTailFloors(items);
assert.equal(chainResp.keepTail, 12);
assert.equal(chainResp.keepRecentPairs, 6, 'responses chain keeps 6 pairs (12 items)');
process.env.PXLITE_TOOL_ROUND_CUT = '0';
assert.equal(O.pxliteTailFloors(chat).keepTail, 4, 'chain rule can be turned off');
delete process.env.PXLITE_TOOL_ROUND_CUT;

console.log('gpt history drop: ok');
