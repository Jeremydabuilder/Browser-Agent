// Side panel controller: view switching, current-tab tracking, companion status.
import { ping, listModels } from '../lib/ai.js';
import { getTargetTab } from '../lib/browser.js';
import { toast } from '../lib/ui.js';
import * as askView from './views/ask.js';
import * as schoolView from './views/school.js';
import * as tabsView from './views/tabs.js';
import * as emailView from './views/email.js';
import * as meetingsView from './views/meetings.js';
import { getItem, removeItem } from '../lib/storage.js';

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

async function checkCompanion() {
  const pill = document.getElementById('companion-status');
  try {
    const r = await ping();
    if (!r.hasKey) throw Object.assign(new Error('The companion is installed but no Groq key is stored. Run set-key.cmd in the companion folder.'), { code: 'no_key' });
    app.companion = { ok: true, message: `Companion ${r.version} connected` };
    pill.textContent = 'AI: ready';
    pill.className = 'status-pill ok';
    listModels().catch(() => {});
  } catch (err) {
    app.companion = { ok: false, message: err.message };
    pill.textContent = 'AI: not set up';
    pill.className = 'status-pill bad';
  }
  pill.title = app.companion.message;
  return app.companion;
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
    const s = await checkCompanion();
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
  chrome.storage.onChanged.addListener((changes, area) => { if (area === 'session' && changes.meetingsIntent?.newValue) openMeetingsIntent(); });
}

main();
