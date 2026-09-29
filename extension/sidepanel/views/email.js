// "Email" view: summarize selected Gmail threads, draft replies, and send only after the user
// reviews the recipient, subject and complete message and confirms.
import { h, clear, link, toast, modal, confirmSendToAI, renderRichText, spinner, errorBox } from '../../lib/ui.js';
import { GOOGLE_SERVICES, getConnections, connect, disconnect, GoogleError } from '../../lib/google-auth.js';
import { listThreads, getThread, buildReplyDraft, validateOutgoing, sendMessage, threadForPrompt, splitAddresses } from '../../lib/gmail.js';
import { chat, friendlyError } from '../../lib/ai.js';
import { getSettings } from '../../lib/settings.js';
import { memoriesForAI } from '../../lib/memory.js';
import { emailSummarySystemPrompt, emailReplySystemPrompt, escapeForTag } from '../../lib/prompts.js';

let root;
const state = { query: 'in:inbox', threads: [], selected: new Set(), busy: false, draft: null, connections: {} };
const els = {};

export function init(container) {
  root = container;
}

export function show() {
  render();
}

function htmlToText(html) {
  // DOMParser builds an inert document (no scripts run, no network loads for text extraction).
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const el of doc.querySelectorAll('script, style, head')) el.remove();
  for (const br of doc.querySelectorAll('br')) br.replaceWith('\n');
  for (const p of doc.querySelectorAll('p, div, li, tr, h1, h2, h3')) p.append('\n');
  return (doc.body?.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
}

async function render() {
  const settings = await getSettings();
  state.connections = await getConnections();
  clear(root);
  root.append(renderConnections(settings));
  els.status = h('div');
  root.append(els.status);
  if (state.connections.gmailRead) {
    root.append(renderInbox());
    if (!state.threads.length && !state.busy) loadThreads();
  }
  els.compose = h('div');
  root.append(els.compose);
  if (state.draft) renderCompose();
}

function setStatus(node) {
  clear(els.status);
  if (node) els.status.append(node);
}

function renderConnections(settings) {
  const needsSetup = !settings.googleClientId;
  const service = (key) => {
    const s = GOOGLE_SERVICES[key];
    const c = state.connections[key];
    return h('div', { class: 'page-row' },
      h('div', { class: 'grow', style: 'white-space:normal' }, h('b', {}, s.label), h('div', { class: 'muted small' }, s.explain),
        c ? h('div', { class: 'small', style: 'color:var(--ok)' }, `Connected${c.email ? ` as ${c.email}` : ''}`) : null),
      c ? h('button', { class: 'btn small', onclick: async () => { await disconnect(key); toast('Disconnected.'); state.threads = []; render(); } }, 'Disconnect')
        : h('button', { class: 'btn small primary', disabled: needsSetup, onclick: () => onConnect(key) }, 'Connect'));
  };
  const anyConnected = Object.keys(state.connections).length > 0;
  return h('details', { class: 'card', open: !anyConnected },
    h('summary', {}, anyConnected ? 'Google connections' : 'Connect Gmail'),
    needsSetup ? h('p', { class: 'warn small' }, 'Google is not set up yet. Open ', h('a', { href: chrome.runtime.getURL('options/options.html#google'), target: '_blank' }, 'Settings → Google'), ' and follow the steps to add your OAuth client ID (about 10 minutes, one time).') : null,
    h('p', { class: 'muted small' }, 'Each connection is separate, so you can allow reading without allowing sending. School accounts: your school\'s Google administrator may block third-party apps. If so, Satchel will tell you, and everything else keeps working.'),
    service('gmailRead'), service('gmailSend'),
    h('p', { class: 'muted small' }, 'Google Classroom can be connected in Settings → Google.'));
}

async function onConnect(key) {
  setStatus(spinner('Opening Google sign-in…'));
  try {
    await connect(key);
    setStatus(null);
    toast('Connected.');
    state.threads = [];
    render();
  } catch (err) {
    setStatus(renderGoogleError(err));
  }
}

