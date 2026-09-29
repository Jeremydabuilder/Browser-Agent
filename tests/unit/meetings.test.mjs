import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import * as store from '../../extension/lib/meeting-store.js';
import { captureReducer, initialCaptureState, shouldRotate, formatClock, planRecovery, isStale } from '../../extension/lib/meeting-capture.js';
import { createMeeting, recoverInterrupted, searchMeetings, renameMeeting, TIMESLICE_MS } from '../../extension/lib/meetings.js';
import { runTranscription, assembleTranscript, editSegment, transcriptStats } from '../../extension/lib/transcription.js';
import { validateNotes, generateNotes, windowLines, transcriptLines } from '../../extension/lib/meeting-notes.js';
import { notesToMarkdown, notesToText, transcriptToMarkdown, meetingToMarkdown, transcriptToText, safeFileName } from '../../extension/lib/meeting-export.js';
import { planChunks, encodeWav, downmix, resample, checkImportFile, IMPORT_LIMITS } from '../../extension/lib/audio-chunks.js';
import { setStorageBackend, createMemoryBackend } from '../../extension/lib/storage.js';
import { listMemories } from '../../extension/lib/memory.js';

beforeEach(() => {
  store.setIndexedDB(new IDBFactory());
  setStorageBackend(createMemoryBackend());
});

const blob = (s) => new Blob([s], { type: 'audio/webm' });

async function meetingWithChunks(n, { chunkSec = 300, statuses = [] } = {}) {
  const m = await createMeeting({ title: 'Team sync', source: 'import' });
  await store.updateMeeting(m.id, { status: 'recorded' });
  // Insert out of order on purpose: order must come from the index, not insertion order.
  for (const index of [...Array(n).keys()].reverse()) {
    await store.putChunk({ meetingId: m.id, index, startSec: index * chunkSec, durationSec: chunkSec, mime: 'audio/wav', data: blob(`audio-${index}`), size: 7, hasAudio: true, status: statuses[index] || 'pending', attempts: 0 });
  }
  return m;
}

// ---------------- capture state machine ----------------
test('capture: normal start, recording and stop', () => {
  let s = initialCaptureState();
  s = captureReducer(s, { type: 'START' });
  assert.equal(s.state, 'starting');
  s = captureReducer(s, { type: 'STREAMS_READY', sources: { tab: true, mic: true } }, 1000);
  assert.deepEqual([s.state, s.sources, s.startedAt], ['recording', { tab: true, mic: true }, 1000]);
  s = captureReducer(s, { type: 'STOP' });
  assert.deepEqual([s.state, s.stopReason], ['stopping', 'user']);
  s = captureReducer(s, { type: 'SAVED' }, 5000);
  assert.deepEqual([s.state, s.stoppedAt], ['stopped', 5000]);
});

test('capture: denied microphone continues with tab only and says so', () => {
  let s = captureReducer(initialCaptureState(), { type: 'START' });
  s = captureReducer(s, { type: 'MIC_DENIED' });
  assert.equal(s.state, 'starting');
  assert.match(s.warnings[0], /Microphone permission was denied/);
  s = captureReducer(s, { type: 'STREAMS_READY', sources: { tab: true, mic: false } });
  assert.deepEqual([s.state, s.sources.mic], ['recording', false]);
});

test('capture: denied tab capture or a tab without audio fails without recording', () => {
  const denied = captureReducer(captureReducer(initialCaptureState(), { type: 'START' }), { type: 'TAB_DENIED' });
  assert.equal(denied.state, 'failed');
  assert.match(denied.error, /Nothing was recorded/);
  const noAudio = captureReducer(captureReducer(initialCaptureState(), { type: 'START' }), { type: 'NO_TAB_AUDIO' });
  assert.match(noAudio.error, /Also share tab audio/);
  assert.equal(captureReducer(captureReducer(initialCaptureState(), { type: 'START' }), { type: 'STREAMS_READY', sources: { tab: false } }).state, 'failed');
});

