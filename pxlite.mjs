#!/usr/bin/env node
// pxlite: a slim pxpipe proxy for long Claude Code sessions.
//   - images prose and code only: data-like tool_results stay text (classify.mjs)
//   - events.jsonl is size-capped and aged out (rotlog.mjs)
//   - no dashboard (no in-memory event replay), smaller render cache
// Built on pxpipe-proxy's core createProxy; the HTTP glue mirrors dist/node.js.
//
// Usage: node pxlite.mjs [serve|stop|status|classify <file>]
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { analyze, applyScale } from './classify.mjs';
import { RotatingLog } from './rotlog.mjs';
import { classifyCompaction, decodeRequestBody, stripCacheBreakpoints } from './compat.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRecall, describeResponsesShape } from './recall.mjs';
import { createClaudeRecall } from './recall-claude.mjs';
import { createBlockDedupe, parseDedupeTags } from './dedupe-blocks.mjs';
import { createToolCollapse, ttlMsOf } from './collapse-tools.mjs';
import { listSessions, sessionInfo } from './recall-session.mjs';
import { listOpenCodeSessions } from './recall-opencode-session.mjs';
import { createRecallSessions } from './recall-sessions.mjs';
import { createGptCachePolicy, toGptCacheSeedEvent } from './gpt-cache-policy.mjs';
import { createGptPrefixTracker } from './gpt-prefix.mjs';
import { describeGptUpstream, describeGptResponse } from './gpt-upstream-diagnostics.mjs';

// Set by serve() when recall is enabled; used by toWebRequest on request bodies.
let recall = null; // OpenCode, Responses
let claudeRecall = null; // Claude Code, Messages
let chatRecall = null; // OpenCode providers on Chat Completions (opencode/*, e.g. deepseek)
let claudeToolCollapse = null; // old successful Bash/Edit/Write results (collapse-tools.mjs)
let claudeDedupe = null; // repeated injected blocks in Claude Messages (dedupe-blocks.mjs)
let gptCachePolicy = null;
const gptPrefixes = createGptPrefixTracker();

// Per-request flags read by proxyConfig.transform(), which pxpipe calls with no
// arguments inside the request's async context.
const requestCtx = new AsyncLocalStorage();
// A compaction summary is what the next session lives on; one test (2026-11-15) showed
// a summary read from history images keep a superseded Codex setup as the final one.
// So compaction requests go upstream as plain text unless PXLITE_COMPACT_IMAGES=1.
const COMPACT_IMAGES = /^(1|true|yes|on)$/i.test(process.env.PXLITE_COMPACT_IMAGES ?? '');

const TESTED_PXPIPE = '0.16.0';
const HOME = os.homedir();
const STATE_DIR = path.join(HOME, '.pxpipe');
const PORT = Number(process.env.PORT ?? 47821);
const PID_FILE = path.join(STATE_DIR, `pxlite-${PORT}.pid`);
const HOST = '127.0.0.1';
const CONNECT_PORT = Number(process.env.PXLITE_CONNECT_PORT ?? PORT + 1);
// Vendored pxpipe 0.16.0 whose glyph atlases add Vietnamese (build/atlas, vi-eval/RESULTS.md).
const PKG = process.env.PXLITE_PKG ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'vendor', 'pxpipe-proxy');
const VERBOSE = /^(1|true|yes|on)$/i.test(process.env.PXLITE_VERBOSE ?? '');

const cmd = process.argv[2] ?? 'serve';
if (cmd === 'classify') classifyCmd(process.argv.slice(3));
else if (cmd === 'stop') stopCmd();
else if (cmd === 'status') await statusCmd();
else if (cmd === 'serve') { await ensureVendor(); await serve(); }
else if (cmd === 'sessions') await sessionsCmd(process.argv.slice(3));
else if (cmd === 'setup') await (await import('./setup.mjs')).setupCmd(process.argv.slice(3), { pxliteMjs: fileURLToPath(import.meta.url), port: PORT, connectPort: CONNECT_PORT, stateDir: STATE_DIR });
else if (cmd === 'recall-test') await (await import('./recall-test.mjs')).recallTest(process.argv.slice(3));
else {
  console.error('usage: pxlite [serve|stop|status|classify <file>...|sessions [--all] [words]|setup [claude-vscode|codex|opencode|autostart] [--undo] [--yes]|recall-test [--client ...] [--model ...] [--all] [--wait]]');
  process.exit(64);
}

// vendor/ is built by npm's postinstall; build it on first run when that step was skipped
// (npm config ignore-scripts, or a copy of the repo that was never installed).
async function ensureVendor() {
  if (process.env.PXLITE_PKG || fs.existsSync(path.join(PKG, 'package.json'))) return;
  console.log('[pxlite] building vendor/pxpipe-proxy (first run)');
  await import('./scripts/postinstall.mjs');
}

