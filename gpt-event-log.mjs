// Serialization only. Never feed this projection back into live policy state.
const omit = (value, keys) => Object.fromEntries(Object.entries(value)
  .filter(([key]) => !keys.has(key)));
const TOP_NOISE = new Set([
  'cwd', 'is_git_repo', 'git_branch', 'platform', 'os_version', 'today',
  'baseline_tokens', 'baseline_cacheable_tokens', 'baseline_imaged_tokens',
  'native_injected_tokens', 'text_chars_measured', 'thinking_chars_measured',
  'tool_use_chars_measured', 'dropped_codepoints_top', 'bucket_chars',
  'history_tuning', 'history_gate',
]);
const TOP_ZERO = new Set([
  'static_chars', 'dynamic_chars', 'dynamic_block_count', 'tool_result_imgs',
  'tool_docs_chars', 'image_count', 'image_bytes', 'cache_write_tokens',
]);
const GATE_NOISE = new Set([
  'estimate', 'estimate_basis', 'baseline_cost', 'candidate_cost',
  'baseline_tokens', 'candidate_tokens', 'warm_ratio', 'rewrite_ratio',
  'read_rate', 'write_rate', 'future_cache_ratio', 'calibration_offset',
  'context_tokens_basis', 'min_gain_chars',
]);
const GATE_ZERO = new Set([
  'stable_samples', 'rewrite_samples', 'source_epoch_samples', 'cache_miss_streak',
  'preserved_prefix_tokens', 'candidate_reasoning_removed', 'reasoning_removed',
  'reasoning_kept_at_checkpoint', 'reasoning_protected', 'opaque_items',
  'unknown_image_dimensions', 'text_fallbacks', 'deferred_epochs',
  'reasoning_summaries', 'candidate_archived_pairs', 'candidate_history_images',
  'visible_overhead_tokens',
]);
const GATE_FALSE = new Set([
  'bootstrap', 'opaque_prefix_worst_case', 'unknown_reasoning_savings',
  'budget_forced', 'history_reset', 'full_miss_rewrite',
]);
const withoutHash = value => value == null ? value : omit(value, new Set(['hash']));

function compactDiff(diff, status) {
  if (!diff) return diff;
  const { before, after, changes = [], ...out } = diff;
  // On routine rounds only counts are useful. Do not repeat all block hashes
  // and every appended item/part fingerprint.
  if (!['rewrite', 'truncate', 'unknown'].includes(status)) {
    out.reported_changes = 0;
    if (changes.length) out.details_omitted = true;
    return out;
  }
  const blocks = {};
  for (const key of new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])) {
    if (JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key]))
      blocks[key] = { before: withoutHash(before?.[key]), after: withoutHash(after?.[key]) };
  }
  if (Object.keys(blocks).length) out.blocks = blocks;
  out.changes = changes.slice(0, 8).map(change => ({
    ...change, before: withoutHash(change.before), after: withoutHash(change.after),
  }));
  out.reported_changes = out.changes.length;
  out.truncated = diff.truncated || changes.length > out.changes.length;
  return out;
}

/** Pure, detached JSON-event projection. Unknown diagnostics pass through.
 * chosen_options and numeric/hash restore metadata intentionally remain complete:
 * each line must independently seed policy after rotation/restart.
 */
export function projectGptEvent(event, { detail = 'compact' } = {}) {
  if (detail === 'full' || !/^(?:openai\/)?(?:gpt-|o\d)/i.test(event?.model ?? ''))
    return structuredClone(event);
  const out = structuredClone(omit(event, TOP_NOISE));
  for (const key of TOP_ZERO) if (out[key] === 0) delete out[key];
  if (out.compressed === false) delete out.compressed;
  if (out.tool_collapse?.mode === 'history_cache_gate' && out.tool_collapse.collapsed === 0)
    delete out.tool_collapse; // Already represented by held/chosen_cutoff.
  if (out.gpt_cache_gate) {
    out.gpt_cache_gate = omit(out.gpt_cache_gate, GATE_NOISE);
    for (const key of GATE_ZERO) if (out.gpt_cache_gate[key] === 0) delete out.gpt_cache_gate[key];
    for (const key of GATE_FALSE) if (out.gpt_cache_gate[key] === false) delete out.gpt_cache_gate[key];
  }
  if (out.gpt_prefix) {
    if (out.gpt_prefix.reason == null) delete out.gpt_prefix.reason;
    if (out.gpt_prefix.truncated === false) delete out.gpt_prefix.truncated;
    if (out.gpt_prefix.has_key === true) delete out.gpt_prefix.has_key;
  }
  if ('gpt_prefix_diff' in out)
    out.gpt_prefix_diff = compactDiff(out.gpt_prefix_diff, out.gpt_prefix?.status);
  if (out.gpt_upstream) {
    for (const key of ['cache_key_sha', 'request_id', 'response_id'])
      if (out.gpt_upstream[key] == null) delete out.gpt_upstream[key];
    for (const key of ['cache_mode', 'retention'])
      if (out.gpt_upstream[key] === 'default') delete out.gpt_upstream[key];
    for (const key of ['anchors', 'images'])
      if (out.gpt_upstream[key] === 0) delete out.gpt_upstream[key];
    for (const key of ['has_previous_response', 'has_conversation'])
      if (out.gpt_upstream[key] === false) delete out.gpt_upstream[key];
    // Keep transport-header false too: it is useful negative evidence.
  }
  return out;
}
