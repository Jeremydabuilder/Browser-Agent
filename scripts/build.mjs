// Builds installable artifacts into dist/:
//   dist/satchel-extension/        folder to "Load unpacked" in Chrome/Edge
//   dist/satchel-extension.zip     the same, zipped
//   dist/satchel-companion-windows.zip   the Windows companion (install.cmd etc.)
//   dist/SatchelSetup.exe          one Windows installer (companion + extension files), when makensis is available
import { cpSync, rmSync, mkdirSync, readdirSync, statSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { installerFiles, installerInputsHash, toCrlf } from './installer-inputs.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
execFileSync(process.execPath, [path.join(root, 'scripts/check.mjs')], { stdio: 'inherit' });

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
const extOut = path.join(dist, 'satchel-extension');
cpSync(path.join(root, 'extension'), extOut, { recursive: true, filter: (src) => !src.endsWith('.svg') });

const walk = (dir) => readdirSync(dir).flatMap((f) => { const p = path.join(dir, f); return statSync(p).isDirectory() ? walk(p) : [p]; });

// Minimal ZIP writer (deflate) so the build has no dependencies.
function zip(files, outFile) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const dosTime = ((new Date().getHours() << 11) | (new Date().getMinutes() << 5)) & 0xffff;
  const d = new Date();
  const dosDate = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name.replace(/\\/g, '/'), 'utf8');
    const deflated = zlib.deflateRawSync(data);
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, deflated);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10);
    c.writeUInt16LE(dosTime, 12); c.writeUInt16LE(dosDate, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(deflated.length, 20);
    c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nameBuf.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, nameBuf);
    offset += local.length + nameBuf.length + deflated.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12); end.writeUInt32LE(offset, 16);
  writeFileSync(outFile, Buffer.concat([...chunks, centralBuf, end]));
}

zip(walk(extOut).map((f) => ({ name: path.join('satchel-extension', path.relative(extOut, f)), data: readFileSync(f) })), path.join(dist, 'satchel-extension.zip'));
const compDir = path.join(root, 'companion/windows');
zip(walk(compDir).filter((f) => !f.includes(`${path.sep}installer${path.sep}`)).map((f) => ({ name: path.join('satchel-companion', path.relative(compDir, f)), data: f.endsWith('.ps1') ? toCrlf(readFileSync(f)) : readFileSync(f) })), path.join(dist, 'satchel-companion-windows.zip'));
const version = JSON.parse(readFileSync(path.join(root, 'extension/manifest.json'), 'utf8')).version;

// ---- Windows installer (NSIS). makensis also runs on Linux/macOS, so the .exe can be built anywhere.
function hasMakensis() {
  try { execFileSync('makensis', ['-VERSION'], { stdio: 'ignore' }); return true; } catch { return false; }
}
const stage = path.join(dist, 'installer-stage');
for (const { rel, data } of installerFiles(root)) {
  mkdirSync(path.dirname(path.join(stage, rel)), { recursive: true });
  writeFileSync(path.join(stage, rel), data);
}

let setupLine = '  dist/SatchelSetup.exe: SKIPPED (install NSIS, e.g. "apt install nsis" or "choco install nsis", then build again)';
if (hasMakensis()) {
  const exe = path.join(dist, 'SatchelSetup.exe');
  execFileSync('makensis', ['-V2', `-DVERSION=${version}`, `-DSTAGE=${stage}`, `-DOUTFILE=${exe}`, path.join(compDir, 'installer/satchel-setup.nsi')], { stdio: 'inherit' });
  // The committed copy that users download (with "Code > Download ZIP"), plus a fingerprint of its
  // inputs so `npm run lint` notices when it's out of date.
  // NSIS output embeds timestamps, so release/ is only replaced when the inputs actually changed.
  const rel = path.join(root, 'release');
  const metaFile = path.join(rel, 'SatchelSetup.json');
  const inputs = installerInputsHash(root);
  let current = null;
  try { current = JSON.parse(readFileSync(metaFile, 'utf8')); } catch { /* none yet */ }
  const upToDate = current?.inputs === inputs && current?.version === version && existsSync(path.join(rel, 'SatchelSetup.exe'));
  if (!upToDate) {
    mkdirSync(rel, { recursive: true });
    cpSync(exe, path.join(rel, 'SatchelSetup.exe'));
    writeFileSync(metaFile, `${JSON.stringify({ version, inputs, sha256: createHash('sha256').update(readFileSync(exe)).digest('hex') }, null, 2)}\n`);
  }
  setupLine = `  dist/SatchelSetup.exe  (one installer: companion + extension files + Start menu)\n  release/SatchelSetup.exe  ${upToDate ? '(already up to date, left unchanged)' : '(UPDATED: commit release/)'}`;
}
console.log(`✓ Built Satchel ${version}:\n  dist/satchel-extension/  (Load unpacked)\n  dist/satchel-extension.zip\n  dist/satchel-companion-windows.zip\n${setupLine}`);
