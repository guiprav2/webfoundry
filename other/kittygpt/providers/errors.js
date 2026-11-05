// providers/errors.js
// Normalized provider errors. Each provider exposes `parseError(status, bodyText, headers)`
// (HTTP errors) and may throw `ProviderError` from its stream parser (in-band errors).

export class ProviderError extends Error {
  constructor({ provider, status = null, code = null, type = null, summary, detail = '', hint = '', retryable = false, retryAfterMs = null, raw = null }) {
    let head = `${provider}: ${summary}` + (status || code ? ` (${[status && `HTTP ${status}`, code].filter(Boolean).join(' ')})` : '');
    super([head, detail && `  ${detail}`, hint && `  Hint: ${hint}`].filter(Boolean).join('\n'));
    this.name = 'ProviderError';
    Object.assign(this, { provider, status, code, type, summary, detail, hint, retryable, retryAfterMs, raw });
  }

  /** Short label for the status line. */
  get short() {
    return `${this.provider}: ${this.summary}`;
  }
}

/** Parse Retry-After / retry-after-ms headers into milliseconds (null if absent). */
export function retryAfterMs(headers) {
  let get = k => headers?.get?.(k) ?? headers?.[k] ?? null;
  let ms = Number(get('retry-after-ms'));
  if (Number.isFinite(ms) && ms > 0) return ms;
  let ra = get('retry-after');
  if (ra == null) return null;
  let secs = Number(ra);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  let date = Date.parse(ra);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function parseBody(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function trimText(text, n = 500) {
  let s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

let isServerStatus = s => s === 408 || s === 409 || (s >= 500 && s <= 599);

/* --------------------------------------------------
 * OpenAI (Responses + Chat Completions)
 * Body: { error: { message, type, param, code } }
 * https://platform.openai.com/docs/guides/error-codes
 * -------------------------------------------------- */
export function openaiError(status, bodyText, headers, provider = 'OpenAI') {
  let body = parseBody(bodyText);
  let e = body?.error && typeof body.error === 'object' ? body.error : body || {};
  let code = e.code || null;
  let type = e.type || null;
  let detail = e.message || trimText(bodyText);
  let msg = String(detail).toLowerCase();
  let out = { provider, status, code, type, detail, raw: body ?? bodyText, retryAfterMs: retryAfterMs(headers) };

  if (status === 401) {
    if (code === 'invalid_api_key' || msg.includes('incorrect api key'))
      return new ProviderError({ ...out, summary: 'invalid API key', hint: 'check OPENAI_API_KEY in ~/.kittygpt/.env.' });
    if (msg.includes('member of an organization'))
      return new ProviderError({ ...out, summary: 'account is not part of an organization', hint: 'join an organization or create a new key.' });
    if (msg.includes('ip'))
      return new ProviderError({ ...out, summary: 'request IP not authorized', hint: 'check the IP allowlist for your project.' });
    return new ProviderError({ ...out, summary: 'authentication failed', hint: 'check OPENAI_API_KEY in ~/.kittygpt/.env.' });
  }
  if (status === 403) {
    if (code === 'unsupported_country_region_territory' || msg.includes('country'))
      return new ProviderError({ ...out, summary: 'region not supported' });
    return new ProviderError({ ...out, summary: 'permission denied', hint: 'the key or project may lack access to this model or endpoint.' });
  }
  if (status === 404) {
    if (code === 'model_not_found' || msg.includes('model'))
      return new ProviderError({ ...out, summary: 'model not found', hint: 'check --model; the model may not exist or your key may lack access to it.' });
    return new ProviderError({ ...out, summary: 'not found' });
  }
  if (status === 429) {
    if (code === 'insufficient_quota' || msg.includes('exceeded your current quota'))
      return new ProviderError({ ...out, summary: 'out of credits / quota exceeded', hint: 'add credits or raise the limit at https://platform.openai.com/settings/organization/billing.' });
    return new ProviderError({ ...out, summary: 'rate limited', retryable: true });
  }
  if (status === 400 || status === 422) {
    if (code === 'context_length_exceeded' || msg.includes('context length') || msg.includes('maximum context'))
      return new ProviderError({ ...out, summary: 'context length exceeded', hint: 'lower --max-context so the window rolls over sooner.' });
    if (code === 'invalid_prompt' || msg.includes('flagged'))
      return new ProviderError({ ...out, summary: 'prompt rejected by safety filter' });
    if (code === 'unsupported_parameter' || code === 'unsupported_value')
      return new ProviderError({ ...out, summary: 'unsupported parameter for this model', hint: e.param ? `parameter: ${e.param}` : '' });
    return new ProviderError({ ...out, summary: 'invalid request', hint: e.param ? `parameter: ${e.param}` : '' });
  }
  if (status === 503 && (msg.includes('slow down')))
    return new ProviderError({ ...out, summary: 'slow down (traffic spike)', retryable: true });
  if (status === 503)
    return new ProviderError({ ...out, summary: 'service overloaded', retryable: true });
  if (isServerStatus(status))
    return new ProviderError({ ...out, summary: 'server error', retryable: true });
  return new ProviderError({ ...out, summary: `unexpected error` });
}

/** Responses API in-band stream errors (`error`, `response.failed`). */
export function openaiStreamError(payload, provider = 'OpenAI') {
  let e = payload?.type === 'response.failed'
    ? (payload.response?.error || {})
    : (payload?.error && typeof payload.error === 'object' ? payload.error : payload || {});
  let code = e.code || null;
  let detail = e.message || 'stream failed';
  let summary = {
    server_error: 'server error',
    rate_limit_exceeded: 'rate limited',
    insufficient_quota: 'out of credits / quota exceeded',
    invalid_prompt: 'prompt rejected by safety filter',
    context_length_exceeded: 'context length exceeded',
    vector_store_timeout: 'vector store timeout',
    invalid_image: 'invalid image',
    invalid_image_format: 'invalid image format',
    invalid_base64_image: 'invalid base64 image',
    invalid_image_url: 'invalid image URL',
    image_too_large: 'image too large',
    image_too_small: 'image too small',
    image_parse_error: 'image parse error',
    image_content_policy_violation: 'image violates content policy',
    invalid_image_mode: 'invalid image mode',
    image_file_too_large: 'image file too large',
    unsupported_image_media_type: 'unsupported image media type',
    empty_image_file: 'empty image file',
    failed_to_download_image: 'failed to download image',
    image_file_not_found: 'image file not found',
  }[code] || 'response failed';
  let hint = code === 'context_length_exceeded' ? 'lower --max-context so the window rolls over sooner.' : '';
  // Mid-stream failures are not retried (partial output may already be shown).
  return new ProviderError({ provider, code, summary, detail, hint, raw: payload });
}

/* --------------------------------------------------
 * xAI
 * Body: { code: "permission-denied", error: "..." } (sometimes OpenAI-shaped)
 * https://docs.x.ai/docs/key-information/debugging
 * -------------------------------------------------- */
export function xaiError(status, bodyText, headers) {
  let body = parseBody(bodyText);
  // Some xAI endpoints return OpenAI-compatible bodies.
  if (body?.error && typeof body.error === 'object') return openaiError(status, bodyText, headers, 'xAI');

  let code = body?.code || null;
  let detail = (typeof body?.error === 'string' && body.error) || body?.message || trimText(bodyText);
  let msg = String(detail).toLowerCase();
  let out = { provider: 'xAI', status, code, detail, raw: body ?? bodyText, retryAfterMs: retryAfterMs(headers) };

  switch (status) {
    case 400:
      if (msg.includes('context') && (msg.includes('length') || msg.includes('maximum') || msg.includes('too long')))
        return new ProviderError({ ...out, summary: 'context length exceeded', hint: 'lower --max-context so the window rolls over sooner.' });
      if (msg.includes('api key'))
        return new ProviderError({ ...out, summary: 'invalid API key', hint: 'check XAI_KEY in ~/.kittygpt/.env.' });
      return new ProviderError({ ...out, summary: 'invalid request' });
    case 401:
      return new ProviderError({ ...out, summary: 'missing or invalid API key', hint: 'check XAI_KEY in ~/.kittygpt/.env.' });
    case 403:
      if (msg.includes('credits') || msg.includes('spending limit'))
        return new ProviderError({ ...out, summary: 'out of credits or monthly spending limit reached', hint: 'buy credits or raise the spending limit at https://console.x.ai.' });
      if (msg.includes('blocked') || msg.includes('disabled'))
        return new ProviderError({ ...out, summary: 'API key blocked or disabled', hint: 'check the key at https://console.x.ai.' });
      return new ProviderError({ ...out, summary: 'permission denied', hint: 'the key may lack access to this model or endpoint.' });
    case 404:
      return new ProviderError({ ...out, summary: msg.includes('model') ? 'model not found' : 'not found', hint: 'check --model and the endpoint.' });
    case 405:
      return new ProviderError({ ...out, summary: 'method not allowed' });
    case 413:
      return new ProviderError({ ...out, summary: 'request too large', hint: 'lower --max-context or shrink attachments.' });
    case 415:
      return new ProviderError({ ...out, summary: 'unsupported media type' });
    case 422:
      return new ProviderError({ ...out, summary: 'unprocessable request (invalid field format)' });
    case 429:
      return new ProviderError({ ...out, summary: 'rate limited', retryable: true });
  }
  if (isServerStatus(status))
    return new ProviderError({ ...out, summary: status === 503 ? 'service unavailable' : 'server error', retryable: true });
  return new ProviderError({ ...out, summary: 'unexpected error' });
}

/** xAI streams use the Responses event shapes; reuse the OpenAI parser with xAI labeling. */
export function xaiStreamError(payload) {
  return openaiStreamError(payload, 'xAI');
}

/** Transport failures (DNS, reset, TLS) before any HTTP status. */
export function networkError(provider, err) {
  let cause = err?.cause?.code || err?.cause?.message || err?.message || String(err);
  return new ProviderError({ provider, code: err?.cause?.code || null, summary: 'network error', detail: String(cause), retryable: true, raw: err });
}
