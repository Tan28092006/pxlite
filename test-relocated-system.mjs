// node --test test-relocated-system.mjs — needs vendor/ (junction to ~/.pxpipe-lite/vendor).
//
// OpenCode + opencode-claude-auth does not send its system prompt in `system`: the plugin
// moves every non-identity system entry to the FRONT of the first user message as plain text
// blocks (the OAuth endpoint rejects third-party text in `system`). Before this was handled,
// the first history collapse read those blocks as the user's stale opening request and cut
// each to a 4000-char "PRIOR CONTEXT ONLY ... must not be acted on" preview: the agent lost
// the middle of its harness rules and ~90k chars of tool catalog mid-session, silently.
//
// These tests pin (1) the wire shape, against the real plugin when it is installed,
// (2) that a collapse now carries those blocks through byte-identical while the user's own
// opening request is still demoted, and (3) that a normal request is treated as before.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

process.env.PXPIPE_MODELS ??= 'claude-opus-5-5';
const core = new URL('./vendor/pxpipe-proxy/dist/core/', import.meta.url).href;
const { transformRequest, relocatedSystemTexts } = await import(core + 'transform.js');
const { toTrackEvent } = await import(core + 'tracker.js');

const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const BILLING = 'x-anthropic-billing-header: cc_version=2.1.0; cc_entrypoint=sdk-cli;';
const E = { type: 'ephemeral' };

let seed = 11;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const WORDS = 'the proxy reads cache prefix and writes image chunk for history when tail grows beyond limit then agent calls tool again to check result of previous step'.split(' ');
const prose = (n) => Array.from({ length: n }, () => WORDS[Math.floor(rnd() * WORDS.length)]).join(' ');
const code = (lines) => Array.from({ length: lines }, (_, i) => `  const v${i} = compute(${prose(4).replace(/ /g, ', ')}); // ${prose(5)}`).join('\n');

// Same order and rough sizes as a real OpenCode session: harness rules, model card, a tool
// catalog far above the 4000-char preview, a short trailing note.
const HARNESS = 'You are an AI agent running in OpenCode. RULE_HEAD_ALPHA: answer in Vietnamese.\n' + prose(500) + '\nRULE_MID_BRAVO: never push to main without asking.\n' + prose(500) + '\nRULE_TAIL_CHARLIE: run tests before reporting.';
const MODEL = '# Your Model\n- Name: Claude Probe MODEL_INDIA';
const CATALOG = '# Code Mode\nTools below only work inside execute. CATALOG_HEAD_DELTA\n' + prose(7000) + '\n- tools.browse.snapshot({ tab }) CATALOG_MID_ECHO\n' + prose(7000) + '\n- Use rg -uu when completeness matters. CATALOG_TAIL_FOXTROT';
const NOTE = 'When you create a worktree, move the session there. NOTE_HOTEL';
const SYSTEM = [HARNESS, MODEL, CATALOG, NOTE];
const SYSTEM_MARKERS = ['RULE_HEAD_ALPHA', 'RULE_MID_BRAVO', 'RULE_TAIL_CHARLIE', 'MODEL_INDIA', 'CATALOG_HEAD_DELTA', 'CATALOG_MID_ECHO', 'CATALOG_TAIL_FOXTROT', 'NOTE_HOTEL'];
const REQUEST = 'USER_REQUEST_GOLF: please audit the cache policy and fix what is wrong.';

/** What the plugin puts on the wire (see relocateSystemEntries in its transforms.js). */
function relocate(systemTexts, userContent, marks = [systemTexts.length - 1]) {
  const isString = typeof userContent === 'string';
  const blocks = systemTexts.map((t, i) => ({ type: 'text', text: t + (i < systemTexts.length - 1 || isString ? '\n\n' : '') }));
  // Default: the plugin's own mark on the last moved block (client sent no cache marks).
  // OpenCode marks its first two system entries itself and the plugin carries those: [0, 1].
  for (const i of marks) blocks[i].cache_control = { ...E };
  return [...blocks, ...(isString ? [{ type: 'text', text: userContent }] : userContent)];
}

const ROUNDS = (() => {
  const m = [];
  for (let r = 0; r < 80; r++) {
    const id = 'toolu_' + String(r).padStart(4, '0');
    m.push({ role: 'assistant', content: [{ type: 'text', text: prose(40) }, { type: 'tool_use', id, name: 'Read', input: { file_path: `/repo/src/file${r}.js` } }] });
    m.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: code(30 + Math.floor(rnd() * 60)) }] });
  }
  return m;
})();
const TOOLS = [{ name: 'Read', description: prose(200), input_schema: { type: 'object', properties: { file_path: { type: 'string' } } } }];

