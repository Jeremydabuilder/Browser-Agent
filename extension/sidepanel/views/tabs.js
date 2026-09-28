// "Tabs" view: list, search, group, save, reopen, and close tabs.
// Every close goes through a confirmation screen listing the exact tabs. Pinned tabs are never
// included unless the user ticks them personally on that screen.
import { h, clear, link, toast, modal, confirmSendToAI, spinner } from '../../lib/ui.js';
import { parseTabCommand, searchTabs, findDuplicateTabs, tabsForPrompt } from '../../lib/tabs.js';
import { validateAction } from '../../lib/actions.js';
import { executeTabAction, listSavedGroups, deleteSavedGroup, renameSavedGroup } from '../../lib/tab-exec.js';
import { chat, friendlyError } from '../../lib/ai.js';
import { tabCommandSystemPrompt, escapeForTag } from '../../lib/prompts.js';
import { hostnameOf } from '../../lib/util.js';

let root;
const state = { query: '', selected: new Set(), tabs: [], busy: false };
const els = {};
const GROUP_COLORS = { grey: '#9aa0a6', blue: '#4c8bf5', red: '#e8453c', yellow: '#f9ab00', green: '#34a853', pink: '#ff63b8', purple: '#a142f4', cyan: '#24c1e0', orange: '#fa903e' };

export function init(container) {
  root = container;
  const refresh = () => { if (!root.hidden && !state.busy) loadAndRender(); };
  chrome.tabs.onCreated.addListener(refresh);
  chrome.tabs.onRemoved.addListener(refresh);
  chrome.tabs.onUpdated.addListener((id, info) => { if (info.title || info.url || info.pinned !== undefined || info.groupId !== undefined) refresh(); });
  chrome.tabs.onMoved.addListener(refresh);
  buildShell();
}

export function show() {
  loadAndRender();
}

function buildShell() {
  clear(root);
  els.command = h('input', { type: 'text', placeholder: 'e.g. “close duplicate tabs” or “save these research tabs and close them”', 'aria-label': 'Tab command' });
  els.command.addEventListener('keydown', (e) => { if (e.key === 'Enter') runCommand(els.command.value); });
  els.search = h('input', { type: 'search', placeholder: 'Search tabs by title or address', 'aria-label': 'Search tabs' });
  els.search.addEventListener('input', () => { state.query = els.search.value; renderList(); });
  els.status = h('div');
  els.selectionBar = h('div', { class: 'btn-row sticky-actions' });
  els.list = h('div');
  els.saved = h('div');
  root.append(
    h('div', { class: 'card soft' },
      h('label', { style: 'margin-top:0' }, 'Tell Satchel what to do with your tabs'),
      h('div', { style: 'display:flex;gap:6px' }, els.command, h('button', { class: 'btn primary', onclick: () => runCommand(els.command.value) }, 'Go')),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn small', onclick: () => runCommand('close duplicate tabs') }, 'Close duplicate tabs'),
        h('button', { class: 'btn small', onclick: () => { els.command.value = 'save these research tabs and close them'; els.command.focus(); } }, 'Save these & close…')),
      h('p', { class: 'muted small' }, '“These/selected” means the tabs you tick below. Common commands work instantly; others are interpreted by the AI (tab titles and site addresses of this window are sent). You always confirm before tabs are closed.')),
    els.status, els.search, els.selectionBar, els.list,
    h('h3', { style: 'margin-top:16px' }, 'Saved groups'), els.saved,
  );
}

async function loadAndRender() {
  state.tabs = await chrome.tabs.query({ windowType: 'normal' });
  for (const id of [...state.selected]) if (!state.tabs.some((t) => t.id === id)) state.selected.delete(id);
  renderList();
  renderSaved();
}

function setStatus(node) {
  clear(els.status);
  if (node) els.status.append(node);
}

function favicon(t) {
  return t.favIconUrl && /^https?:|^data:/.test(t.favIconUrl) ? h('img', { class: 'favicon', src: t.favIconUrl, alt: '' }) : h('span', { class: 'favicon' });
}

