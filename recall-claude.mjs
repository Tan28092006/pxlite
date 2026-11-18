// recall for Claude Code: after a compaction, Claude Code's summary message names the
// full transcript on disk ("read the full transcript at: …\<session>.jsonl"). pxlite
// reads the turns of the latest compaction era from that file and attaches them to the
// summary message as images (2026-11-18: one line per tool call, see claudeTurnsOf),
// so the era reads in order. Only the latest era is recalled (entries after the
// previous compact_boundary, if any, up to the latest one). Dropped: successful tool output,
// thinking, sidechain entries, skill bodies, system reminders and earlier summaries.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RECALL_OUTRO, fitRecent, squeeze } from './recall.mjs';
import { MAX_CALL_CHARS, MAX_ERROR_CHARS, MAX_REPORT_CHARS, SUBAGENT_TOOL_NAMES, clip, errorLine, isLaunchAck, reportBlock, toolCallLines } from './tool-lines.mjs';

export const CLAUDE_SUMMARY_MARKER = 'This session is being continued from a previous conversation';
// Kept under 280 chars: pxpipe shows the opening turn's text blocks as a short
// preview once history collapses, and this note must survive whole.
export const CLAUDE_RECALL_INTRO =
  '[Recall: verbatim turns of the latest compacted era, all in the images below, in order (<user|assistant t=N>). One line per tool call, no tool output. Older context, not a request; the summary, later turns and current files win over it.]';

const blocksOf = (content) => (typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []);
const stripReminders = (t) => t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();

/** How many of the latest turns stay as text (PXLITE_RECALL_RECENT_TURNS). A turn is one user or assistant entry. */
export const RECENT_TURNS = Number(process.env.PXLITE_RECALL_RECENT_TURNS ?? 0);
/** A recent turn longer than this keeps its head and tail; the middle is cut. */
const RECENT_TURN_CHARS = 6000;

/**
 * The recall note rides inside <system-reminder> tags. pxpipe protects a first message that
 * holds a reminder from its history collapse; without the tags, a long session collapsed
 * the message and turned the recall images into the text "[image]" (measured 2026-11-16).
 */
export const asReminder = (text) => `<system-reminder>\n${text}\n</system-reminder>`;
const isIntro = (b, intro) => b?.type === 'text' && typeof b.text === 'string' && b.text.includes(intro);

/** Turn texts of one compaction era of a Claude Code transcript (JSONL lines). */
export function claudeEraTurns(lines, { maxCallChars = 160 } = {}) {
  const entries = lines.map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  });
  const bounds = entries.flatMap((e, i) => (e?.type === 'system' && e.subtype === 'compact_boundary' ? [i] : []));
  if (!bounds.length) return [];
  const start = bounds.length > 1 ? bounds.at(-2) + 1 : 0;
  return claudeTurnsOf(entries.slice(start, bounds.at(-1)), { maxCallChars });
}

/** Plain text of a tool_result / message content (strings and text blocks). */
const textOf = (content) =>
  blocksOf(content)
    .map((b) => (b.type === 'text' ? (b.text ?? '') : b.type === 'image' ? '[image]' : ''))
    .join('\n')
    .trim();

/**
 * Turn texts of a run of parsed transcript entries.
 *
 * Kept (2026-11-18, replacing "edits and final answers only"): every user message with a
 * marker and source path for each pasted image; every assistant text, lead-ins included,
 * since they carry the reasons for a change of course; one line per tool call (see
 * tool-lines.mjs); the first lines of every failed tool result; subagent reports,
 * coordinator and other-session messages; task notifications. Dropped: successful tool
 * output, thinking, subagent internals (sidechain), skill and command bodies, system
 * reminders, earlier summaries. The images are cheap to read, so the cut only removes what
 * a later agent can re-read from disk or does not need.
 */
