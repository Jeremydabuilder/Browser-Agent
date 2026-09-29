// What goes into the Windows installer (SatchelSetup.exe), shared by the build and the lint check.
// The committed release/SatchelSetup.exe carries a fingerprint of these inputs, so `npm run lint`
// fails when the extension or companion changed and the installer was not rebuilt.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

export const COMPANION_FILES = ['SatchelCommon.ps1', 'satchel-host.ps1', 'satchel-host.bat', 'set-key.ps1', 'status.ps1', 'uninstall.ps1'];
const walk = (dir) => readdirSync(dir).flatMap((f) => { const p = path.join(dir, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
export const toCrlf = (buf) => Buffer.from(buf.toString('utf8').replace(/\r?\n/g, '\r\n'), 'utf8');

function buildIco(pngs) {
  // ICO with PNG-compressed images (supported since Windows Vista).
  const header = Buffer.alloc(6 + 16 * pngs.length);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach((img, i) => {
    const w = img.readUInt32BE(16); const hgt = img.readUInt32BE(20);
    const e = 6 + 16 * i;
    header.writeUInt8(w >= 256 ? 0 : w, e); header.writeUInt8(hgt >= 256 ? 0 : hgt, e + 1);
    header.writeUInt16LE(1, e + 4); header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(img.length, e + 8); header.writeUInt32LE(offset, e + 12);
    offset += img.length;
  });
  return Buffer.concat([header, ...pngs]);
}

/** Every file the installer ships, as { rel: path inside the staging folder, data: Buffer }. */
export function installerFiles(root) {
  const compDir = path.join(root, 'companion/windows');
  const ext = path.join(root, 'extension');
  const files = [];
  for (const f of COMPANION_FILES) {
    const data = readFileSync(path.join(compDir, f));
    files.push({ rel: `companion/${f}`, data: f.endsWith('.ps1') ? toCrlf(data) : data });
  }
  const extId = /\$script:SatchelExtensionId\s*=\s*'([a-p]{32})'/.exec(readFileSync(path.join(compDir, 'SatchelCommon.ps1'), 'utf8'))[1];
  // "path" is relative to this manifest's folder (allowed on Windows), so the file has no user-specific path.
  files.push({ rel: 'companion/com.satchel.companion.json', data: Buffer.from(JSON.stringify({
    name: 'com.satchel.companion',
    description: 'Satchel companion (AI provider access for the Satchel extension)',
    path: 'satchel-host.bat',
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extId}/`],
  }, null, 2)) });
  for (const f of walk(ext).filter((p) => !p.endsWith('.svg'))) {
    files.push({ rel: `extension/${path.relative(ext, f).split(path.sep).join('/')}`, data: readFileSync(f) });
  }
  files.push({ rel: 'setup-guide.html', data: readFileSync(path.join(compDir, 'installer/setup-guide.html')) });
  files.push({ rel: 'satchel.ico', data: buildIco(['16', '32', '48', '128'].map((s) => readFileSync(path.join(ext, `icons/icon${s}.png`)))) });
  return files.sort((a, b) => a.rel.localeCompare(b.rel));
}

/** Fingerprint of the installer's inputs: its files plus the NSIS script. */
export function installerInputsHash(root) {
  // Line endings are normalized so a Windows checkout (git core.autocrlf) gives the same fingerprint.
  const norm = (rel, data) => (/\.(png|ico)$/.test(rel) ? data : Buffer.from(data.toString('latin1').replace(/\r\n/g, '\n'), 'latin1'));
  const h = createHash('sha256');
  for (const { rel, data } of installerFiles(root)) { const d = norm(rel, data); h.update(`${rel}\0${d.length}\0`).update(d); }
  h.update('satchel-setup.nsi\0').update(norm('nsi', readFileSync(path.join(root, 'companion/windows/installer/satchel-setup.nsi'))));
  return h.digest('hex');
}
