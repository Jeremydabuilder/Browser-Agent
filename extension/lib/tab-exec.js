// Executes VALIDATED tab actions with chrome.tabs / chrome.tabGroups, and manages saved tab groups.
// Closing actions require `confirmed: true`, which only the confirmation screen passes.
import { validateAction } from './actions.js';
import { findDuplicateTabs } from './tabs.js';
import { getItem, setItem } from './storage.js';
import { uid } from './util.js';

const SAVED_KEY = 'savedTabGroups';

export async function listSavedGroups() {
  return getItem(SAVED_KEY, []);
}

export async function deleteSavedGroup(id) {
  await setItem(SAVED_KEY, (await listSavedGroups()).filter((g) => g.id !== id));
}

export async function renameSavedGroup(id, name) {
  const list = await listSavedGroups();
  await setItem(SAVED_KEY, list.map((g) => (g.id === id ? { ...g, name: String(name).trim().slice(0, 80) || g.name } : g)));
}

export async function allTabs() {
  return chrome.tabs.query({ windowType: 'normal' });
}

/** Resolves "close duplicates" into the exact list of tabs the confirmation screen will show. */
export async function previewDuplicates() {
  const tabs = await allTabs();
  return findDuplicateTabs(tabs);
}

export async function executeTabAction(action, { explicitTabIds = [], confirmed = false } = {}) {
  const tabs = await allTabs();
  const savedGroups = await listSavedGroups();
  // Re-validate against the tabs that exist right now (they may have changed since the preview).
  const v = validateAction(action, { tabs, savedGroups, explicitTabIds });
  if (!v.ok) throw new Error(v.errors.join(' '));
  if (v.requiresConfirmation && !confirmed) throw new Error('This action needs your confirmation first.');
  const a = v.action;
  const byId = new Map(tabs.map((t) => [t.id, t]));

  switch (a.type) {
    case 'none':
    case 'search_tabs':
      return { message: '' };
    case 'focus_tab': {
      const t = byId.get(a.tabId);
      await chrome.tabs.update(t.id, { active: true });
      await chrome.windows.update(t.windowId, { focused: true });
      return { message: `Switched to "${t.title}".` };
    }
    case 'group_tabs': {
      const byWindow = new Map();
      for (const id of a.tabIds) {
        const w = byId.get(id).windowId;
        if (!byWindow.has(w)) byWindow.set(w, []);
        byWindow.get(w).push(id);
      }
      for (const [windowId, ids] of byWindow) {
        // Pass the window explicitly: the default ("current window") may be the side panel's window.
        const groupId = await chrome.tabs.group({ tabIds: ids, createProperties: { windowId } });
        await chrome.tabGroups.update(groupId, { title: a.title || 'Satchel group', color: a.color || 'blue' });
      }
      return { message: `Grouped ${a.tabIds.length} tab(s)${a.title ? ` as "${a.title}"` : ''}.` };
    }
    case 'ungroup_tabs':
      await chrome.tabs.ungroup(a.tabIds);
      return { message: `Ungrouped ${a.tabIds.length} tab(s).` };
    case 'close_tabs':
      await chrome.tabs.remove(a.tabIds);
      return { message: `Closed ${a.tabIds.length} tab(s).`, closed: a.tabIds };
    case 'close_duplicate_tabs': {
      const { close } = findDuplicateTabs(tabs);
      const ids = close.map((t) => t.id);
      if (ids.length) await chrome.tabs.remove(ids);
      return { message: ids.length ? `Closed ${ids.length} duplicate tab(s).` : 'No duplicate tabs found.', closed: ids };
    }
    case 'save_tabs': {
      const chosen = a.tabIds.map((id) => byId.get(id));
      const group = {
        id: uid('grp'),
        name: a.name || `Saved tabs ${new Date().toLocaleDateString()}`,
        createdAt: new Date().toISOString(),
        tabs: chosen.map((t) => ({ title: t.title || t.url, url: t.url, pinned: !!t.pinned })),
      };
      await setItem(SAVED_KEY, [group, ...savedGroups]);
      if (a.close) await chrome.tabs.remove(a.tabIds);
      return { message: `Saved ${chosen.length} tab(s) as "${group.name}"${a.close ? ' and closed them' : ''}. Reopen them any time from Saved groups.`, savedGroupId: group.id, closed: a.close ? a.tabIds : [] };
    }
    case 'reopen_saved_group': {
      const group = savedGroups.find((g) => g.id === a.groupId);
      const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null)
        || await chrome.windows.create({ focused: true });
      const created = [];
      for (const t of group.tabs) {
        if (!/^https?:|^file:/i.test(t.url)) continue;
        created.push(await chrome.tabs.create({ url: t.url, active: false, windowId: win.id }));
      }
      if (created.length) {
        const groupId = await chrome.tabs.group({ tabIds: created.map((t) => t.id), createProperties: { windowId: win.id } });
        await chrome.tabGroups.update(groupId, { title: group.name.slice(0, 40), color: 'cyan' });
        await chrome.tabs.update(created[0].id, { active: true });
      }
      return { message: `Reopened ${created.length} tab(s) from "${group.name}".` };
    }
    default:
      throw new Error('Unsupported action.');
  }
}
