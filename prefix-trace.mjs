// Diagnostics only. Answers ONE question: when an already-closed GPT history prefix
// is rebuilt (an uncached rewrite), what actually changed?
//
//   * did the client's own input change inside the region the gate had closed?
//   * did the source key (first user item / instructions / tools / first 8 items)
//     change, which silently starts a brand-new cache epoch?
//   * did the planner reset although the source did NOT change (planner bug)?
//
// It never mutates a request and never retains content: only hashes, lengths, key
// names and protocol type tags (message/function_call/input_image...). Every public
// call is wrapped so that a bug here can never fail a proxy request.
import { createHash } from 'node:crypto';
import { RotatingLog } from './rotlog.mjs';

const sha = s => createHash('sha1').update(s).digest('base64url').slice(0, 8);
const enc = v => JSON.stringify(v) ?? 'undefined';
const ARRAY_FIELDS = ['content', 'output', 'summary'];
const MAX_LIST = 5, MAX_SHIFT = 16, MAX_PARTS = 6;
const lenOf = d => Number(d.split(':')[1]);
const typeOf = d => d.split(':')[2];
const tag = v => typeof v === 'string' && /^[\w.-]{1,40}$/.test(v) ? v : undefined;

// One item -> { t, sig, keys: {field: "hash:len"}, parts: {field: ["hash:len:type"]} }.
// Array fields are hashed once, per part; the field hash is derived from those.
function fingerprint(item) {
  const keys = {}, parts = {};
  for (const k of Object.keys(item)) {
    const v = item[k];
    if (ARRAY_FIELDS.includes(k) && Array.isArray(v)) {
      const ds = v.map(p => { const s = enc(p); return `${sha(s)}:${s.length}:${tag(p?.type) ?? typeof p}`; });
      parts[k] = ds;
      keys[k] = `${sha(ds.join(','))}:${ds.reduce((n, d) => n + lenOf(d), 0)}`;
    } else {
      const s = enc(v);
      keys[k] = `${sha(s)}:${s.length}`;
    }
  }
  const t = tag(item.type) ?? (tag(item.role) ? `msg:${item.role}` : '?');
  const name = tag(item.name);
  return { t: name ? `${t}:${name}` : t,
    sig: sha(Object.entries(keys).map(([k, d]) => `${k}=${d}`).join(';')), keys, parts };
}

function diffParts(x = [], y = []) {
  const differing = [];
  for (let i = 0; i < Math.min(x.length, y.length) && differing.length < MAX_PARTS; i++)
    if (x[i] !== y[i]) differing.push(i);
  return { count: [x.length, y.length], differing,
    added_types: y.slice(x.length, x.length + MAX_PARTS).map(typeOf),
    removed_types: x.slice(y.length, y.length + MAX_PARTS).map(typeOf) };
}

function diffItem(a, b) {
  const changed = {}, added = [], removed = [];
  for (const k of Object.keys(b.keys)) {
    if (!(k in a.keys)) { added.push(k); continue; }
    if (a.keys[k] === b.keys[k]) continue;
    changed[k] = { len: [lenOf(a.keys[k]), lenOf(b.keys[k])] };
    if (a.parts[k] || b.parts[k]) changed[k].parts = diffParts(a.parts[k], b.parts[k]);
  }
  for (const k of Object.keys(a.keys)) if (!(k in b.keys)) removed.push(k);
  return { type: a.t === b.t ? a.t : `${a.t}->${b.t}`, changed, added, removed };
}

// Insertion/removal looks like "everything after d changed". Re-align to tell them apart.
function detectShift(prev, now, d) {
  const same = (x, i, y, j) => x[i] && y[j] && x[i].sig === y[j].sig;
  for (let k = 1; k <= MAX_SHIFT; k++) {
    if (same(now, d + k, prev, d) && (d + 1 >= prev.length || same(now, d + k + 1, prev, d + 1))) {
      let residual = 0;
      for (let i = d; i < prev.length && i + k < now.length; i++) if (!same(prev, i, now, i + k)) residual++;
      return { kind: 'inserted', at: d, count: k, types: now.slice(d, d + k).map(x => x.t), residual_changed: residual };
    }
    if (same(prev, d + k, now, d) && (d + 1 >= now.length || same(prev, d + k + 1, now, d + 1))) {
      let residual = 0;
      for (let i = d; i < now.length && i + k < prev.length; i++) if (!same(now, i, prev, i + k)) residual++;
      return { kind: 'removed', at: d, count: k, types: prev.slice(d, d + k).map(x => x.t), residual_changed: residual };
    }
  }
  return undefined;
}

function scan(prev, now, closedThrough) {
  const n = Math.min(prev.length, now.length), items = [];
  let first = -1, changed = 0, inClosed = 0;
  for (let i = 0; i < n; i++) {
    if (prev[i].sig === now[i].sig) continue;
    changed++;
    if (i < closedThrough) inClosed++;
    if (first < 0) first = i;
    if (items.length < MAX_LIST) items.push({ i, ...diffItem(prev[i], now[i]) });
  }
  return { first_changed: first, changed, changed_in_closed: inClosed, items,
    shift: first >= 0 ? detectShift(prev, now, first) : undefined,
    shrank_into_closed: now.length < closedThrough };
}

