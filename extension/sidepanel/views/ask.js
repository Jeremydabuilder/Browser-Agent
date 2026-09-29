// "Ask" view: summarize the current page, answer questions grounded in it, compare selected tabs,
// research across selected tabs, or chat without any page.
import { h, clear, toast, errorBox, confirmSendToAI, renderGroundedAnswer, renderRichText, saveMemoryDialog, spinner } from '../../lib/ui.js';
import { readTab, requestSiteAccess, unreadableReason } from '../../lib/browser.js';
import { runGroundedTask, describeOutgoing, buildSources } from '../../lib/research.js';
import { chat } from '../../lib/ai.js';
import { getSettings } from '../../lib/settings.js';
import { addMemory, memoriesForAI, getConversation, appendConversation, clearConversation } from '../../lib/memory.js';
import { generalChatSystemPrompt } from '../../lib/prompts.js';
import { hostnameOf } from '../../lib/util.js';

let root;
let app;
const state = { scope: 'page', selected: new Set(), tabs: [], busy: false };
let els = {};

export function init(container, appRef) {
  root = container;
  app = appRef;
  render();
  app.onTargetTab(() => { updateContextLine(); if (state.scope === 'tabs') loadTabs(); });
  restoreConversation();
}

export function show() {
  if (state.scope === 'tabs') loadTabs();
  updateContextLine();
}

function render() {
  clear(root);
  const scopeBtn = (key, label) => h('button', { 'aria-pressed': String(state.scope === key), dataset: { scope: key }, onclick: () => setScope(key) }, label);
  els.scope = h('div', { class: 'scope', role: 'group', 'aria-label': 'What should Satchel look at?' },
    scopeBtn('page', 'This page'), scopeBtn('tabs', 'Selected tabs'), scopeBtn('none', 'No page'));
  els.context = h('div', { class: 'context-line' });
  els.picker = h('div', { class: 'tab-picker', hidden: true });
  els.quick = h('div', { class: 'btn-row' });
  els.log = h('div', { class: 'chat-log', 'aria-live': 'polite' });
  els.input = h('textarea', { rows: 2, placeholder: 'Ask about this page…', 'aria-label': 'Your question' });
  els.input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  els.input.addEventListener('input', updateOutgoing);
  els.outgoing = h('div', { class: 'outgoing' });
  els.send = h('button', { class: 'btn primary', onclick: () => send() }, 'Send');
  root.append(
    els.scope, els.context, els.picker, els.quick, els.log,
    h('div', { class: 'composer' }, els.input, h('div', { class: 'composer-row' }, els.outgoing,
      h('button', { class: 'btn small', title: 'Clears this conversation. Your saved memories are not affected.', onclick: onClearChat }, 'Clear chat'),
      els.send)),
  );
  renderQuick();
  updateContextLine();
}

function setScope(scope) {
  state.scope = scope;
  for (const b of els.scope.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.scope === scope));
  els.picker.hidden = scope !== 'tabs';
  els.input.placeholder = scope === 'page' ? 'Ask about this page…' : scope === 'tabs' ? 'Ask a research question across the selected tabs…' : 'Ask anything (no page is shared)…';
  if (scope === 'tabs') loadTabs();
  renderQuick();
  updateContextLine();
}

function renderQuick() {
  clear(els.quick);
  if (state.scope === 'page') {
    els.quick.append(h('button', { class: 'btn', onclick: () => runPage('summarize', 'Summarize this page.') }, '📝 Summarize page'));
  } else if (state.scope === 'tabs') {
    els.quick.append(
      h('button', { class: 'btn', onclick: () => runTabs('compare', els.input.value.trim() || 'Compare these pages.') }, '⚖️ Compare selected'),
      h('button', { class: 'btn', onclick: () => { if (!els.input.value.trim()) { els.input.focus(); toast('Type your research question first.'); return; } runTabs('research', els.input.value.trim()); } }, '🔎 Research question'),
    );
  }
}

function updateContextLine() {
  if (!els.context) return;
  const t = app.targetTab;
  clear(els.context);
  if (state.scope === 'page') {
    if (!t) els.context.append('No page is open.');
    else {
      const reason = unreadableReason(t.url);
      els.context.append('Current page: ', h('b', {}, t.title || t.url));
      if (reason) els.context.append(h('span', { class: 'error' }, ` (can't be read: ${reason})`));
    }
  } else if (state.scope === 'tabs') {
    els.context.append(`${state.selected.size} tab(s) selected. Only these pages are read and sent.`);
  } else {
    els.context.append('No page content will be shared, only your message.');
  }
  updateOutgoing();
}

