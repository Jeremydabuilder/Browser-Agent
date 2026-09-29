// Runs a meeting's transcription as a background job in the service worker, so it keeps going when
// the side panel is closed. Progress is published to session storage ("transcriptionJob").
import { runTranscription } from './transcription.js';
import { transcribe, toBase64, friendlyError } from './ai.js';
import { getItem, setItem } from './storage.js';

const JOB_KEY = 'transcriptionJob';
export const JOB_STALE_MS = 3 * 60 * 1000; // no progress for this long = the job died (browser closed etc.)

export async function getJob() {
  return getItem(JOB_KEY, null, 'session');
}

async function publish(job) {
  await setItem(JOB_KEY, { ...job, updatedAt: Date.now() }, 'session');
}

export function isJobActive(job, now = Date.now()) {
  return !!job && job.state === 'running' && now - (job.updatedAt || 0) < JOB_STALE_MS;
}

export async function runTranscriptionJob(meetingId, { onlyFailed = false } = {}) {
  const current = await getJob();
  if (isJobActive(current)) {
    return { alreadyRunning: true, meetingId: current.meetingId };
  }
  const job = { meetingId, state: 'running', message: 'Starting transcription…', onlyFailed };
  await publish(job);
  // Keep the service worker awake while waiting on long provider calls.
  const keepAlive = setInterval(() => { chrome.runtime.getPlatformInfo?.(() => {}); publish({ ...job }); }, 20000);
  try {
    const result = await runTranscription(meetingId, {
      transcribeChunk: async (chunk, previousText) => {
        const mime = (chunk.mime || 'audio/webm').split(';')[0];
        const ext = { 'audio/wav': 'wav', 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3' }[mime] || 'webm';
        return transcribe({ audioBase64: await toBase64(chunk.data), mime, fileName: `part-${chunk.index + 1}.${ext}`, prompt: previousText, durationSec: chunk.durationSec });
      },
      onProgress: (p) => { job.message = p.message; job.progress = { index: p.index, total: p.total }; publish(job); },
    }, { onlyFailed });
    await publish({ meetingId, state: 'done', result, message: '' });
    return result;
  } catch (err) {
    await publish({ meetingId, state: 'error', message: friendlyError(err), code: err.code });
    throw err;
  } finally {
    clearInterval(keepAlive);
  }
}
