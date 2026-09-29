// AI client: talks to the Satchel Windows companion over Chrome/Edge native messaging.
// The companion holds the provider API keys (Groq, and optionally OpenAI); this module never sees them.
// Chat/notes and meeting transcription can each use a different provider (Settings → AI).
import { getSettings } from './settings.js';
import { getItem, setItem } from './storage.js';
import { sleep } from './util.js';
import { estimateChatCost, estimateTranscriptionCost, checkBudget, addSpend, formatUsd } from './pricing.js';

export const HOST_NAME = 'com.satchel.companion';

// Model preference order used only when the user leaves "Auto" selected. Every choice is
// checked against the live model list from Groq, so a retired model is simply skipped.
export const PREFERRED_MODELS = [
  'llama-3.3-70b-versatile',
  'openai/gpt-oss-120b',
  'meta-llama/llama-4-maverick-17b-128e-instruct',
  'qwen/qwen3-32b',
  'openai/gpt-oss-20b',
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'llama-3.1-8b-instant',
];

export const PROVIDERS = { groq: 'Groq', openai: 'OpenAI' };
export const providerLabel = (p) => PROVIDERS[p] || 'Groq';

// "Auto" preferences for OpenAI, also checked against the live model list.
export const PREFERRED_OPENAI_MODELS = ['gpt-4.1-mini', 'gpt-4o-mini', 'gpt-5-mini', 'gpt-4.1', 'gpt-4o'];

const NON_CHAT_MODEL = /whisper|tts|playai|guard|orpheus|safeguard|distil|embed|compound/i;
const OPENAI_CHAT = /^(gpt-|o\d|chatgpt-)/i;
const OPENAI_NOT_CHAT = /audio|realtime|transcribe|tts|search|image|instruct|embedding|moderation|dall-e|whisper|codex|computer-use/i;
const OPENAI_STT = /^(whisper-1|gpt-4o(-mini)?-transcribe)/i;
const KEY_HELP = {
  groq: 'Open the Start menu → “Satchel - Set Groq key” (or run set-key.cmd in the companion folder).',
  openai: 'Open the Start menu → “Satchel - Set OpenAI key” (or run set-openai-key.cmd in the companion folder).',
};
const MODEL_CACHE_MS = 60 * 60 * 1000;

export class AIError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'AIError';
    this.code = code;
    Object.assign(this, extra);
    // A setup problem means the side panel's cached "AI: ready" is wrong; make it check again next time.
    if (/^companion_|^(no_key|bad_key)$/.test(code)) globalThis.chrome?.storage?.session?.remove('companionStatus')?.catch?.(() => {});
  }
}

let nativeSender = (msg) => chrome.runtime.sendNativeMessage(HOST_NAME, msg);
export function setNativeSender(fn) {
  nativeSender = fn;
}

async function callCompanion(message) {
  try {
    const reply = await nativeSender(message);
    if (!reply) throw new AIError('companion_crashed', 'The Satchel companion closed without answering.');
    return reply;
  } catch (err) {
    if (err instanceof AIError) throw err;
    const msg = String(err?.message || err);
    if (/not found/i.test(msg)) {
      throw new AIError('companion_missing', 'The Satchel companion is not installed (or the browser was not restarted after installing it). Double-click install.cmd in the companion\\windows folder of your Satchel download, then close every browser window and reopen.');
    }
    if (/forbidden/i.test(msg)) {
      throw new AIError('companion_forbidden', 'The companion is installed for a different extension ID. Run install.cmd again.');
    }
    if (/exited|disconnected/i.test(msg)) {
      throw new AIError('companion_crashed', 'The Satchel companion could not start. PowerShell may be blocked on this computer (common on school laptops). Run “Satchel - Check companion” from the Start menu to see why.');
    }
    throw new AIError('companion_error', `Could not talk to the Satchel companion: ${msg}`);
  }
}

export async function ping() {
  const reply = await callCompanion({ type: 'ping' });
  if (!reply.ok) throw new AIError(reply.error?.code || 'companion_error', reply.error?.message || 'Companion error');
  return reply;
}

function parseGroqError(body) {
  try {
    const e = JSON.parse(body).error || {};
    return { code: e.code || e.type || '', message: e.message || '' };
  } catch {
    return { code: '', message: String(body || '').slice(0, 200) };
  }
}

export function isChatModel(model, provider = 'groq') {
  if (!model || model.active === false) return false;
  if (provider === 'openai') return OPENAI_CHAT.test(model.id) && !OPENAI_NOT_CHAT.test(model.id);
  return !NON_CHAT_MODEL.test(model.id);
}

