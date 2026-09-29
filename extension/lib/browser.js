// Thin wrappers over chrome.* for reading pages and finding the user's current tab.
import { extractPageContent, extractAssignmentCandidates } from './extractor.js';
import { isHttpUrl, originPattern, sleep } from './util.js';

const UNSCRIPTABLE_HOSTS = ['chromewebstore.google.com', 'chrome.google.com', 'microsoftedge.microsoft.com'];

/** Why a tab cannot be read, or '' if it probably can. Used so Satchel never pretends to have read a page. */
export function unreadableReason(url) {
  if (!url) return 'This tab has no address Satchel can read.';
  let u;
  try { u = new URL(url); } catch { return 'This tab has no address Satchel can read.'; }
  if (u.protocol === 'file:') return 'Local files are not readable by Satchel.';
  if (!['http:', 'https:'].includes(u.protocol)) return 'Browser pages (settings, new tab, extensions) cannot be read by extensions.';
  if (UNSCRIPTABLE_HOSTS.includes(u.hostname) && (u.hostname !== 'chrome.google.com' || u.pathname.startsWith('/webstore'))) {
    return 'Browser extension stores cannot be read by extensions.';
  }
  if (/\.pdf($|\?)/i.test(u.pathname)) return 'PDF files open in the browser\'s PDF viewer, which extensions cannot read. Copy the text you need into the chat instead.';
  return '';
}

/** The tab the user is looking at: active tab of the last focused normal window (never Satchel's own pages). */
export async function getTargetTab() {
  const ownPrefix = chrome.runtime.getURL('');
  try {
    const win = await chrome.windows.getLastFocused({ populate: true, windowTypes: ['normal'] });
    const active = win?.tabs?.find((t) => t.active);
    if (active && !String(active.url || '').startsWith(ownPrefix)) return active;
  } catch { /* no focused window */ }
  const tabs = await chrome.tabs.query({ windowType: 'normal' });
  const candidates = tabs.filter((t) => !String(t.url || '').startsWith(ownPrefix));
  candidates.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  return candidates.find((t) => t.active) || candidates[0] || null;
}

export function originsFor(urls) {
  return [...new Set(urls.filter(isHttpUrl).map(originPattern))];
}

/**
 * Asks for access to these sites. MUST be called synchronously inside a click handler (before any await),
 * because Chrome only shows permission prompts in response to a user gesture.
 */
export function requestSiteAccess(urls) {
  const origins = originsFor(urls);
  if (!origins.length) return Promise.resolve(true);
  return chrome.permissions.request({ origins });
}

export async function hasSiteAccess(url) {
  if (!isHttpUrl(url)) return false;
  return chrome.permissions.contains({ origins: [originPattern(url)] });
}

async function runInTab(tabId, func, args) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args, world: 'ISOLATED' });
  return res?.result;
}

function explainScriptError(err) {
  const msg = String(err?.message || err);
  if (/Cannot access|permission|host/i.test(msg)) return 'Satchel does not have permission to read this site. Click the button again and choose "Allow".';
  if (/gallery|cannot be scripted/i.test(msg)) return 'This page cannot be read by extensions.';
  if (/No tab with id|closed/i.test(msg)) return 'The tab was closed.';
  if (/Frame with ID 0 was removed|error page/i.test(msg)) return 'The page did not finish loading.';
  return `Satchel could not read this page (${msg}).`;
}

/** Reads a tab's text. Returns {ok:true, page} or {ok:false, reason}; never throws. */
export async function readTab(tab, { maxChars = 400000 } = {}) {
  const reason = unreadableReason(tab.url);
  if (reason) return { ok: false, reason, tab };
  try {
    const page = await runInTab(tab.id, extractPageContent, [{ maxChars }]);
    if (!page) return { ok: false, reason: 'The page returned no content.', tab };
    if (/application\/pdf/i.test(page.contentType)) return { ok: false, reason: unreadableReason('x.pdf') || 'PDF files cannot be read.', tab };
    if (page.textLength < 40) {
      return {
        ok: false,
        reason: page.likelyCanvasApp
          ? 'This page draws its text in a way extensions cannot read (for example Google Docs). Copy the text into the chat instead.'
          : 'Almost no readable text was found on this page (it may still be loading, or be mostly images).',
        tab,
      };
    }
    return { ok: true, page, tab };
  } catch (err) {
    return { ok: false, reason: explainScriptError(err), tab };
  }
}

export async function readAssignmentsInTab(tab) {
  const reason = unreadableReason(tab.url);
  if (reason) return { ok: false, reason };
  try {
    const [page, found] = await Promise.all([
      runInTab(tab.id, extractPageContent, [{ maxChars: 200000 }]),
      runInTab(tab.id, extractAssignmentCandidates, [{}]),
    ]);
    return { ok: true, page, found };
  } catch (err) {
    return { ok: false, reason: explainScriptError(err) };
  }
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve(value);
    };
    const listener = (id, info) => { if (id === tabId && info.status === 'complete') finish(true); };
    const timer = setTimeout(() => finish(false), timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((t) => { if (t.status === 'complete') finish(true); }).catch(() => finish(false));
  });
}

/**
 * Opens a URL in a background tab (so the user's normal signed-in session is used), extracts
 * assignments and text, and closes the tab. Waits a little for script-heavy pages to render.
 */
export async function fetchPageInBackground(url, { timeoutMs = 25000, settleMs = 1500 } = {}) {
  const reason = unreadableReason(url);
  if (reason) return { url, ok: false, reason };
  if (!(await hasSiteAccess(url))) return { url, ok: false, reason: 'Satchel does not have permission to read this site yet. Use "Allow access" on the School tab.' };
  let tab;
  try {
    tab = await chrome.tabs.create({ url, active: false });
    const loaded = await waitForTabComplete(tab.id, timeoutMs);
    if (!loaded) return { url, ok: false, reason: 'The page took too long to load.' };
    let best = null;
    // Pages that render with JavaScript may need a moment; take the reading with the most candidates.
    for (let i = 0; i < 4; i++) {
      await sleep(i === 0 ? settleMs : 1200);
      const current = await chrome.tabs.get(tab.id);
      const r = await readAssignmentsInTab(current);
      if (!r.ok) return { url, ok: false, reason: r.reason };
      if (!best || r.found.candidates.length > best.found.candidates.length) best = { ...r, finalUrl: current.url };
      if (best.found.candidates.length && i >= 1) break;
    }
    const signedOut = best.page?.hasPasswordField && best.found.candidates.length === 0;
    const host = (u) => new URL(u).hostname.replace(/^www\./, '');
    if (signedOut || host(best.finalUrl) !== host(url)) {
      return { url, ok: false, signedOut: true, finalUrl: best.finalUrl, reason: 'It looks like you are signed out of this site (a sign-in page appeared). Sign in in a normal tab, then refresh again.' };
    }
    return { url, ok: true, finalUrl: best.finalUrl, page: best.page, found: best.found };
  } catch (err) {
    return { url, ok: false, reason: explainScriptError(err) };
  } finally {
    if (tab?.id) chrome.tabs.remove(tab.id).catch(() => {});
  }
}