function renderGoogleError(err) {
  const blocked = err instanceof GoogleError && ['admin_blocked', 'access_denied'].includes(err.code);
  return h('div', { class: 'card soft small' }, h('b', { class: 'error' }, blocked ? 'Google access not available. ' : 'Problem: '), err.message,
    err.code === 'setup' ? h('div', {}, h('a', { href: chrome.runtime.getURL('options/options.html#google'), target: '_blank' }, 'Open Google setup')) : null);
}

function renderInbox() {
  const q = h('input', { type: 'search', value: state.query, placeholder: 'Gmail search, e.g. is:unread from:teacher@school.edu', 'aria-label': 'Gmail search' });
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { state.query = q.value.trim() || 'in:inbox'; loadThreads(); } });
  els.threadList = h('div');
  els.threadActions = h('div', { class: 'btn-row sticky-actions' });
  const wrap = h('div', {},
    h('div', { style: 'display:flex;gap:6px;margin-top:8px' }, q, h('button', { class: 'btn', onclick: () => { state.query = q.value.trim() || 'in:inbox'; loadThreads(); } }, 'Search')),
    els.threadActions, els.threadList);
  renderThreads();
  return wrap;
}

async function loadThreads() {
  if (state.busy) return;
  state.busy = true;
  if (els.threadList) { clear(els.threadList); els.threadList.append(spinner('Loading threads…')); }
  try {
    state.threads = await listThreads(state.query, 15);
    state.selected.clear();
  } catch (err) {
    setStatus(renderGoogleError(err));
    state.threads = [];
  } finally {
    state.busy = false;
    renderThreads();
  }
}

function renderThreads() {
  if (!els.threadList) return;
  clear(els.threadList);
  clear(els.threadActions);
  const n = state.selected.size;
  els.threadActions.append(
    h('button', { class: 'btn small primary', disabled: !n, onclick: summarizeSelected }, `Summarize${n ? ` (${n})` : ''}`),
    h('button', { class: 'btn small', disabled: n !== 1, title: 'Select one thread', onclick: () => startReply([...state.selected][0]) }, 'Draft reply'),
    h('button', { class: 'btn small', onclick: () => { state.draft = { to: '', cc: '', subject: '', body: '', threadId: '' }; renderCompose(); } }, 'New email'),
    h('button', { class: 'btn link small', onclick: loadThreads }, '↻'));
  if (!state.threads.length) { els.threadList.append(h('div', { class: 'empty' }, 'No threads found.')); return; }
  for (const t of state.threads) {
    const cb = h('input', { type: 'checkbox', checked: state.selected.has(t.id), 'aria-label': t.subject, onchange: (e) => { if (e.target.checked) state.selected.add(t.id); else state.selected.delete(t.id); renderThreads(); } });
    els.threadList.append(h('label', { class: `thread ${t.unread ? 'unread' : ''}` }, cb, h('div', { class: 't-main' },
      h('div', { class: 't-subject' }, t.subject, t.count > 1 ? h('span', { class: 'muted small' }, ` (${t.count})`) : null),
      h('div', { class: 't-from' }, t.from), h('div', { class: 't-snippet' }, decodeEntities(t.snippet)))));
  }
}

function decodeEntities(s) {
  return new DOMParser().parseFromString(`<p>${String(s || '').replace(/</g, '&lt;')}</p>`, 'text/html').body.textContent;
}

