// Recorder window: captures the meeting tab's audio (and optionally the microphone), keeps the tab
// audible, saves audio every few seconds, and rotates to a new standalone chunk every few minutes.
import * as store from '../lib/meeting-store.js';
import { captureReducer, initialCaptureState, shouldRotate, formatClock, describeStopReason } from '../lib/meeting-capture.js';
import { TIMESLICE_MS } from '../lib/meetings.js';
import { getSettings } from '../lib/settings.js';
import { setItem, removeItem } from '../lib/storage.js';
import { h, clear } from '../lib/ui.js';

const params = new URLSearchParams(location.search);
const meetingId = params.get('meetingId');
const mode = params.get('mode'); // 'tab' (tabCapture stream id) or 'pick' (browser tab picker)
const wantMic = params.get('mic') === '1';
const MIME = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
const $ = (id) => document.getElementById(id);

let cap = initialCaptureState();
let meeting;
let segmentSec = 300;
let streams = [];
let audioCtx;
let mixDest;
let recorder = null;
let seg = -1;
let seq = 0;
let segStartedAt = 0; // performance.now() when current segment started
let meetingStartedAt = 0;
let segStartSec = 0;
let writeQueue = Promise.resolve();
let finalizing = [];

function dispatch(event) {
  cap = captureReducer(cap, event);
  render();
  publish();
  return cap;
}

function enqueue(fn) {
  writeQueue = writeQueue.then(fn).catch((err) => console.error('Satchel recorder write failed', err));
  return writeQueue;
}

function elapsedSec() {
  return meetingStartedAt ? (performance.now() - meetingStartedAt) / 1000 : 0;
}

async function publish() {
  const active = cap.state === 'starting' || cap.state === 'recording' || cap.state === 'stopping';
  const win = await chrome.windows.getCurrent().catch(() => null);
  if (active) {
    await setItem('activeRecording', { meetingId, windowId: win?.id, state: cap.state, sources: cap.sources, startedAt: cap.startedAt, title: meeting?.title || '' }, 'session');
  } else {
    await removeItem('activeRecording', 'session');
  }
}

function render() {
  const labels = { idle: 'Preparing…', starting: 'Starting…', recording: 'Recording', stopping: 'Saving…', stopped: 'Saved', failed: 'Not recording' };
  $('state-label').textContent = labels[cap.state];
  $('dot').className = `dot ${cap.state === 'recording' ? 'on' : ''}`;
  document.title = cap.state === 'recording' ? `● REC ${formatClock(elapsedSec())} – Satchel` : 'Satchel recorder';
  $('stop').hidden = cap.state !== 'recording';
  $('close').hidden = !(cap.state === 'stopped' || cap.state === 'failed');
  $('choose').hidden = !(mode === 'pick' && cap.state === 'starting' && !streams.length);
  const src = $('sources');
  clear(src);
  if (cap.state === 'recording' || cap.state === 'stopping' || cap.state === 'stopped') {
    src.append(h('b', {}, 'Capturing:'), h('ul', {},
      h('li', {}, `🔊 Audio of the meeting tab${meeting?.sourceInfo?.tabTitle ? `: “${meeting.sourceInfo.tabTitle}”` : ''}`),
      cap.sources.mic ? h('li', {}, '🎙 Your microphone') : h('li', { class: 'muted' }, '🎙 Microphone: not recorded')),
    h('div', { class: 'muted' }, 'Not captured: other tabs, other apps, your screen, or video.'));
  }
  const w = $('warnings');
  clear(w);
  for (const msg of cap.warnings) w.append(h('p', { class: 'warn small' }, msg));
  if (cap.state === 'failed' && cap.error) w.append(h('p', { class: 'warn small' }, cap.error));
  if (cap.state === 'stopped') $('saved').textContent = `${describeStopReason(cap.stopReason)} Open the Meetings tab in Satchel to transcribe it.`;
}

setInterval(() => { if (cap.state === 'recording') { $('timer').textContent = formatClock(elapsedSec()); document.title = `● REC ${formatClock(elapsedSec())} – Satchel`; } }, 500);

async function getTabStream() {
  if (mode === 'tab') {
    const streamId = params.get('streamId');
    return navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } }, video: false });
  }
  const s = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: { suppressLocalAudioPlayback: false }, // you keep hearing the meeting
    selfBrowserSurface: 'exclude',
    systemAudio: 'exclude',
    surfaceSwitching: 'exclude',
    monitorTypeSurfaces: 'exclude',
  });
  return s;
}

