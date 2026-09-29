// Satchel background service worker.
// Deliberately minimal: it opens the side panel, runs school-page refreshes that the user starts,
// shows a "REC" badge while a meeting recording (started by the user) is running, and recovers
// recordings interrupted by a closed recorder window or a browser restart.
// There is NO background monitoring of browsing and no background recording: nothing runs unless
// the user clicks something.
import { fetchPageInBackground } from '../lib/browser.js';
import { recoverInterrupted } from '../lib/meetings.js';
import { runTranscriptionJob } from '../lib/transcription-job.js';

const RECORD_MENU_ID = 'satchel-record-tab';

// Clicking the toolbar icon opens the side panel (set on every service worker start; it is cheap).
const setup = () => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: RECORD_MENU_ID, title: 'Record this tab with Satchel…', contexts: ['page', 'frame', 'video', 'audio'], documentUrlPatterns: ['http://*/*', 'https://*/*'] }, () => void chrome.runtime.lastError);
  });
};
setup();
chrome.runtime.onInstalled.addListener(setup);

// After a browser restart no recorder can still be running, so any "recording" meeting was interrupted.
chrome.runtime.onStartup.addListener(() => {
  setup();
  chrome.storage.session.remove('activeRecording');
  recoverInterrupted({ force: true }).catch(() => {});
});

// If the recorder window is closed without pressing Stop, keep what was saved.
chrome.windows.onRemoved.addListener(async (windowId) => {
  const { activeRecording } = await chrome.storage.session.get('activeRecording');
  if (!activeRecording || activeRecording.windowId !== windowId) return;
  await chrome.storage.session.remove('activeRecording');
  await recoverInterrupted({ force: true, onlyIds: [activeRecording.meetingId] }).catch(() => {});
});

// Visible indicator on the toolbar icon while recording.
async function updateBadge() {
  const { activeRecording } = await chrome.storage.session.get('activeRecording');
  const on = activeRecording && (activeRecording.state === 'recording' || activeRecording.state === 'starting');
  await chrome.action.setBadgeText({ text: on ? 'REC' : '' });
  if (on) await chrome.action.setBadgeBackgroundColor({ color: '#e5372b' });
  await chrome.action.setTitle({ title: on ? `Satchel – recording “${activeRecording.title || 'meeting'}”` : 'Open Satchel' });
}
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'session' && changes.activeRecording) updateBadge(); });
updateBadge();

// Right-click → "Record this tab with Satchel…". This counts as invoking the extension on the tab,
// which Chrome requires before an extension may capture a tab's audio. It only opens the Meetings
// view; recording still starts only when the user presses Start there.
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== RECORD_MENU_ID || !tab?.id) return;
  chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
  chrome.storage.session.set({ meetingsIntent: { tabId: tab.id, at: Date.now() } });
});

const handlers = {
  // Meeting transcription the user approved in the side panel; runs here so closing the panel doesn't stop it.
  async 'meeting.transcribe'({ meetingId, onlyFailed }) {
    return runTranscriptionJob(String(meetingId), { onlyFailed: !!onlyFailed });
  },
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
