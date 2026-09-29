// "Meetings" view: record a meeting tab or import a recording, transcribe it with Groq (only after you
// approve), review/correct the transcript, and generate editable, grounded notes.
import { h, clear, toast, modal, confirmDialog, spinner, errorBox, costSummary } from '../../lib/ui.js';
import * as store from '../../lib/meeting-store.js';
import { createMeeting, renameMeeting, recoverInterrupted, searchMeetings, meetingStats } from '../../lib/meetings.js';
import { editSegment, transcriptStats } from '../../lib/transcription.js';
import { generateNotes } from '../../lib/meeting-notes.js';
import { describeStopReason, formatClock } from '../../lib/meeting-capture.js';
import { IMPORT_FORMATS, IMPORT_LIMITS, checkImportFile, decodeAndSplit, formatBytes } from '../../lib/audio-chunks.js';
import { notesToMarkdown, notesToText, transcriptToMarkdown, transcriptToText, meetingToMarkdown, meetingToText, safeFileName } from '../../lib/meeting-export.js';
import { chat, providerLabel } from '../../lib/ai.js';
import { getJob, isJobActive } from '../../lib/transcription-job.js';
import { getSettings } from '../../lib/settings.js';
import { getItem } from '../../lib/storage.js';
import { loadPanelState, savePanelState } from '../../lib/panel-state.js';
import { unreadableReason, getTargetTab } from '../../lib/browser.js';
import { hostnameOf } from '../../lib/util.js';

let root;
let app;
const state = { detailId: null, query: '', busy: false, pickerFallback: null, highlight: null, form: { titleEdited: false }, formEl: null };

export function init(container, appRef) {
  root = container;
  app = appRef;
  app.onTargetTab(() => {
    if (root.hidden || state.detailId || state.busy) return;
    // The form is persistent, so this only updates what it says it will capture.
    state.refreshRecordTarget?.();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes.activeRecording && !root.hidden) renderBanner();
    // A recording just ended: refresh the list, but never redraw the form while the user is typing in it.
    if (area === 'session' && changes.activeRecording && !changes.activeRecording.newValue && !root.hidden && !state.busy) {
      setTimeout(() => { if (state.detailId) render(); else refreshList(); }, 500);
    }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes.transcriptionJob) onJobChange(changes.transcriptionJob.newValue);
  });
  setInterval(tickBanner, 1000);
}

export async function show() {
  await recover();
  if (!state.restored) {
    // Reopen the meeting you were looking at last time (if it still exists).
    state.restored = true;
    const saved = await loadPanelState();
    if (saved.meetingId && !state.detailId && await store.getMeeting(saved.meetingId)) state.detailId = saved.meetingId;
  }
  render();
}

/** Opens a meeting (or the list, with null) and remembers it for next time. */
export function openMeeting(id) {
  state.restored = true;
  state.detailId = id || null;
  savePanelState({ meetingId: state.detailId });
  render();
}

async function recover() {
  const active = await getItem('activeRecording', null, 'session');
  await recoverInterrupted({
    isAlive: async (m) => {
      if (!active || active.meetingId !== m.id || !active.windowId) return false;
      try { await chrome.windows.get(active.windowId); return true; } catch { return false; }
    },
  }).catch(() => {});
}

