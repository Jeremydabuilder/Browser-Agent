// Tests the real Windows installer (release/SatchelSetup.exe, built with NSIS) by running it under Wine:
// silent install, what lands on disk, the registry entries Chrome/Edge use to find the companion,
// Start menu shortcuts, the Settings > Apps entry, an in-place upgrade, and uninstall.
//
// Needs makensis and wine (32-bit support, e.g. "apt install nsis wine wine32:i386"); skipped otherwise.
// Wine is not Windows: the interactive pages, SmartScreen, the real PowerShell 5.1 key window and
// DPAPI still need a manual check on Windows (docs/MANUAL-TESTS.md, section A).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const has = (cmd, args = ['--version']) => { try { execFileSync(cmd, args, { stdio: 'ignore' }); return true; } catch { return false; } };
const skip = !has('makensis', ['-VERSION']) ? 'makensis (NSIS) is not installed' : !has('wine') ? 'wine is not installed' : false;

const prefix = mkdtempSync(path.join(tmpdir(), 'satchel-wine-'));
const env = { ...process.env, WINEPREFIX: prefix, WINEDEBUG: '-all' };
const user = process.env.USER || 'root';
const local = path.join(prefix, 'drive_c/users', user, 'AppData/Local/Satchel');
const menu = path.join(prefix, 'drive_c/users', user, 'AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Satchel');
const HOST = 'com.satchel.companion';