async function renderList() {
  const own = chrome.runtime.getURL('');
  const visible = searchTabs(state.tabs, state.query).filter((t) => !String(t.url).startsWith(own));
  const dupIds = new Set(findDuplicateTabs(state.tabs).close.map((t) => t.id));
  let groups = [];
  try { groups = await chrome.tabGroups.query({}); } catch { /* ignore */ }
  const groupById = new Map(groups.map((g) => [g.id, g]));
  clear(els.list);
  renderSelectionBar();
  if (!visible.length) { els.list.append(h('div', { class: 'empty' }, state.query ? 'No tabs match your search.' : 'No tabs open.')); return; }
  const byWindow = new Map();
  for (const t of visible) {
    if (!byWindow.has(t.windowId)) byWindow.set(t.windowId, []);
    byWindow.get(t.windowId).push(t);
  }
  let n = 1;
  for (const [, tabs] of byWindow) {
    els.list.append(h('div', { class: 'window-label' }, `Window ${n++} · ${tabs.length} tab(s)`,
      h('button', { class: 'btn link small', onclick: () => { const all = tabs.every((t) => state.selected.has(t.id)); for (const t of tabs) { if (all) state.selected.delete(t.id); else if (!t.pinned) state.selected.add(t.id); } renderList(); } }, 'select all')));
    els.list.append(h('div', { class: 'tab-list' }, tabs.map((t) => {
      const g = groupById.get(t.groupId);
      return h('div', { class: `tab-row ${t.pinned ? 'pinned' : ''}`, title: t.url },
        h('input', { type: 'checkbox', checked: state.selected.has(t.id), 'aria-label': `Select ${t.title}`, onchange: (e) => { if (e.target.checked) state.selected.add(t.id); else state.selected.delete(t.id); renderSelectionBar(); } }),
        g ? h('span', { class: 'group-dot', style: `background:${GROUP_COLORS[g.color] || '#999'}`, title: `Group: ${g.title || '(untitled)'}` }) : null,
        favicon(t),
        h('a', { class: 'tab-title', href: '#', onclick: (e) => { e.preventDefault(); executeTabAction({ type: 'focus_tab', tabId: t.id }).catch((err) => toast(err.message, 'error')); } }, t.title || t.url),
        t.pinned ? h('span', { class: 'chip', title: 'Pinned tabs are never closed unless you tick them yourself' }, '📌') : null,
        dupIds.has(t.id) ? h('span', { class: 'chip warn' }, 'duplicate') : null,
        h('span', { class: 'host' }, hostnameOf(t.url)),
        h('button', { class: 'x', title: t.pinned ? 'Close pinned tab (asks first)' : 'Close tab', 'aria-label': `Close ${t.title}`, onclick: () => closeOne(t) }, '×'));
    })));
  }
}

function renderSelectionBar() {
  clear(els.selectionBar);
  const ids = [...state.selected];
  if (!ids.length) { els.selectionBar.append(h('span', { class: 'muted small' }, 'Tick tabs to group, save, or close them.')); return; }
  els.selectionBar.append(
    h('span', { class: 'small', style: 'align-self:center' }, `${ids.length} selected`),
    h('button', { class: 'btn small', onclick: () => groupSelected() }, 'Group'),
    h('button', { class: 'btn small', onclick: () => saveSelected(false) }, 'Save'),
    h('button', { class: 'btn small', onclick: () => saveSelected(true) }, 'Save & close'),
    h('button', { class: 'btn small danger', onclick: () => proposeAndConfirm({ type: 'close_tabs', tabIds: ids }, { explicit: ids }) }, 'Close'),
    h('button', { class: 'btn link small', onclick: () => { state.selected.clear(); renderList(); } }, 'Clear'),
  );
}

async function closeOne(t) {
  if (t.pinned) return proposeAndConfirm({ type: 'close_tabs', tabIds: [t.id] }, { explicit: [t.id] });
  try { await chrome.tabs.remove(t.id); } catch (err) { toast(err.message, 'error'); }
}

async function askName(title, placeholder) {
  const input = h('input', { type: 'text', placeholder, maxlength: 60 });
  const res = await modal({ title, body: h('div', { class: 'form' }, input), actions: [{ label: 'Cancel', value: null }, { label: 'OK', kind: 'primary', value: () => input.value.trim() || placeholder }] });
  return res;
}

async function groupSelected() {
  const name = await askName('Name this tab group', 'Group');
  if (name === null) return;
  await run({ type: 'group_tabs', tabIds: [...state.selected], title: name }, { explicit: [...state.selected] });
}

async function saveSelected(close) {
  const name = await askName('Name this saved group', 'Research');
  if (name === null) return;
  await proposeAndConfirm({ type: 'save_tabs', tabIds: [...state.selected], name, close }, { explicit: [...state.selected] });
}