// Earlier Claude Code sessions of the current folder (or of every project with --all), newest
// first: the names that "recall <words>" matches, and the ids it accepts.
async function sessionsCmd(args) {
  const all = args.includes('--all');
  const words = args.filter((a) => a !== '--all').join(' ').toLowerCase().split(/\s+/).filter(Boolean);
  const projects = path.join(HOME, '.claude', 'projects');
  const dirs = all ? (fs.existsSync(projects) ? fs.readdirSync(projects).map((n) => path.join(projects, n)) : []) : [path.join(projects, process.cwd().replace(/[^A-Za-z0-9]/g, '-'))];
  const rows = dirs.flatMap((d) => listSessions(d).filter((s) => s.size >= 6000).slice(0, all ? 40 : 200).map((s) => ({ ...s, ...sessionInfo(s.file, s.size), project: path.basename(d) })));
  const shown = rows
    .filter((r) => words.every((w) => `${r.title}\n${r.first}`.toLowerCase().includes(w)))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, 20);
  for (const r of shown) {
    const when = new Date(r.mtimeMs).toISOString().slice(0, 16).replace('T', ' ');
    console.log(`[claude] ${r.id.slice(0, 8)}  ${when}  ${String(Math.round(r.size / 1024)).padStart(6)} KB  ${r.title || r.first.slice(0, 60).replace(/\s+/g, ' ')}${all ? `  [${r.project}]` : ''}`);
  }
  try {
    const oc = (await listOpenCodeSessions(all ? undefined : process.cwd()))
      .filter((s) => words.every((w) => String(s.title ?? '').toLowerCase().includes(w)))
      .slice(0, 20);
    for (const s of oc) {
      const when = new Date(s.time?.updated ?? 0).toISOString().slice(0, 16).replace('T', ' ');
      console.log(`[opencode] ${s.id}  ${when}  ${s.title || 'untitled'}${all ? `  [${s.location?.directory ?? ''}]` : ''}`);
    }
    if (!shown.length && !oc.length) console.log(all ? 'no sessions found' : `no sessions found for ${process.cwd()} (try --all)`);
  } catch (err) {
    console.warn(`pxlite: OpenCode sessions unavailable: ${err.message}`);
    if (!shown.length) process.exitCode = 1;
  }
}

function classifyCmd(files) {
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    const asRead = text.split('\n').map((l, i) => String(i + 1).padStart(6) + '\t' + l).join('\n');
    const { reason } = analyze(asRead);
    const verdict = reason ? `text (${reason})` : asRead.length < 6000 ? 'text (below 6000 chars)' : 'image allowed';
    console.log(`${verdict.padEnd(26)} ${f}`);
  }
}

function readPid() {
  try {
    return Number(fs.readFileSync(PID_FILE, 'utf8').trim()) || undefined;
  } catch {
    return undefined;
  }
}

function stopCmd() {
  const pid = readPid();
  if (!pid) return console.log('pxlite: not running (no pid file)');
  try {
    process.kill(pid);
    console.log(`pxlite: stopped pid ${pid}`);
  } catch (err) {
    console.log(`pxlite: pid ${pid} not running (${err.code})`);
  }
  fs.rmSync(PID_FILE, { force: true });
}

async function statusCmd() {
  try {
    const res = await fetch(`http://${HOST}:${PORT}/pxlite/status`);
    console.log(JSON.stringify(await res.json(), null, 2));
  } catch {
    console.log(`pxlite: not listening on ${HOST}:${PORT}`);
    process.exitCode = 1;
  }
}

// ~/.config/pxpipe/config.json: {"models": [...], "gptProfiles": {prefix: partial profile}}.
// Environment variables win over the file.
function applyConfigFileModels() {
  const file = process.env.PXPIPE_CONFIG ?? path.join(HOME, '.config', 'pxpipe', 'config.json');
  // Without a user file, use the config.default.json that ships with pxlite (models imaged and the
  // Spleen 5x8 + 2px-row profile for every GPT-wire model), so a fresh install images the same
  // models as the author's setup.
  const shipped = path.join(path.dirname(fileURLToPath(import.meta.url)), 'config.default.json');
  let cfg;
  for (const f of [file, shipped]) {
    try {
      cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
      break;
    } catch {
      // try the next one
    }
  }
  if (!cfg) return; // keep pxpipe's built-in defaults
  const models = cfg.models;
  if (process.env.PXPIPE_MODELS === undefined) {
    if (Array.isArray(models)) process.env.PXPIPE_MODELS = models.join(',') || 'off';
    else if (typeof models === 'string') process.env.PXPIPE_MODELS = models.trim() || 'off';
  }
  if (process.env.PXPIPE_GPT_PROFILES === undefined && cfg.gptProfiles && typeof cfg.gptProfiles === 'object') {
    process.env.PXPIPE_GPT_PROFILES = JSON.stringify(cfg.gptProfiles);
  }
}

function fileStore(file) {
  return {
    load: () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined),
    save(text) {
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, text, { mode: 0o600 });
      fs.renameSync(tmp, file);
    },
  };
}