function download(name, text, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

// ---------------------------------------------------------------- rendering
// The new-meeting form is created once and kept in the page, so redraws (tab switches, a recording
// ending) never replace the field you are typing in. Only the banner, list, and detail page are rebuilt;
// they are built off-screen and swapped in, and an older redraw that finishes late is dropped.
let renderSeq = 0;
let bannerInfo = null;
async function render() {
  const my = ++renderSeq;
  if (state.detailId) {
    const out = h('div');
    out.append(h('div', { id: 'rec-banner' }));
    await renderDetail(state.detailId, out);
    if (my !== renderSeq) return;
    clear(root);
    root.append(...out.childNodes);
    await renderBanner();
    if (state.highlight) root.querySelector(`#seg-${CSS.escape(state.highlight)}`)?.scrollIntoView({ block: 'center' });
    return;
  }
  const form = newMeetingForm();
  const list = await renderList();
  if (my !== renderSeq) return;
  if (root.contains(form)) {
    root.querySelector('#mtg-list-wrap')?.replaceWith(list);
  } else {
    clear(root);
    root.append(h('div', { id: 'rec-banner' }), form, list);
  }
  await renderBanner();
}

async function renderBanner() {
  const el = root.querySelector('#rec-banner');
  if (!el) return;
  bannerInfo = await getItem('activeRecording', null, 'session');
  clear(el);
  if (!bannerInfo) return;
  const a = bannerInfo;
  el.append(h('div', { class: 'rec-banner', role: 'status' },
    h('span', { class: 'rec-dot', 'aria-hidden': 'true' }),
    h('div', { class: 'grow' },
      h('b', {}, a.state === 'recording' ? 'Recording' : a.state === 'stopping' ? 'Saving…' : 'Starting…', ' ', h('span', { class: 'rec-timer' }, a.startedAt ? formatClock((Date.now() - a.startedAt) / 1000) : '')),
      h('div', { class: 'small' }, a.title, ' · ', a.sources?.mic ? 'meeting tab + your microphone' : 'meeting tab audio only')),
    h('button', { class: 'btn small', onclick: () => chrome.windows.update(a.windowId, { focused: true }).catch(() => {}) }, 'Show recorder'),
    a.state === 'recording' ? h('button', { class: 'btn small danger', onclick: () => chrome.runtime.sendMessage({ cmd: 'meeting.stop', meetingId: a.meetingId }).catch(() => {}) }, '■ Stop') : null));
}

function tickBanner() {
  const t = root?.querySelector('.rec-timer');
  if (t && bannerInfo?.startedAt) t.textContent = formatClock((Date.now() - bannerInfo.startedAt) / 1000);
}

function defaultTitle(tab) {
  return tab && !unreadableReason(tab.url) ? `${(tab.title || hostnameOf(tab.url)).slice(0, 60)} – ${new Date().toLocaleDateString()}` : '';
}

/** Returns the persistent new-meeting form, creating it on first use and refreshing it afterwards. */
function newMeetingForm() {
  if (state.formEl) {
    state.refreshRecordTarget();
    return state.formEl;
  }
  let tab = app.targetTab;
  let reason = tab ? unreadableReason(tab.url) : 'No tab is open.';
  const f = state.form;
  // The default title follows the current tab until you edit it.
  const title = h('input', { type: 'text', value: defaultTitle(tab), 'aria-label': 'New recording title' });
  title.addEventListener('input', () => { f.titleEdited = true; });
  const mic = h('input', { type: 'checkbox', id: 'mtg-mic' });
  const consent = h('input', { type: 'checkbox', id: 'mtg-consent' });
  const captured = h('ul', { class: 'small' });
  const warning = h('div');
  const fallbackSlot = h('div');
  let startBtn = null;
  const updateCaptured = () => {
    clear(captured);
    clear(warning);
    if (reason) warning.append(h('p', { class: 'warn small' }, `The current tab can't be recorded: ${reason} Switch to the tab that has your meeting (Google Meet, Zoom or Teams in the browser, etc.).`));
    if (startBtn) startBtn.disabled = !!reason;
    captured.append(h('li', {}, '🔊 Everything you hear in the tab ', h('b', {}, tab && !reason ? `“${(tab.title || '').slice(0, 50)}”` : '(no tab)'), ': other participants and any shared audio.'));
    captured.append(h('li', {}, mic.checked ? '🎙 Your microphone (use headphones to avoid echo).' : '🎙 Your microphone is NOT recorded, so your own voice will be missing unless the meeting plays it back.'));
    captured.append(h('li', { class: 'muted' }, 'Not captured: other tabs, desktop apps (such as the Zoom app), your screen, or video.'));
  };
  mic.addEventListener('change', updateCaptured);
  state.refreshRecordTarget = () => {
    tab = app.targetTab;
    reason = tab ? unreadableReason(tab.url) : 'No tab is open.';
    if (!f.titleEdited && document.activeElement !== title) title.value = defaultTitle(tab);
    updateCaptured();
    clear(fallbackSlot);
    if (state.pickerFallback) fallbackSlot.append(renderPickerFallback());
  };
  // After a recording starts, clear the form in place (consent is confirmed again for each recording).
  state.resetForm = () => {
    f.titleEdited = false;
    title.value = defaultTitle(app.targetTab);
    mic.checked = false;
    consent.checked = false;
    state.refreshRecordTarget();
  };
  const recordCard = h('details', { class: 'card', open: true },
    h('summary', {}, '⏺ Record a meeting in a browser tab'),
    warning,
    h('label', {}, 'Title'), title,
    h('div', { class: 'small', style: 'margin-top:6px' }, h('b', {}, 'What will be recorded')), captured,
    h('label', { class: 'check' }, mic, ' Also record my microphone'),
    h('label', { class: 'check small' }, consent, ' I have told the other participants that I am recording and have their consent where it is required (laws and school rules differ).'),
    h('div', { class: 'btn-row' }, startBtn = h('button', { class: 'btn primary', disabled: !!reason, onclick: () => startRecording({ title: title.value, mic: mic.checked, consent: consent.checked }) }, '⏺ Start recording')),
    fallbackSlot,
    h('p', { class: 'muted small' }, 'Recording starts only when you press Start, runs in a small visible recorder window, and shows REC on the Satchel icon. Audio stays on this computer unless you later choose to send it to Groq for transcription.'));
  updateCaptured();

  const file = h('input', { type: 'file', accept: 'audio/*,video/*,.m4a,.mp4,.mp3,.wav,.webm,.ogg,.flac', 'aria-label': 'Recording file' });
  const importTitle = h('input', { type: 'text', placeholder: 'Title (defaults to the file name)', 'aria-label': 'Imported meeting title' });
  const importStatus = h('div');
  const importCard = h('details', { class: 'card' },
    h('summary', {}, '⬆ Import a recording (Zoom app, phone, etc.)'),
    h('p', { class: 'small' }, 'Supported: ', IMPORT_FORMATS.map((x) => x.label).join(', '), '.'),
    h('p', { class: 'muted small' }, `Limits: up to ${formatBytes(IMPORT_LIMITS.maxFileBytes)} and ${IMPORT_LIMITS.maxDurationSec / 3600} hours per file (the file is decoded in this browser). For a Zoom desktop recording, choose the “audio_only.m4a” file in Documents\\Zoom\\<meeting folder> (it is much smaller than the MP4). Satchel cannot record the Zoom desktop app, or other desktop apps, live.`),
    file, importTitle,
    h('div', { class: 'btn-row' }, h('button', { class: 'btn primary', onclick: () => importRecording(file.files[0], importTitle.value, importStatus) }, 'Import')),
    importStatus);
  state.formEl = h('div', {}, recordCard, importCard);
  return state.formEl;
}

function renderPickerFallback() {
  const fb = state.pickerFallback;
  return h('div', { class: 'card soft small' },
    h('p', {}, h('b', {}, 'Chrome needs one more step. '), 'Browsers only let an extension capture a tab after you invoke the extension on that tab. Do one of these, then press Start again:'),
    h('ul', {},
      h('li', {}, 'Click the Satchel toolbar icon while the meeting tab is showing (or press Alt+Shift+S).'),
      h('li', {}, 'Or right-click on the meeting page and choose “Record this tab with Satchel…”.')),
    h('p', {}, 'Or use the browser\'s tab picker instead. You choose the meeting tab and tick “Also share tab audio”:'),
    h('button', { class: 'btn', onclick: () => openRecorder({ ...fb, mode: 'pick' }) }, 'Use the tab picker instead'));
}

async function refreshList() {
  const results = root.querySelector('#mtg-results');
  if (!results) return;
  const fresh = await renderResults();
  clear(results);
  results.append(fresh);
}

async function renderList() {
  const wrap = h('div');
  const search = h('input', { type: 'search', value: state.query, placeholder: 'Search meetings, transcripts and notes', 'aria-label': 'Search meetings' });
  let t;
  search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(async () => { state.query = search.value; clear(results); results.append(await renderResults()); }, 250); });
  const results = h('div', { id: 'mtg-results' });
  results.append(await renderResults());
  wrap.id = 'mtg-list-wrap';
  wrap.append(h('h3', { style: 'margin-top:14px' }, 'Your meetings'), search, results);
  return wrap;
}

