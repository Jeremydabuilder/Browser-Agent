// Meeting notes: prompt construction, long-transcript handling, and strict grounding validation.
// Decisions and action items must quote the transcript; owners and due dates are kept only when the
// cited lines actually state them. Anything else is dropped or flagged for review - never invented.
import { SAFETY_RULES, escapeForTag } from './prompts.js';
import { verifyQuote, normalizeForMatch } from './grounding.js';
import { parseDue } from './dates.js';
import { formatClock } from './meeting-capture.js';

export function transcriptLines(segments) {
  return segments.filter((s) => !s.gap && s.text).map((s) => `${s.id} [${formatClock(s.start)}] ${escapeForTag(s.text)}`);
}

export function notesSystemPrompt(partial = false) {
  return `TASK:meeting_notes
You write meeting notes from a transcript${partial ? ' EXCERPT (one part of a longer meeting)' : ''}. Each transcript line starts with its id (like c0s3) and timestamp.

${SAFETY_RULES}

Respond with JSON only:
{
  "summary": "3-6 sentence summary of what was discussed",
  "keyPoints": [{"text": "...", "refs": ["c0s3"]}],
  "decisions": [{"text": "the decision", "quote": "exact words from the transcript where it was decided", "refs": ["c0s5"]}],
  "actionItems": [{"task": "...", "owner": "name exactly as said, or empty", "due": "due date exactly as said, or empty", "quote": "exact words from the transcript", "refs": ["c1s2"], "uncertain": false}],
  "openQuestions": [{"text": "...", "refs": ["c2s1"]}]
}
Strict rules:
- Only include a decision if the transcript shows it was actually decided or agreed. Discussion is not a decision.
- Only include an action item if someone clearly committed or was asked to do something.
- "owner" and "due" must be empty unless the transcript explicitly states them. Never guess owners or dates.
- Set "uncertain": true if a name or date might be misheard or unclear.
- Every item must cite the line ids it came from in "refs". "quote" must be copied exactly from those lines.
- Transcripts can contain speech-recognition errors; do not "fix" names you are not sure about.`;
}

export function notesUserPrompt(lines, { title = '', note = '' } = {}) {
  return `${note ? `${note}\n\n` : ''}Meeting title: ${escapeForTag(title)}\n<source id="transcript">\n${lines.join('\n')}\n</source>`;
}

/** Splits transcript lines into windows that fit the per-request budget. */
export function windowLines(lines, maxChars) {
  const windows = [];
  let cur = [];
  let size = 0;
  for (const l of lines) {
    if (size + l.length + 1 > maxChars && cur.length) { windows.push(cur); cur = []; size = 0; }
    cur.push(l);
    size += l.length + 1;
  }
  if (cur.length) windows.push(cur);
  return windows;
}

function arr(x) {
  return Array.isArray(x) ? x : [];
}

function cleanRefs(refs, byId) {
  return [...new Set(arr(refs).map((r) => String(r).trim().replace(/^\[|\]$/g, '')))].filter((r) => byId.has(r));
}

function textOf(refs, byId, { neighbors = false, order = [] } = {}) {
  const ids = new Set(refs);
  if (neighbors) {
    for (const r of refs) {
      const i = order.indexOf(r);
      if (i > 0) ids.add(order[i - 1]);
      if (i >= 0 && i < order.length - 1) ids.add(order[i + 1]);
    }
  }
  return [...ids].map((id) => byId.get(id)?.text || '').join(' ');
}

