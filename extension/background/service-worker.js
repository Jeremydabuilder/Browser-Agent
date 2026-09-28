// Satchel background service worker.
// Deliberately minimal: it opens the side panel and runs school-page refreshes that the user starts.
// There is NO background monitoring of browsing: nothing runs unless the user clicks something.
import { fetchPageInBackground } from '../lib/browser.js';

// Clicking the toolbar icon opens the side panel (set on every service worker start; it is cheap).
const openOnClick = () => chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
openOnClick();
chrome.runtime.onInstalled.addListener(openOnClick);
chrome.runtime.onStartup.addListener(openOnClick);

const handlers = {
  // Loads each school page the user chose in a background tab (using their signed-in session),
  // extracts assignments, and closes the tab again.
  async 'school.fetchPages'({ urls }) {
    const results = [];
    for (const url of (urls || []).slice(0, 25)) {
      results.push(await fetchPageInBackground(url));
    }
    return results;
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only accept messages from Satchel's own pages (side panel / options), never from web pages.
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return false;
  const handler = handlers[msg?.cmd];
  if (!handler || !Object.hasOwn(handlers, msg.cmd)) return false;
  handler(msg)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true;
});
