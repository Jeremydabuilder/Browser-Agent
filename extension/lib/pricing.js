// Cost estimates and the local OpenAI spending guard.
// These are APP-SIDE ESTIMATES based on a price table the user can edit in Settings. They are not
// the provider's billing: real charges can differ (price changes, rounding, free tiers, retries).
import { getItem, setItem } from './storage.js';

// Default prices in US dollars (September 2026, from the providers' public price pages at the time of
// writing). Edit them in Settings if they change. Unknown models use the conservative fallback.
export const DEFAULT_PRICES = Object.freeze({
  transcriptionPerMinute: {
    openai: { 'whisper-1': 0.006, 'gpt-4o-transcribe': 0.006, 'gpt-4o-mini-transcribe': 0.003 },
    groq: { 'whisper-large-v3': 0.111 / 60, 'whisper-large-v3-turbo': 0.04 / 60, 'distil-whisper-large-v3-en': 0.02 / 60 },
  },
  // [input, output] per 1 million tokens
  chatPer1M: {
    openai: { 'gpt-4o-mini': [0.15, 0.6], 'gpt-4.1-mini': [0.4, 1.6], 'gpt-4.1-nano': [0.1, 0.4], 'gpt-4.1': [2, 8], 'gpt-4o': [2.5, 10], 'gpt-5-mini': [0.25, 2], 'gpt-5-nano': [0.05, 0.4], 'gpt-5': [1.25, 10] },
    groq: { 'llama-3.3-70b-versatile': [0.59, 0.79], 'llama-3.1-8b-instant': [0.05, 0.08], 'openai/gpt-oss-120b': [0.15, 0.75], 'openai/gpt-oss-20b': [0.1, 0.5] },
  },
  fallback: { transcriptionPerMinute: 0.006, chatPer1M: [2.5, 10] },
});

/** Longest price-table key that the model id starts with (so "gpt-4o-mini-2024-07-18" matches "gpt-4o-mini"). */
function lookup(table, model) {
  if (!table || !model) return undefined;
  if (table[model] !== undefined) return table[model];
  const key = Object.keys(table).filter((k) => model.startsWith(k)).sort((a, b) => b.length - a.length)[0];
  return key ? table[key] : undefined;
}

export function transcriptionPrice(provider, model, overrides = {}) {
  const o = overrides[`stt:${provider}:${model}`];
  if (Number.isFinite(o) && o >= 0) return { perMinute: o, known: true, source: 'yours' };
  const p = lookup(DEFAULT_PRICES.transcriptionPerMinute[provider], model);
  if (p !== undefined) return { perMinute: p, known: true, source: 'default' };
  return { perMinute: DEFAULT_PRICES.fallback.transcriptionPerMinute, known: false, source: 'fallback' };
}

export function chatPrice(provider, model, overrides = {}) {
  const o = overrides[`chat:${provider}:${model}`];
  if (Array.isArray(o) && o.every((x) => Number.isFinite(x) && x >= 0)) return { input: o[0], output: o[1], known: true, source: 'yours' };
  const p = lookup(DEFAULT_PRICES.chatPer1M[provider], model);
  if (p) return { input: p[0], output: p[1], known: true, source: 'default' };
  const [input, output] = DEFAULT_PRICES.fallback.chatPer1M;
  return { input, output, known: false, source: 'fallback' };
}

export function estimateTranscriptionCost(provider, model, seconds, overrides) {
  const price = transcriptionPrice(provider, model, overrides);
  return { usd: (Math.max(0, seconds) / 60) * price.perMinute, ...price, minutes: seconds / 60 };
}

export function estimateChatCost(provider, model, inputTokens, outputTokens, overrides) {
  const price = chatPrice(provider, model, overrides);
  return { usd: (inputTokens * price.input + outputTokens * price.output) / 1e6, ...price };
}

export function formatUsd(usd) {
  if (usd > 0 && usd < 0.01) return '< $0.01';
  return `$${usd.toFixed(2)}`;
}

// ---- local spending ledger (per calendar month) ----
export function currentPeriod(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export async function getSpend(now = new Date()) {
  const period = currentPeriod(now);
  const s = await getItem('spend', null);
  if (!s || s.period !== period) return { period, openai: 0, groq: 0, requests: { openai: 0, groq: 0 } };
  return s;
}

export async function addSpend(provider, usd, now = new Date()) {
  const s = await getSpend(now);
  s[provider] = (s[provider] || 0) + Math.max(0, usd || 0);
  s.requests = { ...s.requests, [provider]: (s.requests?.[provider] || 0) + 1 };
  await setItem('spend', s);
  return s;
}

export async function resetSpend(now = new Date()) {
  await setItem('spend', { period: currentPeriod(now), openai: 0, groq: 0, requests: { openai: 0, groq: 0 } });
}

/**
 * The spending guard applies to OpenAI only (Groq has a free tier and its own limits).
 * Returns whether a request with this estimated cost may go ahead.
 */
export async function checkBudget(provider, estimateUsd, limitUsd, now = new Date()) {
  const spend = await getSpend(now);
  const used = spend[provider] || 0;
  if (provider !== 'openai') return { ok: true, used, limit: null, remaining: Infinity };
  const limit = Math.max(0, Number(limitUsd) || 0);
  const remaining = Math.max(0, limit - used);
  return { ok: used + estimateUsd <= limit + 1e-9, used, limit, remaining, estimate: estimateUsd };
}