const SPEAKER_LABEL = /^\s*[\p{L}][\p{L} .'-]{0,40}:\s/u;

function splitSpeaker(text) {
  const m = SPEAKER_LABEL.exec(text);
  return m ? { label: m[0], body: text.slice(m[0].length) } : { label: '', body: text };
}

function nameAppears(name, text) {
  const n = normalizeForMatch(name).replace(/[^\p{L}\p{N} ]/gu, '').trim();
  if (n.length < 2) return false;
  const t = ` ${normalizeForMatch(text).replace(/[^\p{L}\p{N} ]/gu, ' ')} `;
  // Every word of the name must appear as a word in the cited lines.
  return n.split(/\s+/).every((w) => t.includes(` ${w} `));
}

/**
 * Validates raw model output against the transcript.
 * @param raw       parsed JSON from the model
 * @param segments  assembled transcript segments ({id, start, text})
 * @param meetingDate Date the meeting happened (for resolving "Friday" etc.)
 */
export function validateNotes(raw, segments, { meetingDate = new Date(), dateOrder = 'MDY' } = {}) {
  const byId = new Map(segments.filter((s) => !s.gap).map((s) => [s.id, s]));
  const order = segments.filter((s) => !s.gap).map((s) => s.id);
  const refsOut = (refs) => refs.map((id) => ({ id, start: byId.get(id).start }));
  const dropped = [];
  const out = { summary: String(raw?.summary || '').trim().slice(0, 3000), keyPoints: [], decisions: [], actionItems: [], openQuestions: [], dropped };

  for (const k of arr(raw?.keyPoints).slice(0, 30)) {
    const text = String(k?.text || k || '').trim();
    if (!text) continue;
    const refs = cleanRefs(k?.refs, byId);
    out.keyPoints.push({ text, refs: refsOut(refs), review: refs.length ? [] : ['Not linked to a transcript line.'] });
  }
  for (const q of arr(raw?.openQuestions).slice(0, 20)) {
    const text = String(q?.text || q || '').trim();
    if (!text) continue;
    const refs = cleanRefs(q?.refs, byId);
    out.openQuestions.push({ text, refs: refsOut(refs), review: refs.length ? [] : ['Not linked to a transcript line.'] });
  }
  for (const d of arr(raw?.decisions).slice(0, 20)) {
    const text = String(d?.text || '').trim();
    if (!text) continue;
    const refs = cleanRefs(d?.refs, byId);
    const quote = String(d?.quote || '').trim();
    if (!refs.length || !quote || !verifyQuote(quote, textOf(refs, byId))) {
      dropped.push({ kind: 'decision', text, why: 'The AI suggested this decision, but its quote was not found in the cited transcript lines.' });
      continue;
    }
    out.decisions.push({ text, quote, refs: refsOut(refs), review: [] });
  }
  for (const a of arr(raw?.actionItems).slice(0, 40)) {
    const task = String(a?.task || '').trim();
    if (!task) continue;
    const refs = cleanRefs(a?.refs, byId);
    const quote = String(a?.quote || '').trim();
    if (!refs.length || !quote || !verifyQuote(quote, textOf(refs, byId))) {
      dropped.push({ kind: 'action item', text: task, why: 'The AI suggested this action item, but its quote was not found in the cited transcript lines.' });
      continue;
    }
    const nearby = textOf(refs, byId, { neighbors: true, order });
    const nearbyIds = [...new Set([...refs, ...refs.flatMap((r) => [order[order.indexOf(r) - 1], order[order.indexOf(r) + 1]])])].filter(Boolean);
    const parts = nearbyIds.map((id) => splitSpeaker(byId.get(id)?.text || ''));
    const spoken = parts.map((p) => p.body).join(' ');
    const labels = parts.map((p) => p.label).join(' ');
    const review = [];
    let owner = String(a?.owner || '').trim();
    if (owner && !nameAppears(owner, spoken)) {
      if (nameAppears(owner, labels)) {
        review.push(`Owner “${owner}” was inferred from who was speaking, not stated outright; please check.`);
      } else {
        review.push(`The AI suggested “${owner}” as owner, but that name is not in the cited lines. Owner left blank.`);
        owner = '';
      }
    }
    let due = String(a?.due || '').trim();
    let dueDate = null;
    if (due) {
      if (!verifyQuote(due, nearby) && !normalizeForMatch(nearby).includes(normalizeForMatch(due))) {
        review.push(`The AI suggested the due date “${due}”, but it is not stated in the cited lines. Due date left blank.`);
        due = '';
      } else {
        const parsed = parseDue(due, { now: meetingDate, dateOrder });
        dueDate = parsed.date;
        if (parsed.status !== 'exact') review.push(`Due date “${due}” ${parsed.date ? `read as ${parsed.date}` : 'could not be turned into a date'}; please check.`);
      }
    }
    if (a?.uncertain) review.push('The AI marked a name or date here as possibly misheard.');
    out.actionItems.push({ task, owner, due, dueDate, quote, refs: refsOut(refs), review, done: false });
  }
  return out;
}

/** Items from partial notes, flattened for the combining step (keeps quotes and refs). */
export function partialNotesForReduce(parts) {
  return JSON.stringify(parts.map((p, i) => ({
    part: i + 1,
    summary: p.summary,
    keyPoints: p.keyPoints.map((k) => ({ text: k.text, refs: k.refs.map((r) => r.id) })),
    decisions: p.decisions.map((d) => ({ text: d.text, quote: d.quote, refs: d.refs.map((r) => r.id) })),
    actionItems: p.actionItems.map((a) => ({ task: a.task, owner: a.owner, due: a.due, quote: a.quote, refs: a.refs.map((r) => r.id) })),
    openQuestions: p.openQuestions.map((q) => ({ text: q.text, refs: q.refs.map((r) => r.id) })),
  })));
}

export function reduceSystemPrompt() {
  return `TASK:meeting_notes_combine
You combine notes from consecutive parts of one long meeting into final notes. Merge duplicates, keep the chronology, and keep every item's "refs" and "quote" exactly as given (do not create new quotes or refs).

${SAFETY_RULES}

Respond with JSON only, in the same shape: {"summary": "", "keyPoints": [], "decisions": [], "actionItems": [], "openQuestions": []}. Never add owners, dates, decisions, or action items that are not in the part notes.`;
}

/**
 * Generates notes. Short transcripts go in one request; long ones are processed in windows and then
 * combined. Every result is validated against the full transcript.
 * @param chat  the ai.chat function (injectable for tests)
 */
export async function generateNotes({ segments, title, meetingDate, dateOrder, maxChars, chat, onStatus = () => {} }) {
  const lines = transcriptLines(segments);
  if (!lines.length) throw new Error('The transcript is empty, so there is nothing to summarize.');
  const windows = windowLines(lines, maxChars);
  let raw;
  let model = '';
  const notices = [];
  if (windows.length === 1) {
    onStatus('Writing notes…');
    const r = await chat({ messages: [{ role: 'system', content: notesSystemPrompt(false) }, { role: 'user', content: notesUserPrompt(windows[0], { title }) }], json: true, maxTokens: 2500, onStatus });
    raw = r.data;
    model = r.model;
    notices.push(...(r.notices || []));
  } else {
    const parts = [];
    for (let i = 0; i < windows.length; i++) {
      onStatus(`Reading part ${i + 1} of ${windows.length} of the transcript…`);
      const r = await chat({ messages: [{ role: 'system', content: notesSystemPrompt(true) }, { role: 'user', content: notesUserPrompt(windows[i], { title, note: `Part ${i + 1} of ${windows.length}.` }) }], json: true, maxTokens: 2000, onStatus });
      parts.push(validateNotes(r.data, segments, { meetingDate, dateOrder }));
      model = r.model;
      notices.push(...(r.notices || []));
    }
    onStatus('Combining the parts…');
    const r = await chat({ messages: [{ role: 'system', content: reduceSystemPrompt() }, { role: 'user', content: `Meeting title: ${escapeForTag(title)}\nPart notes (JSON):\n${escapeForTag(partialNotesForReduce(parts))}` }], json: true, maxTokens: 3000, onStatus });
    raw = r.data;
    notices.push(...(r.notices || []));
  }
  const notes = validateNotes(raw, segments, { meetingDate, dateOrder });
  return { ...notes, generatedAt: new Date().toISOString(), model, parts: windows.length, notices: [...new Set(notices)] };
}