async function renderResults() {
  const found = await searchMeetings(state.query);
  if (!found.length) return h('p', { class: 'empty' }, state.query ? 'No meetings match.' : 'No meetings yet.');
  const box = h('div');
  for (const { meeting: m, where, snippet } of found) {
    const chunks = await store.listChunks(m.id);
    const st = transcriptStats(chunks);
    const audio = chunks.reduce((n, c) => n + (c.hasAudio ? store.dataSize(c.data) : 0), 0);
    box.append(h('button', { class: 'mtg-row', onclick: () => { openMeeting(m.id); } },
      h('div', { class: 'mtg-title' }, m.title),
      h('div', { class: 'asg-meta' },
        h('span', {}, new Date(m.createdAt).toLocaleString()),
        m.durationSec ? h('span', { class: 'chip' }, formatClock(m.durationSec)) : null,
        statusChip(m),
        audio ? h('span', { class: 'chip' }, `audio ${formatBytes(audio)}`) : null,
        st.done ? h('span', { class: `chip ${st.complete ? 'ok' : 'warn'}` }, `transcript ${st.done}/${st.total}`) : null,
        m.notes ? h('span', { class: 'chip ok' }, 'notes') : null),
      snippet ? h('div', { class: 'muted small' }, `${where}: ${snippet}`) : null));
  }
  return box;
}

function statusChip(m) {
  const map = {
    recording: ['danger', '● recording'], importing: ['warn', 'importing'], interrupted: ['warn', 'interrupted – audio kept'],
    failed: ['danger', 'failed'], recorded: ['', m.source === 'import' ? 'imported' : 'recorded'],
  };
  const [cls, text] = map[m.status] || ['', m.status];
  return h('span', { class: `chip ${cls}` }, text);
}