function updateOutgoing() {
  if (!els.outgoing) return;
  const t = app.targetTab;
  let text = '';
  if (state.scope === 'page') text = t ? `Sends to Groq: your question + text of "${(t.title || hostnameOf(t.url)).slice(0, 40)}"` : '';
  else if (state.scope === 'tabs') text = `Sends to Groq: your question + text of ${state.selected.size} selected tab(s)`;
  else text = 'Sends to Groq: your message and recent chat (no pages)';
  els.outgoing.textContent = text;
}

async function loadTabs() {
  const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
  const own = chrome.runtime.getURL('');
  const tabs = (await chrome.tabs.query(win ? { windowId: win.id } : { currentWindow: true })).filter((t) => !String(t.url).startsWith(own));
  state.tabs = tabs;
  for (const id of [...state.selected]) if (!tabs.some((t) => t.id === id)) state.selected.delete(id);
  clear(els.picker);
  if (!tabs.length) { els.picker.append(h('div', { class: 'empty' }, 'No tabs in this window.')); return; }
  for (const t of tabs) {
    const reason = unreadableReason(t.url);
    const cb = h('input', { type: 'checkbox', checked: state.selected.has(t.id), disabled: !!reason, onchange: (e) => { if (e.target.checked) state.selected.add(t.id); else state.selected.delete(t.id); updateContextLine(); } });
    els.picker.append(h('label', { title: reason || t.url }, cb,
      t.favIconUrl && /^https?:|^data:/.test(t.favIconUrl) ? h('img', { class: 'favicon', src: t.favIconUrl, alt: '' }) : h('span', { class: 'favicon' }),
      h('span', { class: 'tab-title' }, t.title || t.url), reason ? h('span', { class: 'chip warn' }, "can't read") : null));
  }
  updateContextLine();
}

function addMessage(role, content, meta = '') {
  const el = h('div', { class: `msg ${role}` }, meta ? h('div', { class: 'meta' }, meta) : null, content);
  els.log.append(el);
  el.scrollIntoView({ block: 'end', behavior: 'smooth' });
  return el;
}

function setBusy(b) {
  state.busy = b;
  els.send.disabled = b;
  for (const btn of els.quick.querySelectorAll('button')) btn.disabled = b;
}

function saveMemoryFrom() {
  return () => saveMemoryDialog({ prefill: '', addMemory });
}

async function send() {
  if (state.busy) return;
  const text = els.input.value.trim();
  if (!text) return;
  if (/^\/remember\b/i.test(text)) {
    els.input.value = '';
    await saveMemoryDialog({ prefill: text.replace(/^\/remember\s*/i, ''), addMemory });
    return;
  }
  if (state.scope === 'page') return runPage('qa', text);
  if (state.scope === 'tabs') return runTabs('research', text);
  return runChat(text);
}

// Permission prompts must start synchronously inside the click, so these functions request site
// access before their first await.
function runPage(task, question) {
  if (state.busy) return;
  const tab = app.targetTab;
  if (!tab) { toast('Open a web page first.', 'error'); return; }
  const reason = unreadableReason(tab.url);
  const access = reason ? Promise.resolve(false) : requestSiteAccess([tab.url]);
  return runGrounded(task, question, [tab], access);
}

function runTabs(task, question) {
  if (state.busy) return;
  const tabs = state.tabs.filter((t) => state.selected.has(t.id));
  if (!tabs.length) { toast('Tick at least one tab first.', 'error'); return; }
  if (task === 'compare' && tabs.length < 2) { toast('Select at least two tabs to compare.', 'error'); return; }
  const access = requestSiteAccess(tabs.filter((t) => !unreadableReason(t.url)).map((t) => t.url));
  return runGrounded(task, question, tabs, access);
}

