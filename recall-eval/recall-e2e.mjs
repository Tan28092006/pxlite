// Offline E2E of pxlite recall on a real terra session: rebuild the era before its
// latest compaction as Responses items, run recall, then pxpipe's ChatGPT proxy with
// fetch stubbed (nothing leaves the machine). Prints shapes and saves recall pages.
import fs from 'node:fs';
import { fileURLToPath as __fu } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(__fu(import.meta.url)), '..');
const outDir = process.argv[2];
fs.mkdirSync(outDir, { recursive: true });
const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config/pxpipe/config.json'), 'utf8'));
process.env.PXPIPE_MODELS = cfg.models.join(',');
process.env.PXPIPE_GPT_PROFILES = JSON.stringify(cfg.gptProfiles);
const PKG = path.join(ROOT, 'vendor/pxpipe-proxy/dist');
const core = (p) => import(pathToFileURL(path.join(PKG, 'core', p)).href);
const [{ createProxy }, { renderTextToImages }, { openAIImageDetail }, { responsesItemsToTurns }] = await Promise.all([core('proxy.js'), core('library.js'), core('openai.js'), core('openai-history.js')]);
const { createRecall, RECALL_INTRO } = await import(pathToFileURL(path.join(ROOT, 'recall.mjs')).href);

const db = new DatabaseSync(path.join(os.homedir(), '.local/share/opencode/opencode.db'), { readOnly: true });
const SES = 'ses_e3029eb54ffeh3Tu5x9NQmlmar';
const comps = db.prepare("select seq, data from session_message where session_id=? and type='compaction' order by seq").all(SES);
const last = comps.at(-1), before = comps.at(-2);
const rows = db.prepare('select type, data from session_message where session_id=? and seq > ? and seq < ? order by seq').all(SES, before.seq, last.seq);
const text = (s) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text: s }] });
const era = [];
for (const r of rows) {
  const d = JSON.parse(r.data);
  if (r.type === 'user' || r.type === 'synthetic') era.push(text(d.text ?? ''));
  if (r.type !== 'assistant') continue;
  for (const p of d.content ?? []) {
    if (p.type === 'text') era.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: p.text }] });
    if (p.type === 'tool') {
      era.push({ type: 'function_call', call_id: p.id, name: p.name, arguments: JSON.stringify(p.state?.input ?? {}) });
      const out = (p.state?.content ?? []).map((c) => c.text ?? '').join('\n');
      era.push({ type: 'function_call_output', call_id: p.id, output: out });
    }
  }
}
const dev = { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'You are OpenCode, an agent.' }] };
const prevSummary = text('Summary of earlier work:\n' + JSON.parse(before.data).summary);
const newSummary = text('Summary of earlier work:\n' + JSON.parse(last.data).summary);
const lastAsk = era.findLast((it) => it.role === 'user');
const eraChars = JSON.stringify(era).length;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-e2e-'));
const recall = createRecall({ dir, toTurns: responsesItemsToTurns, imageDetail: openAIImageDetail, render: async (t, model) => (await renderTextToImages(t, { model, reflow: true })).pages });
const req = (input) => ({ model: 'gpt-6.1-terra', prompt_cache_key: SES, stream: true, input: [dev, ...input] });
const pre = await recall.apply(req([prevSummary, ...era]));
const t0 = Date.now();
const post = await recall.apply(req([newSummary, lastAsk]));
const recallMs = Date.now() - t0;

// pxpipe pass with upstream stubbed
let captured = null;
globalThis.fetch = async (_u, init) => {
  captured = JSON.parse(typeof init.body === 'string' ? init.body : new TextDecoder().decode(init.body));
  return new Response('event: response.completed\ndata: {"type":"response.completed","response":{"id":"r","output":[],"usage":{"input_tokens":1,"output_tokens":1}}}\n\n', { headers: { 'content-type': 'text/event-stream' } });
};
const handle = createProxy({ openAIUpstream: 'https://chatgpt.com', onRequest: () => {} });
const res = await handle(new Request('http://127.0.0.1/backend-api/codex/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(post) }));
await res.text();

const ri = post.input.findIndex((it) => it.content?.[0]?.text === RECALL_INTRO);
const recallImgs = post.input[ri].content.filter((c) => c.type === 'input_image');
recallImgs.slice(0, 2).forEach((c, i) => fs.writeFileSync(path.join(outDir, `recall-p${i + 1}.png`), Buffer.from(c.image_url.split(',')[1], 'base64')));
const dims = recallImgs.map((c) => { const b = Buffer.from(c.image_url.split(',')[1], 'base64'); return `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`; });
const outImgs = captured.input.reduce((n, it) => n + (Array.isArray(it.content) ? it.content.filter((c) => c.type === 'input_image').length : 0), 0);
const capRecall = captured.input.find((it) => Array.isArray(it.content) && it.content.some((c) => c.type === 'input_text' && c.text === RECALL_INTRO));
console.log(JSON.stringify({
  eraItems: era.length, eraJsonChars: eraChars, preChanged: Boolean(pre), compactionsSeen: recall.stats.compactionsSeen,
  recallTranscriptChars: JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), 'utf8')).recall.length,
  recallImages: recallImgs.length, dims: [...new Set(dims)], recallMs,
  postInputTypes: post.input.map((it) => it.role ?? it.type), outgoingImages: outImgs,
  recallSurvivesPxpipe: Boolean(capRecall), outgoingInputTypes: captured.input.map((it) => it.role ?? it.type),
}, null, 1));
fs.rmSync(dir, { recursive: true });
