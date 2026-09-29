// Gmail API helpers: list threads, read a selected thread, build and send a reply.
// Sending requires the separate "gmailSend" connection and an explicit confirmation in the UI.
import { googleFetch } from './google-auth.js';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

export function decodeBase64Url(data) {
  const b64 = String(data || '').replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

export function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function encodeBase64Url(str) {
  return utf8ToBase64(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function header(headers, name) {
  const h = (headers || []).find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

/** Walks a MIME payload tree and returns {text, html, attachments}. */
export function extractBodies(payload) {
  const out = { text: '', html: '', attachments: [] };
  function walk(part) {
    if (!part) return;
    const mime = (part.mimeType || '').toLowerCase();
    if (part.filename) out.attachments.push(part.filename);
    else if (mime === 'text/plain' && part.body?.data && !out.text) out.text = decodeBase64Url(part.body.data);
    else if (mime === 'text/html' && part.body?.data && !out.html) out.html = decodeBase64Url(part.body.data);
    for (const p of part.parts || []) walk(p);
  }
  walk(payload);
  return out;
}

/** Removes quoted history ("On ... wrote:", "> " lines) to keep AI input small and focused. */
export function stripQuoted(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const out = [];
  for (const line of lines) {
    if (/^On .{5,200}wrote:\s*$/.test(line.trim()) || /^-{2,}\s*Original Message\s*-{2,}/i.test(line.trim()) || /^From: .+/.test(line) && out.length > 3) break;
    if (/^\s*>/.test(line)) continue;
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function parseThread(thread, htmlToText = (h) => h.replace(/<[^>]+>/g, ' ')) {
  const messages = (thread.messages || []).map((m) => {
    const headers = m.payload?.headers || [];
    const bodies = extractBodies(m.payload);
    const text = bodies.text || (bodies.html ? htmlToText(bodies.html) : m.snippet || '');
    return {
      id: m.id,
      from: header(headers, 'From'),
      to: header(headers, 'To'),
      cc: header(headers, 'Cc'),
      replyTo: header(headers, 'Reply-To'),
      subject: header(headers, 'Subject'),
      date: header(headers, 'Date'),
      messageId: header(headers, 'Message-ID') || header(headers, 'Message-Id'),
      references: header(headers, 'References'),
      labelIds: m.labelIds || [],
      body: stripQuoted(text).slice(0, 20000),
      attachments: bodies.attachments,
    };
  });
  return { id: thread.id, subject: messages[0]?.subject || '(no subject)', messages };
}

export function emailAddressOf(value) {
  const m = String(value || '').match(/<([^>]+)>/);
  return (m ? m[1] : String(value || '')).trim().toLowerCase();
}

/** Reply headers come from the thread itself - never from the AI - so injected text can't redirect a reply. */
export function buildReplyDraft(parsed, myEmail = '') {
  const me = myEmail.toLowerCase();
  const msgs = parsed.messages;
  const last = [...msgs].reverse().find((m) => !m.labelIds.includes('SENT') && emailAddressOf(m.from) !== me) || msgs[msgs.length - 1];
  const to = last?.replyTo || last?.from || '';
  const subject = /^re:/i.test(parsed.subject) ? parsed.subject : `Re: ${parsed.subject}`;
  const references = [last?.references, last?.messageId].filter(Boolean).join(' ').trim();
  return { to, cc: '', subject, body: '', inReplyTo: last?.messageId || '', references, threadId: parsed.id };
}

const ADDRESS_RE = /^(?:"?[^"<>\r\n]{0,100}"?\s*<)?[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}>?$/;

export function splitAddresses(list) {
  return String(list || '').split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((s) => s.trim()).filter(Boolean);
}

export function validateOutgoing({ to, cc = '', subject, body }) {
  const errors = [];
  const toList = splitAddresses(to);
  if (!toList.length) errors.push('Add at least one recipient.');
  for (const a of [...toList, ...splitAddresses(cc)]) if (!ADDRESS_RE.test(a)) errors.push(`"${a}" is not a valid email address.`);
  if (toList.length + splitAddresses(cc).length > 20) errors.push('Too many recipients (max 20).');
  if (/[\r\n]/.test(`${to}${cc}${subject}`)) errors.push('Recipients and subject cannot contain line breaks.');
  if (!String(subject || '').trim()) errors.push('Add a subject.');
  if (!String(body || '').trim()) errors.push('The message is empty.');
  if (String(body || '').length > 50000) errors.push('The message is too long.');
  return errors;
}

function encodeHeaderValue(v) {
  // RFC 2047 encoded-word for non-ASCII header text.
  return /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${utf8ToBase64(v)}?=`;
}

export function buildMime({ to, cc = '', subject, body, inReplyTo = '', references = '' }) {
  const errors = validateOutgoing({ to, cc, subject, body });
  if (errors.length) throw new Error(errors.join(' '));
  const bodyB64 = utf8ToBase64(body.replace(/\r?\n/g, '\r\n')).replace(/.{76}/g, '$&\r\n');
  const lines = [
    `To: ${to}`,
    ...(cc ? [`Cc: ${cc}`] : []),
    `Subject: ${encodeHeaderValue(subject)}`,
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`] : []),
    ...(references ? [`References: ${references}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    bodyB64,
  ];
  return lines.join('\r\n');
}

export async function getProfile() {
  return googleFetch('gmailRead', `${API}/profile`, { label: 'Gmail' });
}

export async function listThreads(query = 'in:inbox', max = 15) {
  const list = await googleFetch('gmailRead', `${API}/threads?maxResults=${max}&q=${encodeURIComponent(query)}`, { label: 'Gmail' });
  const threads = list.threads || [];
  const meta = await Promise.all(threads.map(async (t) => {
    const full = await googleFetch('gmailRead', `${API}/threads/${t.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`, { label: 'Gmail' });
    const first = full.messages?.[0];
    const lastMsg = full.messages?.[full.messages.length - 1];
    return {
      id: t.id,
      subject: header(first?.payload?.headers, 'Subject') || '(no subject)',
      from: header(lastMsg?.payload?.headers, 'From'),
      date: header(lastMsg?.payload?.headers, 'Date'),
      snippet: t.snippet || lastMsg?.snippet || '',
      count: full.messages?.length || 1,
      unread: (full.messages || []).some((m) => (m.labelIds || []).includes('UNREAD')),
    };
  }));
  return meta;
}

export async function getThread(id, htmlToText) {
  const t = await googleFetch('gmailRead', `${API}/threads/${encodeURIComponent(id)}?format=full`, { label: 'Gmail' });
  return parseThread(t, htmlToText);
}

export async function sendMessage(draft) {
  const raw = encodeBase64Url(buildMime(draft));
  return googleFetch('gmailSend', `${API}/messages/send`, { method: 'POST', body: { raw, ...(draft.threadId ? { threadId: draft.threadId } : {}) }, label: 'Gmail' });
}

export function threadForPrompt(parsed, maxChars = 16000) {
  const parts = [];
  let used = 0;
  // Most recent messages matter most; walk backwards and keep what fits.
  for (const m of [...parsed.messages].reverse()) {
    const block = `From: ${m.from}\nDate: ${m.date}\n${m.attachments.length ? `Attachments: ${m.attachments.join(', ')}\n` : ''}\n${m.body}`;
    if (used + block.length > maxChars) {
      if (!parts.length) parts.push(block.slice(0, maxChars));
      break;
    }
    parts.unshift(block);
    used += block.length;
  }
  const omitted = parsed.messages.length - parts.length;
  return `${omitted > 0 ? `[${omitted} older message(s) omitted for length]\n\n` : ''}${parts.join('\n\n---\n\n')}`;
}
