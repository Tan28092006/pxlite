// GPT cache decisions: estimates are deliberately separate from provider usage.
// State contains only hashes, cutoffs and numeric usage; never prompts or blobs.
import { createHash } from 'node:crypto';

const quantile = (xs, q, fallback) => {
  if (!xs.length) return fallback;
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.floor((a.length - 1) * q)];
};
const bounded = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const finite = x => typeof x === 'number' && Number.isFinite(x);
const count = x => Number.isSafeInteger(x) && x >= 0;
const hashValue = x => typeof x === 'string' && /^[a-f\d]{8,128}$/i.test(x) ? x : undefined;
const supported = model => /^(?:openai\/)?(?:gpt-|o\d)/i.test(model ?? '');
const digest = x => createHash('sha256').update(x).digest('hex').slice(0, 24);
const bucketKey = e => `${e.model}|${e.path}`;
const PLAN_KEYS = ['checkpointBootstrap', 'reflow', 'keepTail', 'keepRecentPairs',
  'minCollapseTokens', 'minCollapsePrefix', 'collapseChunk', 'freezeChunk',
  'preserveClientImages', 'responsesMode', 'cols', 'maxHeightPx', 'maxImages',
  'sectionTokens', 'checkpointChunk', 'reasoningKeep', 'reasoningMode', 'projectionVersion'];
const planOptions = o => Object.fromEntries(PLAN_KEYS.filter(k =>
  k === 'reasoningMode' ? o?.[k] === 'summary'
    : k === 'responsesMode' ? ['pairs', 'mixed'].includes(o?.[k])
      : finite(o?.[k]) || typeof o?.[k] === 'boolean').map(k => [k, o[k]]));
const observedAt = e => e._cache_observed_at ?? Date.parse(e.ts);
const requestOrder = g => [g?.request_started_ms ?? 0, g?.request_seq ?? 0];
const older = (a, b) => a[0] < b[0] || a[0] === b[0] && a[1] < b[1];
const numbers = (o, keys) => Object.fromEntries(keys.filter(k => finite(o?.[k])).map(k => [k, o[k]]));
const sampleGate = g => g ? {
  session: typeof g.session === 'string' ? g.session : undefined,
  history_mode: g.history_mode === 'summary' ? 'summary' : 'legacy',
  ...numbers(g, ['chosen_cutoff', 'candidate_cutoff', 'selected_local_tokens', 'request_started_ms', 'request_seq']),
  chosen_options: planOptions(g.chosen_options),
  closed_through: count(g.closed_through) ? g.closed_through : undefined,
  closed_prefix_signature: hashValue(g.closed_prefix_signature),
  wire_applied: g.wire_applied !== false,
} : undefined;

// Copy only diagnostic metadata at the boundary. In particular, never retain an
// event (or nested report/options object) supplied by a caller that also has a body.
const sampleEvent = e => {
  const p = e.gpt_prefix;
  return {
    ...Object.fromEntries(['model', 'path', 'first_user_sha8', 'system_sha8', 'history_image_sha8']
      .filter(k => typeof e[k] === 'string').map(k => [k, e[k]])),
    ...numbers(e, ['status', 'input_tokens', 'cached_tokens', 'gpt_history_checkpoint_chunk']),
    _cache_observed_at: observedAt(e),
    gpt_prefix: p ? {
      status: ['first', 'unknown', 'append_only', 'unchanged', 'rewrite', 'truncate'].includes(p.status)
        ? p.status : 'unknown',
      ...numbers(p, ['common_items', 'previous_items', 'current_items']),
      first_changed: { area: p.first_changed?.area === 'input' ? 'input' : 'other' },
    } : undefined,
    gpt_cache_gate: sampleGate(e.gpt_cache_gate),
  };
};

/** Shared launcher/restart boundary. A native fallback never becomes evidence
 * merely because the process restarted; raw payload fields never enter seeds. */
export function toGptCacheSeedEvent(event) {
  if (!event || typeof event !== 'object' || !supported(event.model)
    || event.gpt_cache_gate?.wire_applied === false) return null;
  return sampleEvent(event);
}

/** Historical hashes can identify a transition, not its cause or first token.
 * Keep sessions/configs separate before aggregating numerical model statistics. */