// ---------------------------------------------------------------- recording
async function startRecording({ title, mic, consent }) {
  if (!consent) { toast('Please confirm you have told participants and have their consent where required.', 'error'); return; }
  if (bannerInfo) { toast('A recording is already running. Stop it first.', 'error'); return; }
  // Look up the tab you are viewing right now (the cached one can be a moment out of date).
  const tab = await getTargetTab().catch(() => null);
  if (!tab || unreadableReason(tab.url)) { toast('Switch to the browser tab that has your meeting first.', 'error'); return; }
  if (tab.id !== app.targetTab?.id) app.refreshTarget();
  // Works once Satchel has been invoked on this tab (toolbar icon, Alt+Shift+S, or right-click menu).
  chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }).then(
    (streamId) => openRecorder({ tab, title, mic, mode: 'tab', streamId }),
    (err) => {
      const msg = String(err?.message || err);
      if (/invoked|activeTab/i.test(msg)) {
        state.pickerFallback = { tab, title, mic };
        render();
      } else if (/invalid tab|no tab with id/i.test(msg)) {
        toast('That tab is no longer open. Switch to your meeting tab and press Start again.', 'error');
        app.refreshTarget();
      } else if (/active stream|already/i.test(msg)) {
        toast('This tab is already being captured. Stop the other capture first.', 'error');
      } else {
        toast(`Could not capture this tab: ${msg}`, 'error');
      }
    },
  );
}

async function openRecorder({ tab, title, mic, mode, streamId = '' }) {
  state.pickerFallback = null;
  state.resetForm?.();
  const meeting = await createMeeting({
    title,
    source: 'tab',
    sourceInfo: { tabTitle: (tab?.title || '').slice(0, 120), site: hostnameOf(tab?.url || ''), mode },
    captureSources: { tab: true, mic },
  });
  const url = chrome.runtime.getURL(`meetings/recorder.html?${new URLSearchParams({ meetingId: meeting.id, mode, mic: mic ? '1' : '0', streamId })}`);
  await chrome.windows.create({ url, type: 'popup', width: 380, height: mode === 'pick' ? 420 : 340, focused: true });
  render();
}

// ---------------------------------------------------------------- import
async function importRecording(file, title, statusEl) {
  if (!file) { toast('Choose a file first.', 'error'); return; }
  const problem = checkImportFile(file);
  if (problem) { clear(statusEl); statusEl.append(h('p', { class: 'warn small' }, problem)); return; }
  if (state.busy) return;
  state.busy = true;
  const { importChunkSec } = await getSettings();
  const meeting = await createMeeting({ title: title || file.name.replace(/\.[^.]+$/, ''), source: 'import', sourceInfo: { fileName: file.name.slice(0, 120), fileSize: file.size, mime: file.type } });
  const show = (msg) => { clear(statusEl); statusEl.append(spinner(msg)); };
  try {
    const r = await decodeAndSplit(file, {
      chunkSec: importChunkSec,
      onProgress: show,
      onChunk: async (c) => {
        const data = new Blob([c.bytes], { type: c.mime });
        await store.putChunk({ meetingId: meeting.id, index: c.index, startSec: c.startSec, durationSec: c.durationSec, mime: c.mime, data, size: data.size, hasAudio: true, status: 'pending', attempts: 0 });
        await store.updateMeeting(meeting.id, { lastHeartbeat: new Date().toISOString(), durationSec: c.startSec + c.durationSec });
      },
    });
    await store.updateMeeting(meeting.id, { status: 'recorded', durationSec: r.durationSec });
    state.busy = false;
    toast(`Imported ${formatClock(r.durationSec)} of audio in ${r.chunkCount} part(s). Nothing has been sent anywhere yet.`);
    openMeeting(meeting.id);
  } catch (err) {
    const saved = await store.listChunks(meeting.id);
    if (!saved.length) await store.deleteMeeting(meeting.id);
    else await store.updateMeeting(meeting.id, { status: 'interrupted', error: err.message });
    clear(statusEl);
    statusEl.append(h('p', { class: 'warn small' }, err.message));
  } finally {
    state.busy = false;
  }
}

