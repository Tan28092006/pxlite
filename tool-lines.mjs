// One-line accounts of tool calls, shared by recall (recall-claude.mjs, recall-opencode-session.mjs)
// and the vendored in-session history collapse (overlay/dist/core/history.js), so a later
// agent reads the same format everywhere. Self-contained: history.js imports it by path.
//
// Policy (2026-11-18): the images are cheap to read, so keep what a later agent needs to
// follow the work — what each call touched (file, command, pattern, skill, subagent task),
// the first lines of a failed call, and subagent reports — and drop what it can re-read from
// disk: successful tool output and file contents.

export const MAX_CALL_CHARS = 200;
export const MAX_ERROR_CHARS = 600;
export const MAX_REPORT_CHARS = 6000;

/** Keep head and tail of an over-long string, marking the cut. */
export function clip(text, max) {
  const t = String(text ?? '');
  if (t.length <= max) return t;
  const half = Math.floor(max / 2);
  return `${t.slice(0, half)} [… ${t.length - max} chars omitted …] ${t.slice(-half)}`;
}

const oneLine = (v, max) => clip(String(v ?? '').replace(/\s+/g, ' ').trim(), max);

/** Tools that write files: listed by path only, never with their content. */
export const EDIT_TOOL_NAMES = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit', 'edit', 'write', 'multiedit', 'patch', 'apply_patch']);
/** Tools that only load tool schemas: no information for a later agent. */
const SILENT_TOOL_NAMES = new Set(['ToolSearch']);
/** Tools that start a subagent; their non-trivial result is its report. */
export const SUBAGENT_TOOL_NAMES = new Set(['Agent', 'Task', 'subagent', 'task']);

const fileOf = (i) => i?.file_path ?? i?.filePath ?? i?.notebook_path ?? i?.path;

/** Paths named in an apply_patch text ("*** Update File: …"). */
const patchFiles = (text) => [...String(text ?? '').matchAll(/^\*\*\* (Update|Add|Delete) File: (.+)$/gm)].map((m) => `${m[1]} ${m[2].trim()}`);

/**
 * The line(s) for one tool call, or [] when the call carries nothing worth keeping.
 * `seen` (optional Set) lists a file read or edited more than once only the first time.
 */
export function toolCallLines(name, input, { seen, max = MAX_CALL_CHARS } = {}) {
  const n = String(name ?? 'tool');
  const i = input && typeof input === 'object' ? input : {};
  if (SILENT_TOOL_NAMES.has(n)) return [];
  const once = (key, line) => {
    if (seen) {
      if (seen.has(key)) return [];
      seen.add(key);
    }
    return [line];
  };
  if (n === 'patch' || n === 'apply_patch') {
    const files = patchFiles(i.patchText ?? i.patch ?? i.input);
    return files.length ? files.flatMap((f) => once(`${n}|${f}`, `[${n}] ${oneLine(f, max)}`)) : [`[${n}]`];
  }
  const file = fileOf(i);
  if (EDIT_TOOL_NAMES.has(n) && typeof file === 'string') return once(`${n}|${file}`, `[${n}] ${oneLine(file, max)}`);
  if ((n === 'Read' || n === 'read') && typeof file === 'string') {
    const range = i.offset || i.limit ? ` (lines ${i.offset ?? 1}+${i.limit ?? ''})` : '';
    return once(`${n}|${file}|${range}`, `[${n}] ${oneLine(file, max)}${range}`);
  }
  switch (n) {
    case 'Bash':
    case 'PowerShell':
    case 'bash':
    case 'shell': {
      const cmd = i.command ?? i.cmd ?? '';
      return [`[${n}] ${oneLine(i.description ? `${i.description}: ${cmd}` : cmd, max)}`];
    }
    case 'Grep':
    case 'Glob':
    case 'grep':
    case 'glob':
      return [`[${n}] ${oneLine(`${i.pattern ?? ''}${i.path ? ` in ${i.path}` : ''}`, max)}`];
    case 'Skill':
    case 'skill':
      return [`[${n}] ${oneLine(`${i.skill ?? i.id ?? i.name ?? ''}${i.args ? ` ${i.args}` : ''}`, max)}`];
    case 'WebFetch':
    case 'WebSearch':
    case 'webfetch':
    case 'websearch':
      return [`[${n}] ${oneLine(i.url ?? i.query ?? '', max)}`];
    default:
      if (SUBAGENT_TOOL_NAMES.has(n)) {
        const kind = i.subagent_type ?? i.agent;
        const tags = [kind, i.run_in_background ? 'background' : ''].filter(Boolean).join(', ');
        return [`[Subagent${tags ? ` ${tags}` : ''}] ${oneLine(i.description ?? '', max)}: ${oneLine(i.prompt ?? '', max)}`];
      }
      return [`[${n}] ${oneLine(safeJson(i), max)}`];
  }
}

function safeJson(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** The line for a failed call's output. */
export const errorLine = (name, text, max = MAX_ERROR_CHARS) => `[${name ?? 'tool'} error] ${oneLine(text, max)}`;

/** A subagent's report or another session's message, kept as a block. */
export const reportBlock = (who, text, max = MAX_REPORT_CHARS) => `[Message from ${who}]\n${clip(String(text ?? '').trim(), max)}`;

/** Whether a subagent call's result is only a launch acknowledgement (the report comes later). */
export const isLaunchAck = (text) => /^(Async agent launched|The subagent is working in the background)/i.test(String(text ?? '').trim());
