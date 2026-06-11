/**
 * D&D Scribe Bot — LLM cost estimation & ceiling enforcement.
 *
 * The story pipeline can resend a full multi-hour transcript many times: the
 * verification loop runs up to 4 (campaign) / 10 (one-shot) regenerations, each
 * resending the whole transcript plus a verifier call that resends transcript +
 * story. With no bound that is real, unbounded money on a long session.
 *
 * This module provides:
 *   - a rough token estimate (chars/4) for budgeting before any call is made,
 *   - a per-model USD price table,
 *   - a CostGuard that accumulates *actual* usage (from API `usage` blocks) and
 *     answers "would the next attempt blow the ceiling?" so the loop can stop.
 *
 * Prices are approximate USD per 1M tokens and may drift; they exist to keep a
 * runaway loop from silently spending, not to bill anyone to the cent.
 */

// USD per 1,000,000 tokens, matched by model-id prefix (longest match wins).
const MODEL_PRICING = [
  { prefix: 'claude-opus-4', input: 15, output: 75 },
  { prefix: 'claude-sonnet-4', input: 3, output: 15 },
  { prefix: 'claude-3-5-haiku', input: 0.8, output: 4 },
  { prefix: 'claude-haiku-4', input: 1, output: 5 },
  { prefix: 'claude-3-haiku', input: 0.25, output: 1.25 },
];
// Fallback assumes Sonnet-class pricing — the pipeline's default model.
const DEFAULT_PRICING = { input: 3, output: 15 };

function pricingFor(model) {
  if (!model) return DEFAULT_PRICING;
  const matches = MODEL_PRICING
    .filter(p => model.startsWith(p.prefix))
    .sort((a, b) => b.prefix.length - a.prefix.length);
  return matches[0] || DEFAULT_PRICING;
}

/** Rough token estimate: ~4 characters per token for English prose. */
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/** USD cost of a call with the given token counts on the given model. */
function costForTokens(inputTokens, outputTokens, model) {
  const p = pricingFor(model);
  return (inputTokens / 1e6) * p.input + (outputTokens / 1e6) * p.output;
}

/**
 * Tracks accumulated spend against a ceiling for one logical operation
 * (e.g. generating a single chapter, across its main call + retries +
 * verifier calls).
 */
class CostGuard {
  /**
   * @param {object} opts
   * @param {number} [opts.maxUsd]  Hard ceiling in USD (<=0 or omitted ⇒ no cap).
   * @param {string} [opts.model]   Default model for cost attribution.
   * @param {string} [opts.label]   Human label for logs.
   */
  constructor({ maxUsd, model, label } = {}) {
    this.maxUsd = typeof maxUsd === 'number' && maxUsd > 0 ? maxUsd : Infinity;
    this.model = model;
    this.label = label || 'generation';
    this.spentUsd = 0;
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.calls = 0;
  }

  /** Record real usage from an API response's `usage` block. */
  record(usage, model) {
    if (!usage) return;
    const inT = usage.input_tokens || 0;
    const outT = usage.output_tokens || 0;
    this.inputTokens += inT;
    this.outputTokens += outT;
    this.spentUsd += costForTokens(inT, outT, model || this.model);
    this.calls += 1;
  }

  remainingUsd() {
    return this.maxUsd === Infinity ? Infinity : Math.max(0, this.maxUsd - this.spentUsd);
  }

  /** Would spending an estimated `projectedUsd` more push past the ceiling? */
  wouldExceed(projectedUsd) {
    if (this.maxUsd === Infinity) return false;
    return this.spentUsd + projectedUsd > this.maxUsd;
  }

  summary() {
    return {
      calls: this.calls,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      spentUsd: Number(this.spentUsd.toFixed(4)),
      maxUsd: this.maxUsd === Infinity ? null : this.maxUsd,
    };
  }
}

module.exports = { MODEL_PRICING, pricingFor, estimateTokens, costForTokens, CostGuard };
