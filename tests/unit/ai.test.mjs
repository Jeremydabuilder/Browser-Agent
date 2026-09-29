import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setStorageBackend, createMemoryBackend } from '../../extension/lib/storage.js';
import { chat, listModels, chooseModel, setNativeSender, ping, parseJsonLoose, AIError } from '../../extension/lib/ai.js';
import { updateSettings } from '../../extension/lib/settings.js';

const modelsBody = JSON.stringify({ data: [
  { id: 'llama-3.3-70b-versatile', active: true, context_window: 131072 },
  { id: 'llama-3.1-8b-instant', active: true, context_window: 131072 },
  { id: 'whisper-large-v3', active: true },
  { id: 'old', active: false },
] });
const ok = (content) => ({ ok: true, status: 200, body: JSON.stringify({ choices: [{ message: { content } }], usage: {} }) });

let calls;
function companion(handler) {
  calls = [];
  setNativeSender(async (msg) => { calls.push(msg); return handler(msg, calls.length); });
}
beforeEach(() => setStorageBackend(createMemoryBackend()));

test('model list filters non-chat and inactive models; auto picks a preferred available model', async () => {
  companion((m) => (m.type === 'models' ? { ok: true, status: 200, body: modelsBody } : null));
  const models = await listModels();
  assert.deepEqual(models.map((m) => m.id), ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile']);
  assert.equal(chooseModel(models, 'auto'), 'llama-3.3-70b-versatile');
  assert.equal(chooseModel(models, 'llama-3.1-8b-instant'), 'llama-3.1-8b-instant');
  assert.equal(chooseModel([{ id: 'brand-new-model', contextWindow: 9 }], 'auto'), 'brand-new-model', 'works when no preferred model exists');
});

test('chat sends only the request body; never includes a key', async () => {
  companion((m) => (m.type === 'models' ? { ok: true, status: 200, body: modelsBody } : ok('hello')));
  const r = await chat({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.content, 'hello');
  const req = calls.find((c) => c.type === 'chat');
  assert.deepEqual(Object.keys(req).sort(), ['bodyJson', 'provider', 'timeoutSec', 'type']);
  assert.equal(req.provider, 'groq', 'Groq is the default provider');
  assert.equal(JSON.parse(req.bodyJson).model, 'llama-3.3-70b-versatile');
});

test('short rate limits are retried once automatically', async () => {
  let n = 0;
  companion((m) => {
    if (m.type === 'models') return { ok: true, status: 200, body: modelsBody };
    n++;
    return n === 1 ? { ok: true, status: 429, retryAfter: '0.01', body: '{"error":{"message":"Rate limit"}}' } : ok('after retry');
  });
  const statuses = [];
  const r = await chat({ messages: [{ role: 'user', content: 'x' }], onStatus: (s) => statuses.push(s) });
  assert.equal(r.content, 'after retry');
  assert.match(statuses[0], /rate limit/i);
});

test('long rate limits surface a clear error with the wait time', async () => {
  companion((m) => (m.type === 'models' ? { ok: true, status: 200, body: modelsBody } : { ok: true, status: 429, retryAfter: '120', body: '{}' }));
  await assert.rejects(chat({ messages: [{ role: 'user', content: 'x' }] }), (e) => e.code === 'rate_limited' && /120 seconds/.test(e.message));
});

test('an unavailable model falls back to another available one and tells the user', async () => {
  await updateSettings({ model: 'llama-3.3-70b-versatile' });
  companion((m) => {
    if (m.type === 'models') return { ok: true, status: 200, body: modelsBody };
    const body = JSON.parse(m.bodyJson);
    if (body.model === 'llama-3.3-70b-versatile') return { ok: true, status: 404, body: '{"error":{"code":"model_not_found","message":"does not exist"}}' };
    return ok(`used ${body.model}`);
  });
  const r = await chat({ messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r.content, 'used llama-3.1-8b-instant');
  assert.match(r.notices.join(' '), /unavailable/);
});

test('a chosen model that disappeared from the list is replaced with a notice', async () => {
  await updateSettings({ model: 'retired-model-x' });
  companion((m) => (m.type === 'models' ? { ok: true, status: 200, body: modelsBody } : ok(JSON.parse(m.bodyJson).model)));
  const r = await chat({ messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r.content, 'llama-3.3-70b-versatile');
  assert.match(r.notices[0], /no longer available/);
});

test('timeouts, oversize requests, bad keys and missing companion map to friendly errors', async () => {
  const cases = [
    [{ ok: false, error: { code: 'timeout', message: 'Groq did not respond within 60 seconds.' } }, 'timeout'],
    [{ ok: true, status: 413, body: '{"error":{"message":"Request too large"}}' }, 'too_long'],
    [{ ok: true, status: 400, body: '{"error":{"code":"context_length_exceeded","message":"x"}}' }, 'too_long'],
    [{ ok: true, status: 401, body: '{}' }, 'bad_key'],
    [{ ok: false, error: { code: 'no_key', message: 'No key' } }, 'no_key'],
  ];
  for (const [reply, code] of cases) {
    setStorageBackend(createMemoryBackend());
    companion((m) => (m.type === 'models' ? { ok: true, status: 200, body: modelsBody } : reply));
    await assert.rejects(chat({ messages: [{ role: 'user', content: 'x' }] }), (e) => e instanceof AIError && e.code === code, code);
  }
  setNativeSender(async () => { throw new Error('Specified native messaging host not found.'); });
  await assert.rejects(ping(), (e) => e.code === 'companion_missing' && /install\.cmd/.test(e.message));
});

test('server errors retry once; invalid JSON output retries then fails clearly', async () => {
  let n = 0;
  companion((m) => {
    if (m.type === 'models') return { ok: true, status: 200, body: modelsBody };
    n++;
    return n === 1 ? { ok: true, status: 503, body: '{}' } : ok('{"answer":"fine"}');
  });
  const r = await chat({ messages: [{ role: 'user', content: 'x' }], json: true });
  assert.deepEqual(r.data, { answer: 'fine' });
  companion((m) => (m.type === 'models' ? { ok: true, status: 200, body: modelsBody } : ok('not json at all')));
  await assert.rejects(chat({ messages: [{ role: 'user', content: 'x' }], json: true }), (e) => e.code === 'bad_output');
});

test('loose JSON parsing handles code fences and surrounding text', () => {
  assert.deepEqual(parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonLoose('Sure! {"a":2} hope that helps'), { a: 2 });
  assert.equal(parseJsonLoose('nope'), null);
});

test('transcribe: auto picks a Whisper model from the live list and sends no key', async () => {
  const { transcribe, listTranscriptionModels } = await import('../../extension/lib/ai.js');
  const body = JSON.stringify({ data: [{ id: 'llama-3.3-70b-versatile', active: true }, { id: 'whisper-large-v3', active: true }, { id: 'whisper-large-v3-turbo', active: true }] });
  companion((m) => {
    if (m.type === 'models') return { ok: true, status: 200, body };
    return { ok: true, status: 200, body: JSON.stringify({ text: ' Hello there. ', duration: 4.2, segments: [{ start: 0, end: 2, text: ' Hello' }, { start: 2, end: 4, text: ' there.' }, { start: 4, end: 4.2, text: ' ' }] }) };
  });
  assert.deepEqual((await listTranscriptionModels()).map((m) => m.id), ['whisper-large-v3', 'whisper-large-v3-turbo']);
  const r = await transcribe({ audioBase64: 'AAAA', mime: 'audio/wav', fileName: 'part-1.wav' });
  assert.deepEqual(r, { text: 'Hello there.', segments: [{ start: 0, end: 2, text: 'Hello' }, { start: 2, end: 4, text: 'there.' }], duration: 4.2, model: 'whisper-large-v3-turbo', provider: 'groq' });
  const req = calls.find((c) => c.type === 'transcribe');
  assert.deepEqual(Object.keys(req).sort(), ['audioBase64', 'fileName', 'language', 'mime', 'model', 'prompt', 'provider', 'responseFormat', 'timeoutSec', 'type']);
  assert.equal(req.responseFormat, 'verbose_json');
});

test('transcribe: rate limit and removed models are handled', async () => {
  const { transcribe } = await import('../../extension/lib/ai.js');
  const body = JSON.stringify({ data: [{ id: 'whisper-large-v3', active: true }, { id: 'whisper-large-v3-turbo', active: true }] });
  companion((m) => (m.type === 'models' ? { ok: true, status: 200, body } : { ok: true, status: 429, retryAfter: '720', body: '{"error":{"message":"ASH limit"}}' }));
  await assert.rejects(transcribe({ audioBase64: 'AA', mime: 'audio/wav', fileName: 'a.wav' }), (e) => e.code === 'rate_limited' && e.retryAfter === 720 && /Finished parts are saved/.test(e.message));
  setStorageBackend(createMemoryBackend());
  companion((m) => {
    if (m.type === 'models') return { ok: true, status: 200, body };
    if (m.model === 'whisper-large-v3-turbo') return { ok: true, status: 404, body: '{"error":{"code":"model_not_found","message":"does not exist"}}' };
    return { ok: true, status: 200, body: JSON.stringify({ text: 'ok', segments: [] }) };
  });
  assert.equal((await transcribe({ audioBase64: 'AA', mime: 'audio/wav', fileName: 'a.wav' })).model, 'whisper-large-v3');
  companion((m) => (m.type === 'models' ? { ok: true, status: 200, body } : { ok: false, error: { code: 'too_large', message: 'too big' } }));
  await assert.rejects(transcribe({ audioBase64: 'AA', mime: 'audio/wav', fileName: 'a.wav' }), (e) => e.code === 'too_long');
});
