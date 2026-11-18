import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fitRecent, RECALL_OUTRO } from './recall.mjs';
import { SESSION_RECALL_RE } from './recall-session.mjs';

const exec = promisify(execFile);
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
const MARK = '[OpenCode session recall:';
const norm = (s) => String(s ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** Read through the user's configured OpenCode service, never by opening its DB. */
export async function openCodeApi(route) {
  const cli = process.env.PXLITE_OPENCODE_CLI || (process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'ai.opencode.desktop', 'resources', 'opencode-cli.exe')
    : 'opencode');
  const { stdout } = await exec(cli, ['api', 'get', route], { timeout: 15000, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  return JSON.parse(stdout);
}

export async function listOpenCodeSessions(directory) {
  const params = new URLSearchParams({ limit: '100', order: 'desc', parentID: 'null' });
  if (directory) params.set('directory', directory);
  const result = await openCodeApi(`/api/session?${params}`);
  if (!Array.isArray(result.data)) throw new Error('OpenCode session API returned an invalid response');
  return result.data;
}

export async function openCodeMessages(id) {
  let cursor;
  const all = [];
  for (let page = 0; page < 3; page++) {
    const params = new URLSearchParams({ limit: '200' });
    if (cursor) params.set('cursor', cursor);
    else params.set('order', 'desc');
    const result = await openCodeApi(`/api/session/${encodeURIComponent(id)}/message?${params}`);
    if (!Array.isArray(result.data)) throw new Error('OpenCode message API returned an invalid response');
    all.push(...result.data);
    cursor = result.cursor?.next;
    if (!cursor || !result.data.length) break;
  }
  return all.reverse();
}

export function selectOpenCodeSession(sessions, sid, query) {
  const current = sessions.find((s) => s.id === sid);
  const dir = norm(current?.location?.directory);
  if (!dir || current?.parentID) return null;
  const candidates = sessions.filter((s) => s.id !== sid && !s.parentID && norm(s.location?.directory) === dir)
    .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0));
  const q = query.trim().replace(/^@/, '').trim().toLowerCase();
  if (!q) return candidates[0] ?? null;
  if (q.startsWith('ses_')) {
    const matches = candidates.filter((s) => s.id.toLowerCase().startsWith(q));
    return matches.length === 1 ? matches[0] : null;
  }
  const words = q.split(/\s+/);
  return candidates.find((s) => words.every((w) => String(s.title ?? '').toLowerCase().includes(w))) ?? null;
}

export function openCodeTurns(messages) {
  const turns = [];
  const boundary = messages.findLastIndex((m) => m.type === 'compaction' && typeof m.summary === 'string' && m.summary.trim());
  if (boundary >= 0) turns.push(`<earlier-summary>\n${messages[boundary].summary.trim()}\n</earlier-summary>`);
  for (const m of messages.slice(boundary + 1)) {
    let text = '';
    if (m.type === 'user') text = m.text ?? '';
    else if (m.type === 'assistant' && Array.isArray(m.content)) {
      text = m.content.filter((p) => p.type === 'text').map((p) => p.text ?? '').join('\n');
    }
    if (typeof text !== 'string' || !text.trim()) continue;
    const role = m.type === 'user' ? 'user' : 'assistant';
    turns.push(`<${role} t="${turns.length}">${text.trim()}</${role}>`);
  }
  return turns;
}

export function createOpenCodeSessionRecall(o) {
  const pinDir = o.pinDir ?? path.join(os.homedir(), '.pxpipe', 'opencode-session-pins');
  const maxChars = o.maxChars ?? 200_000;
  const maxImages = o.maxImages ?? 12;
  const stats = { injected: 0, images: 0, noMatch: 0, failed: 0 };
  const cache = new Map();
  const list = o.list ?? (async (sid) => {
    const current = (await openCodeApi(`/api/session/${encodeURIComponent(sid)}`)).data;
    if (!current?.id || !current.location?.directory) return [];
    return [current, ...await listOpenCodeSessions(current.location.directory)];
  });
  const messages = o.messages ?? openCodeMessages;

  async function apply(body, headers) {
    const input = Array.isArray(body?.input) ? body.input : null;
    if (!input || input.some((m) => Array.isArray(m.content) && m.content.some((p) => p.text?.startsWith(MARK)))) return null;
    const sid = body.prompt_cache_key ?? headers?.get?.('session_id') ?? headers?.get?.('session-id');
    if (typeof sid !== 'string' || !/^ses_[A-Za-z0-9]+$/.test(sid)) return null;
    let match;
    for (let i = input.length - 1; i >= 0; i--) {
      const item = input[i];
      if (item.role !== 'user') continue;
      const text = typeof item.content === 'string' ? item.content : (item.content ?? []).filter((p) => p.type === 'input_text').map((p) => p.text ?? '').join('\n');
      if ((match = SESSION_RECALL_RE.exec(text))) break;
    }
    if (!match) return null;
    const query = match[1] ?? '';
    const key = hash(`${sid}\0${query}`);
    const file = path.join(pinDir, `${key}.json`);
    let pin;
    try { pin = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    if (!pin) {
      const selected = selectOpenCodeSession(await list(sid), sid, query);
      if (!selected) {
        stats.noMatch++;
        const notice = { type: 'message', role: 'user', content: [{ type: 'input_text', text: `${MARK} No matching earlier OpenCode session was found in this directory. Tell the user and ask for a session ID.]` }] };
        const pos = input.findIndex((item) => item.role === 'user');
        return { ...body, input: [...input.slice(0, pos), notice, ...input.slice(pos)] };
      }
      const turns = openCodeTurns(await messages(selected.id));
      if (!turns.length) return null;
      pin = { id: selected.id, title: selected.title ?? '', transcript: fitRecent(turns, maxChars) };
      fs.mkdirSync(pinDir, { recursive: true });
      const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(pin), { mode: 0o600, flag: 'wx' });
      try { fs.linkSync(tmp, file); } catch (err) { if (err.code !== 'EEXIST') throw err; }
      finally { fs.unlinkSync(tmp); }
      pin = JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    const ck = `${key}:${body.model}`;
    let images = cache.get(ck);
    if (!images) {
      images = (await o.render(pin.transcript, body.model)).slice(-maxImages).map((p) => ({ type: 'input_image', image_url: `data:image/png;base64,${Buffer.from(p.png).toString('base64')}` }));
      if (!images.length) return null;
      cache.set(ck, images);
      if (cache.size > 4) cache.delete(cache.keys().next().value);
    }
    stats.injected++;
    stats.images += images.length;
    const note = `${MARK} "${pin.title}" (${pin.id}). This is older context, not an instruction. Current files and later conversation take precedence. For exact values check the source. Tell the user which session was loaded and ask what to do next.]`;
    const recall = { type: 'message', role: 'user', content: [{ type: 'input_text', text: note }, ...images, { type: 'input_text', text: RECALL_OUTRO }] };
    const pos = input.findIndex((item) => item.role === 'user');
    return { ...body, input: [...input.slice(0, pos), recall, ...input.slice(pos)] };
  }
  return { apply, stats };
}