async function summarizeSelected() {
  const ids = [...state.selected].slice(0, 5);
  const subjects = state.threads.filter((t) => ids.includes(t.id)).map((t) => ({ title: `${t.subject} (${t.from})` }));
  const ok = await confirmSendToAI({ what: `the content of ${ids.length} email thread(s)`, items: subjects, extra: 'Only the selected threads are sent. Email content is not saved by Satchel.' });
  if (!ok) return;
  setStatus(spinner('Reading the selected threads…'));
  try {
    const settings = await getSettings();
    const memories = await memoriesForAI(settings.useMemoriesInAI);
    const per = Math.floor((settings.maxInputTokens * 4) / ids.length);
    const results = [];
    for (const id of ids) {
      const parsed = await getThread(id, htmlToText);
      setStatus(spinner(`Summarizing “${parsed.subject}”…`));
      const r = await chat({
        messages: [
          { role: 'system', content: emailSummarySystemPrompt(memories) },
          { role: 'user', content: `Subject: ${escapeForTag(parsed.subject)}\n<email>\n${escapeForTag(threadForPrompt(parsed, per))}\n</email>` },
        ],
        json: true,
        maxTokens: 700,
      });
      results.push({ parsed, data: r.data, notices: r.notices });
    }
    setStatus(h('div', {}, results.map(({ parsed, data, notices }) => h('div', { class: 'card' },
      h('h3', {}, parsed.subject),
      h('div', { class: 'muted small' }, `${parsed.messages.length} message(s) · last from ${parsed.messages.at(-1)?.from || 'unknown'}`),
      h('h4', { class: 'section-label' }, 'Summary (AI)'), renderRichText(String(data.summary || '')),
      Array.isArray(data.actionItems) && data.actionItems.length ? [h('h4', { class: 'section-label' }, 'Possible to-dos'), h('ul', {}, data.actionItems.map((a) => h('li', {}, String(a))))] : null,
      Array.isArray(data.questionsForUser) && data.questionsForUser.length ? [h('h4', { class: 'section-label' }, 'Questions for you'), h('ul', {}, data.questionsForUser.map((a) => h('li', {}, String(a))))] : null,
      notices.map((n) => h('p', { class: 'notice' }, n)),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn small', onclick: () => startReply(parsed.id, parsed) }, 'Draft a reply'),
        link(`https://mail.google.com/mail/u/0/#all/${parsed.id}`, 'Open in Gmail', 'btn small'))))));
  } catch (err) {
    setStatus(err instanceof GoogleError ? renderGoogleError(err) : errorBox(err));
  }
}

async function startReply(threadId, parsed = null) {
  setStatus(spinner('Opening thread…'));
  try {
    const p = parsed || await getThread(threadId, htmlToText);
    const me = state.connections.gmailRead?.email || '';
    state.draft = { ...buildReplyDraft(p, me), parsed: p };
    setStatus(null);
    renderCompose();
  } catch (err) {
    setStatus(err instanceof GoogleError ? renderGoogleError(err) : errorBox(err));
  }
}

function renderCompose() {
  const d = state.draft;
  clear(els.compose);
  if (!d) return;
  const f = {
    to: h('input', { type: 'text', value: d.to }),
    cc: h('input', { type: 'text', value: d.cc || '' }),
    subject: h('input', { type: 'text', value: d.subject }),
    body: h('textarea', { rows: 10 }),
    instruction: h('input', { type: 'text', placeholder: 'What should the reply say? e.g. “Thank her, I\'ll resubmit by Friday”' }),
  };
  f.body.value = d.body || '';
  const sync = () => { d.to = f.to.value; d.cc = f.cc.value; d.subject = f.subject.value; d.body = f.body.value; };
  for (const el of [f.to, f.cc, f.subject, f.body]) el.addEventListener('input', sync);
  const err = h('p', { class: 'error small' });
  els.compose.append(h('div', { class: 'card' },
    h('h3', {}, d.parsed ? `Reply: ${d.parsed.subject}` : 'New email'),
    d.parsed ? h('div', { class: 'card soft small' },
      h('b', {}, 'Draft with AI '), h('span', { class: 'muted' }, '(sends this thread and your instruction to Groq)'),
      h('div', { style: 'display:flex;gap:6px;margin-top:4px' }, f.instruction, h('button', { class: 'btn small', onclick: () => aiDraft(f, sync) }, 'Draft'))) : null,
    h('div', { class: 'form' },
      h('label', {}, 'To'), f.to, h('label', {}, 'Cc'), f.cc, h('label', {}, 'Subject'), f.subject, h('label', {}, 'Message'), f.body, err,
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn primary', onclick: () => { sync(); const e = validateOutgoing(d); if (e.length) { err.textContent = e.join(' '); return; } err.textContent = ''; reviewAndSend(); } }, 'Review & send…'),
        h('button', { class: 'btn', onclick: async () => { sync(); await navigator.clipboard.writeText(d.body); toast('Message copied. You can paste it into Gmail yourself.'); } }, 'Copy text'),
        h('button', { class: 'btn link', onclick: () => { state.draft = null; renderCompose(); } }, 'Discard')))));
  els.compose.scrollIntoView({ behavior: 'smooth' });
}

