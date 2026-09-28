// AI client: talks to the Satchel Windows companion over Chrome/Edge native messaging.
// The companion holds the Groq key; this module never sees it.
import { getSettings } from './settings.js';
import { getItem, setItem } from './storage.js';
import { sleep } from './util.js';

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

const NON_CHAT_MODEL = /whisper|tts|playai|guard|orpheus|safeguard|distil|embed|compound/i;
const MODEL_CACHE_MS = 60 * 60 * 1000;

export class AIError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'AIError';
    this.code = code;
    Object.assign(this, extra);
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
      throw new AIError('companion_missing', 'The Satchel companion is not installed. Run companion\\windows\\install.cmd, then restart the browser.');
    }
    if (/forbidden/i.test(msg)) {
      throw new AIError('companion_forbidden', 'The companion is installed for a different extension ID. Run install.cmd again.');
    }
    if (/exited|disconnected/i.test(msg)) {
      throw new AIError('companion_crashed', 'The Satchel companion stopped unexpectedly. PowerShell may be blocked on this computer; run status.cmd in the companion folder for details.');
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

export function isChatModel(model) {
  return model && model.active !== false && !NON_CHAT_MODEL.test(model.id);
}

export async function listModels({ force = false } = {}) {
  const cache = await getItem('modelCache', null);
  if (!force && cache && Date.now() - cache.at < MODEL_CACHE_MS && cache.models?.length) return cache.models;
  const reply = await callCompanion({ type: 'models' });
  if (!reply.ok) throw new AIError(reply.error?.code || 'companion_error', reply.error?.message || 'Could not list models');
  if (reply.status === 401) throw new AIError('bad_key', 'Groq rejected the stored API key. Run set-key.cmd in the companion folder to enter a new one.');
  if (reply.status !== 200) throw new AIError('server_error', `Groq returned HTTP ${reply.status} when listing models.`);
  const models = (JSON.parse(reply.body).data || [])
    .filter(isChatModel)
    .map((m) => ({ id: m.id, contextWindow: m.context_window || null, ownedBy: m.owned_by || '' }))
    .sort((a, b) => a.id.localeCompare(b.id));
  await setItem('modelCache', { at: Date.now(), models });
  return models;
}

export function chooseModel(models, preferred = 'auto', exclude = []) {
  const available = models.filter((m) => !exclude.includes(m.id));
  if (preferred && preferred !== 'auto') {
    const hit = available.find((m) => m.id === preferred);
    if (hit) return hit.id;
  }
  for (const id of PREFERRED_MODELS) if (available.some((m) => m.id === id)) return id;
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

function classify(reply) {
  if (!reply.ok) {
    const code = reply.error?.code || 'companion_error';
    return { kind: code === 'timeout' ? 'timeout' : code, message: reply.error?.message };
  }
  const { status } = reply;
  if (status >= 200 && status < 300) return { kind: 'ok' };
  const err = parseGroqError(reply.body);
  const text = `${err.code} ${err.message}`;
  if (status === 401) return { kind: 'bad_key', message: 'Groq rejected the stored API key. Run set-key.cmd in the companion folder.' };
  if (status === 413 || /context_length|too large|maximum context|reduce the length|too many tokens/i.test(text)) {
    return { kind: 'too_long', message: 'The text was too long for this model or your Groq rate limit.' };
  }
  if (status === 429) {
    const retryAfter = Number(reply.retryAfter) || Number((err.message.match(/try again in ([\d.]+)s/i) || [])[1]) || null;
    return { kind: 'rate_limited', retryAfter, message: err.message };
  }
  if (/model_not_found|model_decommissioned|does not exist|decommissioned|not supported/i.test(text) && (status === 404 || status === 400)) {
    return { kind: 'model_unavailable', message: err.message };
  }
  if (/json_validate_failed/i.test(text)) return { kind: 'json_failed', message: err.message };
  if (status === 403) return { kind: 'forbidden', message: err.message || 'Groq refused the request (403). Your Groq organization or network may restrict access.' };
  if (status >= 500) return { kind: 'server_error', message: `Groq is having trouble (HTTP ${status}).` };
  return { kind: 'bad_request', message: err.message || `Groq returned HTTP ${status}.` };
}

/**
 * Sends a chat completion. Handles rate limits (one automatic wait-and-retry when short),
 * unavailable models (switches to another available model and reports it), server errors,
 * and invalid JSON output. Throws AIError with a user-readable message otherwise.
 */
export async function chat({ messages, json = false, maxTokens = 1200, temperature = 0.2, onStatus = () => {} }) {
  const settings = await getSettings();
  const notices = [];
  let models = [];
  try {
    models = await listModels();
  } catch (err) {
    if (settings.model === 'auto' || ['companion_missing', 'companion_forbidden', 'companion_crashed', 'bad_key', 'no_key'].includes(err.code)) throw err;
  }
  const excluded = [];
  let model = models.length ? chooseModel(models, settings.model) : settings.model;
  if (!model) throw new AIError('model_unavailable', 'No chat models are available on your Groq account right now.');
  if (settings.model !== 'auto' && model !== settings.model) {
    notices.push(`Your chosen model "${settings.model}" is no longer available, so "${model}" was used. You can pick another in Settings.`);
  }
  let useJsonMode = json;
  let rateRetried = false;
  let serverRetried = false;
  let jsonRetried = false;

  for (let attempt = 0; attempt < 6; attempt++) {
    const body = { model, messages, temperature, max_tokens: maxTokens };
    if (useJsonMode) body.response_format = { type: 'json_object' };
    const reply = await callCompanion({ type: 'chat', bodyJson: JSON.stringify(body), timeoutSec: settings.requestTimeoutSec });
    const c = classify(reply);
    if (c.kind === 'ok') {
      const parsed = JSON.parse(reply.body);
      const content = parsed.choices?.[0]?.message?.content ?? '';
      if (json) {
        const data = parseJsonLoose(content);
        if (data && typeof data === 'object') return { data, content, model, usage: parsed.usage, notices };
        if (!jsonRetried) { jsonRetried = true; continue; }
        throw new AIError('bad_output', 'The AI returned an answer Satchel could not read. Try again or choose a different model in Settings.');
      }
      return { content, model, usage: parsed.usage, notices };
    }
    if (c.kind === 'rate_limited') {
      const wait = c.retryAfter ?? 5;
      if (!rateRetried && wait <= 20) {
        rateRetried = true;
        onStatus(`Groq rate limit reached; retrying in ${Math.ceil(wait)}s…`);
        await sleep(wait * 1000);
        continue;
      }
      throw new AIError('rate_limited', `Groq's rate limit for your account was reached. Try again in ${wait ? `${Math.ceil(wait)} seconds` : 'a minute'}, or use a smaller model in Settings.`, { retryAfter: wait });
    }
    if (c.kind === 'model_unavailable') {
      excluded.push(model);
      await setItem('modelCache', null);
      try { models = await listModels({ force: true }); } catch { /* keep old list */ }
      const next = chooseModel(models, 'auto', excluded);
      if (!next) throw new AIError('model_unavailable', `The model "${model}" is unavailable and no alternative was found. Choose a model in Settings.`);
      notices.push(`The model "${model}" is unavailable, so "${next}" was used instead. You can choose a model in Settings.`);
      onStatus(`Model ${model} unavailable; switching to ${next}…`);
      model = next;
      continue;
    }
    if (c.kind === 'json_failed' && !jsonRetried) { jsonRetried = true; useJsonMode = false; continue; }
    if (c.kind === 'server_error' && !serverRetried) { serverRetried = true; onStatus('Groq had a temporary error; retrying…'); await sleep(2000); continue; }
    if (c.kind === 'timeout') throw new AIError('timeout', `${c.message || 'Groq timed out.'} Try again, or shorten the request.`);
    if (c.kind === 'too_long') throw new AIError('too_long', c.message);
    throw new AIError(c.kind, c.message || 'The AI request failed.');
  }
  throw new AIError('failed', 'The AI request failed after several attempts.');
}

export function friendlyError(err) {
  if (err instanceof AIError) return err.message;
  return `Something went wrong: ${err?.message || err}`;
}
