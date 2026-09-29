// Audio helpers for importing recordings: format checks, splitting into transcription-sized chunks,
// and 16 kHz mono WAV encoding (the format Groq's Whisper models work with best).

export const IMPORT_LIMITS = Object.freeze({
  maxFileBytes: 300 * 1024 * 1024, // file is decoded in memory by the browser
  maxDurationSec: 2 * 60 * 60,
});

// What the browser's own decoder can open. Chrome and Edge include AAC (M4A/MP4) and MP3 decoders;
// open-source Chromium builds do not include AAC.
export const IMPORT_FORMATS = [
  { ext: 'm4a', label: 'M4A (Zoom “audio only” recording)' },
  { ext: 'mp4', label: 'MP4 video (audio track is used)' },
  { ext: 'mp3', label: 'MP3' },
  { ext: 'wav', label: 'WAV' },
  { ext: 'webm', label: 'WebM' },
  { ext: 'ogg', label: 'OGG / Opus' },
  { ext: 'flac', label: 'FLAC' },
];

export const TARGET_SAMPLE_RATE = 16000;
export const DEFAULT_IMPORT_CHUNK_SEC = 300; // 5 min of 16 kHz mono WAV = 9.6 MB (Groq limit: 25 MB)

export function checkImportFile(file) {
  const ext = String(file.name || '').toLowerCase().split('.').pop();
  const known = IMPORT_FORMATS.some((f) => f.ext === ext);
  const typeOk = /^(audio|video)\//.test(file.type || '');
  if (!known && !typeOk) return `“${file.name}” is not a supported audio or video file. Supported: ${IMPORT_FORMATS.map((f) => f.ext.toUpperCase()).join(', ')}.`;
  if (file.size === 0) return 'The file is empty.';
  if (file.size > IMPORT_LIMITS.maxFileBytes) {
    return `The file is ${formatBytes(file.size)}; the limit is ${formatBytes(IMPORT_LIMITS.maxFileBytes)}. For Zoom, import the smaller “audio only” M4A file instead of the MP4 video.`;
  }
  return '';
}

/** Splits [0, durationSec) into consecutive chunks of at most chunkSec (a tiny last chunk is merged). */
export function planChunks(durationSec, chunkSec = DEFAULT_IMPORT_CHUNK_SEC) {
  const out = [];
  let start = 0;
  while (start < durationSec - 1e-6) {
    let end = Math.min(durationSec, start + chunkSec);
    if (durationSec - end < 2) end = durationSec; // avoid a sub-2-second tail chunk
    out.push({ index: out.length, startSec: start, durationSec: end - start });
    start = end;
  }
  return out;
}

/** Mixes channels [Float32Array,...] down to mono for the sample range [from, to). */
export function downmix(channels, from, to) {
  const n = Math.max(0, to - from);
  const out = new Float32Array(n);
  for (const ch of channels) for (let i = 0; i < n; i++) out[i] += ch[from + i] / channels.length;
  return out;
}

/** Linear resampling (used only if the decoder did not already resample to 16 kHz). */
export function resample(samples, fromRate, toRate) {
  if (fromRate === toRate) return samples;
  const ratio = fromRate / toRate;
  const n = Math.floor(samples.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, samples.length - 1);
    out[i] = samples[i0] + (samples[i1] - samples[i0]) * (pos - i0);
  }
  return out;
}

/** 16-bit PCM mono WAV. Returns a Uint8Array. */
export function encodeWav(samples, sampleRate = TARGET_SAMPLE_RATE) {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const v = new DataView(bytes.buffer);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return bytes;
}

export function formatBytes(n) {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} bytes`;
}

/**
 * Browser-only: decodes an audio/video file and returns WAV chunks via onChunk (called in order).
 * The browser decoder resamples to 16 kHz as it decodes, which keeps memory use manageable.
 */
export async function decodeAndSplit(file, { chunkSec = DEFAULT_IMPORT_CHUNK_SEC, onChunk, onProgress = () => {} } = {}) {
  const problem = checkImportFile(file);
  if (problem) throw new Error(problem);
  onProgress('Reading file…');
  const data = await file.arrayBuffer();
  onProgress('Decoding audio (this can take a minute for long recordings)…');
  let buffer;
  try {
    const ctx = new OfflineAudioContext(1, 1, TARGET_SAMPLE_RATE);
    buffer = await ctx.decodeAudioData(data);
  } catch {
    throw new Error(`This browser could not decode “${file.name}”. Try the M4A/MP3/WAV version of the recording.`);
  }
  if (buffer.duration > IMPORT_LIMITS.maxDurationSec) {
    throw new Error(`The recording is ${Math.round(buffer.duration / 60)} minutes long; the limit for imports is ${IMPORT_LIMITS.maxDurationSec / 3600} hours. Split it into parts first.`);
  }
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  const rate = buffer.sampleRate;
  const plan = planChunks(buffer.duration, chunkSec);
  for (const c of plan) {
    onProgress(`Preparing chunk ${c.index + 1} of ${plan.length}…`);
    const from = Math.floor(c.startSec * rate);
    const to = Math.min(channels[0].length, Math.floor((c.startSec + c.durationSec) * rate));
    const mono = resample(downmix(channels, from, to), rate, TARGET_SAMPLE_RATE);
    await onChunk({ ...c, bytes: encodeWav(mono), mime: 'audio/wav' });
  }
  return { durationSec: buffer.duration, chunkCount: plan.length };
}
