import { createHash } from 'node:crypto';

/**
 * Content-free diagnostics for parsed, outgoing Responses/Chat JSON objects.
 *
 * API: createGptPrefixTracker({ now = Date.now, maxSessions = 64,
 *   maxUnits = 4096, ttlMs = 3600000 } = {}).observe(body, { sessionKey, route } = {})
 *
 * Report (all keys always present):
 *   status: first | unchanged | append_only | rewrite | truncate | unknown
 *   reason: null | missing_session | invalid_context | invalid_body |
 *           invalid_clock | disabled | limit
 *   has_key: boolean
 *   common_items: number | null (equal leading native entries, independent of options)
 *   previous_items: number | null
 *   current_items: number | null
 *   first_changed: null | { area, index, before_type, after_type, part }
 *   truncated: boolean
 * `part` has the same change shape, with its own `part: null`. Indices are zero-based;
 * a top-level field has index null. Missing values have type null (JSON null has
 * type "null"). Unknown field names collapse to area "other"; native type labels
 * are allowlisted. "input_format" identifies an input[]/messages[] switch.
 *
 * Only hashes, numeric counts/timestamps, and fixed tags survive observe(). No
 * payload references, raw identity values, hash/state getters, logging or I/O.
 * maxUnits bounds TOTAL retained item + content/output-part fingerprints per
 * partition; top-level fingerprints have fixed overhead. Incomplete snapshots
 * always produce unknown, including when only part diagnostics exceeded budget.
 * TTL is idle time; each session/route/model partition consumes one LRU slot.
 * Malformed bodies invalidate their session/route scope (model may be unknown);
 * failed native hashing invalidates the identified model partition.
 *
 * Native JSON values (including opaque encrypted_content and argument strings)
 * are hashed without decoding or normalization. Object key ordering is retained,
 * so reorderings can conservatively report rewrite. This is NOT wire-byte,
 * tokenizer, provider cache-eligibility or cache-hit analysis.
 */

const ABSENT = Symbol('absent');
const INVALID = Symbol('invalid_json');
const LIMIT = Symbol('hash_limit');
const MAX_DEPTH = 64;
const MAX_NODES = 100000;

// Compare every other top-level option in the fixed "other" bucket. Unknown
// options must not silently look like a stable prefix or leak their field names.
const TOP_FIELDS = Object.freeze([
  'instructions', 'tools', 'model', 'reasoning', 'text', 'response_format',
  'tool_choice', 'parallel_tool_calls', 'prompt_cache_key', 'prompt_cache_options',
  'prompt_cache_retention', 'cache_control', 'cache_key', 'cache_options',
  'previous_response_id', 'conversation', 'truncation', 'modalities', 'audio',
  'prediction', 'system',
]);
const EXCLUDED = new Set([
  ...TOP_FIELDS, 'input', 'messages',
  'max_tokens', 'max_output_tokens', 'max_completion_tokens', 'stream', 'stream_options',
]);
const NATIVE_TYPES = new Set([
  'message', 'reasoning', 'function_call', 'function_call_output', 'item_reference',
  'computer_call', 'computer_call_output', 'file_search_call', 'web_search_call',
  'code_interpreter_call', 'image_generation_call', 'local_shell_call',
  'local_shell_call_output', 'custom_tool_call', 'custom_tool_call_output',
  'mcp_call', 'mcp_list_tools', 'mcp_approval_request', 'mcp_approval_response',
  'shell_call', 'shell_call_output', 'apply_patch_call', 'apply_patch_call_output',
  'compaction', 'input_text', 'output_text', 'text', 'input_image', 'image_url',
  'image', 'input_audio', 'audio', 'input_file', 'file', 'video', 'refusal',
  'reasoning_text', 'summary_text', 'tool_use', 'tool_result',
]);
const ROLES = new Set(['user', 'assistant', 'system', 'developer', 'tool', 'function']);
const PART_FIELDS = Object.freeze(['content', 'output']);

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// Never invoke a payload getter or toJSON method. The contract is parsed JSON.
function own(object, key) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor) return ABSENT;
  if (!Object.hasOwn(descriptor, 'value')) throw INVALID;
  return descriptor.value;
}

function jsonType(value) {
  if (value === ABSENT) return null;
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  switch (typeof value) {
    case 'string': return 'string';
    case 'number': return 'number';
    case 'boolean': return 'boolean';
    case 'object': return 'object';
    default: return 'unknown';
  }
}

function nativeType(value) {
  if (typeof value === 'string') return 'text';
  if (!isRecord(value)) return 'unknown';
  const type = own(value, 'type');
  if (type !== ABSENT) return NATIVE_TYPES.has(type) ? type : 'unknown';
  return ROLES.has(own(value, 'role')) ? 'message' : 'unknown';
}