test('capture: closed meeting tab stops with a reason; late events are ignored', () => {
  let s = captureReducer(captureReducer(initialCaptureState(), { type: 'START' }), { type: 'STREAMS_READY', sources: { tab: true } });
  s = captureReducer(s, { type: 'TAB_ENDED' });
  assert.deepEqual([s.state, s.stopReason], ['stopping', 'tab_closed']);
  const late = captureReducer(s, { type: 'STOP' });
  assert.equal(late.ignored, true);
  assert.equal(late.stopReason, 'tab_closed');
  assert.equal(captureReducer(initialCaptureState(), { type: 'STOP' }).ignored, true, 'cannot stop before starting');
  assert.equal(captureReducer(initialCaptureState(), { type: 'SAVED' }).ignored, true);
  const again = captureReducer(captureReducer(s, { type: 'SAVED' }), { type: 'START' });
  assert.equal(again.state, 'starting', 'a new recording can start after saving');
  assert.deepEqual(again.warnings, []);
});

test('capture: recorder error while recording stops and keeps audio; before start it fails', () => {
  const rec = captureReducer(captureReducer(captureReducer(initialCaptureState(), { type: 'START' }), { type: 'STREAMS_READY', sources: { tab: true } }), { type: 'RECORDER_ERROR', message: 'boom' });
  assert.deepEqual([rec.state, rec.stopReason], ['stopping', 'error']);
  assert.equal(captureReducer(captureReducer(initialCaptureState(), { type: 'START' }), { type: 'RECORDER_ERROR' }).state, 'failed');
});

test('segment rotation and clock formatting', () => {
  assert.equal(shouldRotate(299999, 300), false);
  assert.equal(shouldRotate(300000, 300), true);
  assert.equal(formatClock(0), '00:00');
  assert.equal(formatClock(754.9), '12:34');
  assert.equal(formatClock(3725), '1:02:05');
});

// ---------------- chunk ordering & retry ----------------
test('transcription runs chunks in order, saves each, and passes context from the previous part', async () => {
  const m = await meetingWithChunks(3);
  const calls = [];
  const r = await runTranscription(m.id, { transcribeChunk: async (c, prev) => { calls.push([c.index, prev]); return { text: `text ${c.index}`, segments: [{ start: 1, end: 4, text: `text ${c.index}` }] }; } });
  assert.deepEqual(calls, [[0, ''], [1, 'text 0'], [2, 'text 1']]);
  assert.deepEqual([r.done, r.failed], [3, 0]);
  assert.equal(transcriptStats(await store.listChunks(m.id)).complete, true);
});

test('a failed chunk is retried alone without re-transcribing finished chunks', async () => {
  const m = await meetingWithChunks(3);
  let calls = [];
  let chunk1Attempts = 0;
  const flaky = async (c) => { calls.push(c.index); if (c.index === 1 && ++chunk1Attempts === 1) throw new Error('HTTP 500'); return { text: `t${c.index}`, segments: [] }; };
  const first = await runTranscription(m.id, { transcribeChunk: flaky });
  assert.deepEqual(calls, [0, 1, 2], 'a failure does not stop later chunks');
  assert.deepEqual([first.done, first.failed], [2, 1]);
  const failed = await store.getChunk(m.id, 1);
  assert.deepEqual([failed.status, failed.error, failed.attempts], ['failed', 'HTTP 500', 1]);
  calls = [];
  const retry = await runTranscription(m.id, { transcribeChunk: flaky }, { onlyFailed: true });
  assert.deepEqual(calls, [1], 'only the failed chunk is sent again');
  assert.deepEqual([retry.done, retry.skipped], [1, 2]);
  assert.equal((await store.getChunk(m.id, 1)).attempts, 2);
});

