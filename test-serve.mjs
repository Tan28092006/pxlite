// node --test test-serve.mjs
// Runs the real `pxlite serve` from a folder whose name has spaces and non-ASCII letters, with a
// local server standing in for opencode.ai, and checks what that server receives.
// Needs vendor/ (built by `npm install`); skipped otherwise.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VENDOR = path.join(HERE, 'vendor', 'pxpipe-proxy');
const SKIP = fs.existsSync(path.join(VENDOR, 'package.json')) ? false : 'vendor/ not built (run npm install)';

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startServe(t, extraEnv = {}, responseFixture) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pxlite-serve-'));
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home);
  // Install dir: spaces and Vietnamese letters, the case a file-URL pathname breaks on.
  const install = path.join(tmp, 'pxlite ĐIỂM PHÚ');
  fs.mkdirSync(install);
  for (const f of fs.readdirSync(HERE)) {
    if (/\.mjs$/.test(f) && !/^test/.test(f)) fs.copyFileSync(path.join(HERE, f), path.join(install, f));
  }
  fs.copyFileSync(path.join(HERE, 'config.default.json'), path.join(install, 'config.default.json'));
  fs.symlinkSync(path.join(HERE, 'vendor'), path.join(install, 'vendor'), 'junction');
  // Intercept only the network destination. The real launcher still applies its
  // host-specific compatibility code before this fixture receives the request.
  const fetchFixture = path.join(tmp, 'offline-fetch.mjs');
  fs.writeFileSync(fetchFixture, `
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (u.hostname === 'api.openai.com' || u.hostname === 'chatgpt.com')
        return nativeFetch(new URL(u.pathname + u.search, process.env.PXLITE_TEST_UPSTREAM), init);
      return nativeFetch(input, init);
    };
  `);

  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push({ method: req.method, url: req.url, body });
      res.setHeader('x-request-id', `req_fixture_${seen.length}`);
      if (req.url.startsWith('/v1/messages')) {
        let stream = false;
        try {
          stream = JSON.parse(body).stream === true;
        } catch {}
        return void answerMessages(res, stream);
      }
      res.setHeader('content-type', 'application/json');
      if (responseFixture) return void res.end(JSON.stringify(responseFixture(JSON.parse(body), seen.length)));
      res.end(
        JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        }),
      );
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upstreamPort = upstream.address().port;

  const port = await freePort();
  const connectPort = await freePort();
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    PORT: String(port),
    PXLITE_CONNECT_PORT: String(connectPort),
    PXPIPE_MODELS: 'off',
    PXLITE_OPENCODE_UPSTREAM: `http://127.0.0.1:${upstreamPort}/inference/openai`,
    PXLITE_ANTHROPIC_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
    PXLITE_TEST_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(fetchFixture).href}`].filter(Boolean).join(' '),
    // Never launch the user's real OpenCode CLI from a test: with HOME pointed at a temp
    // directory it hangs until recall's 15 s timeout and keeps that directory locked.
    PXLITE_OPENCODE_CLI: path.join(tmp, 'no-opencode-cli'),
    ...extraEnv,
  };
  delete env.PXPIPE_LOG;
  if (!('PXLITE_DEDUPE_TAGS' in extraEnv)) delete env.PXLITE_DEDUPE_TAGS;
  delete env.PXLITE_PKG;
  const child = spawn(process.execPath, [path.join(install, 'pxlite.mjs'), 'serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));

  t.after(async () => {
    // Wait for the proxy to exit before deleting its home: on Windows a live process still
    // holds its log and pin files, and removing them 200 ms after kill() failed with EPERM.
    const exited = child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    upstream.close();
    await Promise.race([exited, sleep(5000)]);
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const base = `http://127.0.0.1:${port}`;
  let status = null;
  for (let i = 0; i < 100 && status === null; i++) {
    if (child.exitCode !== null) assert.fail(`pxlite serve exited ${child.exitCode}:\n${log}`);
    try {
      status = await (await fetch(`${base}/pxlite/status`)).json();
    } catch {
      await sleep(200);
    }
  }
  assert.ok(status, `pxlite serve did not come up:\n${log}`);
  return { base, install, seen, status, home };
}

/** Minimal Anthropic Messages reply, as one JSON body or as an SSE stream. */
function answerMessages(res, stream) {
  const usage = { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  if (!stream) {
    res.setHeader('content-type', 'application/json');
    return void res.end(JSON.stringify({ id: 'msg_t', type: 'message', role: 'assistant', model: 'm', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage }));
  }
  res.setHeader('content-type', 'text/event-stream');
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  ev('message_start', { message: { id: 'msg_t', type: 'message', role: 'assistant', model: 'm', content: [], usage } });
  ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'ok' } });
  ev('content_block_stop', { index: 0 });
  ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } });
  ev('message_stop', {});
  res.end();
}