// Length-framed structured hashing: no JSON parsing of strings (especially
// reasoning.encrypted_content), no whole-body serialization, no retained text.
// UTF-16 code units preserve even distinct unpaired surrogates. JSON numbers
// follow native JSON semantics, i.e. -0 and 0 have the same representation.
function digest(value, rootKeys) {
  const hash = createHash('sha256');
  const active = new Set();
  let nodes = 0;
  function string(text) {
    hash.update(`s${text.length}:`);
    for (let i = 0; i < text.length; i += 16384)
      hash.update(text.slice(i, i + 16384), 'utf16le');
  }
  function visit(current, depth, selectedKeys) {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) throw LIMIT;
    if (current === null) { hash.update('z'); return; }
    switch (typeof current) {
      case 'string': string(current); return;
      case 'boolean': hash.update(current ? 't' : 'f'); return;
      case 'number':
        if (!Number.isFinite(current)) throw INVALID;
        hash.update(`n${String(current)};`);
        return;
      case 'object': break;
      default: throw INVALID;
    }
    if (active.has(current)) throw INVALID;
    active.add(current);
    if (Array.isArray(current)) {
      if (current.length > MAX_NODES) throw LIMIT;
      // Holes and enumerable non-index properties are not native JSON arrays.
      if (Object.keys(current).length !== current.length) throw INVALID;
      hash.update(`a${current.length}:`);
      for (let i = 0; i < current.length; i++) visit(own(current, String(i)), depth + 1);
    } else {
      if (!isRecord(current)) throw INVALID;
      const keys = selectedKeys ?? Object.keys(current);
      if (keys.length > MAX_NODES) throw LIMIT;
      hash.update(`o${keys.length}:`);
      for (const key of keys) {
        string(key);
        visit(own(current, key), depth + 1);
      }
    }
    active.delete(current);
  }
  visit(value, 0, rootKeys);
  return hash.digest('hex');
}

function describe(body) {
  if (!isRecord(body)) throw INVALID;
  const input = own(body, 'input');
  const messages = own(body, 'messages');
  if ((input === ABSENT) === (messages === ABSENT)) throw INVALID;
  const kind = input === ABSENT ? 'messages' : 'input';
  const entries = kind === 'input' ? input : messages;
  if (!Array.isArray(entries)) throw INVALID;
  const model = own(body, 'model');
  if (model !== ABSENT && typeof model !== 'string') throw INVALID;
  return { kind, entries, model };
}

function countItems(body) {
  try {
    if (!isRecord(body)) return null;
    const input = own(body, 'input');
    if (input !== ABSENT) return Array.isArray(input) ? input.length : null;
    const messages = own(body, 'messages');
    return Array.isArray(messages) ? messages.length : null;
  } catch {
    return null; // Untrusted input; the report, not an exception/log, is the error boundary.
  }
}

function snapshot(body, description, maxUnits) {
  const result = {
    kind: description.kind, count: description.entries.length,
    top: [], items: [], truncated: false,
  };
  for (const field of TOP_FIELDS) {
    const value = own(body, field);
    result.top.push(value === ABSENT ? null : { hash: digest(value), type: jsonType(value) });
  }
  const otherKeys = Object.keys(body).filter(key => !EXCLUDED.has(key));
  result.top.push(otherKeys.length ? { hash: digest(body, otherKeys), type: 'object' } : null);

  let remaining = maxUnits;
  function parts(item, field) {
    const value = own(item, field);
    const count = typeof value === 'string' ? 1 : Array.isArray(value) ? value.length : 0;
    if (!count) return null;
    const group = { count, items: [] };
    for (let i = 0; i < count; i++) {
      if (!remaining) { result.truncated = true; break; }
      const part = typeof value === 'string' ? value : own(value, String(i));
      group.items.push({ hash: digest(part), type: nativeType(part) });
      remaining--;
    }
    return group;
  }
  for (let i = 0; i < description.entries.length; i++) {
    if (!remaining) { result.truncated = true; break; }
    const item = own(description.entries, String(i));
    if (!isRecord(item)) throw INVALID;
    const record = { hash: digest(item), type: nativeType(item) };
    remaining--;
    for (const field of PART_FIELDS) record[field] = parts(item, field);
    result.items.push(record);
  }
  return result;
}

function changed(area, index, before_type, after_type, part = null) {
  return { area, index, before_type, after_type, part };
}

function partChange(before, after) {
  for (const field of PART_FIELDS) {
    const a = before[field];
    const b = after[field];
    const na = a?.count ?? 0;
    const nb = b?.count ?? 0;
    let i = 0;
    while (i < Math.min(na, nb) && a.items[i] && b.items[i] &&
      a.items[i].hash === b.items[i].hash) i++;
    if (i < Math.min(na, nb)) {
      if (a.items[i] && b.items[i])
        return changed(field, i, a.items[i].type, b.items[i].type);
      // Retained details cannot establish the first differing part in this field.
      return null;
    }
    if (na !== nb) {
      if ((i < na && !a.items[i]) || (i < nb && !b.items[i])) return null;
      return changed(field, i, i < na ? a.items[i].type : null, i < nb ? b.items[i].type : null);
    }
  }
  return null;
}