// ---------------------------------------------------------------- detail
async function renderDetail(id, out) {
  const m = await store.getMeeting(id);
  if (!m) { state.detailId = null; out.append(newMeetingForm(), await renderList()); return; }
  const stats = await meetingStats(id);
  const tstats = transcriptStats(stats.chunks);
  const status = h('div', { id: 'mtg-status' });

  const titleInput = h('input', { type: 'text', value: m.title, 'aria-label': 'Meeting title', class: 'title-input' });
  titleInput.addEventListener('change', async () => { try { await renameMeeting(id, titleInput.value); toast('Renamed.'); } catch (e) { toast(e.message, 'error'); } });

  out.append(
    h('button', { class: 'btn link small', onclick: () => openMeeting(null) }, '← All meetings'),
    titleInput,
    h('div', { class: 'asg-meta' }, h('span', {}, new Date(m.createdAt).toLocaleString()), m.durationSec ? h('span', { class: 'chip' }, formatClock(m.durationSec)) : null, statusChip(m),
      m.source === 'import' ? h('span', { class: 'chip' }, `file: ${m.sourceInfo?.fileName || ''}`) : h('span', { class: 'chip' }, m.captureSources?.mic ? 'tab + microphone' : 'tab audio only')),
    m.stopReason && m.stopReason !== 'user' ? h('p', { class: 'warn small' }, describeStopReason(m.stopReason)) : null,
    m.error ? h('p', { class: 'warn small' }, m.error) : null,
    ...(m.warnings || []).map((w) => h('p', { class: 'warn small' }, w)),
    status,
  );
  if (m.status === 'recording') {
    out.append(h('p', { class: 'notice' }, 'This meeting is still being recorded. Stop it in the recorder window first.'));
    return;
  }

  // 1. Audio
  const audioCard = h('div', { class: 'card' }, h('h3', {}, '1. Audio', h('span', { class: 'muted small' }, stats.hasAudio ? ` · ${formatBytes(stats.audioBytes)} stored on this computer` : ' · deleted')));
  const partList = h('ul', { class: 'parts' });
  for (const c of stats.chunks) {
    const player = h('span');
    partList.append(h('li', {},
      h('span', {}, `Part ${c.index + 1} · ${formatClock(c.startSec)}–${formatClock(c.startSec + c.durationSec)}${c.partial ? ' (saved after interruption)' : ''}`),
      h('span', { class: `chip ${c.status === 'done' ? 'ok' : c.status === 'failed' || c.status === 'no-audio' ? 'danger' : ''}` }, { done: 'transcribed', pending: 'not transcribed', failed: 'failed', transcribing: 'in progress', 'no-audio': 'audio deleted' }[c.status] || c.status),
      c.hasAudio ? h('button', { class: 'btn link small', onclick: () => { clear(player); const url = URL.createObjectURL(c.data); player.append(h('audio', { controls: true, src: url, class: 'part-audio' })); } }, '▶ Play') : null,
      player,
      c.error ? h('div', { class: 'error small' }, c.error) : null));
  }
  const job = await getJob();
  const running = isJobActive(job) && job.meetingId === id;
  const sttLabel = providerLabel((await getSettings()).transcriptionProvider);
  const hasPending = !running && stats.chunks.some((c) => c.status !== 'done' && c.hasAudio);
  const hasFailed = !running && stats.chunks.some((c) => c.status === 'failed' && c.hasAudio);
  audioCard.append(stats.chunks.length ? partList : h('p', { class: 'muted small' }, 'No audio parts were saved.'),
    running ? spinner(`${job.message || 'Transcribing…'} (continues if you close the side panel)`) : null,
    h('div', { class: 'btn-row' },
      hasPending ? h('button', { class: 'btn primary', onclick: () => transcribeMeeting(m, stats, { onlyFailed: false }) }, tstats.done ? 'Resume transcription…' : `Transcribe with ${sttLabel}…`) : null,
      hasFailed ? h('button', { class: 'btn', onclick: () => transcribeMeeting(m, stats, { onlyFailed: true }) }, 'Retry failed parts') : null,
      stats.hasAudio ? h('button', { class: 'btn small', onclick: async () => { if (await confirmDialog({ title: 'Delete raw audio?', message: 'The audio parts are deleted from this computer. The transcript and notes are kept. Parts that were not transcribed yet can no longer be transcribed.', confirmLabel: 'Delete audio', danger: true })) { await store.deleteAudio(id); render(); } } }, 'Delete raw audio') : null));
  out.append(audioCard);

  // 2. Transcript
  const segs = stats.segments;
  const tCard = h('div', { class: 'card', id: 'transcript-card' }, h('h3', {}, '2. Transcript', h('span', { class: 'muted small' }, tstats.total ? ` · ${tstats.done} of ${tstats.total} part(s) transcribed` : '')));
  if (!stats.hasTranscript) {
    tCard.append(h('p', { class: 'muted small' }, 'No transcript yet. Transcription sends the audio to Groq only after you approve it.'));
  } else {
    const find = h('input', { type: 'search', placeholder: 'Find in transcript', 'aria-label': 'Find in transcript' });
    const lines = h('div', { class: 'transcript' });
    const drawLines = () => {
      clear(lines);
      const q = find.value.trim().toLowerCase();
      for (const s of segs) {
        if (q && !(s.text || '').toLowerCase().includes(q)) continue;
        if (s.gap) { lines.append(h('div', { class: 'seg gap small' }, `[${formatClock(s.start)}–${formatClock(s.end)}] missing: ${s.gapReason}`)); continue; }
        const ta = h('textarea', { rows: Math.max(1, Math.ceil(s.text.length / 48)), 'aria-label': `Transcript at ${formatClock(s.start)}` });
        ta.value = s.text;
        ta.addEventListener('change', async () => { await editSegment(id, s.id, ta.value); s.text = ta.value; toast('Correction saved.'); });
        lines.append(h('div', { class: `seg ${state.highlight === s.id ? 'hl' : ''}`, id: `seg-${s.id}` }, h('span', { class: 'ts' }, `${s.approxTime ? '~' : ''}${formatClock(s.start)}`), ta, s.edited ? h('span', { class: 'chip', title: 'You corrected this line' }, 'edited') : null));
      }
    };
    find.addEventListener('input', drawLines);
    drawLines();
    tCard.append(
      tstats.complete ? null : h('p', { class: 'warn small' }, `${tstats.total - tstats.done} part(s) are not transcribed. They appear as gaps.`),
      h('p', { class: 'muted small' }, 'Read through and correct names or words. Edits are saved as you go. Notes are generated from this corrected text.'),
      find, lines,
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn primary', onclick: () => makeNotes(m, segs, tstats) }, m.notes ? 'Regenerate notes…' : 'I reviewed the transcript: generate notes…'),
        h('button', { class: 'btn small', onclick: async () => download(safeFileName(`${m.title} transcript`, 'md'), transcriptToMarkdown(await store.getMeeting(id), (await meetingStats(id)).segments, { withAnchors: false }), 'text/markdown') }, 'Export .md'),
        h('button', { class: 'btn small', onclick: async () => download(safeFileName(`${m.title} transcript`, 'txt'), transcriptToText(await store.getMeeting(id), (await meetingStats(id)).segments)) }, 'Export .txt'),
        h('button', { class: 'btn small', onclick: async () => { if (await confirmDialog({ title: 'Delete transcript?', message: 'All transcript text (including your corrections) is deleted. Audio and notes are kept; you can transcribe again while the audio exists.', confirmLabel: 'Delete transcript', danger: true })) { await store.deleteTranscript(id); render(); } } }, 'Delete transcript')));
  }
  out.append(tCard);

  // 3. Notes
  out.append(renderNotes(m, segs));

  out.append(h('div', { class: 'btn-row', style: 'margin-top:16px' },
    h('button', { class: 'btn small', onclick: async () => download(safeFileName(m.title, 'md'), meetingToMarkdown(await store.getMeeting(id), (await store.getMeeting(id)).notes, (await meetingStats(id)).segments), 'text/markdown') }, 'Export everything .md'),
    h('button', { class: 'btn small', onclick: async () => download(safeFileName(m.title, 'txt'), meetingToText(await store.getMeeting(id), (await store.getMeeting(id)).notes, (await meetingStats(id)).segments)) }, 'Export everything .txt'),
    h('button', { class: 'btn small danger', onclick: async () => { if (await confirmDialog({ title: 'Delete this meeting?', message: 'Audio, transcript and notes are all deleted from this computer.', confirmLabel: 'Delete meeting', danger: true })) { await store.deleteMeeting(id); openMeeting(null); toast('Meeting deleted.'); } } }, 'Delete meeting')));
}

