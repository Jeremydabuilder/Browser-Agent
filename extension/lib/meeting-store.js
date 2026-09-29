// Local storage for meetings (IndexedDB, in this browser profile only).
//   meetings: one record per meeting (title, status, notes, consent timestamps)
//   chunks:   one record per audio chunk: the audio itself plus that chunk's transcript
//   pieces:   small pieces of the chunk currently being recorded (crash safety; merged into a chunk on save)
// Raw audio, transcript and notes can each be deleted independently.

const DB_NAME = 'satchel-meetings';
const DB_VERSION = 1;
let factory = globalThis.indexedDB;
let dbPromise = null;

export function setIndexedDB(f) {
  factory = f;
  dbPromise = null;
}

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const r = factory.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore('meetings', { keyPath: 'id' });
      const chunks = db.createObjectStore('chunks', { keyPath: ['meetingId', 'index'] });
      chunks.createIndex('byMeeting', 'meetingId');
      const pieces = db.createObjectStore('pieces', { keyPath: ['meetingId', 'seg', 'seq'] });
      pieces.createIndex('byMeeting', 'meetingId');
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => { dbPromise = null; reject(r.error); };
  });
  return dbPromise;
}

async function tx(stores, mode, fn) {
  const db = await open();
  const t = db.transaction(stores, mode);
  const result = await fn(...(Array.isArray(stores) ? stores : [stores]).map((s) => t.objectStore(s)));
  await new Promise((resolve, reject) => {
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transaction aborted'));
  });
  return result;
}

// ---- meetings ----
export async function putMeeting(m) {
  const record = { ...m, updatedAt: new Date().toISOString() };
  await tx('meetings', 'readwrite', (s) => req(s.put(record)));
  return record;
}

export async function getMeeting(id) {
  return tx('meetings', 'readonly', (s) => req(s.get(id)));
}

export async function updateMeeting(id, patch) {
  const m = await getMeeting(id);
  if (!m) throw new Error('Meeting not found.');
  return putMeeting({ ...m, ...(typeof patch === 'function' ? patch(m) : patch) });
}

export async function listMeetings() {
  const all = await tx('meetings', 'readonly', (s) => req(s.getAll()));
  return all.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

// ---- chunks ----
export async function putChunk(c) {
  await tx('chunks', 'readwrite', (s) => req(s.put(c)));
  return c;
}

export async function getChunk(meetingId, index) {
  return tx('chunks', 'readonly', (s) => req(s.get([meetingId, index])));
}

export async function updateChunk(meetingId, index, patch) {
  return tx('chunks', 'readwrite', async (s) => {
    const c = await req(s.get([meetingId, index]));
    if (!c) throw new Error(`Chunk ${index} not found.`);
    const next = { ...c, ...(typeof patch === 'function' ? patch(c) : patch) };
    await req(s.put(next));
    return next;
  });
}

/** Chunks of a meeting, always in recording order. */
export async function listChunks(meetingId) {
  const all = await tx('chunks', 'readonly', (s) => req(s.index('byMeeting').getAll(meetingId)));
  return all.sort((a, b) => a.index - b.index);
}

// ---- pieces (in-progress recording) ----
export async function addPiece(p) {
  await tx('pieces', 'readwrite', (s) => req(s.put(p)));
}

export async function listPieces(meetingId) {
  const all = await tx('pieces', 'readonly', (s) => req(s.index('byMeeting').getAll(meetingId)));
  return all.sort((a, b) => a.seg - b.seg || a.seq - b.seq);
}

export async function deletePieces(meetingId, seg) {
  await tx('pieces', 'readwrite', async (s) => {
    const all = await req(s.index('byMeeting').getAll(meetingId));
    for (const p of all) if (seg === undefined || p.seg === seg) await req(s.delete([p.meetingId, p.seg, p.seq]));
  });
}

// ---- deletion (each part separately) ----
export async function deleteAudio(meetingId) {
  await tx(['chunks', 'pieces'], 'readwrite', async (chunks, pieces) => {
    for (const c of await req(chunks.index('byMeeting').getAll(meetingId))) {
      await req(chunks.put({ ...c, data: null, hasAudio: false, size: 0, status: c.status === 'done' ? 'done' : 'no-audio' }));
    }
    for (const p of await req(pieces.index('byMeeting').getAll(meetingId))) await req(pieces.delete([p.meetingId, p.seg, p.seq]));
  });
  await updateMeeting(meetingId, { audioDeletedAt: new Date().toISOString() });
}

export async function deleteTranscript(meetingId) {
  await tx('chunks', 'readwrite', async (chunks) => {
    for (const c of await req(chunks.index('byMeeting').getAll(meetingId))) {
      await req(chunks.put({ ...c, transcript: null, status: c.hasAudio ? 'pending' : 'no-audio', error: '', attempts: 0 }));
    }
  });
  await updateMeeting(meetingId, { transcriptReviewedAt: null, transcriptDeletedAt: new Date().toISOString() });
}

export async function deleteNotes(meetingId) {
  await updateMeeting(meetingId, { notes: null });
}

export async function deleteMeeting(meetingId) {
  await tx(['meetings', 'chunks', 'pieces'], 'readwrite', async (meetings, chunks, pieces) => {
    for (const c of await req(chunks.index('byMeeting').getAll(meetingId))) await req(chunks.delete([c.meetingId, c.index]));
    for (const p of await req(pieces.index('byMeeting').getAll(meetingId))) await req(pieces.delete([p.meetingId, p.seg, p.seq]));
    await req(meetings.delete(meetingId));
  });
}

export function dataSize(data) {
  if (!data) return 0;
  return data.size ?? data.byteLength ?? data.length ?? 0;
}