export function analyzeGptCacheEvents(events, { maxSamples = 128 } = {}) {
  const groups = new Map(), buckets = new Map();
  for (const e of events) {
    if (!supported(e?.model) || !(e.status >= 200 && e.status < 300)
      || !finite(e.input_tokens) || !(e.input_tokens > 0) || !finite(e.cached_tokens)
      || e.gpt_cache_gate?.wire_applied === false
      || !(e.gpt_history_checkpoint_chunk > 0)
      || !e.history_image_sha8 && !e.gpt_prefix) continue;
    const key = bucketKey(e);
    const b = buckets.get(key) ?? { stable: [], rewrite: [], runs: [], scheduled: new Map(), chunk: 0 };
    buckets.set(key, b);
    const session = e.gpt_cache_gate?.session ?? e.first_user_sha8;
    if (!session) continue;
    const group = `${key}|${session}|${e.system_sha8 ?? ''}`;
    const previous = groups.get(group);
    const ratio = bounded(e.cached_tokens / e.input_tokens, 0, 1);
    const g = e.gpt_cache_gate;
    const chunk = g?.chosen_options?.checkpointChunk ?? e.gpt_history_checkpoint_chunk;
    const epoch = g?.history_mode === 'summary' && count(g.candidate_cutoff)
      && count(chunk) && chunk > 1 ? g.candidate_cutoff : null;
    if (epoch !== null) b.chunk = chunk;
    if (previous) {
      if (epoch !== null) {
        if (previous.epoch === epoch && previous.chunk === chunk) previous.epochReads++;
        else {
          const consecutive = previous.epoch !== null && previous.chunk === chunk
            && epoch - previous.epoch === chunk;
          if (consecutive && previous.epochComplete) {
            const runs = b.scheduled.get(chunk) ?? [];
            runs.push(Math.max(0, previous.epochReads - 1));
            if (runs.length > maxSamples) runs.splice(0, runs.length - maxSamples);
            b.scheduled.set(chunk, runs);
          }
          previous.epoch = epoch;
          previous.chunk = chunk;
          previous.epochReads = 1;
          previous.epochComplete = consecutive;
        }
      } else {
        previous.epoch = null;
        previous.epochComplete = false;
      }
      const p = e.gpt_prefix;
      const hashChanged = previous.hash && e.history_image_sha8 && previous.hash !== e.history_image_sha8;
      const tailOnly = !hashChanged && p?.first_changed?.area === 'input'
        && p.common_items >= Math.max(1, p.previous_items - 1);
      const changed = p?.status === 'append_only' || p?.status === 'unchanged' || tailOnly ? false
        : p?.status === 'rewrite' || p?.status === 'truncate' ? true : hashChanged;
      const comparable = p?.status !== 'first' && (p?.status !== 'unknown' || hashChanged);
      if (comparable && changed) {
        b.rewrite.push(ratio);
        b.runs.push(previous.run);
        previous.run = 0;
      } else if (comparable) {
        b.stable.push(ratio);
        previous.run++;
      }
      previous.hash = e.history_image_sha8;
    } else groups.set(group, { hash: e.history_image_sha8, run: 0, epoch,
      chunk, epochReads: epoch === null ? 0 : 1, epochComplete: false });
    for (const a of [b.stable, b.rewrite, b.runs])
      if (a.length > maxSamples) a.splice(0, a.length - maxSamples);
  }
  return Object.fromEntries([...buckets].map(([key, b]) => {
    const scheduled = b.scheduled.get(b.chunk) ?? [];
    const sourceEvidence = scheduled.length >= 3;
    return [key, {
    stable_samples: b.stable.length, rewrite_samples: b.rewrite.length,
    // A fixed-source-grid policy should not inherit the retired projector's
    // per-request rewrite frequency. Use completed, consecutive source windows
    // only; skip the first partial window and require three complete samples.
    // Lower quartile is an estimate of future reads, never a savings guarantee.
    horizon: bounded(sourceEvidence ? quantile(scheduled, 0.25, 0) : quantile(b.runs, 0.5, 1), 0, 12),
    horizon_basis: sourceEvidence ? 'source_epochs' : 'rewrites',
    source_epoch_samples: scheduled.length,
    warm_ratio: quantile(b.stable, 0.5, 1),
    // Small/unknown samples assume a fully cold rewrite. With enough data use
    // the conservative lower quartile, not an optimistic mean cache hit rate.
    rewrite_ratio: b.rewrite.length >= 3 ? quantile(b.rewrite, 0.25, 0) : 0,
  }]; }));
}