// PXLITE_DEBUG_SHAPE=1 appends content-free shapes of Responses requests (incoming
// from the client, outgoing after pxpipe) to ~/.pxpipe/shape-debug.jsonl.
const DEBUG_SHAPE = /^(1|true|yes|on)$/i.test(process.env.PXLITE_DEBUG_SHAPE ?? '');
function debugShape(dir, url, body, headers) {
  try {
    const text = typeof body === 'string' ? body : new TextDecoder().decode(body);
    const rec = { ts: new Date().toISOString(), dir, url: String(url).replace(/^https?:\/\/[^/]+/, ''), ...describeResponsesShape(JSON.parse(text), headers) };
    fs.appendFileSync(path.join(os.homedir(), '.pxpipe', 'shape-debug.jsonl'), JSON.stringify(rec) + '\n');
  } catch (err) {
    console.warn(`[pxlite] shape debug failed: ${err.message}`);
  }
}

// Codex's built-in ChatGPT provider zstd-compresses request bodies; pxpipe must see
// plain JSON to transform them, so buffer and decode those before handing over.
async function toWebRequest(req) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v == null) continue;
    if (Array.isArray(v)) v.forEach((vv) => headers.append(k, vv));
    else headers.append(k, v);
  }
  const method = req.method ?? 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const anthropicMessages = method === 'POST' && /^\/v1\/messages(\?|$)/.test(req.url ?? '');
  const responses = method === 'POST' && /^\/(backend-api\/codex|v1)\/responses(\?|$)/.test(req.url ?? '');
  // OpenCode's own provider (`opencode/*`, e.g. deepseek) speaks Chat Completions at
  // opencode.ai/inference/openai/v1. pxpipe only recognizes the canonical shape, so the
  // request is rewritten to /v1/chat/completions and forwarded to the opencode base.
  const openCodeChat = method === 'POST' && /^\/inference\/openai\/v1\/chat\/completions(\?|$)/.test(req.url ?? '');
  const openCodeResponses = method === 'POST' && /^\/inference\/openai\/v1\/responses(\?|$)/.test(req.url ?? '');
  const canonicalChat = method === 'POST' && /^\/v1\/chat\/completions(\?|$)/.test(req.url ?? '');
  const gptWire = responses || canonicalChat || openCodeChat || openCodeResponses;
  const urlPath = openCodeChat
    ? (req.url ?? '').replace(/^\/inference\/openai\/v1\/chat\/completions/, '/v1/chat/completions')
    : openCodeResponses
      ? (req.url ?? '').replace(/^\/inference\/openai\/v1\/responses/, '/v1/responses')
      : req.url ?? '/';
  const url = `http://${req.headers.host ?? 'localhost'}${urlPath}`;
  if (hasBody && (headers.has('content-encoding') || anthropicMessages || gptWire)) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const plain = headers.has('content-encoding') ? decodeRequestBody(headers.get('content-encoding'), raw) : null;
    if (plain) {
      headers.delete('content-encoding');
      headers.set('content-length', String(plain.byteLength));
    }
    let bytes = plain ?? raw;
    const c = anthropicMessages || gptWire ? classifyCompaction(bytes) : { compact: false, where: null };
    let tags = null;
    if (anthropicMessages) {
      let parsed;
      try {
        parsed = JSON.parse(bytes.toString('utf8'));
      } catch {}
      // Headers are read even when the body does not parse, so the session id survives.
      tags = claudeRequestTags(parsed, headers);
      if (parsed && claudeDedupe) {
        try {
          // One conversation = session id plus subagent id: a subagent has its own server-side history.
          const sessionKey = tags.session_id ? `${tags.session_id}\u0000${headers.get('x-claude-code-agent-id') ?? ''}` : null;
          if (claudeDedupe.apply(parsed, { sessionKey, bodyKind: tags.body_kind }) > 0) {
            bytes = Buffer.from(JSON.stringify(parsed));
            headers.set('content-length', String(bytes.byteLength));
          }
        } catch (err) {
          // Dedupe must never break a request: forward the body as it was.
          console.warn(`[pxlite] dedupe skipped: ${err.message}`);
        }
      }
      // Collapse old successful Bash/Edit/Write results (collapse-tools.mjs); never on the compaction request.
      if (parsed && claudeToolCollapse && !c.compact) {
        try {
          const sessionKey = tags.session_id ? `${tags.session_id}\u0000${headers.get('x-claude-code-agent-id') ?? ''}` : null;
          const report = {};
          const collapsed = claudeToolCollapse.apply(parsed, { sessionKey, report });
          tags.tool_collapse = report;
          if (collapsed > 0) {
            bytes = Buffer.from(JSON.stringify(parsed));
            headers.set('content-length', String(bytes.byteLength));
          }
        } catch (err) {
          console.warn(`[pxlite] tool collapse skipped: ${err.message}`);
        }
      }
    }
    // Recall: OpenCode Responses (recall.mjs) and Claude Code Messages after a
    // compaction (recall-claude.mjs); never on the compaction request itself.
    const r = openCodeChat ? chatRecall : responses || openCodeResponses ? recall : anthropicMessages && !c.compact ? claudeRecall : null;
    if (anthropicMessages && process.env.PXLITE_DEBUG_META) {
      try {
        const b = JSON.parse(bytes.toString('utf8'));
        const sysText = JSON.stringify(b.system ?? '');
        console.error('[pxlite] meta', JSON.stringify({ keys: Object.keys(b), metadata: b.metadata, cwd: sysText.match(/Primary working directory: [^\\"]{0,120}/)?.[0], hdrKeys: [...headers.keys()].filter((k) => /session|claude|anthropic-/i.test(k)) }));
      } catch {}
    }
    if (r) {
      try {
        const next = await r.apply(JSON.parse(bytes.toString('utf8')), headers);
        if (next) {
          bytes = Buffer.from(JSON.stringify(next));
          headers.set('content-length', String(bytes.byteLength));
        }
      } catch (err) {
        // Recall must never break a request: forward the original body.
        console.warn(`[pxlite] recall skipped: ${err.message}`);
      }
    }
    // All GPT wires, including canonical /v1 and Codex, not only opencode.ai.
    // Runs after recall so snapshots keep full original tool results.
    let gptHistory, gptPolicyRequest, gptPrefixContext;
    if (gptWire && !c.compact) {
      try {
        const parsed = JSON.parse(bytes.toString('utf8'));
        const sid = headers.get('x-opencode-session-id') ?? parsed?.prompt_cache_key ?? headers.get('session_id') ?? headers.get('session-id');
        const report = {};
        const wire = Array.isArray(parsed?.input) ? 'responses' : 'chat';
        const supportedGpt = /^(?:openai\/)?(?:gpt-|o\d)/i.test(parsed.model ?? '');
        const configuredChunk = Number.parseInt(process.env.PXLITE_GPT_CHECKPOINT_CHUNK ?? '130', 10);
        const checkpointChunk = Number.isFinite(configuredChunk) && configuredChunk >= 0 ? configuredChunk : 130;
        const summaryMode = process.env.PXLITE_GPT_REASONING_MODE !== 'native';
        const sourceKey = summaryMode && wire === 'responses'
          ? createHash('sha256').update(JSON.stringify([
            parsed.input.find(item => item?.role === 'user') ?? null,
            parsed.instructions ?? null, parsed.tools ?? null,
            parsed.input.length >= 8 ? parsed.input.slice(0, 8) : null,
          ])).digest('hex') : undefined;
        if (sid && supportedGpt) {
          gptPrefixContext = { sessionKey: sourceKey ? `${sid}\u0000${sourceKey}` : sid, route: new URL(url).pathname };
          if (wire === 'responses' && checkpointChunk > 1) gptPolicyRequest = gptCachePolicy?.forRequest({
            sessionKey: sid, model: parsed.model, route: new URL(url).pathname,
            ...(summaryMode ? { historyMode: 'summary', sourceKey } : {}) });
        }
        // A second, independently advancing destructive boundary would bypass the
        // whole-prefix gate. Managed Responses fold old tools inside the selected
        // history epoch instead. Claude/Chat retain their existing tool policy.
        const collapsed = gptPolicyRequest ? 0 : claudeToolCollapse?.apply(parsed, { sessionKey: sid ? `oc\u0000${sid}\u0000${parsed.model ?? ''}\u0000${wire}` : null, report }) ?? 0;
        if (gptPolicyRequest) Object.assign(report, { has_key: true,
          n: parsed.input.length, boundary: gptPolicyRequest.cacheGate.heldCutoff ?? 0,
          collapsed: 0, mode: 'history_cache_gate' });
        if (claudeToolCollapse) tags = { ...tags, tool_collapse: report };
        // Fixed input-item epochs for managed GPT sessions. Read/write accounting
        // is not a clock: in particular, cache_write=0 does not mean cache is dead.
        if (sid && supportedGpt) {
          gptHistory = { checkpointChunk };
          if (gptPolicyRequest && gptHistory.checkpointChunk > 1) {
            Object.assign(gptHistory, { cacheGate: gptPolicyRequest.cacheGate,
              preserveClientImages: true });
            if (summaryMode) {
              const tail = Number.parseInt(process.env.PXLITE_GPT_NATIVE_TAIL ?? '30', 10);
              Object.assign(gptHistory, { reasoningMode: 'summary',
                keepTail: Number.isFinite(tail) ? Math.max(30, tail) : 30 });
            } else {
              const keep = Number.parseInt(process.env.PXLITE_GPT_REASONING_KEEP ?? '50', 10);
              gptHistory.reasoningKeep = Number.isFinite(keep) && keep >= 0 ? keep : 50;
            }
          }
          tags = { ...tags, gpt_history_checkpoint_chunk: gptHistory.checkpointChunk };
        }
        if (collapsed > 0) {
          bytes = Buffer.from(JSON.stringify(parsed));
          headers.set('content-length', String(bytes.byteLength));
        }
      } catch (err) {
        console.warn(`[pxlite] tool collapse (opencode) skipped: ${err.message}`);
      }
    }
    const request = new Request(url, { method, headers, body: bytes });
    request.pxliteCompact = c.compact;
    request.pxliteCompactWhere = c.where;
    request.pxliteTags = tags;
    request.pxliteGptHistory = gptHistory;
    request.pxliteGptPolicy = gptPolicyRequest;
    request.pxliteGptPrefixContext = gptPrefixContext;
    if ((responses || openCodeResponses) && DEBUG_SHAPE) debugShape('in', req.url, plain ?? raw, headers);
    return request;
  }
  const body = hasBody
    ? new ReadableStream({
        start(c) {
          req.on('data', (chunk) => c.enqueue(chunk));
          req.on('end', () => c.close());
          req.on('error', (e) => c.error(e));
        },
      })
    : undefined;
  return new Request(url, {
    method,
    headers,
    body,
    duplex: hasBody ? 'half' : undefined,
  });
}

async function writeWebResponse(res, out) {
  out.statusCode = res.status;
  res.headers.forEach((v, k) => out.setHeader(k, v));
  if (!res.body) return void out.end();
  out.flushHeaders();
  const reader = res.body.getReader();
  const cancel = () => void reader.cancel().catch(() => {});
  out.once('close', cancel);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value && !out.write(value)) await new Promise((ok, fail) => {
        out.once('drain', ok);
        out.once('close', () => fail(new Error('client response closed')));
      });
    }
    if (!out.writableEnded) out.end();
  } catch (err) {
    if (!out.destroyed) out.destroy(err instanceof Error ? err : undefined);
  } finally {
    out.off('close', cancel);
  }
}