test('a Groq rate limit stops the run and leaves remaining chunks pending for Resume', async () => {
  const m = await meetingWithChunks(4);
  const calls = [];
  const r = await runTranscription(m.id, { transcribeChunk: async (c) => { calls.push(c.index); if (c.index === 1) throw Object.assign(new Error('rate'), { code: 'rate_limited', retryAfter: 600 }); return { text: 'x', segments: [] }; } });
  assert.deepEqual(calls, [0, 1]);
  assert.equal(r.stoppedForRateLimit, true);
  assert.equal(r.retryAfter, 600);
  const chunks = await store.listChunks(m.id);
  assert.deepEqual(chunks.map((c) => c.status), ['done', 'failed', 'pending', 'pending']);
  const resumed = [];
  await runTranscription(m.id, { transcribeChunk: async (c) => { resumed.push(c.index); return { text: 'y', segments: [] }; } });
  assert.deepEqual(resumed, [1, 2, 3]);
});

test('missing companion stops immediately instead of failing every chunk', async () => {
  const m = await meetingWithChunks(3);
  const calls = [];
  const r = await runTranscription(m.id, { transcribeChunk: async (c) => { calls.push(c.index); throw Object.assign(new Error('not installed'), { code: 'companion_missing' }); } });
  assert.deepEqual(calls, [0]);
  assert.equal(r.fatal, 'not installed');
});

test('transcript assembly shifts timestamps to the meeting timeline and shows gaps', async () => {
  const m = await meetingWithChunks(3, { chunkSec: 300 });
  await store.updateChunk(m.id, 0, { status: 'done', transcript: { text: 'Hello all. Next item.', segments: [{ start: 0, end: 2, text: 'Hello all.' }, { start: 2.5, end: 5, text: 'Next item.' }] } });
  await store.updateChunk(m.id, 2, { status: 'done', transcript: { text: 'Wrap up.', segments: [] } });
  await store.updateChunk(m.id, 1, { status: 'failed', error: 'HTTP 500' });
  const segs = assembleTranscript(await store.listChunks(m.id));
  assert.deepEqual(segs.map((s) => [s.id, s.start]), [['c0s0', 0], ['c0s1', 2.5], ['c1gap', 300], ['c2s0', 600]]);
  assert.equal(segs[2].gap, true);
  assert.equal(segs[2].gapReason, 'HTTP 500');
  assert.equal(segs[3].approxTime, true, 'no segment timestamps from the API -> chunk start time, marked approximate');
  await editSegment(m.id, 'c0s1', 'Next item: budget.');
  const edited = assembleTranscript(await store.listChunks(m.id));
  assert.equal(edited[1].text, 'Next item: budget.');
  assert.equal(edited[1].edited, true);
});

test('chunks whose audio was deleted are reported, not silently skipped', async () => {
  const m = await meetingWithChunks(2);
  await store.deleteAudio(m.id);
  const r = await runTranscription(m.id, { transcribeChunk: async () => ({ text: 'x' }) });
  assert.equal(r.failed, 2);
  assert.match((await store.getChunk(m.id, 0)).error, /audio for this part was deleted/);
});

// ---------------- interrupted sessions ----------------
test('an interrupted recording keeps saved pieces as a playable partial chunk', async () => {
  const m = await createMeeting({ title: 'Crashed', source: 'tab', captureSources: { tab: true } });
  await store.updateMeeting(m.id, { lastHeartbeat: new Date(Date.now() - 60000).toISOString() });
  await store.putChunk({ meetingId: m.id, index: 0, startSec: 0, durationSec: 300, mime: 'audio/webm', data: blob('full'), hasAudio: true, status: 'pending' });
  await store.addPiece({ meetingId: m.id, seg: 0, seq: 5, data: blob('leftover'), startSec: 0 }); // already merged into chunk 0
  for (let seq = 0; seq < 3; seq++) await store.addPiece({ meetingId: m.id, seg: 1, seq, data: blob(`p${seq}`), mime: 'audio/webm', startSec: 300, elapsedSec: (seq + 1) * 2 });
  const recovered = await recoverInterrupted();
  assert.deepEqual(recovered, [m.id]);
  const chunks = await store.listChunks(m.id);
  assert.deepEqual(chunks.map((c) => [c.index, c.startSec, c.durationSec, !!c.partial]), [[0, 0, 300, false], [1, 300, 6, true]]);
  assert.equal(await chunks[1].data.text(), 'p0p1p2', 'pieces joined in order');
  assert.equal((await store.listPieces(m.id)).length, 0);
  const after = await store.getMeeting(m.id);
  assert.deepEqual([after.status, after.stopReason, after.durationSec], ['interrupted', 'interrupted', 306]);
});

