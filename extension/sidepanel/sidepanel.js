// Side panel controller: view switching, current-tab tracking, companion status.
import { ping, listModels, providerLabel } from '../lib/ai.js';
import { getTargetTab } from '../lib/browser.js';
import { h, toast, openSettings } from '../lib/ui.js';
import { getSettings } from '../lib/settings.js';
import * as askView from './views/ask.js';
import * as schoolView from './views/school.js';
import * as tabsView from './views/tabs.js';
import * as emailView from './views/email.js';
import * as meetingsView from './views/meetings.js';
import { getItem, setItem, removeItem } from '../lib/storage.js';

const views = { ask: askView, school: schoolView, tabs: tabsView, meetings: meetingsView, email: emailView };
const listeners = new Set();

export const app = {
  targetTab: null,
  companion: { ok: false, message: 'Checking…' },
  onTargetTab(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  async refreshTarget() {
    const tab = await getTargetTab().catch(() => null);
    const changed = tab?.id !== app.targetTab?.id || tab?.url !== app.targetTab?.url || tab?.title !== app.targetTab?.title;
    app.targetTab = tab;
    if (changed) for (const fn of listeners) fn(tab);
  },
  checkCompanion,
};

const STATUS_KEY = 'companionStatus';
const STATUS_FRESH_MS = 10 * 60 * 1000; // re-check the companion (a PowerShell start) at most this often on open

/** Works out whether the providers the user chose for chat and transcription are ready. */
async function evaluate(r) {
  const settings = await getSettings();
  const need = [...new Set([settings.chatProvider || 'groq', settings.transcriptionProvider || 'groq'])];
  const keys = r.keys || { groq: !!r.hasKey };
  const missing = need.filter((p) => !keys[p]);
  if (missing.length) {
    return { ok: false, code: 'no_key', missing, need, message: `The companion is installed, but no ${missing.map(providerLabel).join(' or ')} key is stored.` };
  }
  return { ok: true, need, version: r.version, message: `Companion ${r.version} connected. Chat and notes: ${providerLabel(settings.chatProvider)}. Transcription: ${providerLabel(settings.transcriptionProvider)}.` };
}

function paintPill(status) {
  const pill = document.getElementById('companion-status');
  if (status.ok) {
    pill.textContent = `AI: ready · ${status.need.map(providerLabel).join(' + ')}`;
    pill.className = 'status-pill ok';
  } else {
    pill.textContent = 'AI: not set up';
    pill.className = 'status-pill bad';
  }
  pill.title = `${status.message} Click to check again.`;
  renderSetupCard(status);
}

// Exact steps for each setup problem, shown at the top of the panel until it is fixed.
function setupSteps(status) {
  const restart = 'Close every browser window, then reopen the browser.';
  switch (status.code) {
    case 'companion_missing': return {
      title: 'Finish setup: install the Satchel companion',
      steps: ['In your Satchel download, open the companion\\windows folder.', 'Double-click install.cmd. Paste your Groq key when it asks (get one free at console.groq.com/keys).', restart, 'Open Satchel again, or press Check again.'],
    };
    case 'companion_forbidden': return { title: 'Finish setup: re-register the companion', steps: ['Double-click install.cmd in companion\\windows again (it registers this copy of Satchel).', restart] };
    case 'companion_crashed': return { title: 'The companion could not start', steps: ['Open the Start menu → Satchel → “Satchel - Check companion”. It says what is blocking it (school laptops often block PowerShell).', 'Fix what it reports, or ask your IT admin, then press Check again.'] };
    case 'no_key': return {
      title: `Add your ${(status.missing || ['groq']).map(providerLabel).join(' and ')} key`,
      steps: [...(status.missing || ['groq']).map((p) => `Open the Start menu → Satchel → “Satchel - Set ${providerLabel(p)} key” and paste your key (${p === 'openai' ? 'platform.openai.com/api-keys' : 'console.groq.com/keys'}).`),
        'The key is encrypted for your Windows account on this PC; Satchel never stores it in the browser.', 'Press Check again.'],
      alt: status.need?.includes('openai') ? 'Or switch the task back to Groq in Settings → AI providers.' : '',
    };
    default: return { title: 'Satchel could not reach the companion', steps: [status.message, 'Open the Start menu → Satchel → “Satchel - Check companion”.', 'Press Check again.'] };
  }
}

function renderSetupCard(status) {
  document.getElementById('setup-card')?.remove();
  let hidden = null;
  try { hidden = sessionStorage.getItem('satchel.hideSetup'); } catch { /* ignore */ }
  if (status.ok || hidden === status.code) return;
  const s = setupSteps(status);
  const card = h('section', { id: 'setup-card', class: 'card setup-card', role: 'region', 'aria-label': 'Setup' },
    h('h3', {}, s.title),
    h('ol', { class: 'small' }, s.steps.map((t) => h('li', {}, t))),
    s.alt ? h('p', { class: 'muted small' }, s.alt) : null,
    h('p', { class: 'muted small' }, 'Pages, tabs and memory work without it; AI answers, school AI reading and transcription need it.'),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn small primary', onclick: async (e) => { e.target.disabled = true; e.target.textContent = 'Checking…'; const r = await checkCompanion({ force: true }); toast(r.ok ? 'AI is ready.' : r.message, r.ok ? 'info' : 'error'); } }, 'Check again'),
      h('button', { class: 'btn small', onclick: () => openSettings(status.code === 'no_key' && status.need?.includes('openai') ? 'model' : 'companion') }, 'Open setup in Settings'),
      h('button', { class: 'btn small link', onclick: () => { try { sessionStorage.setItem('satchel.hideSetup', status.code); } catch { /* ignore */ } card.remove(); } }, 'Hide')));
  document.querySelector('main').prepend(card);
}