export function evaluateCacheTransition({ baselineTokens: b, candidateTokens: c,
  readRate: r, writeRate: w = 1, warmRatio = 1, rewriteRatio = 0, horizon = 1,
  preservedPrefixTokens = 0, futureCacheRatio = 1 }) {
  if (![b, c, r, w, warmRatio, rewriteRatio, horizon, preservedPrefixTokens, futureCacheRatio].every(finite)
    || b <= 0 || c < 0 || r <= 0 || r > 1 || w < 1
    || warmRatio < 0 || warmRatio > 1 || rewriteRatio < 0 || rewriteRatio > 1 || horizon < 0
    || preservedPrefixTokens < 0 || futureCacheRatio < 0 || futureCacheRatio > 1)
    return { accept: false, reason: 'invalid_estimate' };
  if (c >= b) return { accept: false, reason: 'no_token_gain' };
  const preserved = Math.min(preservedPrefixTokens, b, c);
  // This exact prefix is already cached in BOTH alternatives. Sampled cache
  // ratios apply only to the remaining suffix; it is not a cold rewrite.
  const oldNow = preserved * r + (b - preserved) * (1 - warmRatio + warmRatio * r);
  const newNow = preserved * r + (c - preserved) * ((1 - rewriteRatio) * w + rewriteRatio * r);
  // Future reads are not necessarily cache hits. In particular a sequence of
  // zero-hit replays must not be modelled as ten cheap cached reads.
  const futureRate = 1 - futureCacheRatio + futureCacheRatio * r;
  const saving = (b - c) * futureRate;
  const payback = Math.ceil(Math.max(0, newNow - oldNow) / saving);
  const baselineCost = oldNow + horizon * b * futureRate;
  const candidateCost = newNow + horizon * c * futureRate;
  if (![oldNow, newNow, saving, payback, baselineCost, candidateCost].every(finite) || saving <= 0)
    return { accept: false, reason: 'invalid_estimate' };
  const accept = candidateCost < baselineCost;
  return { accept, reason: accept ? 'cache_payback_met' : 'cache_payback',
    payback_reads: payback, horizon, baseline_cost: Math.round(baselineCost),
    candidate_cost: Math.round(candidateCost), baseline_tokens: Math.round(b),
    candidate_tokens: Math.round(c), warm_ratio: warmRatio, rewrite_ratio: rewriteRatio,
    read_rate: r, write_rate: w, future_cache_ratio: futureCacheRatio,
    preserved_prefix_tokens: preserved };
}

