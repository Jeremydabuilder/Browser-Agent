import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setStorageBackend, createMemoryBackend } from '../../extension/lib/storage.js';
import { chat, transcribe, setNativeSender, resolveTaskModels, isChatModel, AIError } from '../../extension/lib/ai.js';
import { updateSettings, getSettings } from '../../extension/lib/settings.js';
import { estimateTranscriptionCost, estimateChatCost, getSpend, addSpend, resetSpend, checkBudget, transcriptionPrice, chatPrice, formatUsd } from '../../extension/lib/pricing.js';

const groqModels = JSON.stringify({ data: [{ id: 'llama-3.3-70b-versatile' }, { id: 'whisper-large-v3-turbo' }] });
const openaiModels = JSON.stringify({ data: [
  { id: 'gpt-4.1-mini' }, { id: 'gpt-4o-mini-2024-07-18' }, { id: 'gpt-4o-realtime-preview' }, { id: 'text-embedding-3-small' },
  { id: 'whisper-1' }, { id: 'gpt-4o-mini-transcribe' }, { id: 'tts-1' }, { id: 'dall-e-3' }, { id: 'o3-mini' },
] });
const okChat = (content, usage = { prompt_tokens: 1000, completion_tokens: 500 }) => ({ ok: true, status: 200, body: JSON.stringify({ choices: [{ message: { content } }], usage }) });

let calls;
function companion(handler) {
  calls = [];
  setNativeSender(async (m) => { calls.push(m); return handler(m); });
}
const models = (m) => (m.type === 'models' ? { ok: true, status: 200, body: m.provider === 'openai' ? openaiModels : groqModels } : null);
beforeEach(() => setStorageBackend(createMemoryBackend()));

test('OpenAI model lists keep only chat or speech-to-text models', () => {
  assert.equal(isChatModel({ id: 'gpt-4.1-mini' }, 'openai'), true);
  assert.equal(isChatModel({ id: 'o3-mini' }, 'openai'), true);
  for (const id of ['gpt-4o-realtime-preview', 'text-embedding-3-small', 'whisper-1', 'tts-1', 'dall-e-3', 'gpt-4o-mini-transcribe']) assert.equal(isChatModel({ id }, 'openai'), false, id);
});

test('chat can use OpenAI while transcription stays on Groq (and vice versa)', async () => {
  await updateSettings({ chatProvider: 'openai', transcriptionProvider: 'groq', openaiBudgetUsd: 5 });
  companion((m) => models(m) || (m.type === 'chat' ? okChat('{"ok":true}') : { ok: true, status: 200, body: JSON.stringify({ text: 'hi', segments: [], duration: 60 }) }));
  const r = await chat({ messages: [{ role: 'user', content: 'x' }], json: true });
  assert.equal(r.provider, 'openai');
  assert.equal(r.model, 'gpt-4.1-mini', 'auto picks a preferred OpenAI model from the live list');
  const chatReq = calls.find((c) => c.type === 'chat');
  assert.equal(chatReq.provider, 'openai');
  const body = JSON.parse(chatReq.bodyJson);
  assert.equal(body.max_completion_tokens, 1200, 'OpenAI uses max_completion_tokens');
  assert.equal('max_tokens' in body, false);
  const t = await transcribe({ audioBase64: 'AA', mime: 'audio/wav', fileName: 'a.wav', durationSec: 60 });
  assert.equal(t.provider, 'groq');
  assert.equal(calls.find((c) => c.type === 'transcribe').provider, 'groq');
  const resolved = await resolveTaskModels();
  assert.deepEqual([resolved.chat.provider, resolved.chat.model, resolved.transcription.provider, resolved.transcription.model], ['openai', 'gpt-4.1-mini', 'groq', 'whisper-large-v3-turbo']);
});

test('OpenAI transcription: whisper-1 keeps timestamps; gpt-4o-*-transcribe returns plain text', async () => {
  await updateSettings({ transcriptionProvider: 'openai' });
  companion((m) => models(m) || { ok: true, status: 200, body: JSON.stringify(m.responseFormat === 'verbose_json' ? { text: 'a b', duration: 120, segments: [{ start: 0, end: 2, text: 'a' }] } : { text: 'a b' }) });
  const w = await transcribe({ audioBase64: 'AA', mime: 'audio/webm', fileName: 'p.webm', durationSec: 120 });
  assert.equal(w.model, 'whisper-1');
  assert.equal(calls.at(-1).responseFormat, 'verbose_json');
  assert.equal(w.segments.length, 1);
  await updateSettings({ openaiTranscriptionModel: 'gpt-4o-mini-transcribe' });
  const g = await transcribe({ audioBase64: 'AA', mime: 'audio/webm', fileName: 'p.webm', durationSec: 120 });
  assert.equal(calls.at(-1).responseFormat, 'json');
  assert.deepEqual(g.segments, [], 'no segment timestamps -> the transcript uses part-level times');
  const spend = await getSpend();
  assert.ok(Math.abs(spend.openai - (2 * 0.006 + 2 * 0.003)) < 1e-9, `recorded ${spend.openai}`);
  assert.equal(spend.requests.openai, 2);
});

