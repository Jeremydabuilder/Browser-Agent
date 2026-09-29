// Remembers where you were in the sidebar, so closing and reopening it (or restarting the browser)
// brings you back to the same place.
//  - Layout state (open view, Ask scope, open meeting) is not sensitive: chrome.storage.local.
//  - Drafts you were typing may contain private text: chrome.storage.session, cleared when the
//    browser closes, and never sent anywhere.
import { getItem, setItem } from './storage.js';

const STATE_KEY = 'panelState';
const DRAFTS_KEY = 'panelDrafts';
const MAX_DRAFT = 4000;

let stateCache = null;
let draftsCache = null;
const timers = {};

function later(name, fn, ms = 300) {
  clearTimeout(timers[name]);
  timers[name] = setTimeout(fn, ms);
}

export async function loadPanelState() {
  if (!stateCache) stateCache = { ...(await getItem(STATE_KEY, {})) };
  return stateCache;
}

export async function savePanelState(patch) {
  const s = await loadPanelState();
  Object.assign(s, patch);
  await setItem(STATE_KEY, s);
}

export async function loadDraft(name) {
  if (!draftsCache) draftsCache = { ...(await getItem(DRAFTS_KEY, {}, 'session')) };
  return draftsCache[name] || '';
}

/** Saves a draft shortly after typing stops. An empty string removes it. */
export function saveDraft(name, text) {
  later(`draft:${name}`, async () => {
    await loadDraft(name);
    if (text) draftsCache[name] = String(text).slice(0, MAX_DRAFT);
    else delete draftsCache[name];
    await setItem(DRAFTS_KEY, draftsCache, 'session');
  });
}

/** For tests. */
export function resetPanelStateCache() {
  stateCache = null;
  draftsCache = null;
}
