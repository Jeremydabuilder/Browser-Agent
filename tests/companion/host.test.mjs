// Runs the real companion (satchel-host.ps1) under PowerShell with native-messaging framing,
// against the local fake Groq server. Requires `pwsh` on PATH (skipped otherwise).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeGroq, FAKE_KEY } from '../support/fake-groq.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hostScript = path.join(root, 'companion/windows/satchel-host.ps1');
const hasPwsh = spawnSync('pwsh', ['-v']).status === 0;
let fake;
let dataDir;

function callHost(message, { origin = 'chrome-extension://enhkjfoecodefiigkephlalmoebbfgmb/', env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', hostScript, origin], {
      env: { ...process.env, SATCHEL_DATA_DIR: dataDir, SATCHEL_GROQ_BASE_URL: fake.url, ...env },
    });
    const chunks = [];
    child.stdout.on('data', (c) => chunks.push(c));
    child.on('error', reject);
    child.on('close', () => {
      const buf = Buffer.concat(chunks);
      if (buf.length < 4) return reject(new Error('no reply'));
      const len = buf.readInt32LE(0);
      assert.equal(buf.length, 4 + len, 'stdout must contain exactly one framed message');
      resolve(JSON.parse(buf.subarray(4, 4 + len).toString('utf8')));
    });
    const payload = Buffer.from(JSON.stringify(message), 'utf8');
    const header = Buffer.alloc(4);
    header.writeInt32LE(payload.length, 0);
    child.stdin.end(Buffer.concat([header, payload]));
  });
}

before(async () => {
  fake = await startFakeGroq();
  dataDir = mkdtempSync(path.join(tmpdir(), 'satchel-host-'));
});
after(async () => { await fake?.close(); });

test('ping reports no key before setup', { skip: !hasPwsh }, async () => {
  const r = await callHost({ type: 'ping' });
  assert.equal(r.ok, true);
  assert.equal(r.hasKey, false);
  assert.equal(r.version, '1.0.0');
});

test('chat without a key returns no_key', { skip: !hasPwsh }, async () => {
  const r = await callHost({ type: 'chat', bodyJson: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'hi' }] }) });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'no_key');
});

test('stores key via Save-GroqKey and then pings with hasKey', { skip: !hasPwsh }, async () => {
  const cmd = `. '${path.join(root, 'companion/windows/SatchelCommon.ps1')}'; Save-GroqKey '${FAKE_KEY}'`;
  const r = spawnSync('pwsh', ['-NoProfile', '-Command', cmd], { env: { ...process.env, SATCHEL_DATA_DIR: dataDir } });
  assert.equal(r.status, 0, r.stderr.toString());
  assert.ok(existsSync(path.join(dataDir, 'groq-key.dev.txt')));
  const ping = await callHost({ type: 'ping' });
  assert.equal(ping.hasKey, true);
  assert.equal(JSON.stringify(ping).includes(FAKE_KEY), false, 'key must never be returned');
});

test('models are listed through the companion', { skip: !hasPwsh }, async () => {
  const r = await callHost({ type: 'models' });
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  const ids = JSON.parse(r.body).data.map((m) => m.id);
  assert.ok(ids.includes('llama-3.3-70b-versatile'));
});

test('chat passes the body through and adds the key only as a header', { skip: !hasPwsh }, async () => {
  const body = { model: 'llama-3.1-8b-instant', messages: [{ role: 'user', content: 'Hello ünïcode ✓' }] };
  const r = await callHost({ type: 'chat', bodyJson: JSON.stringify(body) });
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  const parsed = JSON.parse(r.body);
  assert.match(parsed.choices[0].message.content, /Hello ünïcode ✓/);
  const last = fake.log.at(-1);
  assert.equal(last.auth, `Bearer ${FAKE_KEY}`);
  assert.equal(last.body.includes(FAKE_KEY), false);
});

test('rate limits are reported with retry-after', { skip: !hasPwsh }, async () => {
  const r = await callHost({ type: 'chat', bodyJson: JSON.stringify({ model: 'rate-limited', messages: [{ role: 'user', content: 'x' }] }) });
  assert.equal(r.status, 429);
  assert.equal(String(r.retryAfter), '7');
});

test('timeouts become a timeout error code', { skip: !hasPwsh }, async () => {
  const r = await callHost({ type: 'chat', timeoutSec: 5, bodyJson: JSON.stringify({ model: 'slow-model', messages: [{ role: 'user', content: 'x' }] }) });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'timeout');
});

test('rejects unknown request types and malformed bodies', { skip: !hasPwsh }, async () => {
  assert.equal((await callHost({ type: 'shell', cmd: 'whoami' })).error.code, 'unsupported');
  assert.equal((await callHost({ type: 'chat', bodyJson: '{not json' })).error.code, 'bad_request');
  assert.equal((await callHost({ type: 'chat', bodyJson: '{"model":"x"}' })).error.code, 'bad_request');
});