test('recovery leaves live recordings alone and handles "nothing saved"', async () => {
  const live = await createMeeting({ title: 'Live', source: 'tab' });
  assert.deepEqual(await recoverInterrupted(), [], 'fresh heartbeat -> not interrupted');
  await store.updateMeeting(live.id, { lastHeartbeat: new Date(Date.now() - 60000).toISOString() });
  assert.deepEqual(await recoverInterrupted({ isAlive: () => true }), [], 'recorder window still open');
  assert.deepEqual(await recoverInterrupted({ force: true, onlyIds: ['other'] }), []);
  assert.deepEqual(await recoverInterrupted({ force: true }), [live.id], 'browser restart forces recovery');
  const m = await store.getMeeting(live.id);
  assert.equal(m.status, 'failed');
  assert.match(m.error, /before any audio was saved/);
});

test('recovery plan skips segments whose first piece (with the file header) is missing', () => {
  const plans = planRecovery({}, [], [{ seg: 0, seq: 1, data: 'x' }, { seg: 1, seq: 0, data: 'a', startSec: 10 }, { seg: 1, seq: 2, data: 'c' }], TIMESLICE_MS);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].seg, 1);
  assert.equal(plans[0].pieces.length, 1, 'stops at the first missing piece');
  assert.equal(isStale({ status: 'recording', lastHeartbeat: new Date().toISOString() }), false);
  assert.equal(isStale({ status: 'recorded', lastHeartbeat: '2000-01-01' }), false);
});

test('imports get a longer grace period before being treated as interrupted', async () => {
  const m = await createMeeting({ title: 'Import', source: 'import' });
  await store.updateMeeting(m.id, { lastHeartbeat: new Date(Date.now() - 60000).toISOString() });
  assert.deepEqual(await recoverInterrupted(), [], 'decoding may take a while');
  await store.updateMeeting(m.id, { lastHeartbeat: new Date(Date.now() - 20 * 60000).toISOString() });
  assert.deepEqual(await recoverInterrupted(), [m.id]);
});

// ---------------- note grounding ----------------
const segs = [
  { id: 'c0s0', start: 0, text: 'Alice: Thanks everyone for joining.' },
  { id: 'c0s1', start: 12, text: 'Bob: I think we should move the launch.' },
  { id: 'c0s2', start: 30, text: 'Alice: OK, we agreed to move the launch to October 12.' },
  { id: 'c0s3', start: 45, text: 'Alice: Priya, can you send the slides by Friday?' },
  { id: 'c0s4', start: 50, text: 'Priya: Yes, I will send them.' },
  { id: 'c1s0', start: 300, text: 'Someone should update the budget sheet.' },
  { id: 'c1s2', start: 330, text: 'Marco: Sure, I can take the poster.' },
  { id: 'c1s1', start: 320, text: 'Alice: Do we still need the venue?' },
];
const meetingDate = new Date(2026, 8, 28, 10); // Monday

test('notes: decisions need a verifiable quote; invented ones are dropped', () => {
  const n = validateNotes({
    summary: 'Launch moved.',
    decisions: [
      { text: 'Launch moved to Oct 12', quote: 'we agreed to move the launch to October 12', refs: ['c0s2'] },
      { text: 'Hire a new designer', quote: 'we will hire a designer', refs: ['c0s1'] },
      { text: 'Cancel venue', quote: 'cancel the venue', refs: ['c9s9'] },
    ],
  }, segs, { meetingDate });
  assert.deepEqual(n.decisions.map((d) => d.text), ['Launch moved to Oct 12']);
  assert.deepEqual(n.decisions[0].refs, [{ id: 'c0s2', start: 30 }]);
  assert.equal(n.dropped.length, 2);
  assert.ok(n.dropped.every((d) => d.kind === 'decision'));
});