/** n messages of one growing session; `first` is the opening user content, `system` the system blocks. */
function body(n, first, system) {
  const messages = structuredClone([{ role: 'user', content: first }, ...ROUNDS.slice(0, n - 1)]);
  const last = messages.at(-1).content;
  if (Array.isArray(last)) last.at(-1).cache_control = { ...E };
  return { model: 'claude-opus-5-5', max_tokens: 1024, system: structuredClone(system), tools: structuredClone(TOOLS), messages };
}
const OAUTH_SYSTEM = [{ type: 'text', text: BILLING }, { type: 'text', text: IDENTITY }];

async function run(b) {
  const out = await transformRequest(new TextEncoder().encode(JSON.stringify(b)), { model: b.model, emitRecoverable: false });
  const req = JSON.parse(new TextDecoder().decode(out.body));
  // "label" = text the proxy itself wrote to say "this is old, do not act on it".
  const live = [], label = [];
  const walk = (c) => {
    if (typeof c === 'string') live.push(c);
    else for (const blk of Array.isArray(c) ? c : []) {
      if (blk.type === 'text') (/must not be acted on|This is still prior context/.test(blk.text) ? label : live).push(blk.text);
      if (blk.type === 'tool_result') walk(blk.content);
    }
  };
  walk(req.system);
  req.messages.forEach((m) => walk(m.content));
  return { req, info: out.info ?? {}, live: live.join('\n'), label: label.join('\n') };
}

// ---------------------------------------------------------------- wire shape

test('detects the relocated system prompt: array user content', () => {
  const b = body(3, relocate(SYSTEM, [{ type: 'text', text: REQUEST }]), OAUTH_SYSTEM);
  assert.deepEqual(relocatedSystemTexts(b), [HARNESS + '\n\n', MODEL + '\n\n', CATALOG + '\n\n', NOTE]);
});

test('detects the relocated system prompt: string user content (every moved block ends in a blank line)', () => {
  const b = body(3, relocate(SYSTEM, REQUEST), OAUTH_SYSTEM);
  assert.deepEqual(relocatedSystemTexts(b), SYSTEM.map((t) => t + '\n\n'));
});

test('detects it when `system` holds the billing header alone (what a plain OpenCode prompt leaves)', () => {
  const b = body(3, relocate(SYSTEM, [{ type: 'text', text: REQUEST }]), [{ type: 'text', text: BILLING }]);
  assert.equal(relocatedSystemTexts(b).length, 4);
});

test('a user message with several parts keeps all of them out of the system set', () => {
  const b = body(3, relocate(SYSTEM, [{ type: 'text', text: REQUEST }, { type: 'text', text: 'second part' }]), OAUTH_SYSTEM);
  const got = relocatedSystemTexts(b);
  assert.equal(got.length, 4);
  assert.ok(!got.some((t) => t.includes('USER_REQUEST_GOLF') || t === 'second part'));
});

test('one relocated block is accepted only with its cache breakpoint', () => {
  const marked = body(3, [{ type: 'text', text: HARNESS, cache_control: { ...E } }, { type: 'text', text: REQUEST }], OAUTH_SYSTEM);
  assert.deepEqual(relocatedSystemTexts(marked), [HARNESS]);
  const bare = body(3, [{ type: 'text', text: HARNESS }, { type: 'text', text: REQUEST }], OAUTH_SYSTEM);
  assert.deepEqual(relocatedSystemTexts(bare), [], 'two plain text blocks are just a user message');
});