async function runGrounded(task, question, tabs, accessPromise) {
  setBusy(true);
  els.input.value = '';
  const label = { summarize: 'Summarize', qa: 'Question', compare: 'Compare', research: 'Research' }[task];
  const userMsg = addMessage('user', question, `${label} · ${tabs.length === 1 ? tabs[0].title || tabs[0].url : `${tabs.length} tabs`}`);
  const pending = addMessage('assistant', spinner('Reading the page…'));
  try {
    const granted = await accessPromise.catch(() => false);
    const reads = [];
    for (const t of tabs) {
      if (!granted && !unreadableReason(t.url)) { reads.push({ ok: false, tab: t, reason: 'You did not allow Satchel to read this site.' }); continue; }
      reads.push(await readTab(t));
    }
    const { sources, unreadable } = buildSources(reads);
    if (!sources.length) {
      pending.replaceWith(renderResultMessage({ nothingRead: true, unreadable, sources: [] }, question));
      await appendConversation({ role: 'user', text: question, task });
      await appendConversation({ role: 'assistant', text: 'Could not read any of the chosen pages.', result: { nothingRead: true, unreadable, sources: [] } });
      return;
    }
    const out = describeOutgoing(sources, question);
    const ok = await confirmSendToAI({ what: `your question and the text of ${sources.length === 1 ? 'this page' : `${sources.length} pages`}`, items: out.items, approxWords: out.approxWords,
      extra: unreadable.length ? `${unreadable.length} page(s) could not be read and will not be used.` : '' });
    if (!ok) { pending.replaceWith(h('div', { class: 'msg assistant muted' }, 'Cancelled: nothing was sent.')); return; }
    const status = pending.querySelector('.spinner-text');
    status.textContent = 'Asking the AI…';
    const result = await runGroundedTask(task, question, reads, { onStatus: (s) => { status.textContent = s; } });
    pending.replaceWith(renderResultMessage(result, question));
    await appendConversation({ role: 'user', text: question, task });
    await appendConversation({ role: 'assistant', text: result.answer, result });
  } catch (err) {
    const box = h('div', { class: 'msg error' });
    box.append(errorBox(err, null, { retry: () => { if (state.busy) return; box.remove(); userMsg?.remove(); runGrounded(task, question, tabs, accessPromise); } }));
    pending.replaceWith(box);
  } finally {
    setBusy(false);
  }
}

function renderResultMessage(result, question) {
  return h('div', { class: 'msg assistant' }, renderGroundedAnswer(result, { onSaveMemory: saveMemoryFrom(question) }));
}

async function runChat(text) {
  setBusy(true);
  els.input.value = '';
  const userMsg = addMessage('user', text);
  const pending = addMessage('assistant', spinner('Thinking…'));
  try {
    const settings = await getSettings();
    const memories = await memoriesForAI(settings.useMemoriesInAI);
    const history = (await getConversation()).filter((m) => !m.task && m.text).slice(-8).map((m) => ({ role: m.role, content: m.text.slice(0, 2000) }));
    const status = pending.querySelector('.spinner-text');
    const r = await chat({
      messages: [{ role: 'system', content: generalChatSystemPrompt(memories) }, ...history, { role: 'user', content: text }],
      maxTokens: 1200,
      temperature: 0.4,
      onStatus: (s) => { status.textContent = s; },
    });
    const body = h('div', {}, renderRichText(r.content), ...(r.notices || []).map((n) => h('p', { class: 'notice' }, n)),
      h('div', { class: 'answer-footer' }, h('span', { class: 'muted small' }, `No page used · Model: ${r.model}`),
        h('button', { class: 'btn link small', onclick: saveMemoryFrom(text) }, 'Save a note to memory…')));
    pending.replaceWith(h('div', { class: 'msg assistant' }, body));
    await appendConversation({ role: 'user', text });
    await appendConversation({ role: 'assistant', text: r.content });
  } catch (err) {
    const box = h('div', { class: 'msg error' });
    box.append(errorBox(err, null, { retry: () => { if (state.busy) return; box.remove(); userMsg?.remove(); runChat(text); } }));
    pending.replaceWith(box);
  } finally {
    setBusy(false);
  }
}

async function restoreConversation() {
  const conv = await getConversation();
  for (const m of conv) {
    if (m.role === 'user') addMessage('user', m.text);
    else if (m.result) els.log.append(renderResultMessage(m.result, ''));
    else els.log.append(h('div', { class: 'msg assistant' }, renderRichText(m.text)));
  }
  if (!conv.length) {
    els.log.append(h('div', { class: 'card soft small' },
      h('b', {}, 'Tips'),
      h('ul', {},
        h('li', {}, '“This page”: summarize or ask about the page you are viewing.'),
        h('li', {}, '“Selected tabs”: tick tabs to compare them or research a question across them.'),
        h('li', {}, 'Type ', h('code', {}, '/remember …'), ' to save a note to memory.'),
        h('li', {}, 'Satchel shows facts from pages separately from its own inferences, with links to sources.'))));
  }
}

async function onClearChat() {
  await clearConversation();
  clear(els.log);
  toast('Chat cleared. Saved memories were not changed.');
}