async function run(action, { explicit = [], confirmed = false } = {}) {
  try {
    const r = await executeTabAction(action, { explicitTabIds: explicit, confirmed });
    if (r.message) toast(r.message);
    if (r.closed?.length) for (const id of r.closed) state.selected.delete(id);
    await loadAndRender();
    return r;
  } catch (err) {
    toast(err.message, 'error');
    return null;
  }
}

/**
 * Validates an action and, if it closes tabs (or came from the AI), shows the confirmation screen
 * with the exact tabs. The user can untick tabs, and must tick pinned tabs themselves to include them.
 */
async function proposeAndConfirm(action, { explicit = [], fromAI = false, explanation = '' } = {}) {
  const tabs = await chrome.tabs.query({ windowType: 'normal' });
  const saved = await listSavedGroups();
  let concrete = action;
  if (action.type === 'close_duplicate_tabs') {
    const dup = findDuplicateTabs(tabs);
    if (!dup.close.length) { toast('No duplicate tabs found.'); return; }
    concrete = { type: 'close_tabs', tabIds: dup.close.map((t) => t.id) };
    explanation = explanation || `Found ${dup.close.length} duplicate tab(s). One copy of each page (the active or most recently used) will stay open.`;
  }
  // Validate without explicit pinned selections first, so AI-proposed pinned tabs are dropped.
  const v = validateAction(concrete, { tabs, savedGroups: saved, explicitTabIds: explicit });
  if (!v.ok) {
    setStatus(h('div', { class: 'card soft small' }, h('b', { class: 'error' }, fromAI ? 'Satchel\'s AI suggested something it is not allowed to do, so nothing happened: ' : 'Cannot do that: '), v.errors.join(' ')));
    return;
  }
  const a = v.action;
  if (!v.requiresConfirmation && !fromAI) return run(a, { explicit });

  const byId = new Map(tabs.map((t) => [t.id, t]));
  const listed = a.tabIds ? [...a.tabIds] : [];
  // Also show pinned tabs the proposal wanted but that were excluded, unticked, so the user can opt in.
  const excludedPinned = (concrete.tabIds || []).filter((id) => byId.get(id)?.pinned && !listed.includes(id));
  const checks = new Map();
  const row = (id, checked) => {
    const t = byId.get(id);
    const cb = h('input', { type: 'checkbox', checked, 'aria-label': t.title });
    checks.set(id, cb);
    return h('li', {}, cb, favicon(t), h('span', { class: 'tab-title', title: t.url }, t.title || t.url), t.pinned ? h('span', { class: 'chip' }, '📌 pinned') : null, h('span', { class: 'host muted small' }, hostnameOf(t.url)));
  };
  const verb = a.type === 'close_tabs' ? 'Close' : a.type === 'save_tabs' ? (a.close ? 'Save and close' : 'Save') : a.type === 'group_tabs' ? 'Group' : a.type === 'ungroup_tabs' ? 'Ungroup' : 'Do';
  const describe = {
    focus_tab: () => `Switch to “${byId.get(a.tabId)?.title}”`,
    search_tabs: () => `Search tabs for “${a.query}”`,
    reopen_saved_group: () => `Reopen saved group “${saved.find((g) => g.id === a.groupId)?.name}”`,
    none: () => a.reason || 'The AI could not map this to a tab action.',
  };
  const body = h('div', {},
    explanation ? h('p', {}, explanation) : null,
    listed.length || excludedPinned.length ? h('ul', { class: 'confirm-list' }, listed.map((id) => row(id, true)), excludedPinned.map((id) => row(id, false))) : h('p', {}, (describe[a.type] || (() => a.type))()),
    a.type === 'save_tabs' ? h('p', { class: 'muted small' }, `Saved as “${a.name || 'Saved tabs'}”. You can reopen the group from “Saved groups” at any time.`) : null,
    a.type === 'close_tabs' ? h('p', { class: 'muted small' }, 'Closed tabs can also be restored with Ctrl+Shift+T.') : null,
    v.warnings.length ? h('p', { class: 'warn small' }, v.warnings.join(' ')) : null,
    excludedPinned.length ? h('p', { class: 'muted small' }, 'Pinned tabs are unticked. Tick them only if you really want them included.') : null,
  );
  if (a.type === 'none') {
    await modal({ title: 'Nothing to do', body, actions: [{ label: 'OK', value: true, kind: 'primary' }] });
    return;
  }
  if (a.type === 'search_tabs') { els.search.value = a.query; state.query = a.query; renderList(); return; }
  const count = listed.length + excludedPinned.length;
  const ok = await modal({
    title: listed.length ? `${verb} ${listed.length} tab${listed.length === 1 ? '' : 's'}?` : 'Confirm',
    body,
    wide: true,
    actions: [{ label: 'Cancel', value: false }, { label: listed.length ? `${verb} selected tabs` : 'Confirm', value: true, kind: a.type === 'close_tabs' || a.close ? 'danger' : 'primary' }],
  });
  if (!ok) { toast('Cancelled. No tabs were changed.'); return; }
  let final = a;
  if (count) {
    const chosen = [...checks.entries()].filter(([, cb]) => cb.checked).map(([id]) => id);
    if (!chosen.length) { toast('No tabs were ticked, so nothing happened.'); return; }
    final = { ...a, tabIds: chosen };
    // Pinned tabs ticked on this screen count as explicitly chosen by the user.
    explicit = [...new Set([...explicit, ...chosen.filter((id) => byId.get(id)?.pinned)])];
  }
  return run(final, { explicit, confirmed: true });
}