test('never claims text the user typed', async (t) => {
  await t.test('a request that still has its own system prompt was not relocated', () => {
    const sys = [{ type: 'text', text: IDENTITY }, { type: 'text', text: HARNESS, cache_control: { ...E } }];
    assert.deepEqual(relocatedSystemTexts(body(3, relocate(SYSTEM, REQUEST), sys)), []);
  });
  await t.test('no billing header in system: not the plugin', () => {
    assert.deepEqual(relocatedSystemTexts(body(3, relocate(SYSTEM, REQUEST), [{ type: 'text', text: IDENTITY }])), []);
    assert.deepEqual(relocatedSystemTexts(body(3, relocate(SYSTEM, REQUEST), IDENTITY)), []);
    assert.deepEqual(relocatedSystemTexts(body(3, relocate(SYSTEM, REQUEST), [])), []);
    assert.deepEqual(relocatedSystemTexts(body(3, relocate(SYSTEM, REQUEST), undefined)), []);
  });
  await t.test('a lone typed block, even one ending in a blank line', () => {
    assert.deepEqual(relocatedSystemTexts(body(3, [{ type: 'text', text: REQUEST + '\n\n' }], OAUTH_SYSTEM)), []);
    assert.deepEqual(relocatedSystemTexts(body(3, [{ type: 'text', text: REQUEST }], OAUTH_SYSTEM)), []);
    assert.deepEqual(relocatedSystemTexts(body(3, REQUEST, OAUTH_SYSTEM)), []);
  });
  await t.test('typed text ending in a blank line after relocated blocks stays the user\'s', () => {
    const got = relocatedSystemTexts(body(3, relocate(SYSTEM, REQUEST + '\n\n'), OAUTH_SYSTEM));
    assert.deepEqual(got, SYSTEM.map((x) => x + '\n\n'));
  });
  await t.test('first message is not a user message', () => {
    const b = body(3, relocate(SYSTEM, REQUEST), OAUTH_SYSTEM);
    b.messages[0].role = 'assistant';
    assert.deepEqual(relocatedSystemTexts(b), []);
  });
});

// The real plugin, when this machine has it: the shape above is only worth pinning if it is
// the shape the plugin actually emits.
const pluginFile = (() => {
  const root = path.join(os.homedir(), '.cache', 'opencode', 'npm');
  try {
    for (const pkg of fs.readdirSync(root).filter((d) => d.startsWith('opencode-claude-auth@')).sort().reverse()) {
      for (const inst of fs.readdirSync(path.join(root, pkg)).sort().reverse()) {
        const f = path.join(root, pkg, inst, 'node_modules', 'opencode-claude-auth', 'dist', 'transforms.js');
        if (fs.existsSync(f)) return f;
      }
    }
  } catch { /* not installed */ }
  return null;
})();

test('the installed opencode-claude-auth plugin produces a shape this detector reads', { skip: pluginFile ? false : 'opencode-claude-auth is not installed in ~/.cache/opencode/npm' }, async () => {
  const { transformBody } = await import(pathToFileURL(pluginFile).href);
  for (const [name, userContent] of [['array', [{ type: 'text', text: REQUEST }]], ['string', REQUEST]]) {
    // What OpenCode hands the plugin: its whole prompt in `system`, its own cache marks on it.
    const raw = {
      model: 'claude-opus-5-5',
      max_tokens: 1024,
      system: SYSTEM.map((t, i) => ({ type: 'text', text: t, ...(i < 2 ? { cache_control: { ...E } } : {}) })),
      tools: structuredClone(TOOLS),
      messages: structuredClone([{ role: 'user', content: userContent }, ...ROUNDS.slice(0, 2)]),
    };
    const wire = JSON.parse(transformBody(JSON.stringify(raw)));
    const got = relocatedSystemTexts(wire);
    assert.equal(got.length, SYSTEM.length, `${name}: all ${SYSTEM.length} system entries found on the wire`);
    got.forEach((t, i) => assert.equal(t.trimEnd(), SYSTEM[i], `${name}: block ${i} is the system entry, untouched`));
    assert.ok(!got.some((t) => t.includes('USER_REQUEST_GOLF')), `${name}: the typed request is not in the set`);
  }
});

// ---------------------------------------------------------------- through a collapse