function setStatus(node) {
  const el = root.querySelector('#mtg-status');
  if (el) { clear(el); if (node) el.append(node); }
}

/** Cost/guard summary shown on approval screens. Returns {lines, blocked}. */
async function transcribeMeeting(m, stats, { onlyFailed }) {
  if (state.busy) return;
  if (isJobActive(await getJob())) { toast('A transcription is already running. Wait for it to finish.', 'error'); return; }
  const todo = stats.chunks.filter((c) => c.hasAudio && (onlyFailed ? c.status === 'failed' : c.status !== 'done'));
  const seconds = todo.reduce((n, c) => n + c.durationSec, 0);
  const minutes = Math.round(seconds / 60);
  const bytes = todo.reduce((n, c) => n + store.dataSize(c.data), 0);
  const cost = await costSummary({ task: 'transcription', seconds });
  const label = providerLabel(cost.provider);
  const ok = await modal({
    title: `Send audio to ${label}?`,
    body: h('div', { class: 'consent' },
      h('p', {}, `Satchel will send ${todo.length} audio part(s) (about ${minutes || '<1'} minute(s), ${formatBytes(bytes)}) of “${m.title}” to ${label} for transcription, through the Satchel companion on your PC.`),
      cost.lines,
      h('p', { class: 'small' }, `${label} converts the speech to text. The audio stays stored on this computer; delete it any time with “Delete raw audio”.`),
      h('p', { class: 'muted small' }, 'Parts are sent one at a time, in order, and it keeps going if you close the side panel. If one fails, the others are kept and you can retry just that part.')),
    actions: [{ label: 'Cancel', value: false }, { label: `Send audio to ${label}`, value: true, kind: 'primary', disabled: cost.blocked }],
  });
  if (!ok) return;
  await store.updateMeeting(m.id, (cur) => ({ consent: { ...cur.consent, audioApprovedAt: new Date().toISOString() } }));
  setStatus(spinner('Starting transcription…'));
  // Runs in the background service worker so closing the side panel doesn't stop it.
  chrome.runtime.sendMessage({ cmd: 'meeting.transcribe', meetingId: m.id, onlyFailed }).catch(() => {});
}

