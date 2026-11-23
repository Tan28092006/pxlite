import { createHash } from 'node:crypto';

/**
 * Content-free diagnostics for parsed, outgoing Responses/Chat JSON objects.
 *
 * API: createGptPrefixTracker({ now = Date.now, maxSessions = 64,
 *   maxUnits = 4096, ttlMs = 3600000 } = {}).observe(body, { sessionKey, route } = {})
 * Optional includeDiff=true adds a detached `diff` (null on failed observation).
 * maxDiffEntries (default 64, hard maximum 256) bounds shared top/item/part
 * change entries. Default report keys and classification remain unchanged.
 * Diff hashes are exact structured SHA-256 fingerprints, not cache-hit evidence.
 * Unknown top fields remain a single "other" bucket; excluded stream/token
 * controls remain ignored. No recall/history inference is attempted.
 * Aggregate blocks cover top fields and retained items (including their nested
 * parts), even when the change list is capped. `complete=false` means totals
 * are retained-position lower bounds, not full-request totals; input/messages
 * format switches are deliberately not aligned. First observations have no
 * baseline and report aggregates only. Positional changes are NOT semantic
 * alignment: insertions can make every following position differ.
 * `nodes` counts JSON value nodes; `string_units` counts UTF-16 value units
 * (not keys). Neither measures wire bytes/tokens. `images` counts typed native
 * image objects, not decoded images or untyped URLs. Hashes can reveal equality
 * and permit guessing low-entropy values; they are not anonymization.
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
function digest(value, rootKeys, stats) {
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
    if (stats) {
      stats.nodes++;
      if (typeof current === 'string') stats.string_units += current.length;
    }
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
      if (stats && IMAGE_TYPES.has(own(current, 'type'))) stats.images++;
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

const IMAGE_TYPES = new Set(['input_image', 'image_url', 'image']);
const CATEGORIES = Object.freeze([
  'system/developer', 'tools/options', 'reasoning', 'call/output',
  'user/assistant', 'unknown',
]);

function category(type, role) {
  if (role === 'system' || role === 'developer') return 'system/developer';
  if (type === 'reasoning' || type === 'reasoning_text' || type === 'summary_text') return 'reasoning';
  if (role === 'tool' || role === 'function' || type.includes('call') ||
    type === 'tool_use' || type === 'tool_result') return 'call/output';
  if (role === 'user' || role === 'assistant') return 'user/assistant';
  return 'unknown'; // Never infer recall/history from text, paths, IDs or images.
}

function topCategory(field) {
  if (field === 'instructions' || field === 'system') return 'system/developer';
  if (field === 'reasoning') return 'reasoning';
  return 'tools/options';
}

function fingerprint(value, type, details, rootKeys) {
  const stats = details ? { nodes: 0, string_units: 0, images: 0 } : undefined;
  const hash = digest(value, rootKeys, stats);
  if (stats) stats.value_count = Array.isArray(value) ? value.length :
    value !== null && typeof value === 'object' ? (rootKeys ?? Object.keys(value)).length : null;
  return { hash, type, ...(stats ?? {}) };
}

function snapshot(body, description, maxUnits, details) {
  const result = {
    kind: description.kind, count: description.entries.length,
    top: [], items: [], truncated: false,
  };
  for (const field of TOP_FIELDS) {
    const value = own(body, field);
    result.top.push(value === ABSENT ? null : fingerprint(value, jsonType(value), details));
  }
  const otherKeys = Object.keys(body).filter(key => !EXCLUDED.has(key));
  result.top.push(otherKeys.length ? fingerprint(body, 'object', details, otherKeys) : null);

  let remaining = maxUnits;
  function parts(item, field) {
    const value = own(item, field);
    const count = typeof value === 'string' ? 1 : Array.isArray(value) ? value.length : 0;
    if (!count) return null;
    const group = { count, items: [] };
    for (let i = 0; i < count; i++) {
      if (!remaining) { result.truncated = true; break; }
      const part = typeof value === 'string' ? value : own(value, String(i));
      group.items.push(fingerprint(part, nativeType(part), details));
      remaining--;
    }
    return group;
  }
  for (let i = 0; i < description.entries.length; i++) {
    if (!remaining) { result.truncated = true; break; }
    const item = own(description.entries, String(i));
    if (!isRecord(item)) throw INVALID;
    const record = fingerprint(item, nativeType(item), details);
    if (details) {
      const role = own(item, 'role');
      record.role = ROLES.has(role) ? role : 'unknown';
      record.category = category(record.type, record.role);
    }
    remaining--;
    for (const field of PART_FIELDS) record[field] = parts(item, field);
    result.items.push(record);
  }
  return result;
}

// Report objects are detached from retained snapshots. Sizes are structured JSON
// node counts and UTF-16 VALUE string units, not serialized bytes or token counts.
function summary(record) {
  if (!record) return null;
  const { hash, type, nodes, string_units, images, value_count, role, category } = record;
  return { hash, type, nodes, string_units, images, value_count,
    ...(role === undefined ? {} : { role, category,
      content_parts: record.content?.count ?? 0, output_parts: record.output?.count ?? 0 }) };
}

function blocks(snapshot) {
  if (!snapshot) return null;
  const groups = Object.fromEntries(CATEGORIES.map(c => [c, {
    hash: createHash('sha256'), fields: 0, items: 0, parts: 0,
    nodes: 0, string_units: 0, images: 0,
  }]));
  function add(record, c, position, isItem) {
    if (!record) return;
    const group = groups[c];
    group.hash.update(`${position}:${record.hash};`);
    group[isItem ? 'items' : 'fields']++;
    if (isItem) for (const field of PART_FIELDS) group.parts += record[field]?.count ?? 0;
    for (const key of ['nodes', 'string_units', 'images']) group[key] += record[key];
  }
  snapshot.top.forEach((r, i) => add(r, topCategory(TOP_FIELDS[i]), `t${i}`, false));
  snapshot.items.forEach((r, i) => add(r, r.category, `${snapshot.kind}${i}`, true));
  return Object.fromEntries(Object.entries(groups).map(([c, group]) =>
    [c, { ...group, hash: group.hash.digest('hex') }]));
}

function diff(before, after, maxEntries) {
  const result = {
    alignment: 'positional', complete: !(before?.truncated || after.truncated),
    has_baseline: Boolean(before),
    truncated: false, limit: maxEntries, total_changes: 0, reported_changes: 0,
    totals: { top: 0, items: 0, parts: 0 },
    before: blocks(before), after: blocks(after), changes: [],
  };
  function add(kind, area, index, parent_index, a, b, category) {
    if (a?.hash === b?.hash) return;
    result.totals[kind]++;
    result.total_changes++;
    if (result.changes.length < maxEntries) result.changes.push({
      kind, area, index, parent_index, category,
      before: summary(a), after: summary(b),
    });
  }
  if (before) {
    after.top.forEach((b, i) => add('top', TOP_FIELDS[i] ?? 'other', null, null,
      before.top[i], b, topCategory(TOP_FIELDS[i])));
    if (before.kind !== after.kind) {
      result.complete = false; // Different native formats are not aligned.
    } else for (let i = 0; i < Math.max(before.items.length, after.items.length); i++) {
      // An unretained position is unknown, NOT absent. Only true boundaries
      // establish insertions/removals when one snapshot exceeded its budget.
      if ((i >= before.items.length && i < before.count) ||
        (i >= after.items.length && i < after.count)) continue;
      const a = before.items[i], b = after.items[i];
      add('items', after.kind, i, null, a, b, b?.category ?? a.category);
      for (const field of PART_FIELDS) {
        const ap = a?.[field]?.items ?? [], bp = b?.[field]?.items ?? [];
        for (let j = 0; j < Math.max(ap.length, bp.length); j++) {
          if ((j >= ap.length && j < (a?.[field]?.count ?? 0)) ||
            (j >= bp.length && j < (b?.[field]?.count ?? 0))) continue;
          add('parts', field, j, i, ap[j], bp[j], b?.category ?? a.category);
        }
      }
    }
  }
  result.reported_changes = result.changes.length;
  result.truncated = !result.complete || result.total_changes > result.reported_changes;
  result.totals_scope = !before ? 'no_baseline' : result.complete ? 'all' : 'retained_positions';
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
  includeDiff = false, maxDiffEntries = 64,
} = {}) {
  if (typeof now !== 'function' ||
    !Number.isSafeInteger(maxSessions) || maxSessions < 0 ||
    !Number.isSafeInteger(maxUnits) || maxUnits < 0 ||
    !Number.isFinite(ttlMs) || ttlMs < 0 ||
    typeof includeDiff !== 'boolean' ||
    !Number.isSafeInteger(maxDiffEntries) || maxDiffEntries < 0 || maxDiffEntries > 256)
    throw new TypeError('Invalid prefix tracker options');

  const sessions = new Map();
  function observe(body, context = {}) {
    const report = {
      status: 'unknown', reason: null, has_key: false, common_items: null,
      previous_items: null, current_items: countItems(body),
      first_changed: null, truncated: false,
      ...(includeDiff ? { diff: null } : {}),
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
      current = snapshot(body, description, maxUnits, includeDiff);
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
    if (includeDiff) report.diff = diff(previous, current, maxDiffEntries);
    sessions.delete(identity);
    sessions.set(identity, { scope, time, snapshot: current });
    while (sessions.size > maxSessions) sessions.delete(sessions.keys().next().value);
    return report;
  }
  return Object.freeze({ observe });
}