// Labels for a Claude Messages request in events.jsonl, so cost reports can split
// tokens by session and body kind. Ids and labels only, never prompt text.
// OpenCode's session header wins over the process-wide Claude auth plugin UUID.
// agent_role: Claude Code sends x-claude-code-agent-id only on subagent requests
// (measured 2026-11-18, claude-cli 2.1.310: every subagent turn had it, no main-loop
// request did). Without the session header the client is not Claude Code: unknown.
// body_kind: delta when the body carries no tools and its system prompt, billing
// line excluded, is under 2000 chars (pxpipe's "new part only" body); else full.
const BILLING_LINE = 'x-anthropic-billing-header';
const DELTA_SYSTEM_MAX = 2000;
// body is undefined when the request body is not JSON: session_id and agent_role still come
// from the headers, body_kind is left out.
function claudeRequestTags(body, headers) {
  const tags = {};
  const openCodeSid = headers.get('x-opencode-session-id');
  let sid = openCodeSid || headers.get('x-claude-code-session-id');
  if (!sid) {
    try {
      sid = JSON.parse(body?.metadata?.user_id ?? '{}')?.session_id;
    } catch {}
  }
  if (typeof sid === 'string' && sid) tags.session_id = sid;
  tags.agent_role = openCodeSid
    ? (headers.get('x-opencode-parent-session-id') ? 'subagent' : 'main')
    : headers.get('x-claude-code-agent-id') ? 'subagent' : headers.get('x-claude-code-session-id') ? 'main' : 'unknown';
  if (!body || typeof body !== 'object') return tags;
  const sys = typeof body?.system === 'string' ? [{ text: body.system }] : Array.isArray(body?.system) ? body.system : [];
  const sysChars = sys.reduce((n, b) => (typeof b?.text !== 'string' || b.text.startsWith(BILLING_LINE) ? n : n + b.text.length), 0);
  const hasTools = Array.isArray(body?.tools) && body.tools.length > 0;
  tags.body_kind = !hasTools && sysChars < DELTA_SYSTEM_MAX ? 'delta' : 'full';
  return tags;
}