export function createGptCachePolicy({ events = [], now = Date.now,
  maxSessions = 64, ttlMs = 3_600_000, maxEvents = 4096,
  summaryHorizon = Number(process.env.PXLITE_HISTORY_HORIZON ?? 10),
  contextBudgetTokens = Number.parseInt(process.env.PXLITE_FORCE_COLLAPSE_TOKENS ?? '180000', 10) } = {}) {
  const budget = count(contextBudgetTokens) ? contextBudgetTokens : 180000;
  const planningHorizon = finite(summaryHorizon) && summaryHorizon >= 1
    ? bounded(Math.floor(summaryHorizon), 1, 1000) : 10;
  const recent = events.slice(-maxEvents).map(sampleEvent)
    .filter(e => e.gpt_cache_gate?.wire_applied !== false), states = new Map();
  let statistics, sequence = recent.reduce((n, e) => count(e.gpt_cache_gate?.request_seq)
    ? Math.max(n, e.gpt_cache_gate.request_seq) : n, 0);
  const stats = () => statistics ??= analyzeGptCacheEvents(recent);
  const expire = () => {
    for (const [k, s] of states) if (now() - s.at > ttlMs) states.delete(k);
    while (states.size > maxSessions) states.delete(states.keys().next().value);
  };
  return {
    statistics: () => structuredClone(stats()),
    forRequest({ sessionKey, model, route, historyMode, sourceKey }) {
      if (!sessionKey || !supported(model)) return null;
      expire();
      const mode = historyMode === 'summary' ? 'summary' : 'legacy';
      // Keep the legacy identity byte-for-byte. Versioned summary identities and
      // optional client compact/reset roots must never restore an old cap50 epoch.
      const key = mode === 'legacy' && sourceKey == null
        ? digest(`${model}\0${route}\0${sessionKey}`)
        : digest(JSON.stringify(['gpt-cache-policy', `${mode}-v1`, model, route, sessionKey, sourceKey ?? null]));
      let state = states.get(key);
      if (!state) {
        // Approved epochs can be recovered from numeric diagnostics after restart.
        const eligible = recent.filter(e => e.model === model && e.path === route
          && e.status >= 200 && e.status < 300 && e.gpt_cache_gate?.session === key
          && e.gpt_cache_gate.history_mode === mode
          && count(e.gpt_cache_gate.chosen_cutoff)
          && finite(e.gpt_cache_gate.selected_local_tokens) && e.gpt_cache_gate.selected_local_tokens >= 0
          && finite(e.input_tokens) && e.input_tokens > 0
          && finite(observedAt(e)) && now() - observedAt(e) >= 0 && now() - observedAt(e) <= ttlMs);
        const prior = eligible.reduce((best, e) => !best
          || e.gpt_cache_gate.chosen_cutoff > best.gpt_cache_gate.chosen_cutoff
          || e.gpt_cache_gate.chosen_cutoff === best.gpt_cache_gate.chosen_cutoff
            && older(requestOrder(best.gpt_cache_gate), requestOrder(e.gpt_cache_gate)) ? e : best, null);
        state = { at: prior ? observedAt(prior) : now(), cutoff: prior?.gpt_cache_gate?.chosen_cutoff,
          input: prior?.input_tokens, estimate: prior?.gpt_cache_gate?.selected_local_tokens,
          cached: finite(prior?.cached_tokens) ? bounded(prior.cached_tokens, 0, prior.input_tokens) : 0,
          options: planOptions(prior?.gpt_cache_gate?.chosen_options),
          closedThrough: prior?.gpt_cache_gate?.closed_through,
          signature: prior?.gpt_cache_gate?.closed_prefix_signature,
          order: requestOrder(prior?.gpt_cache_gate) };
      }
      states.delete(key);
      states.set(key, state);
      expire();
      const heldCutoff = state.cutoff;
      const heldOptions = planOptions(state.options);
      // Session-local evidence only. Provider zeros are evidence; missing usage
      // is not zero. Keep this reconstructible across restart from safe seeds.
      const local = recent.filter(e => e.model === model && e.path === route
        && e.gpt_cache_gate?.session === key && e.status >= 200 && e.status < 300
        && e.gpt_cache_gate.wire_applied !== false && e.input_tokens > 0)
        .sort((a, b) => observedAt(a) - observedAt(b));
      let missStreak = 0;
      for (let i = local.length - 1; i >= 0 && local[i].cached_tokens === 0; i--) missStreak++;
      const ratios = local.slice(-3).filter(e => finite(e.cached_tokens))
        .map(e => bounded(e.cached_tokens / e.input_tokens, 0, 1));
      const recentWarm = ratios.length ? quantile(ratios, 0.25, 0) : undefined;
      const order = [now(), ++sequence];
      let chosen;
      const cacheGate = {
        heldCutoff,
        heldOptions: { ...heldOptions },
        get heldClosedThrough() { return state.closedThrough; },
        get heldSignature() { return state.signature; },
        evaluate({ candidateCutoff, baselineTokens, candidateTokens, sameWire = false,
          opaquePrefixChanged = false, profile, options, preservedPrefixTokens = 0,
          reasoningRemoved = 0, summaryMode = false,
          baselineOpaqueItems, candidateOpaqueItems, sealedPrefixPreserved = false, savedTextChars }) {
          const s = stats()[`${model}|${route}`] ?? {
            horizon: 1, warm_ratio: 1, rewrite_ratio: 0, stable_samples: 0, rewrite_samples: 0 };
          // Unknown hidden-state cost is a shared offset, NOT tokenized ciphertext.
          const offset = Math.max(0, (state.input ?? 0) - (state.estimate ?? state.input ?? 0));
          const scale = state.input > 0 && state.estimate > state.input ? state.input / state.estimate : 1;
          const baseline = baselineTokens * scale + offset;
          const candidate = candidateTokens * scale + offset;
          const valid = finite(baselineTokens) && baselineTokens > 0
            && finite(candidateTokens) && candidateTokens >= 0
            && finite(preservedPrefixTokens) && preservedPrefixTokens >= 0
            && count(candidateCutoff) && count(reasoningRemoved);
          // Credit visible immutable tokens only, capped by real provider cache
          // evidence. The opaque calibration offset is shared/unknown, not credit.
          let preserved = valid ? Math.floor(Math.min(
            Math.min(preservedPrefixTokens, baselineTokens, candidateTokens) * scale, state.cached ?? 0)) : 0;
          const bootstrap = heldCutoff === undefined;
          // A held cutoff alone does not make a projector migration a replay.
          // Missing versions identify the original projection, including seeds.
          const sameEpoch = candidateCutoff === heldCutoff
            && (options?.projectionVersion ?? 1) === (heldOptions.projectionVersion ?? 1)
            && (options?.checkpointChunk ?? heldOptions.checkpointChunk) === heldOptions.checkpointChunk;
          const claudeSummary = mode === 'summary' && summaryMode
            && options?.projectionVersion >= 5;
          // Item equality is not proof of a reusable provider breakpoint. Live
          // Sol rewrites returned zero cached tokens despite a long equal prefix.
          // Price a new summary wire as a full miss; same-wire replays don't pay.
          const fullMissRewrite = claudeSummary && !sameWire && !sameEpoch;
          if (fullMissRewrite) preserved = 0;
          // Match Claude's explicit planning assumption, rather than using the
          // retired projector's rewrite frequency to predict a one-read lifetime.
          // Completed source epochs take precedence; ten is a policy horizon,
          // not a claim that the caller will actually make ten further requests.
          const horizon = claudeSummary && s.horizon_basis !== 'source_epochs' ? planningHorizon : s.horizon;
          const horizonBasis = claudeSummary && s.horizon_basis !== 'source_epochs'
            ? 'claude_default' : s.horizon_basis ?? 'rewrites';
          let g = valid ? evaluateCacheTransition({ baselineTokens: baseline, candidateTokens: candidate,
              readRate: profile?.cacheReadRate, writeRate: profile?.cacheWriteRate ?? 1,
              warmRatio: bootstrap ? 0 : claudeSummary && finite(state.cached) && state.input > 0
                ? bounded(state.cached / state.input, 0, 1) : s.warm_ratio,
              rewriteRatio: bootstrap || opaquePrefixChanged || fullMissRewrite ? 0 : s.rewrite_ratio,
              futureCacheRatio: claudeSummary ? recentWarm ?? 0 : 1,
               horizon: bootstrap ? 0 : horizon, preservedPrefixTokens: preserved })
            : { accept: false, reason: 'invalid_estimate' };
          // Only an unchanged epoch/wire can bypass payback. Retiring opaque
          // reasoning is not evidence of savings and cannot approve a rewrite.
          if (g.reason !== 'invalid_estimate' && (sameEpoch || sameWire))
            g = { accept: true, reason: 'same_epoch_or_wire' };
          // Opaque retirement alone is NOT a financial override. Below budget,
          // an unprofitable retirement waits; over budget the separate guard
          // below still provides bounded context/state retention.
          // After repeated misses, approve a new layout only if it pays for
          // itself immediately, without a promise that caching will recover.
          if (valid && claudeSummary && !bootstrap && !sameEpoch && !sameWire
              && missStreak >= 3 && g.reason !== 'invalid_estimate') {
            const immediate = evaluateCacheTransition({
              baselineTokens: baseline, candidateTokens: candidate,
              readRate: profile?.cacheReadRate, writeRate: profile?.cacheWriteRate ?? 1,
              warmRatio: finite(state.cached) && state.input > 0 ? state.cached / state.input : 1,
              rewriteRatio: 0, horizon: 0, futureCacheRatio: 0,
              preservedPrefixTokens: preserved });
            if (!immediate.accept) g = { ...g, accept: false,
              reason: 'cache_recovery_unproven', recovery_immediate_accept: false };
          }
          const contextTokens = Math.max(state.input ?? 0, finite(baseline) ? baseline : 0);
          const visibleGain = baseline - candidate;
          const materialGain = visibleGain >= Math.max(4096, baseline * 0.02);
          const retiringState = count(baselineOpaqueItems) && count(candidateOpaqueItems)
            && baselineOpaqueItems - candidateOpaqueItems >= Math.max(30, Math.ceil(baselineOpaqueItems / 2))
            && reasoningRemoved >= baselineOpaqueItems - candidateOpaqueItems
            && candidateCutoff > (heldCutoff ?? 0) && candidate <= baseline;
          // Context safety is separate from cache economics. Only a valid,
          // advancing/different wire may override payback; an unchanged epoch
          // never repeatedly reloads its cache. Opaque savings remain unknown.
          if (valid && mode === 'summary' && budget > 0 && contextTokens >= budget
              && g.reason !== 'invalid_estimate'
              && !sameWire && !sameEpoch && !g.accept && (materialGain || retiringState)) {
            g = { ...g, accept: true, reason: 'context_budget',
              baseline_tokens: Math.round(baseline), candidate_tokens: Math.round(candidate),
              economic_accept: false, economic_reason: g.reason, budget_forced: true,
              unknown_reasoning_savings: reasoningRemoved > 0 };
          }
          // Match the tool-output saved-character floor. Count visible native
          // text only, not ciphertext bytes or image base64. A context-budget
          // override must not smuggle a tiny history rewrite past this floor.
          // Legacy integrations without this field retain their old contract.
          if (valid && !bootstrap && !sameWire && !sameEpoch
              && finite(savedTextChars) && savedTextChars < 40_000) {
            g = { ...g, accept: false, reason: 'min_gain_chars', budget_forced: false };
          }
          chosen = { ...g, session: key, estimate: true, history_mode: mode,
            ...(finite(savedTextChars) ? { saved_text_chars: savedTextChars, min_gain_chars: 40_000 } : {}),
            full_miss_rewrite: fullMissRewrite,
            context_budget_tokens: budget,
            context_tokens: Math.round(contextTokens),
            context_tokens_basis: (state.input ?? 0) >= contextTokens
              ? 'provider_last_usage' : 'calibrated_visible_estimate',
            preserved_prefix_tokens: preserved,
            request_started_ms: order[0], request_seq: order[1],
            estimate_basis: 'o200k_vision_plus_last_usage_offset',
            candidate_cutoff: finite(candidateCutoff) ? candidateCutoff : 0,
            held_cutoff: heldCutoff ?? 0,
            chosen_cutoff: g.accept ? candidateCutoff : heldCutoff ?? 0,
            chosen_options: g.accept && !sameEpoch ? planOptions(options) : { ...heldOptions },
            selected_local_tokens: finite(g.accept ? candidateTokens : baselineTokens)
              ? g.accept ? candidateTokens : baselineTokens : 0,
            stable_samples: s.stable_samples, rewrite_samples: s.rewrite_samples,
             horizon_basis: horizonBasis,
            source_epoch_samples: s.source_epoch_samples ?? 0,
            cache_miss_streak: missStreak,
            recent_cache_ratio: recentWarm ?? 0,
            cache_health: missStreak >= 3 ? 'unrecovered' : ratios.length ? 'observed' : 'unknown',
            bootstrap, opaque_prefix_worst_case: opaquePrefixChanged === true, calibration_offset: Math.round(offset) };
          return chosen;
        },
      };
      return {
        cacheGate,
        record(event) {
          const report = event.gpt_cache_gate ?? chosen;
          // Native-body fallbacks did not apply this plan, so supply no evidence
          // for its epoch, token calibration, preserved prefix, or TTL.
          if (report?.wire_applied === false || report?.reason === 'invalid_estimate'
            || !(event.status >= 200 && event.status < 300)
            || !finite(event.input_tokens) || !(event.input_tokens > 0)) return;
          const g = sampleGate(report);
          if (g) {
            if (g.session !== key || !count(g.chosen_cutoff)
              || !finite(g.selected_local_tokens) || g.selected_local_tokens < 0) return;
            // A slower old request must never move the committed epoch backwards.
            if (state.cutoff !== undefined && g.chosen_cutoff < state.cutoff) return;
            if (state.order && older(requestOrder(g), state.order)) return;
            state.cutoff = Math.max(state.cutoff ?? 0, g.chosen_cutoff);
            state.estimate = g.selected_local_tokens;
            state.options = planOptions(g.chosen_options);
            state.closedThrough = g.closed_through;
            state.signature = g.closed_prefix_signature;
            state.order = requestOrder(g);
          }
          state.input = event.input_tokens;
          state.cached = finite(event.cached_tokens) ? bounded(event.cached_tokens, 0, event.input_tokens) : 0;
          state.at = now();
          const sample = sampleEvent(event);
          sample.gpt_cache_gate = g;
          sample._cache_observed_at = state.at;
          recent.push(sample);
          if (recent.length > maxEvents) recent.splice(0, recent.length - maxEvents);
          statistics = undefined;
        },
      };
    },
  };
}
