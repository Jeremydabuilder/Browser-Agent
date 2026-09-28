import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setStorageBackend, createMemoryBackend } from '../../extension/lib/storage.js';
import * as mem from '../../extension/lib/memory.js';

let backend;
beforeEach(() => { backend = createMemoryBackend(); setStorageBackend(backend); });

test('adds, lists, edits and deletes memories', async () => {
  const a = await mem.addMemory({ kind: 'preference', text: 'I prefer bullet-point summaries.' });
  await mem.addMemory({ kind: 'project', text: 'Science fair project on plant growth, due in November.' });
  assert.equal((await mem.listMemories()).length, 2);
  const edited = await mem.updateMemory(a.id, { text: 'I prefer short bullet-point summaries.', useInAI: false });
  assert.equal(edited.text, 'I prefer short bullet-point summaries.');
  assert.equal(edited.useInAI, false);
  await mem.deleteMemory(a.id);
  assert.equal((await mem.listMemories()).length, 1);
  await mem.deleteAllMemories();
  assert.equal((await mem.listMemories()).length, 0);
});

test('rejects empty, oversized (whole page / email) and invalid memories', async () => {
  await assert.rejects(mem.addMemory({ kind: 'fact', text: '   ' }), /empty/);
  await assert.rejects(mem.addMemory({ kind: 'fact', text: 'x'.repeat(501) }), /short notes/);
  await assert.rejects(mem.addMemory({ kind: 'secret', text: 'hello' }), /Choose a type/);
  await mem.addMemory({ kind: 'fact', text: 'My locker is 214.' });
  await assert.rejects(mem.addMemory({ kind: 'fact', text: 'my locker is  214.' }), /already saved/);
  const [m] = await mem.listMemories();
  await assert.rejects(mem.updateMemory(m.id, { text: 'y'.repeat(600) }), /short notes/);
});

test('only memories marked for AI use are included, and the global switch disables all', async () => {
  const a = await mem.addMemory({ kind: 'preference', text: 'Explain things simply.' });
  await mem.addMemory({ kind: 'fact', text: 'I take AP Biology.' });
  await mem.updateMemory(a.id, { useInAI: false });
  assert.deepEqual(await mem.memoriesForAI(true), [{ kind: 'fact', text: 'I take AP Biology.' }]);
  assert.deepEqual(await mem.memoriesForAI(false), []);
});

test('export and import round-trip with validation', async () => {
  await mem.addMemory({ kind: 'fact', text: 'Soccer practice on Tuesdays.' });
  const json = await mem.exportMemories();
  const parsed = JSON.parse(json);
  assert.equal(parsed.format, 'satchel-memories');
  await mem.deleteAllMemories();
  parsed.memories.push({ kind: 'fact', text: 'z'.repeat(2000) }, { kind: 'bogus', text: 'x' });
  const r = await mem.importMemories(JSON.stringify(parsed));
  assert.deepEqual(r, { added: 1, skipped: 2 });
  await assert.rejects(mem.importMemories('not json'), /not valid JSON/);
  await assert.rejects(mem.importMemories('{"a":1}'), /not a Satchel/);
});

test('conversation history is separate from memory and lives in session storage', async () => {
  await mem.appendConversation({ role: 'user', text: 'What is due today?' });
  await mem.appendConversation({ role: 'assistant', text: 'Two things.' });
  assert.equal((await mem.getConversation()).length, 2);
  assert.equal((await mem.listMemories()).length, 0, 'chatting never creates memories');
  assert.equal(backend.local.data.has('conversation'), false, 'chat is not in durable storage');
  assert.equal(backend.session.data.get('conversation').length, 2);
  await mem.clearConversation();
  assert.equal((await mem.getConversation()).length, 0);
  for (let i = 0; i < 60; i++) await mem.appendConversation({ role: 'user', text: `m${i}` });
  assert.equal((await mem.getConversation()).length, 40, 'history is capped');
});
