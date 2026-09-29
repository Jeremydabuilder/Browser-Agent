// A local stand-in for the Groq OpenAI-compatible API, used ONLY by automated tests.
// It enforces the Bearer key, and simulates rate limits, slow responses, and removed models.
// Responses are deterministic functions of the request so tests can assert on them.
import http from 'node:http';

export const FAKE_KEY = 'gsk_test_fake_key_123';

const MODELS = [
  { id: 'llama-3.3-70b-versatile', object: 'model', active: true, context_window: 131072 },
  { id: 'llama-3.1-8b-instant', object: 'model', active: true, context_window: 131072 },
  { id: 'whisper-large-v3', object: 'model', active: true, context_window: 448 },
  { id: 'whisper-large-v3-turbo', object: 'model', active: true, context_window: 448 },
  { id: 'retired-model', object: 'model', active: false, context_window: 8192 },
];

function firstSentence(text) {
  const m = String(text).replace(/\s+/g, ' ').trim().match(/^(.{20,200}?[.!?])(\s|$)/);
  return m ? m[1] : String(text).slice(0, 80);
}

function extractSources(userText) {
  const sources = [];
  const re = /<source id="(S\d+)"[^>]*>([\s\S]*?)<\/source>/g;
  let m;
  while ((m = re.exec(userText))) sources.push({ id: m[1], text: m[2].trim() });
  return sources;
}

function respondTo(body) {
  const system = body.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  const user = body.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
  const task = (system.match(/TASK:([a-z_]+)/) || [])[1] || 'chat';
  if (task === 'grounded_answer' || task === 'chunk_notes') {
    const sources = extractSources(user);
    return JSON.stringify({
      answer: `Answer based on ${sources.length} source(s).`,
      facts: sources.map((s) => ({ claim: `Source ${s.id} says: ${firstSentence(s.text)}`, quote: firstSentence(s.text), sources: [s.id] })),
      inferences: [{ claim: 'These sources appear related.', basis: 'Both discuss the question.' }],
      unanswered: sources.length === 0 ? ['No readable sources were provided.'] : [],
    });
  }
  if (task === 'extract_assignments') {
    const lines = user.split('\n').filter((l) => /due/i.test(l));
    return JSON.stringify({
      assignments: lines.slice(0, 5).map((l, i) => ({
        title: `AI item ${i + 1}`, className: '', instructions: l.trim(), dueText: (l.match(/due[:\s]+(.+)$/i) || [])[1] || '',
      })),
    });
  }
  if (task === 'tab_command') {
    const cmd = user.toLowerCase();
    if (cmd.includes('news')) {
      const ids = [...user.matchAll(/"id":\s*(\d+)[^}]*news/gi)].map((m) => Number(m[1]));
      return JSON.stringify({ action: { type: 'close_tabs', tabIds: ids }, explanation: 'Closing news tabs.' });
    }
    return JSON.stringify({ action: { type: 'run_script', code: 'alert(1)' }, explanation: 'Malicious attempt' });
  }
  if (task === 'email_reply') {
    return JSON.stringify({ body: 'Hi,\n\nThanks for the update. I will have it done by Friday.\n\nBest,' });
  }
  if (task === 'meeting_notes') {
    const lines = [...user.matchAll(/^(c\d+s\d+) \[[\d:]+\] (.*)$/gm)].map((m) => ({ id: m[1], text: m[2] }));
    const agreed = lines.filter((l) => /agreed/i.test(l.text));
    const asks = lines.filter((l) => /can you/i.test(l.text));
    const questions = lines.filter((l) => /\?$/.test(l.text) && !/can you/i.test(l.text));
    return JSON.stringify({
      summary: `The meeting covered ${lines.length} transcript lines.`,
      keyPoints: lines.slice(0, 2).map((l) => ({ text: l.text.replace(/^\w+: /, ''), refs: [l.id] })),
      decisions: [
        ...agreed.map((l) => ({ text: l.text.replace(/^\w+: /, ''), quote: l.text.replace(/^\w+: /, '').replace(/^OK, /, ''), refs: [l.id] })),
        ...(lines.length ? [{ text: 'We will cancel the field trip', quote: 'cancel the field trip', refs: [lines[0].id] }] : []),
      ],
      actionItems: asks.map((l) => {
        const m = l.text.match(/^\w+: (\w+), can you (.*?)(?: by (\w+))?\?$/);
        return { task: m ? m[2] : l.text, owner: m ? m[1] : '', due: m?.[3] || '', quote: m ? `can you ${m[2]}` : l.text, refs: [l.id], uncertain: false };
      }),
      openQuestions: questions.map((l) => ({ text: l.text.replace(/^\w+: /, ''), refs: [l.id] })),
    });
  }
  if (task === 'meeting_notes_combine') {
    const parts = JSON.parse(user.slice(user.indexOf('[')));
    const all = (k) => parts.flatMap((p) => p[k] || []);
    return JSON.stringify({ summary: parts.map((p) => p.summary).join(' '), keyPoints: all('keyPoints'), decisions: all('decisions'), actionItems: all('actionItems'), openQuestions: all('openQuestions') });
  }
  if (task === 'email_summary') {
    return JSON.stringify({ summary: 'The thread is about a project deadline.', actionItems: ['Reply by Friday'], facts: [] });
  }
  return `Echo: ${user.slice(-200)}`;
}