test('notes: owners and due dates are kept only when stated; guesses are cleared and flagged', () => {
  const n = validateNotes({
    actionItems: [
      { task: 'Send slides', owner: 'Priya', due: 'Friday', quote: 'can you send the slides by Friday', refs: ['c0s3'] },
      { task: 'Update budget sheet', owner: 'Bob', due: 'next Monday', quote: 'Someone should update the budget sheet', refs: ['c1s0'] },
      { task: 'Book caterer', owner: 'Alice', quote: 'book the caterer', refs: ['c0s0'] },
    ],
  }, segs, { meetingDate });
  assert.equal(n.actionItems.length, 2);
  const [slides, budget] = n.actionItems;
  assert.deepEqual([slides.owner, slides.due, slides.dueDate], ['Priya', 'Friday', '2026-10-02']);
  assert.ok(slides.review.some((r) => /Friday.*check/.test(r)), 'weekday-only date is flagged for review');
  assert.equal(budget.owner, '', '"someone" is not an owner, so none is invented');
  assert.equal(budget.due, '');
  assert.ok(budget.review.some((r) => /owner/.test(r)));
  assert.ok(budget.review.some((r) => /due date/.test(r)));
  assert.equal(n.dropped[0].kind, 'action item');
  const speaker = validateNotes({ actionItems: [{ task: 'Make the poster', owner: 'Marco', quote: 'I can take the poster', refs: ['c1s2'] }] }, segs, { meetingDate });
  assert.equal(speaker.actionItems[0].owner, 'Marco');
  assert.ok(speaker.actionItems[0].review.some((r) => /inferred from who was speaking/.test(r)), 'speaker-label owner is kept but flagged');
});

test('notes: uncertain names are flagged and unknown refs removed', () => {
  const n = validateNotes({
    keyPoints: [{ text: 'Launch timing discussed', refs: ['c0s1', 'nope'] }, { text: 'Floating point', refs: [] }],
    openQuestions: [{ text: 'Is the venue still needed?', refs: ['c1s1'] }],
    actionItems: [{ task: 'Send slides', owner: 'Priya', quote: 'Yes, I will send them', refs: ['c0s4'], uncertain: true }],
  }, segs, { meetingDate });
  assert.deepEqual(n.keyPoints[0].refs.map((r) => r.id), ['c0s1']);
  assert.match(n.keyPoints[1].review[0], /Not linked/);
  assert.equal(n.openQuestions[0].refs[0].start, 320);
  assert.ok(n.actionItems[0].review.some((r) => /misheard/.test(r)));
  assert.equal(validateNotes(null, segs).summary, '');
});

test('notes: long transcripts are processed in windows, combined, and validated against the full transcript', async () => {
  const lines = transcriptLines(segs);
  assert.equal(windowLines(lines, 120).length > 2, true);
  const prompts = [];
  const fakeChat = async ({ messages }) => {
    prompts.push(messages[0].content.match(/TASK:(\w+)/)[1]);
    if (messages[0].content.includes('meeting_notes_combine')) {
      return { data: { summary: 'Combined.', decisions: [{ text: 'Launch moved', quote: 'we agreed to move the launch to October 12', refs: ['c0s2'] }, { text: 'Invented', quote: 'nothing like this', refs: ['c0s2'] }] }, model: 'm' };
    }
    return { data: { summary: 'part', keyPoints: [] }, model: 'm' };
  };
  const notes = await generateNotes({ segments: segs, title: 'Sync', meetingDate, maxChars: 120, chat: fakeChat });
  assert.ok(prompts.filter((p) => p === 'meeting_notes').length >= 2);
  assert.equal(prompts.at(-1), 'meeting_notes_combine');
  assert.deepEqual(notes.decisions.map((d) => d.text), ['Launch moved']);
  assert.equal(notes.dropped.length, 1);
  assert.ok(notes.parts > 1);
  await assert.rejects(generateNotes({ segments: [], title: 'x', maxChars: 100, chat: fakeChat }), /empty/);
});

