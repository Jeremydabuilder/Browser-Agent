// Serves tests/fixtures/school-site plus a few dynamic pages, for end-to-end tests.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/school-site');

export function startFixtureServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/page') {
      const title = (url.searchParams.get('title') || 'Page').replace(/[<>&]/g, '');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><title>${title}</title><body><main><h1>${title}</h1><p>This is the ${title} page with enough text to be readable by the assistant for testing purposes.</p></main></body>`);
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