async function startCapture() {
  try {
    const tabStream = await getTabStream();
    const audioTracks = tabStream.getAudioTracks();
    if (!audioTracks.length) {
      tabStream.getTracks().forEach((t) => t.stop());
      dispatch({ type: 'NO_TAB_AUDIO' });
      await store.updateMeeting(meetingId, { status: 'failed', error: cap.error });
      return;
    }
    const surface = tabStream.getVideoTracks()[0]?.getSettings?.().displaySurface;
    if (surface && surface !== 'browser') {
      tabStream.getTracks().forEach((t) => t.stop());
      dispatch({ type: 'TAB_DENIED', message: 'Please choose a browser tab (not a window or screen).' });
      await store.updateMeeting(meetingId, { status: 'failed', error: cap.error });
      return;
    }
    tabStream.getVideoTracks().forEach((t) => t.stop()); // audio only
    streams.push(tabStream);
    audioTracks[0].addEventListener('ended', () => stop('TAB_ENDED'));

    let micStream = null;
    if (wantMic) {
      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        streams.push(micStream);
      } catch {
        dispatch({ type: 'MIC_DENIED' });
      }
    }
    audioCtx = new AudioContext();
    mixDest = audioCtx.createMediaStreamDestination();
    const tabSrc = audioCtx.createMediaStreamSource(new MediaStream(audioTracks));
    tabSrc.connect(mixDest);
    // Tab capture mutes the tab; play it back so you can still hear the meeting.
    // (The browser tab picker keeps the tab audible by itself.)
    if (mode === 'tab') tabSrc.connect(audioCtx.destination);
    if (micStream) audioCtx.createMediaStreamSource(micStream).connect(mixDest);

    meetingStartedAt = performance.now();
    dispatch({ type: 'STREAMS_READY', sources: { tab: true, mic: !!micStream } });
    await store.updateMeeting(meetingId, { captureSources: cap.sources, warnings: cap.warnings, status: 'recording', lastHeartbeat: new Date().toISOString() });
    startSegment();
  } catch (err) {
    const denied = err?.name === 'NotAllowedError' || err?.name === 'AbortError';
    dispatch({ type: 'TAB_DENIED', message: denied ? 'Tab capture was cancelled or not allowed. Nothing was recorded.' : `Could not capture the meeting tab: ${err?.message || err}` });
    await store.updateMeeting(meetingId, { status: 'failed', error: cap.error });
  }
}

function startSegment() {
  const mySeg = ++seg;
  let mySeq = 0;
  seq = 0;
  segStartedAt = performance.now();
  segStartSec = elapsedSec();
  const startSec = segStartSec;
  const rec = new MediaRecorder(mixDest.stream, { mimeType: MIME, audioBitsPerSecond: 32000 });
  let done;
  const finished = new Promise((r) => { done = r; });
  finalizing.push(finished);
  rec.ondataavailable = (e) => {
    if (!e.data || !e.data.size) return;
    const piece = { meetingId, seg: mySeg, seq: mySeq++, data: e.data, mime: MIME, startSec, elapsedSec: (performance.now() - (rec._startedAt || segStartedAt)) / 1000 };
    enqueue(async () => {
      await store.addPiece(piece);
      await store.updateMeeting(meetingId, { lastHeartbeat: new Date().toISOString(), durationSec: elapsedSec() });
    });
    if (rec === recorder && cap.state === 'recording' && shouldRotate(performance.now() - segStartedAt, segmentSec)) rotate();
  };
  rec.onstop = () => {
    const durationSec = (performance.now() - rec._startedAt) / 1000;
    enqueue(async () => {
      const pieces = (await store.listPieces(meetingId)).filter((p) => p.seg === mySeg);
      if (pieces.length) {
        const data = new Blob(pieces.map((p) => p.data), { type: MIME });
        await store.putChunk({ meetingId, index: mySeg, startSec, durationSec, mime: MIME, data, size: data.size, hasAudio: true, status: 'pending', attempts: 0, partial: false });
        await store.deletePieces(meetingId, mySeg);
      }
    }).then(done, done);
  };
  rec.onerror = (e) => stop('RECORDER_ERROR', e?.error?.message || 'recorder error');
  rec._startedAt = performance.now();
  rec.start(TIMESLICE_MS);
  recorder = rec;
}

function rotate() {
  const old = recorder;
  startSegment(); // start the next chunk first so there is no gap
  old.stop();
}

async function stop(type = 'STOP', message = '') {
  if (cap.state !== 'recording') {
    if (cap.state === 'starting') dispatch({ type, message });
    return;
  }
  dispatch({ type, message });
  if (recorder && recorder.state !== 'inactive') recorder.stop();
  await Promise.all(finalizing);
  await writeQueue;
  streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
  await audioCtx?.close().catch(() => {});
  const chunks = await store.listChunks(meetingId);
  await store.updateMeeting(meetingId, {
    status: chunks.length ? 'recorded' : 'failed',
    durationSec: chunks.reduce((n, c) => Math.max(n, c.startSec + c.durationSec), 0),
    stopReason: cap.stopReason,
    error: chunks.length ? '' : 'No audio was captured.',
    warnings: cap.warnings,
  });
  dispatch({ type: 'SAVED' });
}

$('stop').addEventListener('click', () => stop('STOP'));
$('close').addEventListener('click', () => window.close());
$('choose-btn').addEventListener('click', () => startCapture());

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (sender.id !== chrome.runtime.id) return;
  if (msg?.cmd === 'meeting.stop' && msg.meetingId === meetingId) stop('STOP');
});

window.addEventListener('beforeunload', (e) => {
  if (cap.state === 'recording') { e.preventDefault(); e.returnValue = ''; }
});

(async function main() {
  meeting = await store.getMeeting(meetingId);
  // A recorder window restored by the browser (or reloaded) must never restart or overwrite a session.
  if (!meeting || meeting.recorderClaimed || meeting.status !== 'recording') {
    cap = { ...cap, state: 'failed', error: 'This recording session has already ended. Start a new recording from the Meetings tab in Satchel.' };
    render();
    return;
  }
  meeting = await store.updateMeeting(meetingId, { recorderClaimed: true, lastHeartbeat: new Date().toISOString() });
  $('meeting-title').textContent = meeting.title;
  segmentSec = (await getSettings()).meetingSegmentSec;
  dispatch({ type: 'START' });
  if (mode === 'tab') await startCapture();
})();