test('rejects callers from other extension IDs', { skip: !hasPwsh }, async () => {
  const r = await callHost({ type: 'ping' }, { origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/' });
  assert.equal(r.error.code, 'forbidden');
});

test('error log never contains prompt text or the key', { skip: !hasPwsh }, async () => {
  const logPath = path.join(dataDir, 'companion-errors.log');
  if (!existsSync(logPath)) return;
  const log = readFileSync(logPath, 'utf8');
  assert.equal(log.includes(FAKE_KEY), false);
  assert.equal(log.includes('Hello'), false);
  writeFileSync(logPath, '');
});

test('every companion PowerShell script parses without syntax errors', { skip: !hasPwsh }, () => {
  const script = `$bad = 0; Get-ChildItem '${path.join(root, 'companion/windows')}' -Filter *.ps1 | ForEach-Object { $t = $null; $e = $null; [System.Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$t, [ref]$e) | Out-Null; if ($e.Count) { $bad++; Write-Output ($_.Name + ': ' + ($e | ForEach-Object { $_.Message }) -join '; ') } }; exit $bad`;
  const r = spawnSync('pwsh', ['-NoProfile', '-Command', script]);
  assert.equal(r.status, 0, r.stdout.toString() + r.stderr.toString());
});

test('the installer registers the host for both Chrome and Edge with only Satchel allowed', () => {
  const src = readFileSync(path.join(root, 'companion/windows/install.ps1'), 'utf8');
  assert.match(src, /HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts/);
  assert.match(src, /HKCU:\\Software\\Microsoft\\Edge\\NativeMessagingHosts/);
  const common = readFileSync(path.join(root, 'companion/windows/SatchelCommon.ps1'), 'utf8');
  const manifest = JSON.parse(readFileSync(path.join(root, 'extension/manifest.json'), 'utf8'));
  const id = [...createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32)].map((h) => String.fromCharCode(97 + parseInt(h, 16))).join('');
  assert.match(common, new RegExp(`SatchelExtensionId = '${id}'`), 'companion trusts exactly the ID derived from the manifest key');
});

function toneWav(seconds, freq) {
  const sr = 16000;
  const n = sr * seconds;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / sr) * 10000), 44 + i * 2);
  return buf;
}

test('transcribe uploads the audio as multipart to Groq with only whitelisted fields', { skip: !hasPwsh }, async () => {
  const audio = toneWav(3, 500);
  const r = await callHost({ type: 'transcribe', model: 'whisper-large-v3-turbo', mime: 'audio/wav', fileName: 'part-1.wav', audioBase64: audio.toString('base64'), language: 'en', prompt: 'Robotics club', extra: 'ignored' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.match(body.text, /demo day/);
  assert.ok(body.segments.length >= 2);
  const t = fake.log.transcriptions.at(-1);
  assert.deepEqual([t.model, t.response_format, t.granularity, t.filename, t.type, t.bytes, t.language, t.prompt], ['whisper-large-v3-turbo', 'verbose_json', 'segment', 'part-1.wav', 'audio/wav', audio.length, 'en', 'Robotics club']);
  assert.equal(fake.log.at(-1).auth, `Bearer ${FAKE_KEY}`);
});

test('transcribe validates model, type, file name, and audio before contacting Groq', { skip: !hasPwsh }, async () => {
  const before = fake.log.transcriptions?.length || 0;
  const base = { type: 'transcribe', model: 'whisper-large-v3', mime: 'audio/wav', fileName: 'a.wav', audioBase64: toneWav(1, 300).toString('base64') };
  assert.equal((await callHost({ ...base, model: 'bad model; rm' })).error.code, 'bad_request');
  assert.equal((await callHost({ ...base, mime: 'text/html' })).error.code, 'bad_request');
  assert.equal((await callHost({ ...base, fileName: '..\\evil.exe' })).error.code, 'bad_request');
  assert.equal((await callHost({ ...base, audioBase64: '' })).error.code, 'bad_request');
  assert.equal((await callHost({ ...base, audioBase64: '%%%not-base64' })).error.code, 'bad_request');
  assert.equal(fake.log.transcriptions?.length || 0, before, 'nothing was sent to Groq');
});

test('transcribe handles a realistic 10 MB chunk and rejects chunks over 25 MB', { skip: !hasPwsh }, async () => {
  const big = toneWav(310, 700); // ~9.9 MB, like a 5-minute 16 kHz WAV part
  const ok = await callHost({ type: 'transcribe', model: 'whisper-large-v3', mime: 'audio/wav', fileName: 'big.wav', audioBase64: big.toString('base64') });
  assert.equal(ok.status, 200);
  assert.equal(fake.log.transcriptions.at(-1).bytes, big.length);
  const tooBig = Buffer.alloc(26 * 1024 * 1024, 1);
  const r = await callHost({ type: 'transcribe', model: 'whisper-large-v3', mime: 'audio/wav', fileName: 'huge.wav', audioBase64: tooBig.toString('base64') });
  assert.equal(r.error.code, 'too_large');
});

test('transcription rate limits come back with retry-after', { skip: !hasPwsh }, async () => {
  fake.control.rateLimitNextTranscriptions = 1;
  const r = await callHost({ type: 'transcribe', model: 'whisper-large-v3', mime: 'audio/webm', fileName: 'p.webm', audioBase64: Buffer.from('webmdata').toString('base64') });
  assert.equal(r.status, 429);
  assert.equal(String(r.retryAfter), '720');
});
