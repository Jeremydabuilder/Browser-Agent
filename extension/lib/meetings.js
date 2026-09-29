// High-level meeting operations shared by the side panel, recorder window and service worker.
import * as store from './meeting-store.js';
import { planRecovery, isStale } from './meeting-capture.js';
import { assembleTranscript } from './transcription.js';
import { uid, collapseWhitespace } from './util.js';

export const TIMESLICE_MS = 2000; // recorder saves a piece every 2 seconds (at most ~2 s lost in a crash)

export async function createMeeting({ title, source, sourceInfo = {}, captureSources = {} }, s = store) {
  const now = new Date().toISOString();
  const m = {
    id: uid('mtg'),
    title: collapseWhitespace(title).slice(0, 120) || `Meeting ${new Date().toLocaleString()}`,
    createdAt: now,
    source, // 'tab' | 'import'
    sourceInfo,
    captureSources, // what is actually being captured: { tab, mic }
    status: source === 'tab' ? 'recording' : 'importing',
    durationSec: 0,
    notes: null,
    transcriptReviewedAt: null,
    consent: {},
    lastHeartbeat: now,
    warnings: [],
  };
  await s.putMeeting(m);
  return m;
}

export async function renameMeeting(id, title, s = store) {
  const t = collapseWhitespace(title).slice(0, 120);
  if (!t) throw new Error('The title cannot be empty.');
  return s.updateMeeting(id, { title: t });
}

/**
 * Finalizes recordings whose recorder is gone (window closed, crash, or browser restart):
 * leftover pieces become chunks, and the meeting is marked "interrupted" so the user sees it.
 * @param isAlive(meeting) -> boolean  whether a recorder is still running for this meeting
 */
export const IMPORT_STALE_MS = 15 * 60 * 1000; // decoding a long file can take a while between heartbeats

export async function recoverInterrupted({ isAlive = () => false, now = Date.now(), force = false, onlyIds = null } = {}, s = store) {
  const recovered = [];
  for (const m of await s.listMeetings()) {
    if (m.status !== 'recording' && m.status !== 'importing') continue;
    if (onlyIds && !onlyIds.includes(m.id)) continue;
    const stale = m.status === 'importing'
      ? now - Date.parse(m.lastHeartbeat || m.createdAt) > IMPORT_STALE_MS
      : isStale(m, now);
    if (!force && !stale) continue;
    if (await isAlive(m)) continue;
    const chunks = await s.listChunks(m.id);
    const pieces = await s.listPieces(m.id);
    const plans = planRecovery(m, chunks, pieces, TIMESLICE_MS);
    for (const p of plans) {
      const data = new Blob(p.pieces.map((x) => x.data), { type: p.pieces[0].mime || 'audio/webm' });
      await s.putChunk({ meetingId: m.id, index: p.seg, startSec: p.startSec, durationSec: p.durationSec, mime: p.pieces[0].mime || 'audio/webm', data, size: data.size, hasAudio: true, status: 'pending', attempts: 0, partial: true });
    }
    await s.deletePieces(m.id);
    const all = await s.listChunks(m.id);
    const duration = all.reduce((n, c) => Math.max(n, (c.startSec || 0) + (c.durationSec || 0)), 0);
    await s.updateMeeting(m.id, {
      status: all.length ? 'interrupted' : 'failed',
      stopReason: 'interrupted',
      durationSec: duration,
      error: all.length ? '' : (m.status === 'importing' ? 'The import was interrupted before any audio was saved. Import the file again.' : 'The recording was interrupted before any audio was saved.'),
    });
    recovered.push(m.id);
  }
  return recovered;
}

/** Full-text search over titles, transcripts and notes. Returns [{meeting, where, snippet}]. */
export async function searchMeetings(query, s = store) {
  const q = collapseWhitespace(query).toLowerCase();
  const meetings = await s.listMeetings();
  if (!q) return meetings.map((m) => ({ meeting: m, where: '', snippet: '' }));
  const out = [];
  for (const m of meetings) {
    const snip = (text) => {
      const i = text.toLowerCase().indexOf(q);
      return i < 0 ? '' : `${i > 40 ? '…' : ''}${text.slice(Math.max(0, i - 40), i + q.length + 60)}…`;
    };
    if (m.title.toLowerCase().includes(q)) { out.push({ meeting: m, where: 'title', snippet: '' }); continue; }
    const notesText = m.notes ? JSON.stringify([m.notes.summary, m.notes.keyPoints, m.notes.decisions, m.notes.actionItems, m.notes.openQuestions]).replace(/\\"/g, '"') : '';
    if (notesText.toLowerCase().includes(q)) { out.push({ meeting: m, where: 'notes', snippet: snip(notesText) }); continue; }
    const transcript = assembleTranscript(await s.listChunks(m.id)).filter((x) => !x.gap).map((x) => x.text).join(' ');
    if (transcript.toLowerCase().includes(q)) out.push({ meeting: m, where: 'transcript', snippet: snip(transcript) });
  }
  return out;
}

export async function meetingStats(meetingId, s = store) {
  const chunks = await s.listChunks(meetingId);
  const audioBytes = chunks.reduce((n, c) => n + (c.hasAudio ? store.dataSize(c.data) : 0), 0);
  return {
    chunks,
    audioBytes,
    hasAudio: chunks.some((c) => c.hasAudio),
    hasTranscript: chunks.some((c) => c.transcript),
    segments: assembleTranscript(chunks),
  };
}