function wine(args, timeout = 180000) {
  const r = spawnSync('wine', args, { env, encoding: 'utf8', timeout });
  spawnSync('wineserver', ['-w'], { env, timeout });
  return r;
}
function regQuery(key) {
  const r = wine(['reg', 'query', key]);
  return r.status === 0 ? r.stdout : null;
}
const walk = (dir) => readdirSync(dir).flatMap((f) => { const p = path.join(dir, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
const rel = (dir) => walk(dir).map((f) => path.relative(dir, f).split(path.sep).join('/')).sort();

test('Windows installer: install, upgrade and uninstall (under Wine)', { skip, timeout: 900000 }, async (t) => {
  const build = spawnSync(process.execPath, [path.join(root, 'scripts/build.mjs')], { encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr + build.stdout);
  // Test the committed installer that users download (the build refreshes it when its inputs change).
  const setup = path.join(root, 'release/SatchelSetup.exe');
  assert.ok(existsSync(setup), 'release/SatchelSetup.exe exists');
  assert.equal(spawnSync(process.execPath, [path.join(root, 'scripts/check.mjs')]).status, 0, 'release/SatchelSetup.exe is up to date with the sources');
  assert.match(execFileSync('file', [setup], { encoding: 'utf8' }), /PE32 executable .*Intel 80386.*Nullsoft/, '32-bit installer, so it runs on every Windows 10/11 PC');

  wine(['wineboot', '-i'], 300000);

  await t.test('silent install puts the companion and the extension in %LOCALAPPDATA%\\Satchel', () => {
    const r = wine([setup, '/S']);
    assert.equal(r.status, 0, r.stderr);
    for (const f of ['SatchelCommon.ps1', 'satchel-host.ps1', 'satchel-host.bat', 'set-key.ps1', 'status.ps1', 'uninstall.ps1', `${HOST}.json`]) {
      assert.ok(existsSync(path.join(local, 'companion', f)), `companion/${f}`);
    }
    // PowerShell 5.1 needs CRLF-safe, ASCII scripts; the installed host is byte-identical to the release one.
    assert.deepEqual(readFileSync(path.join(local, 'companion/satchel-host.ps1')), readFileSync(path.join(root, 'dist/installer-stage/companion/satchel-host.ps1')));
    assert.match(readFileSync(path.join(local, 'companion/satchel-host.ps1'), 'latin1'), /\r\n/);
    assert.deepEqual(rel(path.join(local, 'extension')), rel(path.join(root, 'dist/satchel-extension')), 'extension folder matches the release build');
    for (const f of ['setup-guide.html', 'satchel.ico', 'uninstall.exe']) assert.ok(existsSync(path.join(local, f)), f);
  });

  await t.test('native messaging manifest trusts only the Satchel extension and points next to itself', () => {
    const m = JSON.parse(readFileSync(path.join(local, 'companion', `${HOST}.json`), 'utf8'));
    assert.equal(m.name, HOST);
    assert.equal(m.type, 'stdio');
    assert.equal(m.path, 'satchel-host.bat');
    assert.ok(existsSync(path.join(local, 'companion', m.path)));
    assert.deepEqual(m.allowed_origins, ['chrome-extension://enhkjfoecodefiigkephlalmoebbfgmb/']);
    const manifest = JSON.parse(readFileSync(path.join(local, 'extension/manifest.json'), 'utf8'));
    assert.ok(manifest.key, 'installed extension keeps the fixed-ID public key');
  });

  await t.test('Chrome and Edge registry entries point at the manifest (HKCU, no admin)', () => {
    for (const k of [`HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST}`, `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST}`]) {
      const out = regQuery(k);
      assert.ok(out, `${k} exists`);
      assert.match(out, new RegExp(`REG_SZ\\s+C:\\\\users\\\\${user}\\\\AppData\\\\Local\\\\Satchel\\\\companion\\\\${HOST.replace(/\./g, '\\.')}\\.json`, 'i'));
    }
    const un = regQuery('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Satchel');
    assert.ok(un, 'Settings > Apps entry exists');
    assert.match(un, /DisplayName\s+REG_SZ\s+Satchel/);
    assert.match(un, /UninstallString\s+REG_SZ\s+"C:\\users\\.+\\Satchel\\uninstall\.exe"/i);
  });

  await t.test('Start menu shortcuts: set keys, check companion, setup guide, uninstall', () => {
    const lnks = readdirSync(menu).sort();
    assert.deepEqual(lnks, [
      'Satchel - Add the extension to Chrome or Edge.lnk',
      'Satchel - Check companion.lnk',
      'Satchel - Set Groq key.lnk',
      'Satchel - Set OpenAI key.lnk',
      'Satchel - Uninstall.lnk',
    ]);
    // .lnk strings are UTF-16LE at arbitrary offsets; dropping NUL bytes makes them searchable.
    const text = (f) => readFileSync(path.join(menu, f)).toString('latin1').replace(/\0/g, '');
    assert.match(text('Satchel - Set Groq key.lnk'), /set-key\.ps1" -Provider groq/);
    assert.match(text('Satchel - Set OpenAI key.lnk'), /set-key\.ps1" -Provider openai/);
    assert.match(text('Satchel - Check companion.lnk'), /status\.ps1/);
    assert.match(text('Satchel - Set Groq key.lnk'), /Satchel\\companion(?!\\)/, 'shortcuts start in the companion folder');
  });

  await t.test('running a newer installer replaces the extension files and keeps stored keys', () => {
    writeFileSync(path.join(local, 'extension/stale-file-from-old-version.js'), '// old');
    writeFileSync(path.join(local, 'groq-key.dat'), 'encrypted-bytes-stand-in');
    writeFileSync(path.join(local, 'openai-key.dat'), 'encrypted-bytes-stand-in');
    const r = wine([setup, '/S']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(path.join(local, 'extension/stale-file-from-old-version.js')), false, 'stale file removed');
    assert.equal(readFileSync(path.join(local, 'groq-key.dat'), 'utf8'), 'encrypted-bytes-stand-in', 'Groq key kept');
    assert.ok(existsSync(path.join(local, 'openai-key.dat')), 'OpenAI key kept');
  });

  await t.test('silent uninstall removes registration, shortcuts and files but keeps keys', () => {
    const r = wine([path.join(local, 'uninstall.exe'), '/S']);
    assert.equal(r.status, 0, r.stderr);
    // The NSIS uninstaller copies itself to a temp folder and returns at once; wait for it.
    for (let i = 0; i < 60 && existsSync(path.join(local, 'uninstall.exe')); i++) spawnSync('sleep', ['1']);
    spawnSync('wineserver', ['-w'], { env });
    assert.equal(regQuery(`HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST}`), null);
    assert.equal(regQuery(`HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST}`), null);
    assert.equal(regQuery('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Satchel'), null);
    assert.equal(existsSync(menu), false, 'Start menu folder removed');
    for (const d of ['companion', 'extension', 'uninstall.exe', 'setup-guide.html']) assert.equal(existsSync(path.join(local, d)), false, `${d} removed`);
    assert.ok(existsSync(path.join(local, 'groq-key.dat')) && existsSync(path.join(local, 'openai-key.dat')), 'keys kept (silent uninstall never deletes them)');
  });
});