for (const [shape, OAUTH_SYSTEM, marks] of [
  ['billing + identity, plugin-placed mark', [{ type: 'text', text: BILLING }, { type: 'text', text: IDENTITY }], [3]],
  ['billing only, OpenCode-placed marks (measured wire shape)', [{ type: 'text', text: BILLING }], [0, 1]],
]) test(`a history collapse keeps the relocated system prompt whole and still demotes the opening request [${shape}]`, async () => {
  const first = relocate(SYSTEM, [{ type: 'text', text: REQUEST }], marks);
  const before = await run(body(41, first, OAUTH_SYSTEM));
  assert.notEqual(before.info.historyReason, 'collapsed', 'fixture: 41 messages are below the collapse floor');
  assert.equal(before.info.relocatedSystemBlocks, 4);

  const a = await run(body(121, first, OAUTH_SYSTEM));
  assert.equal(a.info.historyReason, 'collapsed', 'fixture: 121 messages collapse');
  assert.equal(a.info.standingBlocksKept, 4, 'every relocated block was carried through');
  for (const k of SYSTEM_MARKERS) {
    assert.ok(a.live.includes(k), `${k} is still live text after the collapse`);
    assert.ok(!a.label.includes(k), `${k} is not labelled as stale prior context`);
  }
  // Byte-identical, not merely "the marker survived": no preview, no elision, no relabel.
  const head = a.req.messages[0].content.filter((blk) => blk.type === 'text').map((blk) => blk.text);
  first.slice(0, 4).forEach((blk, i) => assert.equal(head[i], blk.text, `relocated block ${i} is byte-identical`));
  assert.ok(!/middle elided/.test(a.live), 'nothing in live text was elided');
  // The user's own first request is old by now and must not read as the current one.
  assert.ok(!a.live.includes('USER_REQUEST_GOLF'), 'the opening request is not live text');
  assert.ok(a.label.includes('USER_REQUEST_GOLF'), 'the opening request is carried as labelled prior context');

  // The next request of the same session re-sends the same head: the cached prefix holds.
  const b = await run(body(141, first, OAUTH_SYSTEM));
  assert.equal(b.info.historyReason, 'collapsed');
  assert.equal(JSON.stringify(b.req.messages[0]), JSON.stringify(a.req.messages[0]), 'message 0 is byte-stable across requests');
  // And the first collapse itself no longer rewrites the relocated prompt (it used to replace
  // it by previews, discarding the cached prefix from the first byte of message 0).
  const pre = JSON.stringify(before.req.messages[0].content.slice(0, 4));
  const post = JSON.stringify(a.req.messages[0].content.slice(0, 4));
  assert.equal(post, pre, 'the relocated blocks are byte-identical before and after the first collapse');
});

test('string user content: same guarantees', async () => {
  const first = relocate(SYSTEM, REQUEST);
  const a = await run(body(121, first, OAUTH_SYSTEM));
  assert.equal(a.info.historyReason, 'collapsed');
  assert.equal(a.info.standingBlocksKept, 4);
  for (const k of SYSTEM_MARKERS) assert.ok(a.live.includes(k) && !a.label.includes(k), `${k} live`);
  assert.ok(!a.live.includes('USER_REQUEST_GOLF') && a.label.includes('USER_REQUEST_GOLF'));
});

test('control: a normal request (prompt in `system`) is collapsed exactly as before', async () => {
  const sys = [{ type: 'text', text: IDENTITY }, { type: 'text', text: SYSTEM.join('\n\n'), cache_control: { ...E } }];
  const typed = 'USER_REQUEST_GOLF: ' + prose(1500); // a long typed opening, well above the preview cap
  const a = await run(body(121, [{ type: 'text', text: typed }], sys));
  assert.equal(a.info.historyReason, 'collapsed');
  assert.equal(a.info.relocatedSystemBlocks, undefined, 'nothing detected');
  assert.equal(a.info.standingBlocksKept, undefined, 'nothing kept verbatim');
  assert.ok(!a.live.includes('USER_REQUEST_GOLF'), 'the typed opening is demoted, as before');
  assert.ok(a.label.includes('USER_REQUEST_GOLF'));
});

// ---------------------------------------------------------------- log

test('the event log says when a relocated prompt was seen and how much of it a collapse kept', async () => {
  const a = await run(body(121, relocate(SYSTEM, [{ type: 'text', text: REQUEST }]), OAUTH_SYSTEM));
  const ev = toTrackEvent({ method: 'POST', path: '/v1/messages', status: 200, durationMs: 1, info: a.info });
  assert.equal(ev.relocated_system_blocks, 4);
  assert.equal(ev.relocated_system_chars, SYSTEM.join('').length + 6);
  assert.equal(ev.standing_blocks_kept, 4);
  assert.ok(JSON.stringify(ev).length < 20000, 'the prompt text itself never reaches the log');
  assert.ok(!JSON.stringify(a.info).includes('RULE_MID_BRAVO'), 'nor the serialized info');

  const plain = toTrackEvent({ method: 'POST', path: '/v1/messages', status: 200, durationMs: 1, info: { compressed: false } });
  for (const k of ['relocated_system_blocks', 'relocated_system_chars', 'standing_blocks_kept']) assert.ok(!(k in plain), `${k} is absent when there is nothing to say`);
});
