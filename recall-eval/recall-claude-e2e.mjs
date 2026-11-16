// Offline E2E of Claude Code recall on a real transcript: rebuild the request Claude
// Code sends after the latest compaction (summary + later turns), run recall, then
// pxpipe's Anthropic transform. Nothing is sent. usage: node recall-claude-e2e.mjs <transcript.jsonl> <outDir>
import fs from 'node:fs';
import { fileURLToPath as __fu } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(__fu(import.meta.url)), '..');
const [file, outDir] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config/pxpipe/config.json'), 'utf8'));
process.env.PXPIPE_MODELS = cfg.models.join(',');
const core = (p) => import(pathToFileURL(path.join(ROOT, 'vendor/pxpipe-proxy/dist/core', p)).href);
const [{ transformAnthropicMessages, renderTextToImages }] = await Promise.all([core('library.js')]);
const { createClaudeRecall, CLAUDE_RECALL_INTRO, claudeEraTurns, RECENT_TURNS } = await import(pathToFileURL(path.join(ROOT, 'recall-claude.mjs')).href);
const { analyze } = await import(pathToFileURL(path.join(ROOT, 'classify.mjs')).href);

const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
const b = lines.findLastIndex((e) => e.type === 'system' && e.subtype === 'compact_boundary');
const msgs = [];
for (const e of lines.slice(b + 1)) {
  if ((e.type !== 'user' && e.type !== 'assistant') || e.isSidechain || !e.message) continue;
  let content = e.message.content;
  if (typeof content === 'string') content = [{ type: 'text', text: content }];
  content = content.filter((x) => x.type !== 'thinking' && x.type !== 'redacted_thinking');
  if (!content.length) continue;
  const last = msgs.at(-1);
  if (last && last.role === e.message.role) last.content.push(...content);
  else msgs.push({ role: e.message.role, content: [...content] });
}
while (msgs.length && msgs.at(-1).role !== 'user') msgs.pop();
const body = { model: 'claude-opus-5-5', max_tokens: 1000, system: [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }], messages: msgs };

const recall = createClaudeRecall({ render: async (t, model) => (await renderTextToImages(t, { model, reflow: true })).pages });
let t0 = Date.now();
const withRecall = await recall.apply(body);
const firstMs = Date.now() - t0;
t0 = Date.now();
await recall.apply(body);
const cachedMs = Date.now() - t0;
const imgs = withRecall.messages[0].content.filter((x) => x.type === 'image');
imgs.slice(0, 2).forEach((x, i) => fs.writeFileSync(path.join(outDir, `claude-recall-p${i + 1}.png`), Buffer.from(x.source.data, 'base64')));
const dims = imgs.map((x) => { const p = Buffer.from(x.source.data, 'base64'); return [p.readUInt32BE(16), p.readUInt32BE(20)]; });

const r = await transformAnthropicMessages({ body: new TextEncoder().encode(JSON.stringify(withRecall)), model: 'claude-opus-5-5', options: { keepSharp: (x) => analyze(x.text).reason !== null, emitRecoverable: false } });
const out = JSON.parse(new TextDecoder().decode(r.body));
let wire = 0;
const walk = (c) => { for (const x of Array.isArray(c) ? c : []) { if (x.type === 'image') wire++; if (x.type === 'tool_result') walk(x.content); } };
out.messages.forEach((m) => walk(m.content));
// pxpipe wraps opening-turn text in a marker and preview, so look for the whole intro as a substring.
const intro = JSON.stringify(out).includes(JSON.stringify(CLAUDE_RECALL_INTRO).slice(1, -1));
// Recent turns must reach the wire verbatim: probe the last recent turn's first long line.
const raw = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
const eraTurns = claudeEraTurns(raw.slice(0, raw.findLastIndex((l) => l.includes('"subtype":"compact_boundary"')) + 1));
const lastTurn = eraTurns.slice(-RECENT_TURNS).at(-1) ?? '';
const probe = lastTurn.split('\n').find((l) => l.length > 40 && !l.startsWith('<') && !l.startsWith('[tool')) ?? '';
const probeEsc = JSON.stringify(probe).slice(1, -1).slice(0, 60);
const recentOnWire = probe ? JSON.stringify(out).includes(probeEsc) : null;
const recentChars = withRecall.messages[0].content.filter((x) => x.type === 'text' && /^<(user|assistant) t=/.test(x.text)).reduce((s, x) => s + x.text.length, 0);
// Where do the recall images land after pxpipe? (first messages, text truncated)
const shape = out.messages.slice(0, 3).map((m, i) => `${i} ${m.role}: ` + (Array.isArray(m.content) ? m.content.map((x) => (x.type === 'text' ? `text(${x.text.length}):${JSON.stringify(x.text.slice(0, 160))}` : x.type)).join(' | ') : 'string'));
fs.writeFileSync(path.join(outDir, 'out-shape.txt'), shape.join('\n'));
console.log(JSON.stringify({
  postCompactMessages: msgs.length, recallImages: imgs.length, dims: [...new Set(dims.map((d) => d.join('x')))],
  claudeImageTokens: dims.reduce((s, [w, h]) => s + Math.ceil((w * h) / 750), 0), firstMs, cachedMs,
  pxpipeApplied: r.applied, wireImages: wire, recallIntroSurvives: intro, recentTurnsOnWire: recentOnWire, recentTextChars: recentChars, stats: recall.stats,
}, null, 1));
