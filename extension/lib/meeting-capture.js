// Pure logic for meeting capture: the recorder state machine, segment rotation, and recovery of
// interrupted sessions. No browser APIs here, so it can be unit-tested.

export const CAPTURE_STATES = ['idle', 'starting', 'recording', 'stopping', 'stopped', 'failed'];

export function initialCaptureState() {
  return { state: 'idle', sources: { tab: false, mic: false }, warnings: [], error: '', stopReason: '', startedAt: null, stoppedAt: null };
}

const STOP_REASONS = {
  STOP: 'user',
  TAB_ENDED: 'tab_closed',
  RECORDER_ERROR: 'error',
};

/**
 * Recorder state machine. Illegal transitions are ignored (returned unchanged with ignored: true),
 * so a late event (e.g. "tab closed" after the user already pressed Stop) can't corrupt the state.
 */
export function captureReducer(s, event, now = Date.now()) {
  const ignore = () => ({ ...s, ignored: true });
  const next = (patch) => ({ ...s, ...patch, ignored: false });
  switch (event.type) {
    case 'START':
      return s.state === 'idle' || s.state === 'failed' || s.state === 'stopped'
        ? next({ ...initialCaptureState(), state: 'starting' }) : ignore();
    case 'MIC_DENIED':
      if (s.state !== 'starting') return ignore();
      return next({ warnings: [...s.warnings, 'Microphone permission was denied, so only the meeting tab is being recorded.'] });
    case 'TAB_DENIED':
    case 'NO_TAB_AUDIO':
      if (s.state !== 'starting') return ignore();
      return next({
        state: 'failed',
        error: event.type === 'NO_TAB_AUDIO'
          ? 'The shared tab has no audio. Choose the meeting tab again and tick “Also share tab audio”.'
          : (event.message || 'Permission to capture the meeting tab was not given. Nothing was recorded.'),
      });
    case 'STREAMS_READY':
      if (s.state !== 'starting') return ignore();
      if (!event.sources?.tab) return next({ state: 'failed', error: 'No meeting audio source is available.' });
      return next({ state: 'recording', sources: { tab: true, mic: !!event.sources.mic }, startedAt: now });
    case 'STOP':
    case 'TAB_ENDED':
    case 'RECORDER_ERROR':
      if (s.state === 'starting' && event.type !== 'STOP') return next({ state: 'failed', error: event.message || 'Recording could not start.' });
      if (s.state === 'starting') return next({ state: 'failed', error: 'Cancelled before recording started.' });
      if (s.state !== 'recording') return ignore();
      return next({ state: 'stopping', stopReason: STOP_REASONS[event.type], error: event.message || '' });
    case 'SAVED':
      return s.state === 'stopping' ? next({ state: 'stopped', stoppedAt: now }) : ignore();
    default:
      return ignore();
  }
}

export function describeStopReason(reason) {
  return {
    user: 'Stopped by you.',
    tab_closed: 'The meeting tab was closed or stopped sharing, so recording stopped. Everything up to that moment was saved.',
    error: 'The recorder hit an error and stopped. Everything recorded so far was saved.',
    interrupted: 'Recording was interrupted (the recorder window or browser closed unexpectedly). Audio saved up to the last few seconds was kept.',
  }[reason] || '';
}

/** Should the recorder rotate to a new standalone chunk now? */
export function shouldRotate(segmentElapsedMs, segmentSec) {
  return segmentElapsedMs >= segmentSec * 1000;
}

/** Recording older than this without a heartbeat is considered interrupted. */
export const HEARTBEAT_STALE_MS = 20000;

export function isStale(meeting, now = Date.now()) {
  if (meeting.status !== 'recording') return false;
  const last = Date.parse(meeting.lastHeartbeat || meeting.createdAt || 0);
  return !last || now - last > HEARTBEAT_STALE_MS;
}

/**
 * Plans the recovery of an interrupted recording from the pieces that were saved every few seconds.
 * Pieces of the same segment (one MediaRecorder run) concatenate into a playable WebM file.
 * @returns [{ seg, pieces: [...], startSec, durationSec }] - one new chunk per unfinished segment
 */
export function planRecovery(meeting, existingChunks, pieces, timesliceMs) {
  const done = new Set(existingChunks.map((c) => c.index));
  const bySeg = new Map();
  for (const p of pieces) {
    if (done.has(p.seg)) continue; // already saved as a full chunk; leftover pieces are just garbage
    if (!bySeg.has(p.seg)) bySeg.set(p.seg, []);
    bySeg.get(p.seg).push(p);
  }
  const plans = [];
  for (const [seg, list] of [...bySeg.entries()].sort((a, b) => a[0] - b[0])) {
    list.sort((a, b) => a.seq - b.seq);
    // A segment is only playable from its first piece (which carries the WebM header).
    if (list[0].seq !== 0) continue;
    const contiguous = [];
    for (let i = 0; i < list.length && list[i].seq === i; i++) contiguous.push(list[i]);
    const startSec = contiguous[0].startSec ?? existingChunks.filter((c) => c.index < seg).reduce((n, c) => n + (c.durationSec || 0), 0);
    const lastAt = contiguous[contiguous.length - 1].elapsedSec;
    plans.push({ seg, pieces: contiguous, startSec, durationSec: lastAt ?? (contiguous.length * timesliceMs) / 1000 });
  }
  return plans;
}

export function formatClock(totalSec) {
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
