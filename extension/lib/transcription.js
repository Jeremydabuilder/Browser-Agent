// Transcription queue for a meeting's audio chunks.
// - chunks are transcribed strictly in recording order
// - each result is saved as soon as it arrives, so a failure never loses finished chunks
// - chunks already done are skipped; failed chunks can be retried on their own
// - a Groq rate limit stops the run cleanly (progress kept) instead of failing every remaining chunk
import * as defaultStore from './meeting-store.js';
import { formatClock } from './meeting-capture.js';

export const MAX_ATTEMPTS_PER_RUN = 1;

/**
 * @param meetingId
 * @param deps { store, transcribeChunk(chunk, previousText) -> {text, segments, model}, onProgress }
 * @param opts { onlyFailed: boolean }
 * @returns {{done, failed, skipped, stoppedForRateLimit, retryAfter}}
 */
export async function runTranscription(meetingId, { store = defaultStore, transcribeChunk, onProgress = () => {} }, { onlyFailed = false } = {}) {
  const chunks = await store.listChunks(meetingId);
  const result = { done: 0, failed: 0, skipped: 0, stoppedForRateLimit: false, retryAfter: null, total: chunks.length };
  let previousText = '';
  for (const chunk of chunks) {
    if (chunk.status === 'done') {
      result.skipped++;
      previousText = chunk.transcript?.text || previousText;
      continue;
    }
    if (onlyFailed && chunk.status !== 'failed') { result.skipped++; continue; }
    if (!chunk.hasAudio || !chunk.data) {
      await store.updateChunk(meetingId, chunk.index, { status: 'no-audio', error: 'The audio for this part was deleted, so it cannot be transcribed.' });
      result.failed++;
      continue;
    }
    onProgress({ index: chunk.index, total: chunks.length, message: `Transcribing part ${chunk.index + 1} of ${chunks.length} (${formatClock(chunk.startSec)}–${formatClock(chunk.startSec + chunk.durationSec)})…` });
    await store.updateChunk(meetingId, chunk.index, { status: 'transcribing' });
    try {
      // The end of the previous part helps the model keep names and spelling consistent across parts.
      const r = await transcribeChunk(chunk, previousText.slice(-500));
      await store.updateChunk(meetingId, chunk.index, (c) => ({
        status: 'done',
        error: '',
        attempts: (c.attempts || 0) + 1,
        transcript: { text: r.text, segments: r.segments || [], model: r.model || '', at: new Date().toISOString() },
      }));
      previousText = r.text || previousText;
      result.done++;
    } catch (err) {
      await store.updateChunk(meetingId, chunk.index, (c) => ({ status: 'failed', error: String(err?.message || err), attempts: (c.attempts || 0) + 1 }));
      result.failed++;
      if (err?.code === 'rate_limited') {
        result.stoppedForRateLimit = true;
        result.retryAfter = err.retryAfter || null;
        // Leave the remaining chunks pending; "Resume" continues from here.
        for (const rest of chunks.filter((c) => c.index > chunk.index && c.status !== 'done')) {
          if (rest.status === 'transcribing') await store.updateChunk(meetingId, rest.index, { status: 'pending' });
        }
        break;
      }
      if (['companion_missing', 'companion_forbidden', 'bad_key', 'no_key'].includes(err?.code)) {
        // Every other chunk would fail the same way.
        result.fatal = err.message;
        break;
      }
    }
  }
  return result;
}

/**
 * Builds the meeting transcript from chunk results, in chunk order, with timestamps shifted to the
 * meeting timeline. Missing parts are shown as gaps instead of being silently dropped.
 * Segment ids are stable: "c<chunk>s<segment>".
 */
export function assembleTranscript(chunks) {
  const segments = [];
  for (const c of [...chunks].sort((a, b) => a.index - b.index)) {
    const base = c.startSec || 0;
    const end = base + (c.durationSec || 0);
    if (c.status !== 'done' || !c.transcript) {
      segments.push({ id: `c${c.index}gap`, chunkIndex: c.index, start: base, end, text: '', gap: true, gapReason: c.error || (c.status === 'no-audio' ? 'audio deleted' : 'not transcribed yet') });
      continue;
    }
    const segs = c.transcript.segments?.length ? c.transcript.segments : [{ start: 0, end: c.durationSec || 0, text: c.transcript.text || '' }];
    segs.forEach((s, i) => {
      segments.push({
        id: `c${c.index}s${i}`,
        chunkIndex: c.index,
        segIndex: i,
        start: base + Math.min(s.start || 0, c.durationSec || Infinity),
        end: base + Math.min(s.end || s.start || 0, c.durationSec || Infinity),
        text: s.text,
        edited: !!s.edited,
        approxTime: !c.transcript.segments?.length,
      });
    });
  }
  return segments;
}

export function transcriptStats(chunks) {
  const done = chunks.filter((c) => c.status === 'done').length;
  const failed = chunks.filter((c) => c.status === 'failed' || c.status === 'no-audio').length;
  return { total: chunks.length, done, failed, pending: chunks.length - done - failed, complete: chunks.length > 0 && done === chunks.length };
}

/** Saves a corrected segment text back into its chunk. */
export async function editSegment(meetingId, segmentId, text, store = defaultStore) {
  const m = /^c(\d+)s(\d+)$/.exec(segmentId);
  if (!m) throw new Error('Unknown transcript line.');
  const [chunkIndex, segIndex] = [Number(m[1]), Number(m[2])];
  return store.updateChunk(meetingId, chunkIndex, (c) => {
    if (!c.transcript) throw new Error('This part has no transcript.');
    const segs = c.transcript.segments?.length ? c.transcript.segments.map((s) => ({ ...s })) : [{ start: 0, end: c.durationSec || 0, text: c.transcript.text }];
    if (!segs[segIndex]) throw new Error('Unknown transcript line.');
    segs[segIndex] = { ...segs[segIndex], text: String(text).trim(), edited: true };
    return { transcript: { ...c.transcript, segments: segs, text: segs.map((s) => s.text).join(' ') } };
  });
}
