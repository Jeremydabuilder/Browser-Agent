// Static checks: manifest references, relative imports resolve, JS syntax, no secrets, PS1 files are ASCII.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ext = path.join(root, 'extension');
const problems = [];
const walk = (dir) => readdirSync(dir).flatMap((f) => { const p = path.join(dir, f); return statSync(p).isDirectory() ? walk(p) : [p]; });

const manifest = JSON.parse(readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
const refs = [manifest.background.service_worker, manifest.side_panel.default_path, manifest.options_page, ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon)];
for (const r of refs) if (!existsSync(path.join(ext, r))) problems.push(`manifest references missing file ${r}`);
if (manifest.host_permissions?.length) problems.push('manifest must not request host_permissions up front (use optional_host_permissions)');

const files = walk(ext);
for (const f of files.filter((p) => p.endsWith('.js'))) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); } catch (e) { problems.push(`syntax error in ${path.relative(root, f)}: ${e.stderr}`); }
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/(?:import|export)[^'"]*?from\s+['"](\.[^'"]+)['"]/g)) {
    if (!existsSync(path.resolve(path.dirname(f), m[1]))) problems.push(`${path.relative(root, f)} imports missing ${m[1]}`);
  }
  if (/gsk_[A-Za-z0-9]{20,}/.test(src)) problems.push(`possible Groq key in ${f}`);
  if (/\.innerHTML\s*=|insertAdjacentHTML|document\.write\(|\beval\(|new Function\(/.test(src)) problems.push(`unsafe DOM/eval API in ${path.relative(root, f)}`);
}
for (const f of files.filter((p) => p.endsWith('.html'))) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/(?:src|href)="([^"#:]+)"/g)) if (!existsSync(path.resolve(path.dirname(f), m[1]))) problems.push(`${path.relative(root, f)} references missing ${m[1]}`);
  if (/<script(?![^>]*\bsrc=)[^>]*>/.test(src)) problems.push(`inline script in ${f} (blocked by extension CSP)`);
}
for (const f of walk(path.join(root, 'companion'))) {
  const buf = readFileSync(f);
  if (f.endsWith('.ps1') && buf.some((b) => b > 127)) problems.push(`${path.relative(root, f)} must be ASCII (Windows PowerShell 5.1 reads BOM-less files as ANSI)`);
  if (/\.(cmd|bat)$/.test(f) && !buf.includes(Buffer.from('\r\n'))) problems.push(`${f} must use CRLF line endings`);
}
if (problems.length) { console.error(problems.map((p) => `✗ ${p}`).join('\n')); process.exit(1); }
console.log(`✓ Checked ${files.length} extension files and the companion. No problems found.`);