function slimEvent(ev) {
  for (const k of Object.keys(ev)) if (k.startsWith('req_body_') && k !== 'req_body_sha8') delete ev[k];
  if (typeof ev.error_body === 'string' && ev.error_body.length > 400) ev.error_body = ev.error_body.slice(0, 400) + '…';
  return ev;
}

// Read only a bounded tail of numerical events. Never retain body samples,
// messages, tool arguments, errors or credentials as statistical training data.
function gptCacheSeed(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - 2 * 1024 * 1024);
    const data = Buffer.alloc(size - start);
    fs.readSync(fd, data, 0, data.length, start);
    const lines = data.toString('utf8').split('\n');
    if (start) lines.shift();
    return lines.slice(-4096).flatMap(line => {
      let e;
      try { e = JSON.parse(line); } catch { return []; }
       const sample = toGptCacheSeedEvent(e);
       return sample ? [sample] : [];
    });
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[pxlite] cache statistics unavailable: ${err.code ?? 'read_error'}`);
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

async function serve() {
  // Must be set before pxpipe's render module loads: it reads the cap once at import.
  process.env.PXPIPE_RENDER_CACHE_BYTES ??= String(16 * 1024 * 1024);
  applyConfigFileModels();
  const core = (p) => import(pathToFileURL(path.join(PKG, 'dist', p.includes('/') ? '' : 'core', p)).href);
  const version = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8')).version;
  if (version !== TESTED_PXPIPE) console.warn(`[pxlite] pxpipe-proxy ${version} found, tested with ${TESTED_PXPIPE}; core API may differ`);
  const [{ createProxy }, { toTrackEvent }, sessions] = await Promise.all([core('proxy.js'), core('tracker.js'), core('session-state.js')]);

  fs.mkdirSync(STATE_DIR, { recursive: true });
  sessions.configureSessionStateStore(fileStore(path.join(STATE_DIR, 'session-state.json')));
  const log = new RotatingLog(process.env.PXPIPE_LOG ?? path.join(STATE_DIR, 'events.jsonl'), {
    // 50 MB live + one 50 MB backup = at most 100 MB on disk.
    maxBytes: Number(process.env.PXLITE_LOG_MAX_BYTES ?? 50 * 1024 * 1024),
    maxAgeDays: Number(process.env.PXLITE_LOG_MAX_DAYS ?? 14),
  });
  const disabled = /^(1|true|yes|on)$/i.test(process.env.PXPIPE_DISABLE ?? '');
  const stats = { started: new Date().toISOString(), requests: 0, compressed: 0, keptText: {}, imageBytes: 0 };

  // Repeated injected blocks (dedupe-blocks.mjs), only for models pxpipe images.
  // PXLITE_DEDUPE_TAGS: comma-separated tag names, default browser_instruction; '' or 0 = off.
  const dedupeTags = parseDedupeTags(process.env.PXLITE_DEDUPE_TAGS);
  if (!disabled && dedupeTags.length) {
    const { isPxpipeSupportedModel } = await core('applicability.js');
    const d = createBlockDedupe({ tags: dedupeTags });
    stats.dedupe = d.stats;
    claudeDedupe = { apply: (body, opts) => (isPxpipeSupportedModel(String(body?.model ?? '')) ? d.apply(body, opts) : 0) };
  }

  // PXLITE_TOOL_COLLAPSE=0 turns tool-result collapsing off; _CHUNK / _KEEP tune it (messages).
  if (!disabled && !/^(0|false|no|off)$/i.test(process.env.PXLITE_TOOL_COLLAPSE ?? '')) {
    const { isPxpipeSupportedModel } = await core('applicability.js');
    const tc = createToolCollapse({
      chunk: Number(process.env.PXLITE_TOOL_COLLAPSE_CHUNK ?? 50),
      keepTail: Number(process.env.PXLITE_TOOL_COLLAPSE_KEEP ?? 30),
      ttlMs: ttlMsOf(process.env.PXLITE_CACHE_TTL ?? '1h'),
    });
    claudeToolCollapse = { apply: (body, opts) => (isPxpipeSupportedModel(String(body?.model ?? '')) ? tc.apply(body, opts) : 0) };
  }

  // Recall after OpenAI server-side compaction (recall.mjs). Off with PXLITE_RECALL=0.
  if (!disabled && !/^(0|false|no|off)$/i.test(process.env.PXLITE_RECALL ?? '')) {
    const [{ renderTextToImages }, { openAIImageDetail }, { responsesItemsToTurns }] = await Promise.all([core('library.js'), core('openai.js'), core('openai-history.js')]);
    const r = createRecall({
      dir: path.join(STATE_DIR, 'recall'),
      toTurns: responsesItemsToTurns,
      render: async (text, model) => (await renderTextToImages(text, { model, reflow: true })).pages,
      imageDetail: openAIImageDetail,
      maxChars: Number(process.env.PXLITE_RECALL_MAX_CHARS ?? 800_000),
      maxImages: Number(process.env.PXLITE_RECALL_MAX_IMAGES ?? 50),
    });
    stats.recall = r.stats;
    const cr = createClaudeRecall({
      render: async (text, model) => (await renderTextToImages(text, { model, reflow: true })).pages,
      maxChars: Number(process.env.PXLITE_RECALL_MAX_CHARS ?? 800_000),
      maxImages: Number(process.env.PXLITE_RECALL_CLAUDE_MAX_IMAGES ?? 50),
    });
    stats.claudeRecall = cr.stats;
    // Recall only for models pxpipe itself images (config.json / PXPIPE_MODELS), so a model
    // outside that scope, such as Haiku, never receives images it was not validated for.
    const { isPxpipeSupportedModel } = await core('applicability.js');
    // "recall <name>" typed in a new session (recall-sessions.mjs): one implementation for
    // every client and request shape, Claude Code sessions and OpenCode sessions are
    // interchangeable candidates of the same directory. Falls back to the post-compaction recalls.
    const sr = createRecallSessions({
      render: async (text, model) => (await renderTextToImages(text, { model, reflow: true })).pages,
      maxChars: Number(process.env.PXLITE_RECALL_MAX_CHARS ?? 800_000),
      maxImages: Number(process.env.PXLITE_RECALL_SESSION_MAX_IMAGES ?? 50),
    });
    stats.sessionRecall = sr.stats.claude;
    stats.openCodeSessionRecall = sr.stats.opencode;
    chatRecall = {
      apply: async (body, headers) => (isPxpipeSupportedModel(String(body?.model ?? '')) ? sr.apply(body, headers, 'chat') : null),
    };
    claudeRecall = { apply: async (body, headers) => (isPxpipeSupportedModel(String(body?.model ?? '')) ? (await sr.apply(body, headers)) ?? cr.apply(body) : null) };
    recall = {
      // Codex marks its requests with an `originator` header (codex_cli_rs, Codex Desktop …)
      // and has its own compaction.
      apply: async (body, headers) => {
        if (/codex/i.test(headers?.get?.('originator') ?? '')) return null;
        if (!isPxpipeSupportedModel(String(body?.model ?? ''))) return null;
        const withCompaction = await r.apply(body, headers);
        try {
          return (await sr.apply(withCompaction ?? body, headers)) ?? withCompaction;
        } catch (err) {
          sr.stats.opencode.failed++;
          console.warn(`[pxlite] session recall skipped: ${err.message}`);
          return withCompaction;
        }
      },
    };
  }

  // PXLITE_KEEP_SCALE: multiplier on every data-detection limit. Default 1.5 (measured with
  // scripts/keep-report.mjs: keeps 16.7% of tool_result chars as text instead of 22.3%).
  // Higher images more; 0 images everything, including numbers and JSON.
  const keepScale = Number(process.env.PXLITE_KEEP_SCALE ?? 1.5);
  applyScale(Number.isFinite(keepScale) ? keepScale : 1.5);
  if (!disabled && !/^(0|false|no|off)$/i.test(process.env.PXLITE_GPT_CACHE_GATE ?? '')) {
    gptCachePolicy = createGptCachePolicy({ events: gptCacheSeed(log.file),
      ttlMs: ttlMsOf(process.env.PXLITE_CACHE_TTL ?? '1h') });
  }
  const keepSharp = (block) => {
    const { reason } = analyze(block.text);
    if (reason) stats.keptText[reason] = (stats.keptText[reason] ?? 0) + 1;
    return reason !== null;
  };

  const proxyConfig = {
    transform: () => {
      if (disabled) return { compress: false };
      if (requestCtx.getStore()?.compact && !COMPACT_IMAGES) return { compress: false };
      return { keepSharp, gptHistory: requestCtx.getStore()?.gptHistory };
    },
    onRequest: (e) => {
      stats.requests += 1;
      if (e.info?.compressed) {
        stats.compressed += 1;
        stats.imageBytes += e.info.imageBytes ?? 0;
      }
      try {
        const row = { ...toTrackEvent(e), ...requestCtx.getStore()?.tags };
        requestCtx.getStore()?.gptPolicy?.record(row);
        log.write(slimEvent(row));
      } catch (err) {
        console.warn(`[pxlite] event log write failed: ${err.message}`);
      }
      if (VERBOSE) {
        const tag = e.info?.compressed ? `img=${e.info.imageCount}` : (e.info?.reason ?? '');
        console.log(`[${new Date().toISOString()}] ${e.method} ${e.path} ${e.status} ${e.durationMs}ms ${tag}`);
      }
    },
  };
  // PXLITE_ANTHROPIC_UPSTREAM exists so test-serve.mjs can point it at a local server.
  // Set but empty (or blank) counts as unset: pxpipe's default upstream.
  const handle = createProxy({ ...proxyConfig, upstream: process.env.PXLITE_ANTHROPIC_UPSTREAM?.trim() || undefined });
  // Codex and OpenCode with a ChatGPT login call chatgpt.com/backend-api/codex/*;
  // pxpipe forwards OpenAI-shaped paths to one OpenAI base, so give them their own.
  const handleChatGPT = createProxy({ ...proxyConfig, openAIUpstream: 'https://chatgpt.com' });
  // OpenCode's own provider (opencode/*, e.g. deepseek): canonical Chat Completions is
  // rewritten to /v1/chat/completions in toWebRequest, so only the base differs.
  // PXLITE_OPENCODE_UPSTREAM exists so test-serve.mjs can point it at a local server.
  const handleOpenCode = createProxy({ ...proxyConfig, openAIUpstream: process.env.PXLITE_OPENCODE_UPSTREAM?.trim() || 'https://opencode.ai/inference/openai' });
  // Codex needs its measured compatibility fallback. Public OpenAI API models
  // with explicit caching retain their anchors; never apply a global strip.
  const nativeFetch = globalThis.fetch;
  const RESPONSES = /^https:\/\/(chatgpt\.com\/backend-api\/codex|api\.openai\.com\/v1)\/responses/;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
    if (init?.body && RESPONSES.test(url ?? '')) {
      init = { ...init, body: stripCacheBreakpoints(init.body, { url }) };
      if (DEBUG_SHAPE) debugShape('out', url, init.body, new Headers(init.headers));
    }
    const store = requestCtx.getStore();
    if (init?.body && store?.gptPrefixContext && /\/(?:responses|chat\/completions)(?:\?|$)/.test(url ?? '')) {
      try {
        const json = typeof init.body === 'string' ? init.body : new TextDecoder().decode(init.body);
        const report = gptPrefixes.observe(JSON.parse(json), {
          ...store.gptPrefixContext, route: new URL(url).origin + new URL(url).pathname });
        store.tags = { ...store.tags, gpt_prefix: report,
          gpt_upstream: describeGptUpstream(url, json) };
      } catch {
        store.tags = { ...store.tags, gpt_prefix: { status: 'unknown', reason: 'invalid_body' } };
      }
    }
    const response = await nativeFetch(input, init);
    if (store?.tags?.gpt_upstream) {
      try { store.tags = { ...store.tags,
        gpt_upstream: { ...store.tags.gpt_upstream, ...describeGptResponse(response) } }; } catch {}
    }
    return response;
  };
  const pickHandler = (url) => (url?.startsWith('/backend-api/') ? handleChatGPT : url?.startsWith('/inference/openai/') ? handleOpenCode : handle);

  // Persistent HTTPS_PROXY endpoint (what `pxpipe warp` builds per child): clients
  // that cannot be wrapped (VS Code extension, desktop apps) point HTTPS_PROXY here
  // and trust ~/.pxpipe/warp-ca-bundle.pem. Only routed hosts are decrypted; every
  // other host is tunnelled untouched.
  const [{ CertificateAuthority }, { createWarpHandlers }, { parseRoute }] = await Promise.all([
    core('warp/ca.js'),
    core('warp/connect.js'),
    core('warp/route.js'),
  ]);
  const ca = CertificateAuthority.loadOrCreate(STATE_DIR);
  const to = `http://${HOST}:${PORT}`;
  const routes = [
    'api.anthropic.com/v1/messages*',
    // responses only: analytics and other backend-api calls must tunnel untouched
    'chatgpt.com/backend-api/codex/responses*',
    'api.openai.com/v1/responses*',
    // OpenCode's own provider (opencode/*, e.g. deepseek) uses Chat Completions or Responses.
    'opencode.ai/inference/openai/v1/chat/completions*',
    'opencode.ai/inference/openai/v1/responses*',
    'daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent*',
    'daily-cloudcode-pa.googleapis.com/v1internal:generateContent*',
    'generativelanguage.googleapis.com/v1beta/models/*:streamGenerateContent*',
    'generativelanguage.googleapis.com/v1beta/models/*:generateContent*',
  ].map((r) => parseRoute(`${r}=${to}`));
  const diverted = new Set();
  const warp = createWarpHandlers({
    routes,
    ca,
    onDivert: (host, p) => {
      if (diverted.has(host)) return;
      diverted.add(host);
      console.log(`[pxlite] connect: diverting ${host}${p}`);
    },
  });
  const connectServer = http.createServer(warp.handleAbsoluteForm);
  connectServer.on('connect', warp.handleConnect);
  connectServer.on('error', (err) => console.error(`[pxlite] connect proxy disabled: ${err.message}`));
  connectServer.listen(CONNECT_PORT, HOST, () => console.log(`[pxlite] HTTPS_PROXY=http://${HOST}:${CONNECT_PORT}  CA=${ca.bundlePath}`));

  const server = http.createServer((req, res) => {
    Promise.resolve()
      .then(async () => {
        if (req.url === '/pxlite/status') {
          const m = process.memoryUsage();
          const body = { ...stats, models: process.env.PXPIPE_MODELS ?? '(pxpipe default)', connect_port: CONNECT_PORT, ca_bundle: ca.bundlePath, pkg: PKG, pid: process.pid, pxpipe: version, rss_mb: Math.round(m.rss / 1048576), heap_mb: Math.round(m.heapUsed / 1048576), log: log.file, log_bytes: log.size };
          res.setHeader('content-type', 'application/json');
          return void res.end(JSON.stringify(body));
        }
        // pxpipe only transforms HTTP POSTs. Refuse WebSocket upgrades locally with
        // 426 so Codex falls back to HTTP at once instead of retrying upstream.
        if (/websocket/i.test(req.headers.upgrade ?? '')) {
          stats.websocketRefused = (stats.websocketRefused ?? 0) + 1;
          res.statusCode = 426;
          return void res.end('pxlite: WebSocket not supported, use HTTP');
        }
        const webReq = await toWebRequest(req);
        const compact = Boolean(webReq.pxliteCompact);
        if (compact) stats.compactText = (stats.compactText ?? 0) + 1;
        // Marker seen but not treated as compaction: either a session quoting the
        // phrase in history, or a compaction shape pxlite does not know yet.
        else if (webReq.pxliteCompactWhere) {
          stats.compactMarkerElsewhere ??= {};
          stats.compactMarkerElsewhere[webReq.pxliteCompactWhere] = (stats.compactMarkerElsewhere[webReq.pxliteCompactWhere] ?? 0) + 1;
        }
        const handler = pickHandler(req.url);
        await writeWebResponse(await requestCtx.run({ compact, tags: webReq.pxliteTags,
          gptHistory: webReq.pxliteGptHistory, gptPolicy: webReq.pxliteGptPolicy,
          gptPrefixContext: webReq.pxliteGptPrefixContext }, () => handler(webReq)), res);
      })
      .catch((err) => {
        console.error('[pxlite] handler error:', err);
        if (!res.headersSent) res.statusCode = 500;
        if (!res.writableEnded) res.end();
      });
  });
  server.on('error', (err) => {
    console.error(err.code === 'EADDRINUSE' ? `[pxlite] port ${PORT} is in use (another pxpipe/pxlite?)` : `[pxlite] ${err.message}`);
    process.exit(2);
  });
  server.listen(PORT, HOST, () => {
    fs.writeFileSync(PID_FILE, String(process.pid));
    console.log(`[pxlite] listening on http://${HOST}:${PORT} (pxpipe ${version}${disabled ? ', passthrough' : ''}); log ${log.file}`);
  });

  const shutdown = () => {
    sessions.flushSessionState();
    if (readPid() === process.pid) fs.rmSync(PID_FILE, { force: true });
    connectServer.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