test('the OpenAI spending guard stops before sending; Groq is never blocked', async () => {
  await updateSettings({ transcriptionProvider: 'openai', chatProvider: 'openai', openaiBudgetUsd: 0.05 });
  companion((m) => models(m) || okChat('hello'));
  await addSpend('openai', 0.049);
  await assert.rejects(transcribe({ audioBase64: 'AA', mime: 'audio/wav', fileName: 'a.wav', durationSec: 600 }),
    (e) => e instanceof AIError && e.code === 'budget_reached' && /not OpenAI's billing/.test(e.message) && /Settings → AI/.test(e.message));
  assert.equal(calls.filter((c) => c.type === 'transcribe').length, 0, 'nothing was sent');
  await assert.rejects(chat({ messages: [{ role: 'user', content: 'x'.repeat(40000) }], maxTokens: 2000 }), (e) => e.code === 'budget_reached');
  await updateSettings({ chatProvider: 'groq', transcriptionProvider: 'groq' });
  companion((m) => models(m) || okChat('from groq'));
  assert.equal((await chat({ messages: [{ role: 'user', content: 'x' }] })).content, 'from groq');
  await updateSettings({ chatProvider: 'openai', openaiBudgetUsd: 0 });
  await assert.rejects(chat({ messages: [{ role: 'user', content: 'x' }] }), (e) => e.code === 'budget_reached', 'a $0 guard blocks all OpenAI requests');
});

test('OpenAI errors: no credit vs rate limit vs unsupported parameters vs bad key', async () => {
  await updateSettings({ chatProvider: 'openai' });
  companion((m) => models(m) || { ok: true, status: 429, body: JSON.stringify({ error: { code: 'insufficient_quota', message: 'You exceeded your current quota, please check your plan and billing details.' } }) });
  await assert.rejects(chat({ messages: [{ role: 'user', content: 'x' }] }), (e) => e.code === 'quota' && /no credit or quota/.test(e.message) && /switch this task to Groq/.test(e.message));
  assert.equal(calls.filter((c) => c.type === 'chat').length, 1, 'quota errors are not retried');

  let n = 0;
  companion((m) => {
    if (m.type === 'models') return models(m);
    n++;
    const body = JSON.parse(m.bodyJson);
    if ('temperature' in body) return { ok: true, status: 400, body: JSON.stringify({ error: { code: 'unsupported_value', message: "Unsupported value: 'temperature' does not support 0.2 with this model." } }) };
    return okChat(`ok without temperature (${n})`);
  });
  assert.match((await chat({ messages: [{ role: 'user', content: 'x' }] })).content, /ok without temperature/);

  companion((m) => models(m) || { ok: true, status: 401, body: JSON.stringify({ error: { code: 'invalid_api_key', message: 'Incorrect API key provided' } }) });
  await assert.rejects(chat({ messages: [{ role: 'user', content: 'x' }] }), (e) => e.code === 'bad_key' && /OpenAI rejected/.test(e.message) && /Set OpenAI key/.test(e.message));

  setStorageBackend(createMemoryBackend());
  await updateSettings({ chatProvider: 'openai' });
  companion((m) => (m.type === 'models' ? { ok: false, error: { code: 'no_key', message: 'No OpenAI API key is stored yet.' } } : null));
  await assert.rejects(chat({ messages: [{ role: 'user', content: 'x' }] }), (e) => e.code === 'no_key');
});

test('cost estimates: price table with dated model ids, user overrides, fallback for unknown models', () => {
  const t = estimateTranscriptionCost('openai', 'whisper-1', 3600);
  assert.ok(Math.abs(t.usd - 0.36) < 1e-9);
  assert.ok(Math.abs(estimateTranscriptionCost('groq', 'whisper-large-v3-turbo', 3600).usd - 0.04) < 1e-9);
  assert.equal(chatPrice('openai', 'gpt-4o-mini-2024-07-18').input, 0.15, 'dated ids use the base model price');
  assert.equal(transcriptionPrice('openai', 'whisper-1', { 'stt:openai:whisper-1': 0.01 }).perMinute, 0.01);
  assert.equal(chatPrice('openai', 'brand-new-model').known, false);
  assert.ok(Math.abs(estimateChatCost('openai', 'gpt-4.1-mini', 1e6, 1e6).usd - 2.0) < 1e-9);
  assert.equal(formatUsd(0.004), '< $0.01');
  assert.equal(formatUsd(1.234), '$1.23');
});

test('the spending ledger is per month and can be reset', async () => {
  const sep = new Date(2026, 8, 30);
  const oct = new Date(2026, 9, 1);
  await addSpend('openai', 1.5, sep);
  assert.equal((await getSpend(sep)).openai, 1.5);
  assert.equal((await getSpend(oct)).openai, 0, 'a new month starts at zero');
  assert.deepEqual(await checkBudget('openai', 0.6, 2, sep), { ok: false, used: 1.5, limit: 2, remaining: 0.5, estimate: 0.6 });
  assert.equal((await checkBudget('groq', 100, 0, sep)).ok, true);
  await resetSpend(sep);
  assert.equal((await getSpend(sep)).openai, 0);
});

test('settings validate providers and the guard amount', async () => {
  const s = await updateSettings({ chatProvider: 'claude', transcriptionProvider: 'openai', openaiBudgetUsd: '12.345', priceOverrides: 'x' });
  assert.deepEqual([s.chatProvider, s.transcriptionProvider, s.openaiBudgetUsd], ['groq', 'openai', 12.35]);
  assert.deepEqual(s.priceOverrides, {});
  assert.equal((await getSettings()).chatProvider, 'groq', 'Groq stays the default');
});
