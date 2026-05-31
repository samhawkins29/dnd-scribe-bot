/**
 * Shared Anthropic (Claude) REST client.
 *
 * Uses a direct REST call to the Anthropic API (no SDK) because the
 * Anthropic Python SDK's pydantic DLLs are blocked by Windows
 * Application Control on the host.
 *
 * Why this exists as a shared module: the transcript corrector, scene
 * detector, and character detector all previously carried an identical,
 * minimal `callSonnet` helper with no timeout and no retry. Large
 * multi-hour transcripts (~100 KB) with a 32K output budget take several
 * minutes to generate; a non-streaming request leaves the socket idle the
 * whole time, and network intermediaries silently drop idle sockets —
 * which surfaces in Node's fetch as a bare "fetch failed". This client
 * fixes that by:
 *
 *   1. Streaming (stream: true) so bytes keep flowing and the socket
 *      never goes idle during a long generation.
 *   2. Retrying transient failures (network errors, 429, 5xx, 529) with
 *      exponential backoff.
 *   3. Bounding each attempt with an AbortController timeout.
 */

const config = require('../config');
const log = require('../logger');

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-4-20250514';

// Per-attempt wall-clock cap. Generous enough for a 32K-token echo of a
// multi-hour transcript, but bounded so a truly hung socket can't stall
// the pipeline forever.
const ATTEMPT_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 3;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * True for errors worth retrying: low-level network failures (undici's
 * "fetch failed" TypeError, socket hang-ups) and transient HTTP statuses.
 */
function isRetryable(err) {
  if (err && err.name === 'AbortError') return true;
  if (err && typeof err.status === 'number') {
    return err.status === 429 || err.status === 529 || (err.status >= 500 && err.status <= 599);
  }
  // Network-layer failures from fetch arrive as TypeError("fetch failed")
  // with a `cause`, or as generic errors without an HTTP status.
  return true;
}

/**
 * Read a streaming (SSE) Anthropic response body and accumulate the text
 * from content_block_delta events into a single string.
 */
async function readStream(res) {
  let text = '';
  let buffer = '';
  const decoder = new TextDecoder();

  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });

    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);

      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;

      let evt;
      try {
        evt = JSON.parse(payload);
      } catch {
        continue; // ignore partial/non-JSON keepalive lines
      }

      if (evt.type === 'content_block_delta' && evt.delta) {
        if (typeof evt.delta.text === 'string') text += evt.delta.text;
      } else if (evt.type === 'error') {
        const msg = evt.error?.message || 'stream error';
        const e = new Error(`Anthropic stream error: ${msg}`);
        e.status = 529; // treat mid-stream errors as transient
        throw e;
      }
    }
  }

  return text;
}

/**
 * Call Claude with a single user prompt and return the concatenated text
 * output. Streams the response and retries transient failures.
 *
 * @param {string} prompt     The user prompt.
 * @param {number} maxTokens  Output token budget.
 * @param {object} [opts]
 * @param {string} [opts.model]  Override the model (defaults to config / Sonnet).
 * @returns {Promise<string>}
 */
async function callClaude(prompt, maxTokens, opts = {}) {
  const apiKey = config.anthropic.apiKey;
  if (!apiKey || apiKey.includes('YOUR_')) {
    throw new Error('Anthropic API key not configured');
  }

  const model = opts.model || config.anthropic.model || DEFAULT_MODEL;
  const body = JSON.stringify({
    model,
    max_tokens: maxTokens,
    stream: true,
    messages: [{ role: 'user', content: prompt }],
  });

  let lastErr = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS);

    try {
      const res = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          'content-type': 'application/json',
        },
        body,
        signal: controller.signal,
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => '(no body)');
        const e = new Error(`Anthropic API error ${res.status}: ${errBody}`);
        e.status = res.status;
        throw e;
      }

      return await readStream(res);
    } catch (err) {
      lastErr = err;
      const retryable = isRetryable(err);
      log.warn('Anthropic call failed', {
        attempt,
        of: MAX_ATTEMPTS,
        retryable,
        error: err.message,
        cause: err.cause?.message,
      });
      if (!retryable || attempt === MAX_ATTEMPTS) break;
      // Exponential backoff: 2s, 4s, 8s …
      await sleep(2000 * 2 ** (attempt - 1));
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(
    `Anthropic call failed after ${MAX_ATTEMPTS} attempt(s): ${lastErr?.message || 'unknown error'}`
  );
}

module.exports = { callClaude };