test('notes are never written to durable memory', async () => {
  const m = await meetingWithChunks(1);
  await store.updateMeeting(m.id, { notes: validateNotes({ summary: 'S' }, segs) });
  assert.deepEqual(await listMemories(), []);
});

// ---------------- export ----------------
test('Markdown export: sections, timestamp links to transcript anchors, escaping, review flags', () => {
  const meeting = { title: 'Sync *1*', createdAt: '2026-09-28T14:00:00Z', durationSec: 330 };
  const notes = validateNotes({
    summary: 'We moved the launch.',
    decisions: [{ text: 'Launch moved', quote: 'we agreed to move the launch to October 12', refs: ['c0s2'] }],
    actionItems: [{ task: 'Send slides', owner: 'Priya', due: 'Friday', quote: 'can you send the slides by Friday', refs: ['c0s3'] }],
  }, segs, { meetingDate });
  const md = meetingToMarkdown(meeting, notes, segs);
  assert.match(md, /^# Sync \\\*1\\\*/);
  for (const h of ['## Summary', '## Key points', '## Decisions', '## Action items', '## Open questions', '# Transcript']) assert.ok(md.includes(h), h);
  assert.match(md, /Launch moved \(\[00:30\]\(#t-c0s2\)\)/);
  assert.match(md, /<a id="t-c0s2"><\/a>\*\*\[00:30\]\*\*/);
  assert.match(md, /- \[ \] Send slides — \*\*Owner:\*\* Priya — \*\*Due:\*\* Friday \(2026-10-02\)/);
  assert.match(md, /⚠ \*Review:/);
  assert.match(notesToMarkdown(meeting, null), /No notes yet/);
  assert.doesNotMatch(notesToMarkdown(meeting, notes), /#t-/, 'no dangling links when exporting notes alone');
});

test('plain-text export is readable without markup', () => {
  const meeting = { title: 'Sync', createdAt: '2026-09-28T14:00:00Z' };
  const notes = validateNotes({ summary: 'S', openQuestions: [{ text: 'Venue?', refs: ['c1s1'] }] }, segs);
  const txt = notesToText(meeting, notes);
  assert.match(txt, /OPEN QUESTIONS\n {2}- Venue\? \(at 05:20\)/);
  assert.doesNotMatch(txt, /[*#[\]]/);
  const t = transcriptToText(meeting, [...segs.slice(0, 1), { id: 'g', gap: true, start: 60, end: 120, gapReason: 'HTTP 500' }]);
  assert.match(t, /\[00:00\] Alice: Thanks/);
  assert.match(t, /\[01:00-02:00\] \(missing: HTTP 500\)/);
  assert.match(transcriptToMarkdown(meeting, segs, { withAnchors: false }), /- \*\*\[00:12\]\*\* Bob/);
  assert.equal(safeFileName('Q3: plan / review?', 'md'), 'Q3-plan-review.md');
});

// ---------------- deletion ----------------
test('raw audio, transcript and notes can each be deleted separately', async () => {
  const m = await meetingWithChunks(2);
  await runTranscription(m.id, { transcribeChunk: async (c) => ({ text: `hello ${c.index}`, segments: [] }) });
  await store.updateMeeting(m.id, { notes: validateNotes({ summary: 'S' }, segs) });

  await store.deleteAudio(m.id);
  let chunks = await store.listChunks(m.id);
  assert.ok(chunks.every((c) => !c.hasAudio && c.data === null));
  assert.ok(chunks.every((c) => c.transcript?.text), 'transcript kept');
  assert.ok((await store.getMeeting(m.id)).notes, 'notes kept');

  await store.deleteTranscript(m.id);
  chunks = await store.listChunks(m.id);
  assert.ok(chunks.every((c) => c.transcript === null && c.status === 'no-audio'));
  assert.ok((await store.getMeeting(m.id)).notes, 'notes kept after deleting transcript');

  await store.deleteNotes(m.id);
  assert.equal((await store.getMeeting(m.id)).notes, null);
  assert.ok(await store.getMeeting(m.id), 'meeting record remains');

  await store.addPiece({ meetingId: m.id, seg: 9, seq: 0, data: blob('x') });
  await store.deleteMeeting(m.id);
  assert.equal(await store.getMeeting(m.id), undefined);
  assert.deepEqual(await store.listChunks(m.id), []);
  assert.deepEqual(await store.listPieces(m.id), []);
});

test('deleting a transcript keeps audio so it can be transcribed again', async () => {
  const m = await meetingWithChunks(1);
  await runTranscription(m.id, { transcribeChunk: async () => ({ text: 'first', segments: [] }) });
  await store.deleteTranscript(m.id);
  const [c] = await store.listChunks(m.id);
  assert.deepEqual([c.hasAudio, c.status, c.transcript], [true, 'pending', null]);
  const r = await runTranscription(m.id, { transcribeChunk: async () => ({ text: 'second', segments: [] }) });
  assert.equal(r.done, 1);
});

test('search covers titles, transcripts and notes; rename validates', async () => {
  const m = await meetingWithChunks(1);
  await runTranscription(m.id, { transcribeChunk: async () => ({ text: 'We discussed the robotics fundraiser.', segments: [] }) });
  await store.updateMeeting(m.id, { notes: validateNotes({ summary: 'Budget approved for the trip.' }, segs) });
  assert.equal((await searchMeetings('robotics'))[0].where, 'transcript');
  assert.equal((await searchMeetings('trip'))[0].where, 'notes');
  assert.equal((await searchMeetings('team sync'))[0].where, 'title');
  assert.deepEqual(await searchMeetings('zebra'), []);
  await renameMeeting(m.id, '  Robotics club  ');
  assert.equal((await store.getMeeting(m.id)).title, 'Robotics club');
  await assert.rejects(renameMeeting(m.id, '   '), /cannot be empty/);
  await store.deleteTranscript(m.id);
  assert.deepEqual(await searchMeetings('robotics fundraiser'), [], 'deleted transcript is no longer searchable');
});

// ---------------- audio chunking ----------------
test('import chunk plan covers the whole recording without tiny tail chunks', () => {
  assert.deepEqual(planChunks(650, 300).map((c) => [c.startSec, c.durationSec]), [[0, 300], [300, 300], [600, 50]]);
  assert.deepEqual(planChunks(601, 300).map((c) => c.durationSec), [300, 301]);
  assert.deepEqual(planChunks(0, 300), []);
});

test('WAV encoding produces a valid 16 kHz mono header and clamps samples', () => {
  const wav = encodeWav(new Float32Array([0, 1, -1, 2]), 16000);
  const v = new DataView(wav.buffer);
  assert.equal(String.fromCharCode(...wav.slice(0, 4)), 'RIFF');
  assert.equal(v.getUint32(24, true), 16000);
  assert.equal(v.getUint16(22, true), 1);
  assert.equal(v.getUint32(40, true), 8);
  assert.deepEqual([v.getInt16(46, true), v.getInt16(48, true), v.getInt16(50, true)], [32767, -32768, 32767]);
  assert.deepEqual([...downmix([new Float32Array([1, 1]), new Float32Array([0, -1])], 0, 2)], [0.5, 0]);
  assert.equal(resample(new Float32Array(48000), 48000, 16000).length, 16000);
});

test('import file checks: type and size limits with helpful messages', () => {
  assert.equal(checkImportFile({ name: 'audio_only.m4a', type: 'audio/x-m4a', size: 20e6 }), '');
  assert.equal(checkImportFile({ name: 'zoom_0.mp4', type: 'video/mp4', size: 200e6 }), '');
  assert.match(checkImportFile({ name: 'notes.pdf', type: 'application/pdf', size: 10 }), /not a supported/);
  assert.match(checkImportFile({ name: 'big.mp4', type: 'video/mp4', size: IMPORT_LIMITS.maxFileBytes + 1 }), /audio only/);
  assert.match(checkImportFile({ name: 'x.wav', type: 'audio/wav', size: 0 }), /empty/);
});
