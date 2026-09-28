// A local stand-in for the Groq OpenAI-compatible API, used ONLY by automated tests.
// It enforces the Bearer key, and simulates rate limits, slow responses, and removed models.
// Responses are deterministic functions of the request so tests can assert on them.
import http from 'node:http';

export const FAKE_KEY = 'gsk_test_fake_key_123';

const MODELS = [
  { id: 'llama-3.3-70b-versatile', object: 'model', active: true, context_window: 131072 },
  { id: 'llama-3.1-8b-instant', object: 'model', active: true, context_window: 131072 },
  { id: 'whisper-large-v3', object: 'model', active: true, context_window: 448 },
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
  if (task === 'email_summary') {
    return JSON.stringify({ summary: 'The thread is about a project deadline.', actionItems: ['Reply by Friday'], facts: [] });
  }
  return `Echo: ${user.slice(-200)}`;
}

export function startFakeGroq({ port = 0 } = {}) {
  const log = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', async () => {
      const auth = req.headers.authorization || '';
      log.push({ method: req.method, url: req.url, auth, body: data });
      const send = (status, obj, headers = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
      };
      if (auth !== `Bearer ${FAKE_KEY}`) return send(401, { error: { message: 'Invalid API Key', type: 'invalid_request_error', code: 'invalid_api_key' } });
      if (req.method === 'GET' && req.url === '/models') return send(200, { object: 'list', data: MODELS });
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
      resolve({ url: `http://127.0.0.1:${actual}`, log, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

// Allow running standalone: node tests/support/fake-groq.mjs 8787
if (import.meta.url === `file://${process.argv[1]}`) {
  const s = await startFakeGroq({ port: Number(process.argv[2] || 8787) });
  console.log(`Fake Groq listening at ${s.url}`);
}
