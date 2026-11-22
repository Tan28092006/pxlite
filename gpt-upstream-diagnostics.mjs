// Passive diagnostics only: no retries, credentials, prompt text or body reads.
import { createHash } from 'node:crypto';
const hash = x => createHash('sha256').update(x).digest('hex').slice(0, 24);
const id = x => typeof x === 'string' && /^[a-zA-Z0-9_.:-]{1,160}$/.test(x) ? x : undefined;
export function describeGptUpstream(url, body) {
  const u = new URL(url);
  const req = typeof body === 'string' ? JSON.parse(body)
    : JSON.parse(new TextDecoder().decode(body));
  const input = Array.isArray(req.input) ? req.input : Array.isArray(req.messages) ? req.messages : [];
  let anchors = 0, images = 0;
  for (const item of input) {
    if (item?.prompt_cache_breakpoint) anchors++;
    for (const parts of [item?.content, item?.output]) if (Array.isArray(parts))
      for (const p of parts) {
        if (p?.prompt_cache_breakpoint) anchors++;
        if (['input_image', 'image_url'].includes(p?.type)) images++;
      }
  }
  return {
    endpoint_sha: hash(u.origin + u.pathname),
    cache_key_sha: typeof req.prompt_cache_key === 'string' ? hash(req.prompt_cache_key) : null,
    cache_mode: ['implicit', 'explicit'].includes(req.prompt_cache_options?.mode)
      ? req.prompt_cache_options.mode : req.prompt_cache_options?.mode == null ? 'default' : 'other',
    retention: ['in-memory', '24h'].includes(req.prompt_cache_retention)
      ? req.prompt_cache_retention : req.prompt_cache_retention == null ? 'default' : 'other',
    anchors, images, items: input.length,
    has_previous_response: typeof req.previous_response_id === 'string',
    has_conversation: req.conversation != null,
  };
}
export function describeGptResponse(response) {
  return {
    status: response.status,
    request_id: id(response.headers.get('x-request-id')) ?? null,
    response_id: id(response.headers.get('x-response-id')) ?? null,
    // This is only a transport header, NOT proof of prompt-cache eligibility.
    has_transport_cache_header: response.headers.has('x-cache'),
  };
}