export function createPrefixTrace({ file, sink, now = Date.now, maxSessions = 12, ttlMs = 3_600_000,
  maxItems = 20_000 } = {}) {
  let log;
  const write = rec => (sink ?? (r => (log ??= new RotatingLog(file, { maxBytes: 5 * 1024 * 1024, maxAgeDays: 14 })).write(r)))(rec);
  const states = new Map();
  let seq = 0;
  const stats = { observed: 0, rows: 0, errors: 0, max_ms: 0 };
  const expire = () => {
    for (const [k, s] of states) if (now() - s.at > ttlMs) states.delete(k);
    while (states.size > maxSessions) states.delete(states.keys().next().value);
  };

  return {
    stats: () => ({ ...stats }),

    /** Call with the client input exactly as the transform will see it (post-recall). */
    observe({ sid, model, route, parsed, recallApplied = false }) {
      const t0 = performance.now();
      try {
        const input = parsed?.input;
        if (!sid || !Array.isArray(input) || input.length > maxItems
          || input.some(i => !i || typeof i !== 'object')) return null;
        const fp = input.map(fingerprint);
        const userIdx = input.findIndex(i => i.role === 'user');
        const comps = { user0: fp[userIdx]?.sig ?? 'none', instructions: sha(enc(parsed.instructions ?? null)),
          tools: sha(enc(parsed.tools ?? null)),
          first8: fp.length >= 8 ? sha(fp.slice(0, 8).map(f => f.sig).join(',')) : 'short' };
        const key = `${sid}\0${model}\0${route}`;
        expire();
        const prev = states.get(key);
        const pending = { key, seq: ++seq, fp, comps, recallApplied, sid, model, route, prev: undefined };
        if (prev) {
          const closedThrough = prev.closed?.through ?? 0;
          pending.prev = prev;
          pending.keyChanged = Object.keys(comps).filter(k => comps[k] !== prev.comps[k]);
          pending.scan = scan(prev.fp, fp, closedThrough);
        } else pending.keyChanged = [];
        stats.observed++;
        const ms = performance.now() - t0;
        pending.ms = ms;
        stats.max_ms = Math.max(stats.max_ms, ms);
        return pending;
      } catch { stats.errors++; return null; }
    },

    /** Call from onRequest with the tracked event row (status + gpt_cache_gate). */
    finish(pending, row) {
      try {
        if (!pending) return;
        const g = row?.gpt_cache_gate;
        const ok = row?.status >= 200 && row?.status < 300 && g && g.wire_applied !== false;
        const prev = pending.prev, closed = prev?.closed;
        const reasons = [];
        if (pending.keyChanged.length) reasons.push('source_key_changed');
        if (pending.scan && (pending.scan.changed_in_closed > 0 || pending.scan.shrank_into_closed))
          reasons.push('closed_region_source_changed');
        if (g?.history_reset) reasons.push('planner_reset');
        if (ok && closed && g.closed_through === closed.through && closed.signature
          && g.closed_prefix_signature !== closed.signature && !g.history_reset)
          reasons.push('signature_changed_same_cutoff');
        if (reasons.length) {
          stats.rows++;
          write({ ts: new Date(now()).toISOString(), reasons,
            sid: sha(pending.sid), model: pending.model, route: pending.route, status: row?.status,
            request_seq: g?.request_seq,
            prev: prev ? { n: prev.fp.length, closed_through: closed?.through, closed_signature: closed?.signature,
              cutoff: closed?.cutoff, age_s: Math.round((now() - prev.at) / 1000), recall_applied: prev.recallApplied } : undefined,
            now: { n: pending.fp.length, closed_through: g?.closed_through, closed_signature: g?.closed_prefix_signature,
              cutoff: g?.chosen_cutoff, candidate_cutoff: g?.candidate_cutoff, recall_applied: pending.recallApplied },
            gate: g ? { accept: g.accept, reason: g.reason, economic_reason: g.economic_reason,
              history_reset: g.history_reset === true, wire_applied: g.wire_applied } : undefined,
            source: pending.scan ? { first_changed: pending.scan.first_changed, changed: pending.scan.changed,
              changed_in_closed: pending.scan.changed_in_closed, shrank_into_closed: pending.scan.shrank_into_closed,
              shift: pending.scan.shift, items: pending.scan.items } : undefined,
            source_key: pending.keyChanged.length ? { changed: pending.keyChanged,
              was: prev.comps, now: pending.comps } : undefined,
            upstream: row?.gpt_prefix ? { status: row.gpt_prefix.status,
              first_changed: row.gpt_prefix.first_changed } : undefined,
            observe_ms: Math.round(pending.ms * 10) / 10 });
        }
        // Only a newer request may advance state (parallel requests finish out of order).
        const cur = states.get(pending.key);
        if (cur && cur.seq > pending.seq) return;
        const next = { fp: pending.fp, comps: pending.comps, recallApplied: pending.recallApplied,
          at: now(), seq: pending.seq, closed: closed };
        if (ok && Number.isSafeInteger(g.closed_through))
          next.closed = { through: g.closed_through, signature: g.closed_prefix_signature, cutoff: g.chosen_cutoff };
        states.delete(pending.key);
        states.set(pending.key, next);
      } catch { stats.errors++; }
    },
  };
}