/** Shows background transcription progress and the final result for the open meeting. */
async function onJobChange(job) {
  if (!job || job.meetingId !== state.detailId || root.hidden) return;
  if (job.state === 'running') { setStatus(spinner(job.message || 'Transcribing…')); return; }
  await render();
  if (job.state === 'error') { setStatus(errorBox(job.message, job.code)); return; }
  const r = job.result || {};
  const label = providerLabel((await getSettings()).transcriptionProvider);
  const msg = r.fatal ? r.fatal
    : r.stoppedForRateLimit ? `${label}'s rate limit was reached after ${r.done} part(s). Your progress is saved; press “Resume transcription” later.`
      : r.failed ? `${r.done} part(s) transcribed, ${r.failed} failed. Press “Retry failed parts” to try them again.`
        : `Transcribed ${r.done} part(s). Please review the transcript before generating notes.`;
  setStatus(r.failed || r.fatal ? errorBox(msg, r.fatalCode) : h('p', { class: 'notice' }, msg));
}

async function makeNotes(m, segs, tstats) {
  if (state.busy) return;
  const words = segs.filter((s) => !s.gap).reduce((n, s) => n + s.text.split(/\s+/).length, 0);
  const cost = await costSummary({ task: 'chat', words });
  const label = providerLabel(cost.provider);
  const ok = await modal({
    title: `Send the transcript to ${label}?`,
    body: h('div', { class: 'consent' },
      h('p', {}, `Satchel will send the corrected transcript of “${m.title}” (about ${words.toLocaleString()} words) to ${label} to write notes.`),
      cost.lines,
      tstats.complete ? null : h('p', { class: 'warn small' }, `${tstats.total - tstats.done} part(s) are missing from the transcript, so the notes will not cover them.`),
      h('p', { class: 'muted small' }, 'Notes are saved only with this meeting. Nothing is added to Satchel\'s memory.'),
      m.notes ? h('p', { class: 'warn small' }, 'Regenerating replaces the current notes, including your edits.') : null),
    actions: [{ label: 'Cancel', value: false }, { label: `Send transcript to ${label}`, value: true, kind: 'primary', disabled: cost.blocked }],
  });
  if (!ok) return;
  state.busy = true;
  setStatus(spinner('Writing notes…'));
  try {
    const settings = await getSettings();
    const notes = await generateNotes({
      segments: segs,
      title: m.title,
      meetingDate: new Date(m.createdAt),
      dateOrder: settings.dateOrder,
      maxChars: Math.floor(settings.maxInputTokens * 4 * 0.8),
      chat,
      onStatus: (s) => setStatus(spinner(s)),
    });
    await store.updateMeeting(m.id, (cur) => ({ notes, transcriptReviewedAt: new Date().toISOString(), consent: { ...cur.consent, transcriptApprovedAt: new Date().toISOString() } }));
    state.busy = false;
    await render();
    root.querySelector('#notes-card')?.scrollIntoView({ block: 'start' });
  } catch (err) {
    state.busy = false;
    setStatus(errorBox(err));
  } finally {
    state.busy = false;
  }
}