export function isTranscriptionModel(model, provider = 'groq') {
  if (!model || model.active === false) return false;
  return provider === 'openai' ? OPENAI_STT.test(model.id) : /whisper/i.test(model.id);
}

const cacheKey = (provider) => (provider === 'openai' ? 'modelCache_openai' : 'modelCache');

export async function listModels({ force = false, provider = 'groq' } = {}) {
  const cache = await getItem(cacheKey(provider), null);
  if (!force && cache && Date.now() - cache.at < MODEL_CACHE_MS && cache.models?.length) return cache.models;
  const reply = await callCompanion({ type: 'models', provider });
  const label = providerLabel(provider);
  if (!reply.ok) throw new AIError(reply.error?.code || 'companion_error', reply.error?.message || 'Could not list models', { provider });
  if (reply.status === 401) throw new AIError('bad_key', `${label} rejected the stored API key. ${KEY_HELP[provider]}`, { provider });
  if (reply.status !== 200) throw new AIError('server_error', `${label} returned HTTP ${reply.status} when listing models.`, { provider });
  const raw = JSON.parse(reply.body).data || [];
  const models = raw
    .filter((m) => isChatModel(m, provider))
    .map((m) => ({ id: m.id, contextWindow: m.context_window || null, ownedBy: m.owned_by || '' }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const transcription = raw.filter((m) => isTranscriptionModel(m, provider)).map((m) => ({ id: m.id })).sort((a, b) => a.id.localeCompare(b.id));
  await setItem(cacheKey(provider), { at: Date.now(), models, transcription });
  return models;
}

// Speech-to-text models, preferred in this order when "Auto" is selected (checked against the live list).
export const PREFERRED_TRANSCRIPTION_MODELS = ['whisper-large-v3-turbo', 'whisper-large-v3', 'distil-whisper-large-v3-en'];
// whisper-1 first: it is the OpenAI model that returns segment timestamps.
export const PREFERRED_OPENAI_TRANSCRIPTION_MODELS = ['whisper-1', 'gpt-4o-mini-transcribe', 'gpt-4o-transcribe'];

export async function listTranscriptionModels({ force = false, provider = 'groq' } = {}) {
  let cache = await getItem(cacheKey(provider), null);
  if (force || !cache?.transcription || Date.now() - cache.at >= MODEL_CACHE_MS) {
    await listModels({ force: true, provider });
    cache = await getItem(cacheKey(provider), null);
  }
  return cache?.transcription || [];
}

export function chooseTranscriptionModel(models, preferred = 'auto', exclude = [], provider = 'groq') {
  const available = models.filter((m) => !exclude.includes(m.id));
  if (preferred && preferred !== 'auto' && available.some((m) => m.id === preferred)) return preferred;
  const prefs = provider === 'openai' ? PREFERRED_OPENAI_TRANSCRIPTION_MODELS : PREFERRED_TRANSCRIPTION_MODELS;
  for (const id of prefs) if (available.some((m) => m.id === id)) return id;
  return available[0]?.id || null;
}

/** Which provider and model setting each task uses. */
export function taskConfig(settings, task) {
  if (task === 'transcription') {
    const provider = settings.transcriptionProvider === 'openai' ? 'openai' : 'groq';
    return { provider, preferred: provider === 'openai' ? settings.openaiTranscriptionModel : settings.transcriptionModel };
  }
  const provider = settings.chatProvider === 'openai' ? 'openai' : 'groq';
  return { provider, preferred: provider === 'openai' ? settings.openaiChatModel : settings.model };
}

/**
 * Resolves the provider and model each task will actually use right now (for Settings and consent screens).
 * @returns {{chat:{provider,model,auto,error}, transcription:{provider,model,auto,timestamps,error}}}
 */
export async function resolveTaskModels({ force = false } = {}) {
  const settings = await getSettings();
  const out = {};
  for (const task of ['chat', 'transcription']) {
    const { provider, preferred } = taskConfig(settings, task);
    try {
      const models = task === 'chat' ? await listModels({ provider, force }) : await listTranscriptionModels({ provider, force });
      const model = task === 'chat' ? chooseModel(models, preferred, [], provider) : chooseTranscriptionModel(models, preferred, [], provider);
      out[task] = { provider, model, auto: !preferred || preferred === 'auto', models };
    } catch (err) {
      out[task] = { provider, model: preferred !== 'auto' ? preferred : null, auto: preferred === 'auto', error: err.message, code: err.code, models: [] };
    }
    if (task === 'transcription') out[task].timestamps = out[task].provider === 'groq' || /^whisper/.test(out[task].model || '');
  }
  return out;
}

async function guard(provider, estimateUsd, what) {
  const settings = await getSettings();
  const b = await checkBudget(provider, estimateUsd, settings.openaiBudgetUsd);
  if (!b.ok) {
    throw new AIError('budget_reached', `Stopped before sending: this ${what} is estimated at ${formatUsd(estimateUsd)}, and your OpenAI spending guard is ${formatUsd(b.limit)} this month (${formatUsd(b.used)} already used by Satchel's estimate). Raise the guard in Settings → AI, or switch this task to Groq. This is Satchel's own estimate, not OpenAI's billing.`, { provider, used: b.used, limit: b.limit });
  }
}

/**
 * Transcribes one audio chunk through the companion (which adds the provider's key).
 * @param durationSec length of the chunk, used for the cost estimate and the OpenAI spending guard
 * @returns {{text, segments:[{start,end,text}], duration, model, provider}}
 */
export async function transcribe({ audioBase64, mime, fileName, language = '', prompt = '', durationSec = 0 }) {
  const settings = await getSettings();
  const { provider, preferred } = taskConfig(settings, 'transcription');
  const label = providerLabel(provider);
  const models = await listTranscriptionModels({ provider });
  const excluded = [];
  let model = chooseTranscriptionModel(models, preferred || 'auto', [], provider);
  if (!model) throw new AIError('model_unavailable', `Your ${label} account has no speech-to-text models available right now. Choose another provider for transcription in Settings → AI.`, { provider });
  for (let attempt = 0; attempt < 3; attempt++) {
    const estimate = estimateTranscriptionCost(provider, model, durationSec, settings.priceOverrides);
    await guard(provider, estimate.usd, 'audio part');
    // Only Whisper models return segment timestamps (verbose_json); the others return plain text.
    const responseFormat = provider === 'openai' && !/^whisper/.test(model) ? 'json' : 'verbose_json';
    const reply = await callCompanion({ type: 'transcribe', provider, model, mime, fileName, audioBase64, responseFormat, language: language || settings.transcriptionLanguage || '', prompt, timeoutSec: 180 });
    const c = classify(reply, provider);
    if (c.kind === 'ok') {
      const data = JSON.parse(reply.body);
      const duration = Number(data.duration) || null;
      await addSpend(provider, estimateTranscriptionCost(provider, model, duration || durationSec, settings.priceOverrides).usd);
      return {
        text: String(data.text || '').trim(),
        segments: Array.isArray(data.segments) ? data.segments.map((s) => ({ start: Number(s.start) || 0, end: Number(s.end) || 0, text: String(s.text || '').trim() })).filter((s) => s.text) : [],
        duration,
        model,
        provider,
      };
    }
    if (c.kind === 'model_unavailable') {
      excluded.push(model);
      const next = chooseTranscriptionModel(await listTranscriptionModels({ force: true, provider }), 'auto', excluded, provider);
      if (!next) throw new AIError('model_unavailable', `The ${label} speech-to-text model "${model}" is unavailable and no alternative was found. Choose one in Settings → AI.`, { provider });
      model = next;
      continue;
    }
    if (c.kind === 'rate_limited') {
      throw new AIError('rate_limited', `${label}'s speech-to-text rate limit for your account was reached${c.retryAfter ? `; try again in about ${Math.max(1, Math.ceil(c.retryAfter / 60))} minute(s)` : ''}. Finished parts are saved; press Resume later.`, { retryAfter: c.retryAfter, provider });
    }
    if (c.kind === 'too_long' || reply.error?.code === 'too_large') throw new AIError('too_long', `This audio part is too large for ${label} (25 MB limit).`, { provider });
    if (c.kind === 'timeout') throw new AIError('timeout', `${label} took too long to transcribe this part. Press Retry failed parts.`, { provider });
    throw new AIError(c.kind, c.message || reply.error?.message || 'Transcription failed.', { provider });
  }
  throw new AIError('failed', 'Transcription failed after several attempts.', { provider });
}

/** Base64 for a Blob/ArrayBuffer/Uint8Array (chunked so large chunks don't overflow the stack). */
export async function toBase64(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data instanceof ArrayBuffer ? data : await data.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function chooseModel(models, preferred = 'auto', exclude = [], provider = 'groq') {
  const available = models.filter((m) => !exclude.includes(m.id));
  if (preferred && preferred !== 'auto') {
    const hit = available.find((m) => m.id === preferred);
    if (hit) return hit.id;
  }
  for (const id of provider === 'openai' ? PREFERRED_OPENAI_MODELS : PREFERRED_MODELS) if (available.some((m) => m.id === id)) return id;
  const sorted = [...available].sort((a, b) => (b.contextWindow || 0) - (a.contextWindow || 0));
  return sorted[0]?.id || null;
}

export function parseJsonLoose(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(trimmed); } catch { /* fall through */ }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { /* ignore */ }
  }
  return null;
}

function classify(reply, provider = 'groq') {
  const label = providerLabel(provider);
  if (!reply.ok) {
    const code = reply.error?.code || 'companion_error';
    return { kind: code === 'timeout' ? 'timeout' : code, message: reply.error?.message };
  }
  const { status } = reply;
  if (status >= 200 && status < 300) return { kind: 'ok' };
  const err = parseGroqError(reply.body);
  const text = `${err.code} ${err.message}`;
  if (status === 401) return { kind: 'bad_key', message: `${label} rejected the stored API key. ${KEY_HELP[provider]}` };
  if (status === 413 || /context_length|too large|maximum context|reduce the length|too many tokens/i.test(text)) {
    return { kind: 'too_long', message: `The text was too long for this model or your ${label} rate limit.` };
  }
  // OpenAI uses 429 both for rate limits and for "no credit left"; the second never succeeds on retry.
  if (status === 429 && /insufficient_quota|exceeded your current quota|billing/i.test(text)) {
    return { kind: 'quota', message: `Your ${label} account has no credit or quota left. Add billing or credit in your ${label} account, or switch this task to ${provider === 'openai' ? 'Groq' : 'OpenAI'} in Settings → AI.` };
  }
  if (status === 429) {
    const retryAfter = Number(reply.retryAfter) || Number((err.message.match(/try again in ([\d.]+)s/i) || [])[1]) || null;
    return { kind: 'rate_limited', retryAfter, message: err.message };
  }
  if (/unsupported_parameter|unsupported_value|does not support|not supported with this model/i.test(text) && status === 400) {
    return { kind: 'unsupported_param', message: err.message, param: /temperature/i.test(text) ? 'temperature' : /max_completion_tokens/i.test(text) ? 'max_completion_tokens' : /max_tokens/i.test(text) ? 'max_tokens' : /response_format/i.test(text) ? 'response_format' : '' };
  }
  if (/model_not_found|model_decommissioned|does not exist|decommissioned|not supported/i.test(text) && (status === 404 || status === 400)) {
    return { kind: 'model_unavailable', message: err.message };
  }
  if (/json_validate_failed/i.test(text)) return { kind: 'json_failed', message: err.message };
  if (status === 403) return { kind: 'forbidden', message: err.message || `${label} refused the request (403). Your ${label} organization, region, or network may restrict access.` };
  if (status >= 500) return { kind: 'server_error', message: `${label} is having trouble (HTTP ${status}). Try again in a minute.` };
  return { kind: 'bad_request', message: err.message ? `${label}: ${err.message}` : `${label} returned HTTP ${status}.` };
}

/**
 * Sends a chat completion to the provider chosen for chat/notes. Handles rate limits (one automatic
 * wait-and-retry when short), unavailable models (switches to another available model and reports it),
 * server errors, parameters a model doesn't support, invalid JSON output, and the OpenAI spending guard.
 */
export async function chat({ messages, json = false, maxTokens = 1200, temperature = 0.2, onStatus = () => {} }) {
  const settings = await getSettings();
  const { provider, preferred } = taskConfig(settings, 'chat');
  const label = providerLabel(provider);
  const notices = [];
  let models = [];
  try {
    models = await listModels({ provider });
  } catch (err) {
    if (preferred === 'auto' || ['companion_missing', 'companion_forbidden', 'companion_crashed', 'bad_key', 'no_key'].includes(err.code)) throw err;
  }
  const excluded = [];
  let model = models.length ? chooseModel(models, preferred, [], provider) : preferred;
  if (!model) throw new AIError('model_unavailable', `No chat models are available on your ${label} account right now. Choose another model or provider in Settings → AI.`, { provider });
  if (preferred !== 'auto' && model !== preferred) {
    notices.push(`Your chosen ${label} model "${preferred}" is no longer available, so "${model}" was used. You can pick another in Settings.`);
  }
  let useJsonMode = json;
  let rateRetried = false;
  let serverRetried = false;
  let jsonRetried = false;
  let sendTemperature = true;
  // OpenAI's newer models only accept max_completion_tokens; Groq uses max_tokens.
  let tokenParam = provider === 'openai' ? 'max_completion_tokens' : 'max_tokens';
  const inputTokens = Math.ceil(messages.reduce((n, m) => n + String(m.content).length, 0) / 4);

  for (let attempt = 0; attempt < 8; attempt++) {
    const body = { model, messages, [tokenParam]: maxTokens };
    if (sendTemperature) body.temperature = temperature;
    if (useJsonMode) body.response_format = { type: 'json_object' };
    await guard(provider, estimateChatCost(provider, model, inputTokens, maxTokens, settings.priceOverrides).usd, 'request');
    const reply = await callCompanion({ type: 'chat', provider, bodyJson: JSON.stringify(body), timeoutSec: settings.requestTimeoutSec });
    const c = classify(reply, provider);
    if (c.kind === 'ok') {
      const parsed = JSON.parse(reply.body);
      const usage = parsed.usage || {};
      await addSpend(provider, estimateChatCost(provider, model, usage.prompt_tokens ?? inputTokens, usage.completion_tokens ?? maxTokens, settings.priceOverrides).usd);
      const content = parsed.choices?.[0]?.message?.content ?? '';
      if (json) {
        const data = parseJsonLoose(content);
        if (data && typeof data === 'object') return { data, content, model, provider, usage: parsed.usage, notices };
        if (!jsonRetried) { jsonRetried = true; continue; }
        throw new AIError('bad_output', 'The AI returned an answer Satchel could not read. Try again or choose a different model in Settings → AI.', { provider });
      }
      return { content, model, provider, usage: parsed.usage, notices };
    }
    if (c.kind === 'unsupported_param') {
      if (c.param === 'temperature' && sendTemperature) { sendTemperature = false; continue; }
      if (c.param === 'max_completion_tokens' && tokenParam !== 'max_tokens') { tokenParam = 'max_tokens'; continue; }
      if (c.param === 'max_tokens' && tokenParam !== 'max_completion_tokens') { tokenParam = 'max_completion_tokens'; continue; }
      if (c.param === 'response_format' && useJsonMode) { useJsonMode = false; continue; }
    }
    if (c.kind === 'rate_limited') {
      const wait = c.retryAfter ?? 5;
      if (!rateRetried && wait <= 20) {
        rateRetried = true;
        onStatus(`${label} rate limit reached; retrying in ${Math.ceil(wait)}s…`);
        await sleep(wait * 1000);
        continue;
      }
      throw new AIError('rate_limited', `${label}'s rate limit for your account was reached. Try again in ${wait ? `${Math.ceil(wait)} seconds` : 'a minute'}, or use a smaller model in Settings → AI.`, { retryAfter: wait, provider });
    }
    if (c.kind === 'model_unavailable') {
      excluded.push(model);
      await setItem(cacheKey(provider), null);
      try { models = await listModels({ force: true, provider }); } catch { /* keep old list */ }
      const next = chooseModel(models, 'auto', excluded, provider);
      if (!next) throw new AIError('model_unavailable', `The ${label} model "${model}" is unavailable and no alternative was found. Choose a model in Settings → AI.`, { provider });
      notices.push(`The ${label} model "${model}" is unavailable, so "${next}" was used instead. You can choose a model in Settings → AI.`);
      onStatus(`Model ${model} unavailable; switching to ${next}…`);
      model = next;
      continue;
    }
    if (c.kind === 'json_failed' && !jsonRetried) { jsonRetried = true; useJsonMode = false; continue; }
    if (c.kind === 'server_error' && !serverRetried) { serverRetried = true; onStatus(`${label} had a temporary error; retrying…`); await sleep(2000); continue; }
    if (c.kind === 'timeout') throw new AIError('timeout', `${c.message || `${label} timed out.`} Try again, or shorten the request.`, { provider });
    if (c.kind === 'too_long') throw new AIError('too_long', c.message, { provider });
    if (c.kind === 'no_key') throw new AIError('no_key', c.message || `No ${label} key is stored. ${KEY_HELP[provider]}`, { provider });
    throw new AIError(c.kind, c.message || 'The AI request failed.', { provider });
  }
  throw new AIError('failed', 'The AI request failed after several attempts.', { provider });
}

export function friendlyError(err) {
  if (err instanceof AIError) return err.message;
  return `Something went wrong: ${err?.message || err}`;
}