async function checkCompanion({ force = false } = {}) {
  const cached = await getItem(STATUS_KEY, null, 'session');
  if (cached) { app.companion = cached; paintPill(cached); }
  if (!force && cached?.ok && Date.now() - cached.at < STATUS_FRESH_MS) return cached;
  let status;
  try {
    status = await evaluate(await ping());
    if (status.ok) listModels().catch(() => {});
  } catch (err) {
    status = { ok: false, code: err.code || 'companion_error', message: err.message };
  }
  status.at = Date.now();
  await setItem(STATUS_KEY, status, 'session');
  app.companion = status;
  paintPill(status);
  return status;
}

function showView(name) {
  for (const btn of document.querySelectorAll('.tabs button')) btn.setAttribute('aria-selected', String(btn.dataset.view === name));
  for (const [key, mod] of Object.entries(views)) {
    const section = document.getElementById(`view-${key}`);
    section.hidden = key !== name;
    if (key === name) mod.show?.();
  }
  try { sessionStorage.setItem('satchel.view', name); } catch { /* ignore */ }
}

async function main() {
  for (const [key, mod] of Object.entries(views)) mod.init(document.getElementById(`view-${key}`), app);
  for (const btn of document.querySelectorAll('.tabs button')) btn.addEventListener('click', () => showView(btn.dataset.view));
  document.getElementById('companion-status').addEventListener('click', async () => {
    const s = await checkCompanion({ force: true });
    toast(s.message, s.ok ? 'info' : 'error');
  });
  let pending = null;
  const schedule = () => { clearTimeout(pending); pending = setTimeout(() => app.refreshTarget(), 150); };
  chrome.tabs.onActivated.addListener(schedule);
  chrome.tabs.onUpdated.addListener((id, info) => { if (info.status === 'complete' || info.title || info.url) schedule(); });
  chrome.tabs.onRemoved.addListener(schedule);
  chrome.windows.onFocusChanged.addListener(schedule);
  await app.refreshTarget();
  let initial = 'ask';
  try { initial = sessionStorage.getItem('satchel.view') || 'ask'; } catch { /* ignore */ }
  const hash = location.hash.replace('#', '');
  showView(views[hash] ? hash : views[initial] ? initial : 'ask');
  checkCompanion();
  // Right-click "Record this tab with Satchel…" opens the Meetings view (it never starts recording by itself).
  const openMeetingsIntent = async () => {
    const intent = await getItem('meetingsIntent', null, 'session');
    if (!intent || Date.now() - intent.at > 60000) return;
    await removeItem('meetingsIntent', 'session');
    await app.refreshTarget();
    showView('meetings');
    meetingsView.focusRecording();
  };
  openMeetingsIntent();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes.meetingsIntent?.newValue) openMeetingsIntent();
    // Changing a provider in Settings changes which keys are needed.
    if (area === 'local' && changes.settings) {
      const [o, n] = [changes.settings.oldValue || {}, changes.settings.newValue || {}];
      if (o.chatProvider !== n.chatProvider || o.transcriptionProvider !== n.transcriptionProvider) checkCompanion({ force: true });
    }
  });
}

main();
