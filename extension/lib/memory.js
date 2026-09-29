// Durable memory: short notes the USER chose to save (preferences, ongoing projects, useful facts).
// Kept separate from conversation history (which lives in session storage and is cleared on exit).
// Memories are never created automatically; entire pages/emails cannot be saved as memory.
import { getItem, setItem } from './storage.js';
import { uid, collapseWhitespace } from './util.js';

export const MEMORY_KINDS = ['preference', 'project', 'fact'];
export const MAX_MEMORY_CHARS = 500;
export const MAX_MEMORIES = 300;
const KEY = 'memories';

export function validateMemoryInput({ kind, text }) {
  const errors = [];
  if (!MEMORY_KINDS.includes(kind)) errors.push('Choose a type: preference, project, or fact.');
  const t = String(text ?? '').trim();
  if (!t) errors.push('A memory cannot be empty.');
  if (t.length > MAX_MEMORY_CHARS) {
    errors.push(`Memories are short notes (max ${MAX_MEMORY_CHARS} characters). Write the key point in your own words instead of pasting a page or email.`);
  }
  return errors;
}

export async function listMemories() {
  return getItem(KEY, []);
}

export async function addMemory({ kind, text, source = 'you' }, now = new Date()) {
  const errors = validateMemoryInput({ kind, text });
  if (errors.length) throw new Error(errors.join(' '));
  const list = await listMemories();
  if (list.length >= MAX_MEMORIES) throw new Error(`You have ${MAX_MEMORIES} memories. Delete some before adding more.`);
  const clean = String(text).trim();
  if (list.some((m) => collapseWhitespace(m.text).toLowerCase() === collapseWhitespace(clean).toLowerCase())) {
    throw new Error('You already saved this memory.');
  }
  const memory = { id: uid('mem'), kind, text: clean, useInAI: true, source: String(source).slice(0, 80), createdAt: now.toISOString(), updatedAt: now.toISOString() };
  await setItem(KEY, [...list, memory]);
  return memory;
}

export async function updateMemory(id, patch, now = new Date()) {
  const list = await listMemories();
  const idx = list.findIndex((m) => m.id === id);
  if (idx < 0) throw new Error('Memory not found.');
  const next = { ...list[idx] };
  if ('kind' in patch) next.kind = patch.kind;
  if ('text' in patch) next.text = String(patch.text).trim();
  if ('useInAI' in patch) next.useInAI = !!patch.useInAI;
  const errors = validateMemoryInput(next);
  if (errors.length) throw new Error(errors.join(' '));
  next.updatedAt = now.toISOString();
  list[idx] = next;
  await setItem(KEY, list);
  return next;
}

export async function deleteMemory(id) {
  const list = await listMemories();
  await setItem(KEY, list.filter((m) => m.id !== id));
}

export async function deleteAllMemories() {
  await setItem(KEY, []);
}

export async function exportMemories(now = new Date()) {
  const list = await listMemories();
  return JSON.stringify({ format: 'satchel-memories', version: 1, exportedAt: now.toISOString(), memories: list }, null, 2);
}

/** Imports an export file. Each entry is re-validated; invalid or duplicate entries are skipped. */
export async function importMemories(json, now = new Date()) {
  let data;
  try { data = JSON.parse(json); } catch { throw new Error('That file is not valid JSON.'); }
  if (data?.format !== 'satchel-memories' || !Array.isArray(data.memories)) throw new Error('That file is not a Satchel memory export.');
  let added = 0;
  let skipped = 0;
  for (const m of data.memories) {
    try {
      await addMemory({ kind: m.kind, text: m.text, source: 'import' }, now);
      added++;
    } catch {
      skipped++;
    }
  }
  return { added, skipped };
}

/** Memories that may be included in AI requests (user can switch each one, or all, off). */
export async function memoriesForAI(enabled = true) {
  if (!enabled) return [];
  return (await listMemories()).filter((m) => m.useInAI).map(({ kind, text }) => ({ kind, text }));
}

// ---- Conversation history (NOT memory): session-only, capped, cleared when the browser closes ----
const CHAT_KEY = 'conversation';
const MAX_TURNS = 40;

export async function getConversation() {
  return getItem(CHAT_KEY, [], 'session');
}

export async function appendConversation(entry) {
  const list = await getConversation();
  const next = [...list, { ...entry, at: new Date().toISOString() }].slice(-MAX_TURNS);
  await setItem(CHAT_KEY, next, 'session');
  return next;
}

export async function clearConversation() {
  await setItem(CHAT_KEY, [], 'session');
}
