// Decide whether a tool_result must stay text (keepSharp) because it is data.
// Prose and source code may be imaged; numbers, JSON, CSV, logs and hashes may not,
// because a misread digit in an image is silent and plausible.

// Claude Code's Read output prefixes each line with "   53\t" or "   53→".
const LINE_NO = /^\s*\d+(?:\t|→)/;
const NUM = /(?<![A-Za-z_$])[-+]?\d+(?:[.,]\d+)?(?:[eE][-+]?\d+)?%?/g;
const WORD = /[A-Za-zÀ-ỹ_][A-Za-zÀ-ỹ_0-9]+/g;
const HEX = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,}\b/gi;
const JSON_KV = /"[^"\n]{1,80}"\s*:/g;
const TIMESTAMP = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
const SEP_ROW = /^[^,\t;|]*([,\t;|][^,\t;|]*){3,}$/;

const count = (s, re) => (s.match(re) ?? []).length;

function numericShare(s) {
  const nums = count(s, NUM);
  const words = count(s, WORD);
  return nums + words === 0 ? 0 : nums / (nums + words);
}

function digitRatio(s) {
  const nonSpace = count(s, /\S/g);
  return nonSpace === 0 ? 0 : count(s, /\d/g) / nonSpace;
}

export const LIMITS = {
  digitRatio: 0.14,
  numericShare: 0.3,
  hexPerLine: 0.05,
  hexMin: 6,
  jsonKvPerLine: 0.5,
  rowShare: 0.5,
  timestampShare: 0.3,
  window: 30,
  windowDigitRatio: 0.2,
  windowNumericShare: 0.4,
};

/** Return the measured signals and the reason a block counts as data (or null). */
export function analyze(text) {
  const sample = text.length > 200_000 ? text.slice(0, 100_000) + '\n' + text.slice(-100_000) : text;
  const lines = sample
    .split(/\r?\n/)
    .map((l) => l.replace(LINE_NO, ''))
    .filter((l) => l.trim() !== '');
  const body = lines.join('\n');
  const n = Math.max(lines.length, 1);
  const s = {
    lines: lines.length,
    digitRatio: digitRatio(body),
    numericShare: numericShare(body),
    hex: count(body, HEX),
    jsonKv: count(body, JSON_KV),
    rows: lines.filter((l) => SEP_ROW.test(l) && digitRatio(l) > 0.1).length,
    timestamps: lines.filter((l) => TIMESTAMP.test(l)).length,
    worstWindow: 0,
  };
  // A dense table inside otherwise ordinary prose still makes the block data.
  for (let i = 0; i < lines.length; i += Math.ceil(LIMITS.window / 2)) {
    const w = lines.slice(i, i + LIMITS.window).join('\n');
    if (w.length < 200) continue;
    s.worstWindow = Math.max(s.worstWindow, Math.max(digitRatio(w) / LIMITS.windowDigitRatio, numericShare(w) / LIMITS.windowNumericShare));
  }
  let reason = null;
  if (s.digitRatio >= LIMITS.digitRatio) reason = 'digits';
  else if (s.numericShare >= LIMITS.numericShare) reason = 'numbers';
  else if (s.hex >= LIMITS.hexMin && s.hex / n >= LIMITS.hexPerLine) reason = 'hex';
  else if (s.jsonKv / n >= LIMITS.jsonKvPerLine) reason = 'json';
  else if (s.rows / n >= LIMITS.rowShare) reason = 'table';
  else if (s.timestamps / n >= LIMITS.timestampShare) reason = 'log';
  else if (s.worstWindow >= 1) reason = 'dense-window';
  return { reason, signals: s };
}

export function isDataLike(text) {
  return analyze(text).reason !== null;
}