// ---------------------------------------------------------------- notes editor
function renderNotes(m, segs) {
  const card = h('div', { class: 'card', id: 'notes-card' }, h('h3', {}, '3. Notes'));
  if (!m.notes) {
    card.append(h('p', { class: 'muted small' }, 'Notes appear here after you review the transcript and generate them.'));
    return card;
  }
  const notes = structuredClone(m.notes);
  const save = async () => { await store.updateMeeting(m.id, { notes }); saved.textContent = `Saved ${new Date().toLocaleTimeString()}`; };
  const saved = h('span', { class: 'muted small' });
  const segIds = new Set(segs.map((s) => s.id));
  const refChips = (refs) => (refs || []).map((r) => h('button', {
    class: 'chip ts-link',
    title: segIds.has(r.id) ? 'Show this moment in the transcript' : 'This transcript line no longer exists',
    onclick: () => { state.highlight = r.id; const el = root.querySelector(`#seg-${CSS.escape(r.id)}`); if (el) { root.querySelectorAll('.seg.hl').forEach((x) => x.classList.remove('hl')); el.classList.add('hl'); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } },
  }, `⏱ ${formatClock(r.start)}`));
  const reviewChips = (it) => (it.review || []).map((r) => h('div', { class: 'warn small review' }, '⚠ Review: ', r));

  const summary = h('textarea', { rows: 4, 'aria-label': 'Summary' });
  summary.value = notes.summary || '';
  summary.addEventListener('change', () => { notes.summary = summary.value; save(); });
  card.append(h('label', {}, 'Summary'), summary);

  const listSection = (title, key, fields) => {
    const box = h('div', { class: 'notes-section' });
    const draw = () => {
      clear(box);
      box.append(h('h4', { class: 'section-label' }, title));
      if (!notes[key].length) box.append(h('p', { class: 'muted small' }, key === 'decisions' ? 'No decisions were clearly stated in the transcript.' : key === 'actionItems' ? 'No action items were clearly stated.' : 'None.'));
      notes[key].forEach((it, i) => {
        const inputs = fields.map((f) => {
          const inp = h('input', { type: 'text', value: it[f.name] || '', placeholder: f.placeholder, 'aria-label': `${title} ${f.placeholder}`, class: f.cls || '' });
          inp.addEventListener('change', () => { it[f.name] = inp.value.trim(); if (f.name === 'owner' || f.name === 'due') it.review = (it.review || []).filter((r) => !r.includes(f.name === 'owner' ? 'owner' : 'due date')); save(); });
          // Owner/due keep a visible label so filled-in values are still clear.
          return f.label ? h('label', { class: `mini ${f.cls || ''}` }, f.label, inp) : inp;
        });
        const doneBox = key === 'actionItems' ? h('input', { type: 'checkbox', checked: it.done, title: 'Done', onchange: (e) => { it.done = e.target.checked; save(); } }) : null;
        box.append(h('div', { class: 'note-item' }, doneBox, h('div', { class: 'grow' }, inputs, h('div', {}, refChips(it.refs)), reviewChips(it)),
          h('button', { class: 'btn link small', title: 'Remove', 'aria-label': 'Remove item', onclick: () => { notes[key].splice(i, 1); save(); draw(); } }, '✕')));
      });
      box.append(h('button', { class: 'btn link small', onclick: () => { notes[key].push(Object.fromEntries([...fields.map((f) => [f.name, '']), ['refs', []], ['review', []], ['done', false]])); draw(); } }, `+ Add ${title.toLowerCase().replace(/s$/, '')}`));
    };
    draw();
    return box;
  };
  card.append(
    listSection('Key points', 'keyPoints', [{ name: 'text', placeholder: 'Key point' }]),
    listSection('Decisions', 'decisions', [{ name: 'text', placeholder: 'Decision' }]),
    listSection('Action items', 'actionItems', [{ name: 'task', placeholder: 'Task' }, { name: 'owner', placeholder: 'Owner (only if stated)', cls: 'half', label: 'Owner' }, { name: 'due', placeholder: 'Due (only if stated)', cls: 'half', label: 'Due' }]),
    listSection('Open questions', 'openQuestions', [{ name: 'text', placeholder: 'Question' }]),
  );
  if (notes.dropped?.length) {
    card.append(h('details', { class: 'small' }, h('summary', {}, `${notes.dropped.length} AI suggestion(s) left out because the transcript doesn't support them`),
      h('ul', {}, notes.dropped.map((d) => h('li', {}, `${d.kind}: “${d.text}”. ${d.why}`)))));
  }
  for (const n of notes.notices || []) card.append(h('p', { class: 'notice' }, n));
  card.append(
    h('div', { class: 'btn-row' },
      saved,
      h('button', { class: 'btn small', onclick: async () => download(safeFileName(`${m.title} notes`, 'md'), notesToMarkdown(await store.getMeeting(m.id), notes), 'text/markdown') }, 'Export notes .md'),
      h('button', { class: 'btn small', onclick: async () => download(safeFileName(`${m.title} notes`, 'txt'), notesToText(await store.getMeeting(m.id), notes)) }, 'Export notes .txt'),
      h('button', { class: 'btn small', onclick: async () => { if (await confirmDialog({ title: 'Delete notes?', message: 'The notes (and your edits) are deleted. Audio and transcript are kept.', confirmLabel: 'Delete notes', danger: true })) { await store.deleteNotes(m.id); render(); } } }, 'Delete notes')),
    h('p', { class: 'muted small' }, `Generated ${new Date(notes.generatedAt).toLocaleString()}${notes.model ? ` with ${notes.model}` : ''}${notes.parts > 1 ? ` from ${notes.parts} transcript parts` : ''}. Owners and due dates appear only when the transcript states them.`));
  return card;
}

/** Called when the user right-clicked "Record this tab with Satchel…". */
export function focusRecording() {
  openMeeting(null);
}