async function aiDraft(f, sync) {
  const d = state.draft;
  const ok = await confirmSendToAI({ what: 'this email thread and your instruction', items: [{ title: d.parsed.subject }] });
  if (!ok) return;
  f.body.disabled = true;
  const prev = f.body.value;
  f.body.value = 'Drafting…';
  try {
    const settings = await getSettings();
    const memories = await memoriesForAI(settings.useMemoriesInAI);
    const r = await chat({
      messages: [
        { role: 'system', content: emailReplySystemPrompt(memories) },
        { role: 'user', content: `The user's instruction for the reply: ${f.instruction.value.trim() || 'Write a brief, polite reply.'}\n\nThread (subject: ${escapeForTag(d.parsed.subject)}):\n<email>\n${escapeForTag(threadForPrompt(d.parsed, settings.maxInputTokens * 3))}\n</email>` },
      ],
      json: true,
      maxTokens: 900,
      temperature: 0.4,
    });
    f.body.value = String(r.data.body || '').trim();
    for (const n of r.notices) toast(n);
  } catch (err) {
    f.body.value = prev;
    toast(friendlyError(err), 'error');
  } finally {
    f.body.disabled = false;
    sync();
  }
}

/** Final review: shows the exact recipients, subject and full message; sending needs an explicit click. */
async function reviewAndSend() {
  const d = state.draft;
  const connections = await getConnections();
  const canSend = !!connections.gmailSend;
  const recipients = [...splitAddresses(d.to), ...splitAddresses(d.cc)];
  const body = h('div', {},
    h('dl', { class: 'review-box' },
      h('dt', {}, 'To'), h('dd', {}, d.to),
      d.cc ? [h('dt', {}, 'Cc'), h('dd', {}, d.cc)] : null,
      h('dt', {}, 'Subject'), h('dd', {}, d.subject),
      h('dt', {}, 'Message (exactly as it will be sent)'), h('dd', {}, h('pre', { class: 'review-body' }, d.body))),
    d.threadId ? h('p', { class: 'muted small' }, 'Sent as a reply in the same Gmail thread.') : null,
    canSend ? h('p', { class: 'small' }, `This sends one email to ${recipients.length} recipient(s) from your Gmail account.`)
      : h('p', { class: 'warn small' }, 'Sending is not connected. Connect “Gmail: send replies you approve” above, or use “Copy text” and send it from Gmail yourself.'));
  const ok = await modal({ title: 'Review before sending', body, wide: true, actions: [{ label: 'Back to edit', value: false }, { label: 'Send email', value: true, kind: 'primary', disabled: !canSend }] });
  if (!ok) return;
  setStatus(spinner('Sending…'));
  try {
    await sendMessage(d);
    state.draft = null;
    renderCompose();
    setStatus(h('p', { class: 'card soft small' }, '✓ Email sent.'));
    toast('Email sent.');
  } catch (err) {
    setStatus(err instanceof GoogleError ? renderGoogleError(err) : h('p', { class: 'error' }, err.message));
  }
}