function compare(before, after, report) {
  let first = null;
  for (let i = 0; i < after.top.length; i++) {
    if (before.top[i]?.hash !== after.top[i]?.hash) {
      first = changed(TOP_FIELDS[i] ?? 'other', null, before.top[i]?.type ?? null, after.top[i]?.type ?? null);
      break;
    }
  }
  let common = 0;
  if (before.kind !== after.kind) {
    first ??= changed('input_format', null, 'array', 'array');
  } else {
    while (common < Math.min(before.items.length, after.items.length) &&
      before.items[common].hash === after.items[common].hash) common++;
    if (!first) {
      const a = before.items[common];
      const b = after.items[common];
      if (a && b) {
        first = changed(after.kind, common, a.type, b.type, partChange(a, b));
      } else if (common === Math.min(before.count, after.count) && before.count !== after.count) {
        // Only assert an insertion/deletion if we actually verified its boundary.
        if ((common >= before.count || a) && (common >= after.count || b))
          first = changed(after.kind, common, a?.type ?? null, b?.type ?? null);
      }
    }
  }
  report.common_items = common;
  report.first_changed = first;
  report.truncated = before.truncated || after.truncated;
  if (report.truncated) {
    report.status = 'unknown';
    report.reason = 'limit';
  } else if (before.kind !== after.kind ||
    common < Math.min(before.count, after.count) ||
    first?.index === null) {
    report.status = 'rewrite';
  } else {
    report.status = before.count === after.count ? 'unchanged' :
      before.count < after.count ? 'append_only' : 'truncate';
  }
}

export function createGptPrefixTracker({
  now = Date.now, maxSessions = 64, maxUnits = 4096, ttlMs = 3600000,
} = {}) {
  if (typeof now !== 'function' ||
    !Number.isSafeInteger(maxSessions) || maxSessions < 0 ||
    !Number.isSafeInteger(maxUnits) || maxUnits < 0 ||
    !Number.isFinite(ttlMs) || ttlMs < 0)
    throw new TypeError('Invalid prefix tracker options');

  const sessions = new Map();
  function observe(body, context = {}) {
    const report = {
      status: 'unknown', reason: null, has_key: false, common_items: null,
      previous_items: null, current_items: countItems(body),
      first_changed: null, truncated: false,
    };
    let sessionKey, route;
    try {
      if (!isRecord(context)) throw INVALID;
      sessionKey = own(context, 'sessionKey');
      route = own(context, 'route');
      report.has_key = typeof sessionKey === 'string' && sessionKey.trim().length > 0;
      if (!report.has_key) { report.reason = 'missing_session'; return report; }
      if (route !== ABSENT && route !== undefined && typeof route !== 'string') throw INVALID;
    } catch {
      report.reason = 'invalid_context';
      return report;
    }

    // A separate scope hash permits invalidation even if a malformed body has
    // no usable model. Never keep the raw session or route for this purpose.
    const scope = digest([sessionKey, route === ABSENT || route === undefined ? null : route]);
    let description;
    try {
      description = describe(body);
    } catch {
      for (const [key, entry] of sessions)
        if (entry.scope === scope) sessions.delete(key);
      report.reason = 'invalid_body';
      return report;
    }
    if (!maxSessions || !ttlMs) { report.reason = 'disabled'; return report; }
    let time;
    try {
      time = now();
      if (typeof time !== 'number' || !Number.isFinite(time)) throw INVALID;
    } catch {
      sessions.clear();
      report.reason = 'invalid_clock';
      return report;
    }
    for (const [key, entry] of sessions)
      if (time < entry.time || time - entry.time >= ttlMs) sessions.delete(key);

    // Null sentinels cannot collide with valid routes/models, which are strings.
    const identity = digest([scope, description.model === ABSENT ? null : description.model]);
    const previous = sessions.get(identity)?.snapshot;
    report.previous_items = previous?.count ?? null;
    let current;
    try {
      current = snapshot(body, description, maxUnits);
    } catch (error) {
      // Do not compare a future request to a baseline preceding a failed snapshot.
      sessions.delete(identity);
      report.reason = error === LIMIT ? 'limit' : 'invalid_body';
      report.truncated = error === LIMIT;
      return report;
    }
    report.common_items = 0;
    if (previous) {
      compare(previous, current, report);
    } else if (current.truncated) {
      report.reason = 'limit';
      report.truncated = true;
    } else {
      report.status = 'first';
    }
    sessions.delete(identity);
    sessions.set(identity, { scope, time, snapshot: current });
    while (sessions.size > maxSessions) sessions.delete(sessions.keys().next().value);
    return report;
  }
  return Object.freeze({ observe });
}