const readEvents = (home) => {
  const file = path.join(home, '.pxpipe', 'events.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};

const chatBody = JSON.stringify({ model: 'deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'hello opencode' }] });
const headers = { 'content-type': 'application/json', authorization: 'Bearer test' };

for (const detail of ['compact', 'full']) test(`real GPT upstream event correlates headers and hashes cache identity without storing prompt text (${detail})`, { skip: SKIP }, async t => {
  const { base, home } = await startServe(t, { PXPIPE_MODELS: 'gpt-6.1-sol', PXLITE_LOG_DETAIL: detail });
  const res = await fetch(base + '/v1/responses', { method: 'POST',
    headers: { ...headers, 'x-opencode-session-id': 'diagnostic-fixture' },
    body: JSON.stringify({ model: 'gpt-6.1-sol', prompt_cache_key: 'PRIVATE-CACHE-KEY',
      input: [{ role: 'user', content: 'PRIVATE-PROMPT-BODY' }] }) });
  assert.equal(res.status, 200);
  await res.text();
  let events = [];
  for (let i = 0; i < 50 && !events.length; i++) {
    events = readEvents(home); if (!events.length) await sleep(100);
  }
  assert.equal(events[0]?.gpt_upstream?.request_id, 'req_fixture_1');
  assert.equal(events[0].gpt_upstream.anchors, detail === 'full' ? 0 : undefined);
  assert.match(events[0].gpt_upstream.cache_key_sha, /^[a-f0-9]{24}$/);
  assert.ok(!JSON.stringify(events).includes('PRIVATE-'));
});

// Rules under test (pxlite.mjs claudeRequestTags):
// - session_id: header x-claude-code-session-id, else metadata.user_id JSON .session_id; absent otherwise.
// - agent_role: subagent if x-claude-code-agent-id is sent, main if only the session header is, else unknown.
// - body_kind: delta iff no tools and system (billing line excluded) is under 2000 chars; else full.
test('events.jsonl tags Claude requests with session_id, agent_role, body_kind and no prompt text', { skip: SKIP }, async (t) => {
  const { base, home } = await startServe(t);
  const SECRET = 'PROMPT-TEXT-MUST-NOT-BE-LOGGED';
  const billing = { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.310; cc_entrypoint=cli;' };
  const sysText = (n) => ({ type: 'text', text: SECRET + 'x'.repeat(n - SECRET.length) });
  const tool = { name: 'Read', description: SECRET, input_schema: { type: 'object' } };
  const S1 = '7d644ddd-6d7b-483a-8706-99101d1874aa';
  const S2 = '11111111-2222-3333-4444-555555555555';
  const rows = [
    { name: 'main turn: session header, long system, tools, streamed', hdr: { 'x-claude-code-session-id': S1 }, body: { system: [billing, sysText(5000)], tools: [tool], stream: true }, want: { session_id: S1, agent_role: 'main', body_kind: 'full' } },
    { name: 'subagent delta: agent id header, no system, no tools, streamed', hdr: { 'x-claude-code-session-id': S1, 'x-claude-code-agent-id': 'a5362aa3c04d9a24d' }, body: { stream: true }, want: { session_id: S1, agent_role: 'subagent', body_kind: 'delta' } },
    { name: 'OpenCode session takes precedence over plugin process UUID', hdr: { 'x-claude-code-session-id': S1, 'x-opencode-session-id': 'ses_main123' }, body: { tools: [tool] }, want: { session_id: 'ses_main123', agent_role: 'main', body_kind: 'full' } },
    { name: 'OpenCode child has its own session identity', hdr: { 'x-claude-code-session-id': S1, 'x-opencode-session-id': 'ses_child123', 'x-opencode-parent-session-id': 'ses_main123' }, body: { tools: [tool] }, want: { session_id: 'ses_child123', agent_role: 'subagent', body_kind: 'full' } },
    { name: 'session only in metadata.user_id, no headers', hdr: {}, body: { metadata: { user_id: JSON.stringify({ device_id: 'd', session_id: S2 }) }, system: 'short', tools: [] }, want: { session_id: S2, agent_role: 'unknown', body_kind: 'delta' } },
    { name: 'billing line alone does not count, however long', hdr: {}, body: { system: [{ type: 'text', text: billing.text + 'b'.repeat(3000) }] }, want: { agent_role: 'unknown', body_kind: 'delta' } },
    { name: 'system 1999 chars is still delta', hdr: {}, body: { system: [billing, sysText(1999)] }, want: { agent_role: 'unknown', body_kind: 'delta' } },
    { name: 'system 2000 chars is full', hdr: {}, body: { system: [billing, sysText(2000)] }, want: { agent_role: 'unknown', body_kind: 'full' } },
    { name: 'tools alone make it full', hdr: {}, body: { tools: [tool] }, want: { agent_role: 'unknown', body_kind: 'full' } },
    { name: 'metadata.user_id that is not JSON gives no session_id', hdr: {}, body: { metadata: { user_id: 'user_abc' } }, want: { agent_role: 'unknown', body_kind: 'delta' } },
  ];
  for (const [i, row] of rows.entries()) {
    const body = { model: 'claude-test', max_tokens: 8, messages: [{ role: 'user', content: SECRET }], ...row.body };
    const res = await fetch(`${base}/v1/messages`, { method: 'POST', headers: { ...headers, 'x-api-key': 'k', 'anthropic-version': '2023-06-01', ...row.hdr }, body: JSON.stringify(body) });
    assert.equal(res.status, 200, row.name);
    await res.text();
    let evs = [];
    for (let k = 0; k < 50 && evs.length <= i; k++) {
      evs = readEvents(home).filter((e) => e.path === '/v1/messages');
      if (evs.length <= i) await sleep(100);
    }
    const ev = evs[i];
    assert.ok(ev, `${row.name}: no event logged`);
    const got = { agent_role: ev.agent_role, body_kind: ev.body_kind };
    if ('session_id' in ev) got.session_id = ev.session_id;
    assert.deepEqual(got, row.want, row.name);
  }
  const raw = fs.readFileSync(path.join(home, '.pxpipe', 'events.jsonl'), 'utf8');
  assert.ok(!raw.includes(SECRET), 'prompt text leaked into events.jsonl');
});

test('serve resolves vendor/ from a path with spaces and non-ASCII letters', { skip: SKIP }, async (t) => {
  const { install, status } = await startServe(t);
  assert.equal(path.normalize(status.pkg), path.join(install, 'vendor', 'pxpipe-proxy'));
  assert.doesNotMatch(status.pkg, /%[0-9A-Fa-f]{2}/);
});

test('OpenCode Chat Completions path is rewritten and sent to the OpenCode upstream', { skip: SKIP }, async (t) => {
  const { base, seen } = await startServe(t);
  const res = await fetch(`${base}/inference/openai/v1/chat/completions`, { method: 'POST', headers, body: chatBody });
  assert.equal(res.status, 200);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, 'POST');
  assert.equal(seen[0].url, '/inference/openai/v1/chat/completions');
  assert.match(seen[0].body, /hello opencode/);
});

test('OpenCode Responses path goes to the OpenCode upstream too', { skip: SKIP }, async (t) => {
  const { base, seen } = await startServe(t);
  const body = JSON.stringify({ model: 'deepseek-v4.1-flash-free', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello responses' }] }] });
  const res = await fetch(`${base}/inference/openai/v1/responses`, { method: 'POST', headers, body });
  assert.equal(res.status, 200);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, '/inference/openai/v1/responses');
  assert.match(seen[0].body, /hello responses/);
});

test('legacy GPT gate-off routes run tool checkpoints and hold old output bytes between epochs', { skip: SKIP }, async (t) => {
  const { base, seen, home } = await startServe(t, {
    PXLITE_RECALL: '0', PXPIPE_MODELS: 'gpt-6.1-sol', PXLITE_GPT_CACHE_GATE: '0',
    PXLITE_GPT_CHECKPOINT_CHUNK: '50',
  });
  for (const route of ['/v1/responses', '/backend-api/codex/responses', '/v1/chat/completions']) {
    const chat = route.endsWith('/chat/completions');
    const make = n => {
      const list = [{ role: 'user', content: chat ? 'run checks' : [{ type: 'input_text', text: 'run checks' }] }];
      for (let i = 0; i < n; i++) list.push(...(chat ? [
        { role: 'assistant', tool_calls: [{ id: `c${i}`, function: { name: 'shell', arguments: '{"command":"node check.mjs"}' } }] },
        { role: 'tool', tool_call_id: `c${i}`, content: 'Build check passed.\n'.repeat(100) },
      ] : [
        { type: 'function_call', call_id: `c${i}`, name: 'shell', arguments: '{"command":"node check.mjs"}' },
        { type: 'function_call_output', call_id: `c${i}`, output: 'Build check passed.\n'.repeat(100) },
      ]));
      return { model: 'gpt-6.1-sol', [chat ? 'messages' : 'input']: list };
    };
    const post = async n => {
      const res = await fetch(base + route, { method: 'POST', headers: { ...headers, 'x-opencode-session-id': 'fixture-' + route }, body: JSON.stringify(make(n)) });
      assert.equal(res.status, 200);
      await res.text();
      return JSON.parse(seen.at(-1).body)[chat ? 'messages' : 'input'];
    };
    const a = await post(40);
    assert.ok(JSON.stringify(a).includes('pxlite: older output collapsed'), 'missing tool checkpoint on ' + route);
    const b = await post(45);
    assert.deepEqual(b.slice(0, a.length), a, 'old checkpoint bytes changed on ' + route);
  }
  let events = [];
  for (let i = 0; i < 50; i++) {
    events = readEvents(home).filter(e => e.model === 'gpt-6.1-sol');
    if (events.length === 6) break;
    await sleep(100);
  }
  assert.equal(events.length, 6);
  assert.ok(events.every(e => e.tool_collapse?.has_key && e.tool_collapse.collapsed > 0));
  assert.ok(events.every(e => e.gpt_history_checkpoint_chunk === 50));
});

test('managed GPT proxy logs the outgoing prefix and defers an unprofitable checkpoint atomically', { skip: SKIP }, async (t) => {
  const { base, seen, home } = await startServe(t, {
    PXLITE_LOG_DETAIL: 'compact',
    PXLITE_RECALL: '0', PXPIPE_MODELS: 'gpt-6.1-sol', PXLITE_READ_NOTE: '0',
    PXLITE_GPT_REASONING_MODE: 'native',
    PXLITE_GPT_CHECKPOINT_CHUNK: '50',
    PXLITE_GPT_MIN_COLLAPSE_TOKENS: '0', PXLITE_MIN_COLLAPSE_MESSAGES: '0',
  }, () => ({ id: 'resp_fixture', object: 'response', model: 'gpt-6.1-sol',
    output: [], status: 'completed', usage: { input_tokens: 100000, output_tokens: 2,
      input_tokens_details: { cached_tokens: 95000 }, output_tokens_details: { reasoning_tokens: 1 } } }));
  const make = n => ({ model: 'gpt-6.1-sol', input: [
    { role: 'user', content: 'Inspect C:/project/main.js and complete the checks.' },
    ...Array.from({ length: n }, (_, i) => [
      { type: 'reasoning', id: `r${i}`, summary: [], encrypted_content: `PRIVATE_OPAQUE_${i}` },
      { role: 'assistant', content: 'Inspect the source and preserve the relevant evidence. '.repeat(90) },
      { type: 'function_call', call_id: `c${i}`, name: 'shell', arguments: '{"command":"node check.mjs"}' },
      // Cold bootstrap must actually repay the configured 1.25x write premium.
      { type: 'function_call_output', call_id: `c${i}`, output: 'Build passed.\n'.repeat(300) },
    ]).flat(),
  ] });
  const post = async n => {
    const res = await fetch(base + '/v1/responses', { method: 'POST',
      headers: { ...headers, 'x-opencode-session-id': 'PRIVATE_MANAGED_SESSION' }, body: JSON.stringify(make(n)) });
    assert.equal(res.status, 200);
    await res.text();
    return JSON.parse(seen.at(-1).body);
  };
   // A mature first frame has enough completed outputs to repay a cold write.
   // A 50-item first frame is correctly rejected by the economic gate.
   const a = await post(31);
   const b = await post(33);
  assert.deepEqual(b.input.slice(0, a.input.length), a.input);
   const c = await post(45);
  assert.deepEqual(c.input.slice(0, b.input.length), b.input);
  let events = [];
  for (let i = 0; i < 50; i++) {
    events = readEvents(home).filter(e => e.model === 'gpt-6.1-sol');
    if (events.length === 3) break;
    await sleep(100);
  }
  assert.equal(events.length, 3);
  assert.equal(events[0].gpt_prefix.status, 'first');
  assert.equal(events[1].gpt_prefix.status, 'append_only');
  assert.equal(events[2].gpt_prefix.status, 'append_only');
  assert.equal(events[0].gpt_cache_gate.chosen_cutoff, 100,
    JSON.stringify(events.map(e => e.gpt_cache_gate)));
  assert.equal(events[2].gpt_cache_gate.candidate_cutoff, 150);
  assert.equal(events[2].gpt_cache_gate.chosen_cutoff, 100);
  assert.equal(events[2].gpt_cache_gate.accept, false);
  assert.equal(events[2].gpt_cache_gate.reason, 'cache_payback');
  assert.equal(events[1].reasoning_output_tokens, 1);
  assert.ok(events.every(e => e.tool_collapse === undefined));
  assert.ok(events.every(e => e.gpt_cache_gate.session === events[0].gpt_cache_gate.session));
  assert.ok(events.every(e => e.gpt_prefix_diff && !('changes' in e.gpt_prefix_diff)));
  const raw = fs.readFileSync(path.join(home, '.pxpipe', 'events.jsonl'), 'utf8');
  assert.ok(!raw.includes('PRIVATE_OPAQUE_'));
  assert.ok(!raw.includes('PRIVATE_MANAGED_SESSION'));
});

test('summary GPT wire seals immutable pages and retains native tail without injected reminder', { skip: SKIP }, async t => {
  const { base, seen, home } = await startServe(t, {
    PXLITE_RECALL: '0', PXPIPE_MODELS: 'gpt-6.1-sol', PXLITE_READ_NOTE: undefined,
    PXLITE_GPT_REASONING_MODE: 'summary', PXLITE_GPT_NATIVE_TAIL: '30',
    PXLITE_GPT_CHECKPOINT_CHUNK: '50',
  }, () => ({ id: 'resp_summary', object: 'response', output: [], status: 'completed',
    usage: { input_tokens: 20000, output_tokens: 3, input_tokens_details: { cached_tokens: 19000 },
      output_tokens_details: { reasoning_tokens: 2 } } }));
  const make = n => ({ model: 'gpt-6.1-sol', input: [
    { role: 'user', content: 'Implement and test the changes in C:/project/main.js.' },
    ...Array.from({ length: n }, (_, i) => [
      { type: 'reasoning', id: `rs_${i}`, summary: [{ type: 'summary_text', text: `PUBLIC_CHECK_${i}` }],
        encrypted_content: `PRIVATE_STATE_${i}` },
      { role: 'assistant', content: 'Check the implementation and preserve the verification result. '.repeat(20) },
      { type: 'function_call', call_id: `c_${i}`, name: 'shell', arguments: '{"command":"node check.mjs"}' },
      { type: 'function_call_output', call_id: `c_${i}`, output: 'Build passed.\n'.repeat(90) },
    ]).flat(),
  ] });
  const post = async n => {
    const res = await fetch(base + '/v1/responses', { method: 'POST',
      headers: { ...headers, 'x-opencode-session-id': 'PRIVATE_SUMMARY_SESSION' },
      body: JSON.stringify(make(n)) });
    assert.equal(res.status, 200);
    await res.text();
    return JSON.parse(seen.at(-1).body);
  };
  const pages = b => b.input.filter(x => x.content?.some?.(p =>
    p.type === 'input_text' && /^\[Earlier (turns|conversation)/.test(p.text ?? '')));
  const a = await post(30), b = await post(32), c = await post(43);
  assert.ok(pages(a).length > 0);
  assert.deepEqual(pages(b), pages(a));
  assert.deepEqual(pages(c).slice(0, pages(a).length), pages(a));
  assert.ok(c.input.filter(x => x.type === 'reasoning').length < make(43).input.filter(x => x.type === 'reasoning').length);
  assert.deepEqual(c.input.slice(-30), make(43).input.slice(-30));
  assert.ok(!JSON.stringify(c).includes('Before answering, read every image'));
  let events = [];
  for (let i = 0; i < 50; i++) {
    events = readEvents(home).filter(e => e.model === 'gpt-6.1-sol');
    if (events.length === 3) break;
    await sleep(100);
  }
  assert.equal(events.length, 3);
  assert.ok(events.every(e => !e.read_note && e.gpt_cache_gate.history_mode === 'summary'));
  assert.ok(events.every(e => e.gpt_cache_gate.native_tail_floor >= 30));
  assert.equal(events[1].gpt_prefix.status, 'append_only');
  assert.equal(events[1].gpt_cache_gate.history_reset, undefined);
  assert.equal(events[2].reasoning_output_tokens, 2);
  const raw = fs.readFileSync(path.join(home, '.pxpipe/events.jsonl'), 'utf8');
  assert.ok(!raw.includes('PRIVATE_STATE_') && !raw.includes('PRIVATE_SUMMARY_SESSION'));
});

test('real serve strips unsupported Sol anchors without corrupting schemas', { skip: SKIP }, async (t) => {
  const { base, seen } = await startServe(t);
  const body = { model: 'gpt-6.1-sol', input: [{ role: 'user', content: [{ type: 'input_text', text: 'stable context',
    prompt_cache_breakpoint: { mode: 'explicit' } }] }],
    tools: [{ type: 'function', name: 'x', parameters: { type: 'object', properties: { prompt_cache_breakpoint: { type: 'string' } } } }] };
  for (const route of ['/v1/responses', '/backend-api/codex/responses']) {
    const res = await fetch(base + route, { method: 'POST', headers, body: JSON.stringify(body) });
    assert.equal(res.status, 200);
    await res.text();
    const out = JSON.parse(seen.at(-1).body);
    assert.equal(Boolean(out.input[0].content[0].prompt_cache_breakpoint), false);
    assert.deepEqual(out.tools[0].parameters.properties.prompt_cache_breakpoint, { type: 'string' });
  }
});

test('canonical GPT compaction keeps complete tool outputs and bypasses tool checkpoints', { skip: SKIP }, async (t) => {
  const { base, seen, home } = await startServe(t, { PXLITE_RECALL: '0', PXPIPE_MODELS: 'gpt-6.1-sol' });
  const input = [{ role: 'user', content: [{ type: 'input_text', text: 'previous task' }] }];
  for (let i = 0; i < 40; i++) input.push(
    { type: 'function_call', call_id: `s${i}`, name: 'shell', arguments: '{"command":"node check.mjs"}' },
    { type: 'function_call_output', call_id: `s${i}`, output: 'Complete build output.\n'.repeat(100) },
  );
  const body = { model: 'gpt-6.1-sol', instructions: 'Your task is to create a detailed summary of this conversation.', input };
  const res = await fetch(base + '/v1/responses', { method: 'POST',
    headers: { ...headers, 'x-opencode-session-id': 'compact-fixture' }, body: JSON.stringify(body) });
  assert.equal(res.status, 200);
  await res.text();
  assert.deepEqual(JSON.parse(seen.at(-1).body), body);
  const evs = readEvents(home);
  assert.ok(evs.every(e => !e.tool_collapse));
});

test('GPT history epochs remain enabled when tool-result collapse is disabled', { skip: SKIP }, async (t) => {
  const { base, home } = await startServe(t, { PXLITE_RECALL: '0', PXLITE_TOOL_COLLAPSE: '0', PXPIPE_MODELS: 'gpt-6.1-sol' });
  const res = await fetch(base + '/v1/responses', { method: 'POST',
    headers: { ...headers, 'x-opencode-session-id': 'independent-history-fixture' },
    body: JSON.stringify({ model: 'gpt-6.1-sol', input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }] }),
  });
  assert.equal(res.status, 200);
  await res.text();
  let evs = [];
  for (let i = 0; i < 50 && !evs.length; i++) { evs = readEvents(home); if (!evs.length) await sleep(100); }
  // 160 is the default since 13cbb9b ("increase checkpoint interval to 160"); this test still said 130.
  assert.equal(evs[0]?.gpt_history_checkpoint_chunk, 160);
  assert.ok(!evs[0].tool_collapse);
});

test('config.default.json: every GPT-wire model renders Spleen 5x8 with 2px rows', async () => {
  if (SKIP) return;
  const cfg = JSON.parse(fs.readFileSync(path.join(HERE, 'config.default.json'), 'utf8'));
  const before = process.env.PXPIPE_GPT_PROFILES;
  process.env.PXPIPE_GPT_PROFILES = JSON.stringify(cfg.gptProfiles);
  try {
    const { resolveGptProfile } = await import(pathToFileURL(path.join(VENDOR, 'dist', 'core', 'gpt-model-profiles.js')).href);
    for (const model of ['gpt-6.1-sol', 'gpt-6.1-sol-fast', 'gpt-6.1-terra', 'deepseek-v4.1-flash-free', 'opencode/deepseek-v4.1-flash-free']) {
      const { style } = resolveGptProfile(model);
      assert.equal(style.font, 'spleen-5x8', model);
      assert.equal(style.cellHBonus, 2, model);
    }
  } finally {
    if (before === undefined) delete process.env.PXPIPE_GPT_PROFILES;
    else process.env.PXPIPE_GPT_PROFILES = before;
  }
});

// Rules under test (pxlite.mjs + dedupe-blocks.mjs), checked on the body the upstream receives:
// - full body: a <browser_instruction> block repeated verbatim in the body becomes one marker line; first copy kept.
// - delta body (no tools, short system): a block already seen in the same session_id becomes the marker; other session: kept.
// - text typed next to the block stays; models pxpipe does not image are untouched.
const BI = '<browser_instruction>\nUse the browser tools only on pages the user named.\n' + 'b'.repeat(2000) + '\n</browser_instruction>';
const DEDUPE_MARK = '[browser_instruction lặp lại nguyên văn bản ở lượt trước — đã lược]';
const claudeHeaders = (sid) => ({ ...headers, 'x-api-key': 'k', 'anthropic-version': '2023-06-01', ...(sid ? { 'x-claude-code-session-id': sid } : {}) });
const userText = (text) => ({ role: 'user', content: [{ type: 'text', text }] });
const fullExtra = { system: [{ type: 'text', text: 'S'.repeat(3000) }], tools: [{ name: 'Read', description: 'read', input_schema: { type: 'object' } }] };
// pxpipe may put a short note ahead of the first user text, so each text is matched by its end;
// BI and the marker differ at the start of the block, so the end still tells them apart.
function assertUserTexts(entry, want, name) {
  const got = upstreamUserTexts(entry);
  assert.equal(got.length, want.length, name);
  for (const [i, w] of want.entries()) assert.ok(got[i].endsWith(w), `${name}: user text ${i} ends with ${JSON.stringify(w.slice(0, 40))}…, got …${JSON.stringify(got[i].slice(-w.length - 20, -w.length + 60))}`);
  const blocks = got.join('\n').split('<browser_instruction>').length - 1;
  assert.equal(blocks, want.join('\n').split('<browser_instruction>').length - 1, `${name}: number of verbatim blocks`);
}
// A request that carries images (here: history rendered into pages) gets the read-the-images reminder as an
// extra last text block (appendReadNote). It is pxlite's own block, not typed text, so it is left out of the
// comparison; only a block equal to the note is dropped, any other stray text still fails the asserts.
const { readNoteText } = await import(pathToFileURL(path.join(VENDOR, 'dist', 'core', 'transform.js')).href);
const READ_NOTE = readNoteText();
const upstreamUserTexts = (entry) =>
  JSON.parse(entry.body)
    .messages.filter((m) => m.role === 'user')
    .map((m) => (typeof m.content === 'string' ? m.content : m.content.filter((b) => b.type === 'text' && !(READ_NOTE && b.text === READ_NOTE)).map((b) => b.text).join('|')));

async function postClaude(base, seen, sid, body) {
  const n = seen.length;
  const res = await fetch(`${base}/v1/messages`, { method: 'POST', headers: claudeHeaders(sid), body: JSON.stringify({ max_tokens: 8, ...body }) });
  assert.equal(res.status, 200);
  await res.text();
  // pxpipe may also call /v1/messages/count_tokens for a model it images; pick the request itself.
  const sent = seen.slice(n).filter((e) => /^\/v1\/messages(\?|$)/.test(e.url));
  assert.equal(sent.length, 1, 'one Messages request reached the upstream');
  return sent[0];
}

test('dedupe: repeated browser_instruction is replaced upstream in full and delta bodies, typed text kept', { skip: SKIP }, async (t) => {
  const { base, seen } = await startServe(t, { PXPIPE_MODELS: 'claude-test' });
  const S1 = 'aaaaaaaa-1111-2222-3333-444444444444';
  const S2 = 'bbbbbbbb-1111-2222-3333-444444444444';
  const full = await postClaude(base, seen, S1, {
    model: 'claude-test',
    ...fullExtra,
    messages: [userText(`${BI}\nopen example.com`), { role: 'assistant', content: [{ type: 'text', text: 'done' }] }, userText(`${BI}\nnow click login`)],
  });
  assertUserTexts(full, [`${BI}\nopen example.com`, `${DEDUPE_MARK}\nnow click login`], 'full body');

  const delta = await postClaude(base, seen, S1, { model: 'claude-test', messages: [userText(`${BI}\nscroll down`)] });
  assertUserTexts(delta, [`${DEDUPE_MARK}\nscroll down`], 'delta, same session');

  const other = await postClaude(base, seen, S2, { model: 'claude-test', messages: [userText(`${BI}\nscroll down`)] });
  assertUserTexts(other, [`${BI}\nscroll down`], 'delta, other session');

  const noSid = await postClaude(base, seen, null, { model: 'claude-test', messages: [userText(`${BI}\nx`)] });
  assertUserTexts(noSid, [`${BI}\nx`], 'delta, no session id');

  const unsupported = await postClaude(base, seen, S1, { model: 'claude-other', ...fullExtra, messages: [userText(BI), userText(BI)] });
  assertUserTexts(unsupported, [BI, BI], 'model pxpipe does not image');
});

test('dedupe: PXLITE_DEDUPE_TAGS empty or 0 turns it off', { skip: SKIP }, async (t) => {
  for (const value of ['', '0']) {
    const { base, seen } = await startServe(t, { PXPIPE_MODELS: 'claude-test', PXLITE_DEDUPE_TAGS: value });
    const up = await postClaude(base, seen, 'cccccccc-1111-2222-3333-444444444444', { model: 'claude-test', ...fullExtra, messages: [userText(`${BI}\nq1`), userText(`${BI}\nq2`)] });
    assertUserTexts(up, [`${BI}\nq1`, `${BI}\nq2`], JSON.stringify(value));
  }
});

test('event rows: recall_applied/_images/_bytes only on the request that received a recall', { skip: SKIP }, async (t) => {
  const { base, seen, home } = await startServe(t, { PXPIPE_MODELS: 'claude-test' });
  const CUR = 'cccccccc-1111-2222-3333-444444444444';
  const OLD = 'aaaaaaaa-1111-2222-3333-444444444444';
  const OTHER = 'bbbbbbbb-1111-2222-3333-444444444444';
  const proj = path.join(home, '.claude', 'projects', 'D--FIXTURE');
  fs.mkdirSync(proj, { recursive: true });
  const L = (o) => JSON.stringify({ cwd: 'D:\\FIXTURE', ...o }) + '\n';
  fs.writeFileSync(path.join(proj, `${CUR}.jsonl`), L({ type: 'user', message: { role: 'user', content: 'hi' } }));
  // The older session must be at least 6000 bytes to count as a recall candidate.
  fs.writeFileSync(path.join(proj, `${OLD}.jsonl`), Array.from({ length: 60 }, (_, i) =>
    L({ type: 'user', message: { role: 'user', content: `OLD question ${i} about the parser` } }) +
    L({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `OLD answer ${i} ${'detail '.repeat(12)}` }] } })).join(''));

  const T0 = Date.now();
  const trace = (m) => process.env.PXLITE_TEST_TRACE && console.error(`[trace +${Date.now() - T0}ms] ${m}`);
  let recalled;
  try {
    recalled = await postClaude(base, seen, CUR, { model: 'claude-test', messages: [userText('recall aaaaaaaa')] });
  } catch (err) {
    trace(`postClaude failed: ${err.message}; upstream saw ${seen.map((e) => `${e.method} ${e.url} ${e.body.length}b`).join(', ')}`);
    throw err;
  }
  trace(`recall request done, upstream body ${recalled.body.length} bytes`);
  const hasImage = (b) => JSON.stringify(JSON.parse(b).messages).includes('"type":"image"');
  assert.ok(hasImage(recalled.body), 'the upstream request carries the recall images');
  await postClaude(base, seen, OTHER, { model: 'claude-test', messages: [userText('hello, no recall here')] });

  let evs = [];
  for (let i = 0; i < 60; i++) {
    evs = readEvents(home).filter((e) => e.path === '/v1/messages');
    if (evs.some((e) => e.session_id === CUR) && evs.some((e) => e.session_id === OTHER)) break;
    await sleep(100);
  }
  const withRecall = evs.find((e) => e.session_id === CUR);
  const without = evs.find((e) => e.session_id === OTHER);
  assert.ok(withRecall && without, 'both requests have an event row');
  assert.equal(withRecall.recall_applied, true);
  assert.ok(withRecall.recall_images >= 1, `recall_images=${withRecall.recall_images}`);
  assert.ok(withRecall.recall_bytes > 0, `recall_bytes=${withRecall.recall_bytes}`);
  assert.equal(without.recall_applied, undefined);
  assert.equal(without.recall_images, undefined);
  assert.equal(without.recall_error, undefined);
});

test('session_id comes from the header even when the body is not JSON', { skip: SKIP }, async (t) => {
  const { base, home } = await startServe(t);
  const SID = 'dddddddd-1111-2222-3333-444444444444';
  const res = await fetch(`${base}/v1/messages`, { method: 'POST', headers: claudeHeaders(SID), body: '{"model": "claude-test", broken' });
  await res.text();
  let ev;
  for (let k = 0; k < 50 && !ev; k++) {
    ev = readEvents(home).find((e) => e.path === '/v1/messages');
    if (!ev) await sleep(100);
  }
  assert.ok(ev, 'no event logged');
  assert.equal(ev.session_id, SID);
  assert.equal(ev.agent_role, 'main');
});

// NODE_USE_ENV_PROXY exists from Node 22.21 / 24.5; on older Node the request would reach api.anthropic.com.
const [NODE_MAJOR, NODE_MINOR] = process.versions.node.split('.').map(Number);
const HAS_ENV_PROXY = NODE_MAJOR > 24 || (NODE_MAJOR === 24 && NODE_MINOR >= 5) || (NODE_MAJOR === 22 && NODE_MINOR >= 21);

test('PXLITE_ANTHROPIC_UPSTREAM set but empty falls back to the default Anthropic upstream', { skip: SKIP || (!HAS_ENV_PROXY && 'needs NODE_USE_ENV_PROXY (Node >= 22.21 or >= 24.5)') }, async (t) => {
  // An HTTP proxy that only records CONNECT targets and refuses them, so nothing leaves the machine.
  const targets = [];
  const proxy = http.createServer((req, res) => res.end());
  proxy.on('connect', (req, socket) => {
    targets.push(req.url);
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  t.after(() => proxy.close());
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  const { base } = await startServe(t, { PXLITE_ANTHROPIC_UPSTREAM: '', NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: proxyUrl, https_proxy: proxyUrl, NO_PROXY: '', no_proxy: '' });
  const res = await fetch(`${base}/v1/messages`, { method: 'POST', headers: claudeHeaders(null), body: JSON.stringify({ model: 'claude-test', max_tokens: 8, messages: [userText('hi')] }) });
  await res.text();
  // pxpipe may open a second connection for count_tokens; every one goes to the default host.
  assert.ok(targets.length > 0, 'nothing reached the default upstream');
  assert.deepEqual([...new Set(targets)], ['api.anthropic.com:443']);
});

test('served Claude conversation: transcript pointer starts on the first collapse and the log says so', { skip: SKIP }, async (t) => {
  const WORDS = 'proxy cache prefix image chunk history tail agent tool result check step limit write read'.split(' ');
  let seed = 7;
  const prose = (n) => Array.from({ length: n }, () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return WORDS[seed % WORDS.length]; }).join(' ');
  const code = (n) => Array.from({ length: n }, (_, i) => `  const v${i} = compute(${prose(3).replace(/ /g, ', ')}); // ${prose(5)}`).join('\n');
  const all = [{ role: 'user', content: [{ type: 'text', text: 'start the task' }] }];
  for (let r = 0; r < 200; r++) {
    const id = `toolu_${String(r).padStart(4, '0')}`;
    all.push({ role: 'assistant', content: [{ type: 'text', text: prose(40) }, { type: 'tool_use', id, name: 'Read', input: { file_path: `/repo/f${r}.js` } }] });
    all.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `TOKEN_R${String(r).padStart(4, '0')}_X\n${code(60)}` }] });
  }
  const { base, home } = await startServe(t, { PXPIPE_MODELS: 'claude-opus-5-5' });
  const send = async (n) => {
    const messages = structuredClone(all.slice(0, n));
    messages.at(-1).content.at(-1).cache_control = { type: 'ephemeral' };
    const res = await fetch(`${base}/v1/messages`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'k', 'anthropic-version': '2023-06-01', 'x-opencode-session-id': 'ses_e2etranscript' },
      body: JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 8, system: 'You are a coding agent. ' + prose(600), messages }) });
    await res.text();
  };
  for (const n of [81, 121, 161, 201, 241, 281, 321, 361, 401]) await send(n);
  await sleep(300);
  const rows = readEvents(home).filter((e) => e.path === '/v1/messages');
  console.log(rows.map((e) => `${e.collapsed_turns ?? 0}/${e.history_reason}/${e.history_transcript ?? '-'}`).join('  '));
  assert.ok(rows.some((e) => e.collapsed_turns > 0), 'the conversation never collapsed, so this test proves nothing');
  assert.ok(rows.some((e) => e.history_transcript), 'collapsed requests carried no history_transcript tag');
  assert.ok(fs.existsSync(path.join(home, '.pxpipe', 'transcripts')), 'no transcripts directory was created');
});
