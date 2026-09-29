// Serves tests/fixtures/school-site plus a few dynamic pages, for end-to-end tests.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/school-site');

export function toneWav(seconds, freq, sampleRate = 16000) {
  const n = sampleRate * seconds;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  const freqs = Array.isArray(freq) ? freq : [freq];
  const per = n / freqs.length;
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freqs[Math.min(freqs.length - 1, Math.floor(i / per))] * i) / sampleRate) * 12000), 44 + i * 2);
  return buf;
}

export function startFixtureServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/page') {
      const title = (url.searchParams.get('title') || 'Page').replace(/[<>&]/g, '');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><title>${title}</title><body><main><h1>${title}</h1><p>This is the ${title} page with enough text to be readable by the assistant for testing purposes.</p></main></body>`);
      return;
    }
    if (url.pathname === '/tone.wav') {
      res.writeHead(200, { 'content-type': 'audio/wav' });
      res.end(toneWav(20, 440));
      return;
    }
    if (url.pathname === '/meeting') {
      // Stands in for a meeting running in a tab (Meet/Zoom web/Teams): it plays a 440 Hz tone.
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>Meeting Fixture</title><h1>Meeting Fixture</h1><audio id="a" src="/tone.wav" autoplay loop controls></audio>');
      return;
    }
    if (url.pathname === '/spa') {
      // Content rendered by JavaScript after load, like many school portals.
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><title>SPA Portal</title><body><div id="app">Loading…</div><script>
        setTimeout(() => { document.getElementById('app').innerHTML = '<div class="assignment-item"><h3 class="assignment-title">Rendered Later Worksheet</h3><span class="course-name">Geometry</span><span class="due-date">Due 10/20/2026</span></div>'; }, 600);
      </script></body>`);
      return;
    }
    const file = path.join(dir, path.normalize(url.pathname).replace(/^([/\\])+/, ''));
    if (!file.startsWith(dir)) { res.writeHead(403); res.end(); return; }
    try {
      const data = await readFile(file);
      res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' });
      res.end(data);
    } catch {
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end('<title>Not found</title>Not found');
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) });
  }));
}