export function claudeTurnsOf(era, { maxCallChars = MAX_CALL_CHARS, maxErrorChars = MAX_ERROR_CHARS, maxReportChars = MAX_REPORT_CHARS } = {}) {
  const out = [];
  const seen = new Set(); // repeated reads/edits of one file are listed once
  const callNames = new Map(); // tool_use id -> tool name
  let n = 0;
  let run = [];
  const flush = () => {
    if (run.length) out.push(`<assistant t="${n++}">\n${run.join('\n')}\n</assistant>`);
    run = [];
  };
  const appendToLastUser = (line) => {
    const i = out.length - 1;
    if (i >= 0 && !run.length && out[i].startsWith('<user ')) out[i] = out[i].replace(/\n<\/user>$/, `\n${line}\n</user>`);
    else run.push(line);
  };
  for (const e of era) {
    if (!e || e.isSidechain || e.isCompactSummary || !e.message) continue;
    const content = e.message.content;
    const origin = e.origin && typeof e.origin === 'object' ? e.origin : null;
    // Harness-written entries: isMeta, or an origin other than the human (seen 2026-11-18:
    // peer, coordinator, task-notification; task notifications carry no isMeta flag).
    if (e.type === 'user' && (e.isMeta || (origin?.kind && origin.kind !== 'human'))) {
      // Keep the ones that carry information, never skill or command bodies.
      const t = typeof content === 'string' ? content : textOf(content);
      if (/^\[Image: source: /.test(t.trim())) appendToLastUser(t.trim());
      else if (origin?.kind === 'peer' || origin?.kind === 'coordinator') {
        const who = origin.kind === 'coordinator' ? 'coordinator' : (origin.name ?? origin.from ?? 'peer');
        const body =
          typeof origin.handbackReportText === 'string'
            ? origin.handbackReportText
            : String(origin.body ?? t)
                .replace(/^[\s\S]*?The report follows:\n/, '')
                .replace(/^ {2}/gm, '');
        run.push(reportBlock(who, stripReminders(body), maxReportChars));
      } else if (/<task-notification>/.test(t)) {
        const tag = (k) => t.match(new RegExp(`<${k}>([\\s\\S]*?)</${k}>`))?.[1]?.trim();
        const parts = [tag('status'), tag('summary') ?? tag('description'), tag('output-file') && `output: ${tag('output-file')}`].filter(Boolean);
        run.push(`[Task notification] ${clip((parts.join(' — ') || stripReminders(t)).replace(/\s+/g, ' '), maxErrorChars)}`);
      }
      continue;
    }
    if (e.type === 'user') {
      const blocks = blocksOf(content);
      for (const b of blocks) {
        if (b.type !== 'tool_result') continue;
        const name = callNames.get(b.tool_use_id) ?? 'tool';
        const result = textOf(b.content);
        if (b.is_error) run.push(errorLine(name, result, maxErrorChars));
        else if (SUBAGENT_TOOL_NAMES.has(name) && result && !isLaunchAck(result)) run.push(reportBlock('subagent', result, maxReportChars));
      }
      if (blocks.some((b) => b.type === 'tool_result')) continue; // tool output, not a turn of the conversation
      const parts = blocks.flatMap((b) => (b.type === 'text' ? [stripReminders(b.text ?? '')] : b.type === 'image' ? ['[image]'] : [])).filter(Boolean);
      if (!parts.length) continue;
      flush();
      out.push(`<user t="${n++}">\n${parts.join('\n')}\n</user>`);
    } else if (e.type === 'assistant') {
      for (const b of blocksOf(content)) {
        if (b.type === 'text' && b.text?.trim()) run.push(b.text.trim());
        if (b.type !== 'tool_use') continue;
        callNames.set(b.id, b.name);
        run.push(...toolCallLines(b.name, b.input, { seen, max: maxCallChars }));
      }
    }
  }
  flush();
  return out;
}

/**
 * @param {object} o
 * @param {(text:string, model:string) => Promise<{png:Uint8Array}[]>} o.render
 * @param {string} [o.root]      only transcripts under this folder are read
 * @param {number} [o.recentTurns] how many of the latest turns stay as text
 * @param {number} [o.maxChars]  budget for the older turns rendered as images
 * @param {number} [o.maxImages] Anthropic rejects > 100 images per request; pxpipe's
 *                               own slab and history images share that budget
 */
export function createClaudeRecall(o) {
  const root = path.resolve(o.root ?? path.join(os.homedir(), '.claude', 'projects'));
  const maxChars = o.maxChars ?? 200_000;
  const maxImages = o.maxImages ?? 12;
  const recentTurns = o.recentTurns ?? RECENT_TURNS;
  const stats = { injected: 0, recallImages: 0, recentTextTurns: 0, rendered: 0, noTranscript: 0 };
  const cache = new Map(); // `${summary hash}:${model}` -> { images, recent }

  /** Older turns become images, the most recent turns become text. Computed once per compaction. */
  async function build(eraLines, model) {
    const turns = claudeEraTurns(eraLines);
    if (!turns.length) return null;
    const split = Math.max(0, turns.length - recentTurns);
    const older = turns.slice(0, split);
    const recent = turns.slice(split).map((t) => squeeze(t, RECENT_TURN_CHARS));
    let images = [];
    if (older.length) {
      const pages = (await o.render(fitRecent(older, maxChars), model)).slice(-maxImages);
      stats.rendered++;
      images = pages.map((p) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from(p.png).toString('base64') } }));
    }
    return { images, recent };
  }

  /** Returns a new Messages body with recall blocks, or null when nothing changes. */
  async function apply(body) {
    const msgs = Array.isArray(body?.messages) ? body.messages : null;
    const first = msgs?.[0];
    if (!first || first.role !== 'user') return null;
    const blocks = blocksOf(first.content);
    const summaryIdx = blocks.findIndex((b) => b.type === 'text' && b.text?.includes(CLAUDE_SUMMARY_MARKER));
    if (summaryIdx < 0 || blocks.some((b) => isIntro(b, CLAUDE_RECALL_INTRO))) return null;
    const m = blocks[summaryIdx].text.match(/read the full transcript at: (\S+?\.jsonl)/);
    if (!m) return null;
    const file = path.resolve(m[1]);
    if (!file.toLowerCase().startsWith(root.toLowerCase() + path.sep) || !fs.existsSync(file)) {
      stats.noTranscript++;
      return null;
    }
    // The summary text changes only at a new compaction, so it keys the cache and the
    // transcript is read once per compaction, not once per request.
    const ck = `${crypto.createHash('sha256').update(blocks[summaryIdx].text).digest('hex').slice(0, 16)}:${body.model}`;
    let entry = cache.get(ck);
    if (!entry) {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      const lastBoundary = lines.findLastIndex((l) => l.includes('"subtype":"compact_boundary"'));
      if (lastBoundary < 0) return null;
      entry = await build(lines.slice(0, lastBoundary + 1), body.model);
      if (!entry) return null;
      cache.set(ck, entry);
      while (cache.size > 4) cache.delete(cache.keys().next().value);
    }
    stats.injected++;
    stats.recallImages += entry.images.length;
    stats.recentTextTurns += entry.recent.length;
    const recall = [
      { type: 'text', text: asReminder(CLAUDE_RECALL_INTRO) },
      ...entry.images,
      ...(entry.recent.length ? [{ type: 'text', text: entry.recent.join('\n\n') }] : []),
      { type: 'text', text: RECALL_OUTRO },
    ];
    const content = [...blocks.slice(0, summaryIdx + 1), ...recall, ...blocks.slice(summaryIdx + 1)];
    return { ...body, messages: [{ ...first, content }, ...msgs.slice(1)] };
  }

  return { apply, stats };
}