async function runCommand(text) {
  const cmd = String(text || '').trim();
  if (!cmd || state.busy) return;
  const saved = await listSavedGroups();
  const selected = [...state.selected];
  const local = parseTabCommand(cmd, { selectedTabIds: selected, savedGroups: saved });
  if (local) {
    els.command.value = '';
    return proposeAndConfirm(local, { explicit: selected });
  }
  // Ask the AI - only the current window's tab titles and site addresses are sent.
  const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
  const own = chrome.runtime.getURL('');
  const windowTabs = (await chrome.tabs.query(win ? { windowId: win.id } : { currentWindow: true })).filter((t) => !String(t.url).startsWith(own));
  const ok = await confirmSendToAI({ what: `your request and the titles and site addresses of the ${windowTabs.length} tabs in this window`, extra: 'Page contents are not sent, only titles and addresses (without query strings).' });
  if (!ok) return;
  state.busy = true;
  setStatus(spinner('Asking the AI which tabs you mean…'));
  try {
    const list = tabsForPrompt(windowTabs);
    const savedList = saved.map((g) => ({ id: g.id, name: g.name }));
    const r = await chat({
      messages: [
        { role: 'system', content: tabCommandSystemPrompt() },
        { role: 'user', content: `User request: ${cmd}\nTabs the user ticked: ${JSON.stringify(selected)}\nSaved groups: ${escapeForTag(JSON.stringify(savedList))}\n<tabs>\n${escapeForTag(JSON.stringify(list, null, 0))}\n</tabs>` },
      ],
      json: true,
      maxTokens: 600,
      temperature: 0,
    });
    setStatus(null);
    const proposal = r.data?.action;
    els.command.value = '';
    // The AI's proposal is only a suggestion: it is validated and then confirmed by the user.
    await proposeAndConfirm(proposal, { explicit: selected, fromAI: true, explanation: `Satchel understood: ${String(r.data?.explanation || '').slice(0, 200)}` });
  } catch (err) {
    setStatus(h('p', { class: 'error' }, friendlyError(err)));
  } finally {
    state.busy = false;
  }
}

async function renderSaved() {
  const groups = await listSavedGroups();
  clear(els.saved);
  if (!groups.length) { els.saved.append(h('p', { class: 'muted small' }, 'Groups you save appear here so you can reopen them later.')); return; }
  for (const g of groups) {
    const details = h('details', {}, h('summary', {}, `${g.name} · ${g.tabs.length} tab(s) · ${new Date(g.createdAt).toLocaleDateString()}`),
      h('ul', { class: 'small' }, g.tabs.map((t) => h('li', {}, link(t.url, t.title)))));
    els.saved.append(h('div', { class: 'card' }, details, h('div', { class: 'btn-row' },
      h('button', { class: 'btn small primary', onclick: () => run({ type: 'reopen_saved_group', groupId: g.id }) }, 'Reopen'),
      h('button', { class: 'btn small', onclick: async () => { const n = await askName('Rename saved group', g.name); if (n) { await renameSavedGroup(g.id, n); renderSaved(); } } }, 'Rename'),
      h('button', { class: 'btn small', onclick: async () => { await deleteSavedGroup(g.id); toast('Saved group deleted.'); renderSaved(); } }, 'Delete'))));
  }
}
