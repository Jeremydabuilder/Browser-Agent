// User settings (non-secret). The Groq API key is NEVER stored here - it lives in the Windows companion.
import { getItem, setItem } from './storage.js';

export const DEFAULT_SETTINGS = Object.freeze({
  model: 'auto', // 'auto' or a Groq model id chosen from the live model list
  maxInputTokens: 6000, // per-request budget for page/email text (keeps within Groq free-tier limits)
  requestTimeoutSec: 60,
  confirmBeforeSending: true, // ask before sending page/email text to Groq
  dateOrder: 'MDY', // how to read 03/04 style dates: MDY (US) or DMY
  useMemoriesInAI: true,
  googleClientId: '',
  transcriptionModel: 'auto', // 'auto' or a Groq Whisper model id from the live list
  transcriptionLanguage: '', // '' = let the model detect it, or a two-letter code like 'en'
  meetingSegmentSec: 300, // recorded meetings are saved as standalone 5-minute audio chunks
  importChunkSec: 300, // imported recordings are split into 5-minute 16 kHz WAV chunks (~9.6 MB)
});

export async function getSettings() {
  const stored = await getItem('settings', {});
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function updateSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  if (!['MDY', 'DMY'].includes(next.dateOrder)) next.dateOrder = 'MDY';
  next.maxInputTokens = Math.min(Math.max(Number(next.maxInputTokens) || 6000, 1000), 100000);
  next.requestTimeoutSec = Math.min(Math.max(Number(next.requestTimeoutSec) || 60, 10), 180);
  if (typeof next.model !== 'string' || !next.model.trim()) next.model = 'auto';
  if (typeof next.transcriptionModel !== 'string' || !next.transcriptionModel.trim()) next.transcriptionModel = 'auto';
  if (!/^([a-z]{2})?$/.test(next.transcriptionLanguage || '')) next.transcriptionLanguage = '';
  next.meetingSegmentSec = Math.min(Math.max(Number(next.meetingSegmentSec) || 300, 10), 600);
  next.importChunkSec = Math.min(Math.max(Number(next.importChunkSec) || 300, 10), 600);
  await setItem('settings', next);
  return next;
}