// Scripted speech for the local audio fixture: each tone frequency stands for one part of a meeting.
export const FIXTURE_SPEECH = {
  300: ['Alice: Thanks everyone for joining the robotics club meeting.', 'Alice: First item is the fundraiser.'],
  500: ['Bob: I think we should move demo day.', 'Alice: OK, we agreed to move demo day to October 12.'],
  700: ['Alice: Priya, can you send the slides by Friday?', 'Priya: Yes, I will send them.', 'Bob: Do we still need the gym?'],
};

function parseMultipart(buf, contentType) {
  const boundary = (contentType.match(/boundary="?([^";]+)"?/) || [])[1];
  const fields = {};
  if (!boundary) return fields;
  const sep = Buffer.from(`--${boundary}`);
  let pos = buf.indexOf(sep);
  while (pos >= 0) {
    const next = buf.indexOf(sep, pos + sep.length);
    if (next < 0) break;
    const part = buf.subarray(pos + sep.length + 2, next - 2);
    const headerEnd = part.indexOf('\r\n\r\n');
    const headers = part.subarray(0, headerEnd).toString();
    const body = part.subarray(headerEnd + 4);
    const name = (headers.match(/name="?([^";\r\n]+)"?/) || [])[1];
    const filename = (headers.match(/filename="?([^";\r\n]+)"?/) || [])[1];
    const type = (headers.match(/Content-Type: ([^\r\n]+)/i) || [])[1];
    fields[name] = filename ? { filename, type, data: body } : body.toString();
    pos = next;
  }
  return fields;
}

/** Dominant frequency of a 16-bit PCM WAV via zero crossings (null for non-WAV audio). */
function wavToneHz(buf) {
  if (buf.subarray(0, 4).toString() !== 'RIFF') return null;
  const rate = buf.readUInt32LE(24);
  const dataAt = buf.indexOf('data') + 8;
  const n = (buf.length - dataAt) >> 1;
  let crossings = 0;
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const v = buf.readInt16LE(dataAt + i * 2);
    if ((prev < 0 && v >= 0) || (prev >= 0 && v < 0)) crossings++;
    prev = v;
  }
  return Math.round((crossings / 2) / (n / rate));
}

