import { listMemories, addMemory, updateMemory, deleteMemory, deleteAllMemories, exportMemories, importMemories, MEMORY_KINDS } from '../lib/memory.js';
import { h, clear, toast, confirmDialog } from '../lib/ui.js';

const $ = (id) => document.getElementById(id);
const editing = new Set();

async function render() {
  const all = await listMemories();
  const q = $('filter').value.trim().toLowerCase();
  const kind = $('kind-filter').value;
  const list = all.filter((m) => (!kind || m.kind === kind) && (!q || m.text.toLowerCase().includes(q)));
  const wrap = $('list');
  clear(wrap);
  if (!all.length) { wrap.append(h('div', { class: 'empty' }, 'No memories yet.')); return; }
  if (!list.length) { wrap.append(h('div', { class: 'empty' }, 'No memories match.')); return; }
  for (const m of [...list].reverse()) {
    const isEditing = editing.has(m.id);
    const useToggle = h('input', { type: 'checkbox', checked: m.useInAI, onchange: async (e) => { await updateMemory(m.id, { useInAI: e.target.checked }); toast(e.target.checked ? 'Will be used in AI requests.' : 'Will not be sent to the AI.'); } });
    const head = h('div', { class: 'mem-head' }, h('span', { class: 'chip accent' }, m.kind), h('span', {}, `Saved ${new Date(m.createdAt).toLocaleString()}${m.updatedAt !== m.createdAt ? ` · edited ${new Date(m.updatedAt).toLocaleString()}` : ''}${m.source && m.source !== 'you' ? ` · from ${m.source}` : ''}`),
      h('label', { class: 'check', style: 'margin:0 0 0 auto;font-size:12px' }, useToggle, 'Use in AI'));
    if (isEditing) {
      const kindSel = h('select', { style: 'width:auto' }, MEMORY_KINDS.map((k) => h('option', { value: k }, k)));
      kindSel.value = m.kind;
      const text = h('textarea', { rows: 3, maxlength: 500 });
      text.value = m.text;
      const err = h('p', { class: 'error small' });
      wrap.append(h('div', { class: 'mem' }, head, kindSel, text, err, h('div', { class: 'btn-row' },
        h('button', { class: 'btn primary small', onclick: async () => { try { await updateMemory(m.id, { kind: kindSel.value, text: text.value }); editing.delete(m.id); render(); toast('Saved.'); } catch (e) { err.textContent = e.message; } } }, 'Save'),
        h('button', { class: 'btn small', onclick: () => { editing.delete(m.id); render(); } }, 'Cancel'))));
    } else {
      wrap.append(h('div', { class: 'mem' }, head, h('div', { class: 'mem-text' }, m.text), h('div', { class: 'btn-row' },
        h('button', { class: 'btn small', onclick: () => { editing.add(m.id); render(); } }, 'Edit'),
        h('button', { class: 'btn small', onclick: async () => { await deleteMemory(m.id); toast('Memory deleted.'); render(); } }, 'Delete'))));
    }
  }
}

$('add').onclick = async () => {
  $('add-error').textContent = '';
  try {
    await addMemory({ kind: $('new-kind').value, text: $('new-text').value });
    $('new-text').value = '';
    toast('Memory saved.');
    render();
  } catch (e) {
    $('add-error').textContent = e.message;
  }
};
$('new-text').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('add').click(); });
$('filter').oninput = render;
$('kind-filter').onchange = render;
$('export').onclick = async () => {
  const url = URL.createObjectURL(new Blob([await exportMemories()], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `satchel-memories-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
$('import-file').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const r = await importMemories(await file.text());
    toast(`Imported ${r.added} memories${r.skipped ? `, skipped ${r.skipped} (duplicates or invalid)` : ''}.`);
    render();
  } catch (err) {
    toast(err.message, 'error');
  }
  e.target.value = '';
};
$('delete-all').onclick = async () => {
  if (await confirmDialog({ title: 'Delete all memories?', message: 'This cannot be undone. Consider exporting first.', confirmLabel: 'Delete all', danger: true })) {
    await deleteAllMemories();
    toast('All memories deleted.');
    render();
  }
};
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.memories && !editing.size) render(); });
render();
