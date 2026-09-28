import { getSettings, updateSettings } from '../lib/settings.js';
import { ping, listModels, friendlyError } from '../lib/ai.js';
import { GOOGLE_SERVICES, getConnections, connect, disconnect, disconnectAll, requestIdentityPermission } from '../lib/google-auth.js';
import { listAssignments, clearAssignments } from '../lib/school.js';
import { setItem } from '../lib/storage.js';
import { h, clear, toast, confirmDialog } from '../lib/ui.js';

const $ = (id) => document.getElementById(id);

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = h('a', { href: '#', download: name });
  a.href = url;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function testCompanion() {
  const el = $('companion-status');
  el.className = 'status-line';
  el.textContent = 'Checking…';
  try {
    const r = await ping();
    if (!r.hasKey) throw new Error('The companion is installed, but no Groq key is stored yet. Double-click set-key.cmd in the companion folder.');
    const models = await listModels({ force: true });
    el.className = 'status-line ok';
    el.textContent = `✓ Connected. Companion ${r.version}, key stored (${r.keyStore === 'windows-dpapi' ? 'encrypted with Windows' : r.keyStore}). ${models.length} chat models available.`;
    await fillModels(models);
  } catch (err) {
    el.className = 'status-line bad';
    el.textContent = friendlyError(err);
  }
}

async function fillModels(models) {
  const settings = await getSettings();
  const sel = $('model-select');
  clear(sel);
  sel.append(h('option', { value: 'auto' }, 'Auto (recommended)'));
  for (const m of models) sel.append(h('option', { value: m.id }, `${m.id}${m.contextWindow ? ` · ${Math.round(m.contextWindow / 1000)}k context` : ''}`));
  if (settings.model !== 'auto' && !models.some((m) => m.id === settings.model)) {
    sel.append(h('option', { value: settings.model }, `${settings.model} (not currently available)`));
  }
  sel.value = settings.model;
}

async function renderConnections() {
  const connections = await getConnections();
  const settings = await getSettings();
  const wrap = $('google-connections');
  clear(wrap);
  for (const [key, s] of Object.entries(GOOGLE_SERVICES)) {
    const c = connections[key];
    const btn = c
      ? h('button', { class: 'btn small', onclick: async () => { await disconnect(key); renderConnections(); } }, 'Disconnect')
      : h('button', {
        class: 'btn small primary', disabled: !settings.googleClientId,
        onclick: () => {
          requestIdentityPermission().then(async (ok) => {
            if (!ok) { toast('The identity permission is needed to sign in with Google.', 'error'); return; }
            try { await connect(key); toast('Connected.'); } catch (err) { toast(err.message, 'error'); }
            renderConnections();
          });
        },
      }, 'Connect');
    wrap.append(h('div', { class: 'mem' }, h('div', { class: 'row' }, h('div', {}, h('b', {}, s.label), h('div', { class: 'muted small' }, s.explain),
      c ? h('div', { class: 'small', style: 'color:var(--ok)' }, `Connected${c.email ? ` as ${c.email}` : ''} on ${new Date(c.connectedAt).toLocaleDateString()}`) : null), btn)));
  }
}

async function main() {
  const s = await getSettings();
  $('ext-id').textContent = chrome.runtime.id;
  $('max-tokens').value = s.maxInputTokens;
  $('timeout').value = s.requestTimeoutSec;
  $('confirm-sending').checked = s.confirmBeforeSending;
  $('use-memories').checked = s.useMemoriesInAI;
  $('date-order').value = s.dateOrder;
  $('client-id').value = s.googleClientId;
  $('redirect-uri').textContent = chrome.identity?.getRedirectURL ? chrome.identity.getRedirectURL() : `https://${chrome.runtime.id}.chromiumapp.org/`;
  const cached = await chrome.storage.local.get('modelCache');
  await fillModels(cached.modelCache?.models || []);

  $('test-companion').onclick = testCompanion;
  $('refresh-models').onclick = async () => { try { await fillModels(await listModels({ force: true })); toast('Model list updated.'); } catch (e) { toast(friendlyError(e), 'error'); } };
  $('model-select').onchange = async (e) => { await updateSettings({ model: e.target.value }); toast('Model saved.'); };
  $('max-tokens').onchange = async (e) => { const n = await updateSettings({ maxInputTokens: e.target.value }); e.target.value = n.maxInputTokens; toast('Saved.'); };
  $('timeout').onchange = async (e) => { const n = await updateSettings({ requestTimeoutSec: e.target.value }); e.target.value = n.requestTimeoutSec; toast('Saved.'); };
  $('confirm-sending').onchange = async (e) => { await updateSettings({ confirmBeforeSending: e.target.checked }); toast('Saved.'); };
  $('use-memories').onchange = async (e) => { await updateSettings({ useMemoriesInAI: e.target.checked }); toast('Saved.'); };
  $('date-order').onchange = async (e) => { await updateSettings({ dateOrder: e.target.value }); toast('Saved. New refreshes will use this.'); };
  $('copy-redirect').onclick = async () => { await navigator.clipboard.writeText($('redirect-uri').textContent); toast('Copied.'); };
  $('save-client-id').onclick = async () => {
    const v = $('client-id').value.trim();
    if (v && !/^[\w-]+\.apps\.googleusercontent\.com$/.test(v)) { toast('That does not look like a Google OAuth client ID (it ends with .apps.googleusercontent.com).', 'error'); return; }
    await updateSettings({ googleClientId: v });
    toast('Client ID saved.');
    renderConnections();
  };
  $('disconnect-google').onclick = async () => { if (await confirmDialog({ title: 'Disconnect Google?', message: 'Satchel will revoke its Google access and forget all Google connections.', confirmLabel: 'Disconnect', danger: true })) { await disconnectAll(); renderConnections(); toast('Disconnected.'); } };
  $('export-assignments').onclick = async () => download(`satchel-assignments-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(await listAssignments(), null, 2));
  $('clear-assignments').onclick = async () => { if (await confirmDialog({ title: 'Delete all assignments?', message: 'This removes every assignment from Satchel, including ones you added or corrected.', confirmLabel: 'Delete all', danger: true })) { await clearAssignments(); toast('Assignments deleted.'); } };
  $('clear-saved-tabs').onclick = async () => { if (await confirmDialog({ title: 'Delete saved tab groups?', message: 'Saved groups cannot be reopened after this.', confirmLabel: 'Delete', danger: true })) { await setItem('savedTabGroups', []); toast('Saved tab groups deleted.'); } };
  renderConnections();
  if (location.hash === '#google') $('google-guide').open = true;
  testCompanion();
}

main();