export function startFakeGroq({ port = 0 } = {}) {
  const log = [];
  const control = { failNextTranscriptions: 0, rateLimitNextTranscriptions: 0 };
  const server = http.createServer((req, res) => {
    const bufs = [];
    req.on('data', (c) => bufs.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(bufs);
      const data = req.headers['content-type']?.startsWith('multipart/') ? '' : raw.toString('utf8');
      const auth = req.headers.authorization || '';
      log.push({ method: req.method, url: req.url, auth, body: data });
      const send = (status, obj, headers = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
      };
      if (auth !== `Bearer ${FAKE_KEY}`) return send(401, { error: { message: 'Invalid API Key', type: 'invalid_request_error', code: 'invalid_api_key' } });
      if (req.method === 'GET' && req.url === '/models') return send(200, { object: 'list', data: MODELS });
      if (req.method === 'POST' && req.url === '/audio/transcriptions') {
        const f = parseMultipart(raw, req.headers['content-type'] || '');
        const entry = { model: f.model, response_format: f.response_format, granularity: f['timestamp_granularities[]'], filename: f.file?.filename, type: f.file?.type, bytes: f.file?.data.length || 0, prompt: f.prompt || '', language: f.language || '' };
        (log.transcriptions ||= []).push(entry);
        if (control.rateLimitNextTranscriptions > 0) { control.rateLimitNextTranscriptions--; return send(429, { error: { message: 'Rate limit reached for model whisper in organization on audio seconds per hour (ASH): Limit 7200. Please try again in 12m0s.', code: 'rate_limit_exceeded' } }, { 'retry-after': '720' }); }
        if (control.failNextTranscriptions > 0) { control.failNextTranscriptions--; return send(500, { error: { message: 'Internal server error' } }); }
        if (!f.file || !f.model) return send(400, { error: { message: 'file and model are required' } });
        if (!/^whisper/.test(f.model)) return send(404, { error: { message: `The model \`${f.model}\` does not exist`, code: 'model_not_found' } });
        const hz = wavToneHz(f.file.data);
        const key = hz ? [300, 500, 700].reduce((best, k) => (Math.abs(k - hz) < Math.abs(best - hz) ? k : best), 300) : null;
        const lines = key ? FIXTURE_SPEECH[key] : [`Recorded audio part of ${f.file.data.length} bytes was received.`];
        const duration = hz ? (f.file.data.length - 44) / 32000 : 10;
        const step = duration / lines.length;
        return send(200, {
          task: 'transcribe', language: 'english', duration, text: lines.join(' '),
          segments: lines.map((text, i) => ({ id: i, start: +(i * step).toFixed(2), end: +((i + 1) * step).toFixed(2), text: ` ${text}` })),
        });
      }
      if (req.method === 'POST' && req.url === '/chat/completions') {
        let body;
        try { body = JSON.parse(data); } catch { return send(400, { error: { message: 'bad json' } }); }
        if (body.model === 'rate-limited') return send(429, { error: { message: 'Rate limit reached for model. Please try again in 7s.', type: 'tokens', code: 'rate_limit_exceeded' } }, { 'retry-after': '7' });
        if (body.model === 'gone-model') return send(404, { error: { message: 'The model `gone-model` does not exist or you do not have access to it.', type: 'invalid_request_error', code: 'model_not_found' } });
        if (body.model === 'decommissioned-model') return send(400, { error: { message: 'The model has been decommissioned.', type: 'invalid_request_error', code: 'model_decommissioned' } });
        if (body.model === 'slow-model') { await new Promise((r) => setTimeout(r, 8000)); }
        const totalChars = body.messages.reduce((n, m) => n + String(m.content).length, 0);
        if (totalChars > 400000) return send(413, { error: { message: 'Request too large for model', type: 'tokens', code: 'rate_limit_exceeded' } });
        const content = respondTo(body);
        return send(200, {
          id: 'chatcmpl-fake', object: 'chat.completion', model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: Math.ceil(totalChars / 4), completion_tokens: Math.ceil(content.length / 4) },
        });
      }
      return send(404, { error: { message: 'Unknown route' } });
    });
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const { port: actual } = server.address();
      resolve({ url: `http://127.0.0.1:${actual}`, log, control, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

// Allow running standalone: node tests/support/fake-groq.mjs 8787
if (import.meta.url === `file://${process.argv[1]}`) {
  const s = await startFakeGroq({ port: Number(process.argv[2] || 8787) });
  console.log(`Fake Groq listening at ${s.url}`);
}
