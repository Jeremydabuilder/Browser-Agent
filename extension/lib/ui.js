// DOM helpers shared by the side panel, settings and memory pages.
// All text (including AI output and page content) is inserted as text nodes - never as HTML.
import { getItem, setItem } from './storage.js';
import { getSettings } from './settings.js';
import { isHttpUrl } from './util.js';

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
    else if (k === 'href') { if (isHttpUrl(v) || String(v).startsWith('#') || String(v).startsWith('chrome-extension:')) el.setAttribute('href', v); }
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function link(url, text, cls = '') {
  if (!isHttpUrl(url)) return h('span', { class: cls }, text || url || '');
  return h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', class: cls, title: url }, text || url);
}

let toastTimer;
export function toast(message, kind = 'info') {
  let el = document.getElementById('toast');
  if (!el) { el = h('div', { id: 'toast', role: 'status', 'aria-live': 'polite' }); document.body.append(el); }
  el.className = `toast show ${kind}`;
  el.textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, kind === 'error' ? 7000 : 3500);
}

/** Generic modal. Resolves with the value of the clicked action (or null when dismissed). */
export function modal({ title, body, actions = [{ label: 'OK', value: true, kind: 'primary' }], wide = false }) {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const close = (value) => { overlay.remove(); document.removeEventListener('keydown', onKey); prevFocus?.focus?.(); resolve(value); };
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    const footer = h('div', { class: 'modal-actions' }, actions.map((a) => h('button', {
      class: `btn ${a.kind || ''}`,
      disabled: a.disabled,
      dataset: { value: String(a.value) },
      onclick: async () => {
        if (a.validate) { const ok = await a.validate(); if (!ok) return; }
        close(typeof a.value === 'function' ? a.value() : a.value);
      },
    }, a.label)));
    const dialog = h('div', { class: `modal ${wide ? 'wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('h2', { class: 'modal-title' }, title), h('div', { class: 'modal-body' }, body), footer);
    const overlay = h('div', { class: 'overlay', onclick: (e) => { if (e.target === overlay) close(null); } }, dialog);
    document.body.append(overlay);
    document.addEventListener('keydown', onKey);
    (dialog.querySelector('input:not([type=checkbox]):not([type=file]), textarea, select') || footer.querySelector('.primary') || footer.querySelector('button'))?.focus();
  });
}

export async function confirmDialog({ title, message, details, confirmLabel = 'Confirm', danger = false }) {
  const body = h('div', {}, message ? h('p', {}, message) : null, details || null);
  return (await modal({ title, body, actions: [{ label: 'Cancel', value: false }, { label: confirmLabel, value: true, kind: danger ? 'danger' : 'primary' }] })) === true;
}

/**
 * Tells the user exactly what is about to be sent to Groq, and asks first (unless they turned that off
 * in Settings or chose "don't ask again" for this browser session).
 */
export async function confirmSendToAI({ what, items = [], approxWords, extra }) {
  const settings = await getSettings();
  if (!settings.confirmBeforeSending) return true;
  if (await getItem('consentSkip', false, 'session')) return true;
  const skip = h('input', { type: 'checkbox', id: 'consent-skip' });
  const body = h('div', { class: 'consent' },
    h('p', {}, `Satchel is about to send ${what} to Groq (your AI provider) through the Satchel companion on your PC.`),
    items.length ? h('ul', { class: 'consent-list' }, items.map((i) => h('li', {}, i.url ? link(i.url, i.title || i.url) : i.title, i.words ? h('span', { class: 'muted' }, ` · about ${i.words.toLocaleString()} words`) : null))) : null,
    approxWords ? h('p', { class: 'muted' }, `About ${approxWords.toLocaleString()} words in total.`) : null,
    extra ? h('p', { class: 'muted' }, extra) : null,
    h('p', { class: 'muted small' }, 'Groq processes this text to produce the answer. Nothing is saved to your memory unless you choose to save it.'),
    h('label', { class: 'check' }, skip, ' Don\'t ask again until I restart the browser'),
  );
  const ok = await modal({ title: 'Send to AI?', body, actions: [{ label: 'Cancel', value: false }, { label: 'Send to Groq', value: true, kind: 'primary' }] });
  if (ok && skip.checked) await setItem('consentSkip', true, 'session');
  return ok === true;
}

/** Minimal, safe Markdown-ish rendering: paragraphs, bullet lists, **bold**, and http(s) links. */
export function renderRichText(text) {
  const frag = document.createDocumentFragment();
  const blocks = String(text || '').replace(/\r/g, '').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n');
    if (lines.every((l) => /^\s*([-*•]|\d+\.)\s+/.test(l))) {
      frag.append(h('ul', {}, lines.map((l) => h('li', {}, inline(l.replace(/^\s*([-*•]|\d+\.)\s+/, ''))))));
    } else {
      frag.append(h('p', {}, lines.flatMap((l, i) => (i ? [h('br'), ...inline(l)] : inline(l)))));
    }
  }
  return frag;
}

function inline(text) {
  const out = [];
  const re = /\*\*([^*]+)\*\*|(https?:\/\/[^\s)]+)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(h('strong', {}, m[1]));
    else out.push(link(m[2], m[2]));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function sourceChip(s) {
  return link(s.url, s.id, 'chip source-chip');
}

/** Renders a grounded answer: facts (with sources) are visually separated from the AI's inference. */
export function renderGroundedAnswer(r, { onSaveMemory } = {}) {
  const wrap = h('div', { class: 'grounded' });
  if (r.nothingRead) {
    wrap.append(h('p', { class: 'warn' }, 'Satchel could not read any of the chosen pages, so it did not ask the AI anything.'));
  }
  if (r.answer) wrap.append(h('div', { class: 'answer' }, renderRichText(r.answer)));
  if (r.facts?.length) {
    wrap.append(h('h4', { class: 'section-label facts-label' }, 'From the page', r.sources?.length > 1 ? 's' : '', ' (retrieved)'));
    wrap.append(h('ul', { class: 'facts' }, r.facts.map((f) => h('li', {},
      h('span', {}, f.claim, ' '),
      f.sources.map(sourceChip),
      f.quote ? h('div', { class: `quote ${f.verified ? 'ok' : 'unverified'}` },
        f.verified ? '✓ ' : '⚠ ', `“${f.quote}”`,
        f.verified ? null : h('span', { class: 'muted small' }, ' (this exact quote was not found on the page; treat with caution)')) : null,
    ))));
  }
  if (r.inferences?.length) {
    wrap.append(h('h4', { class: 'section-label inference-label' }, 'Satchel\'s inference (not stated on the page)'));
    wrap.append(h('ul', { class: 'inferences' }, r.inferences.map((i) => h('li', {}, i.claim, i.basis ? h('span', { class: 'muted small' }, ` (${i.basis})`) : null))));
  }
  if (r.unanswered?.length) {
    wrap.append(h('h4', { class: 'section-label' }, 'Not answered by these pages'));
    wrap.append(h('ul', { class: 'unanswered' }, r.unanswered.map((u) => h('li', {}, u))));
  }
  if (r.sources?.length) {
    wrap.append(h('div', { class: 'sources' }, h('span', { class: 'muted small' }, 'Sources read: '),
      r.sources.map((s) => h('span', { class: 'source-item' }, h('b', {}, `${s.id} `), link(s.url, s.title)))));
  }
  if (r.unreadable?.length) {
    wrap.append(h('div', { class: 'unreadable' }, h('b', {}, 'Could not read (not used): '),
      h('ul', {}, r.unreadable.map((u) => h('li', {}, link(u.url, u.title), h('span', { class: 'muted small' }, ` - ${u.reason}`))))));
  }
  const meta = [];
  if (r.parts) meta.push(`Long page read in ${r.parts} parts.`);
  else if (r.trimmed) meta.push('Long pages: only the most relevant passages were sent.');
  if (r.model) meta.push(`Model: ${r.model}`);
  for (const n of r.notices || []) wrap.append(h('p', { class: 'notice' }, n));
  wrap.append(h('div', { class: 'answer-footer' },
    h('span', { class: 'muted small' }, meta.join(' · ')),
    onSaveMemory ? h('button', { class: 'btn link small', onclick: onSaveMemory }, 'Save a note to memory…') : null));
  return wrap;
}

export async function saveMemoryDialog({ prefill = '', addMemory, kinds = ['preference', 'project', 'fact'] }) {
  const kind = h('select', { 'aria-label': 'Memory type' }, kinds.map((k) => h('option', { value: k }, k[0].toUpperCase() + k.slice(1))));
  kind.value = 'fact';
  const text = h('textarea', { rows: 4, maxlength: 500, placeholder: 'Write the key point in your own words (max 500 characters).' });
  text.value = prefill.slice(0, 500);
  const counter = h('span', { class: 'muted small' }, `${text.value.length}/500`);
  text.addEventListener('input', () => { counter.textContent = `${text.value.length}/500`; });
  const error = h('p', { class: 'error small' });
  const body = h('div', { class: 'form' },
    h('p', { class: 'muted small' }, 'Memories are short notes Satchel can use in future answers. You can review, edit, export, or delete them on the Memory page.'),
    h('label', {}, 'Type ', kind), text, counter, error);
  const res = await modal({
    title: 'Save to memory',
    body,
    actions: [{ label: 'Cancel', value: null }, {
      label: 'Save memory', kind: 'primary', value: () => true,
      validate: async () => {
        try { await addMemory({ kind: kind.value, text: text.value }); return true; } catch (e) { error.textContent = e.message; return false; }
      },
    }],
  });
  if (res) toast('Saved to memory.');
  return res;
}

export function spinner(text = 'Working…') {
  return h('div', { class: 'spinner-row' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('span', { class: 'spinner-text' }, text));
}
