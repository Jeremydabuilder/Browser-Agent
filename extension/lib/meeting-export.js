// Markdown and plain-text export of meeting notes and transcripts.
import { formatClock } from './meeting-capture.js';

function mdEscape(s) {
  return String(s || '').replace(/([\\`*_[\]<>#|])/g, '\\$1');
}

function mdRefs(refs, withLinks) {
  if (!refs?.length) return '';
  return ` (${refs.map((r) => (withLinks ? `[${formatClock(r.start)}](#t-${r.id})` : formatClock(r.start))).join(', ')})`;
}

function txtRefs(refs) {
  return refs?.length ? ` (at ${refs.map((r) => formatClock(r.start)).join(', ')})` : '';
}

function header(meeting) {
  const when = meeting.createdAt ? new Date(meeting.createdAt).toLocaleString() : '';
  const dur = meeting.durationSec ? formatClock(meeting.durationSec) : '';
  return { when, dur };
}

export function notesToMarkdown(meeting, notes, { withLinks = false } = {}) {
  const { when, dur } = header(meeting);
  const L = [`# ${mdEscape(meeting.title)}`, '', `*${[when, dur && `Duration ${dur}`].filter(Boolean).join(' · ')}*`, ''];
  if (!notes) return [...L, '_No notes yet._', ''].join('\n');
  L.push('## Summary', '', mdEscape(notes.summary) || '_None._', '');
  const section = (title, items, fmt) => {
    L.push(`## ${title}`, '');
    if (!items?.length) L.push('_None._');
    for (const it of items || []) L.push(fmt(it));
    L.push('');
  };
  const flag = (it) => (it.review?.length ? ` ⚠ *Review: ${mdEscape(it.review.join(' '))}*` : '');
  section('Key points', notes.keyPoints, (k) => `- ${mdEscape(k.text)}${mdRefs(k.refs, withLinks)}${flag(k)}`);
  section('Decisions', notes.decisions, (d) => `- ${mdEscape(d.text)}${mdRefs(d.refs, withLinks)}${flag(d)}`);
  section('Action items', notes.actionItems, (a) => `- [${a.done ? 'x' : ' '}] ${mdEscape(a.task)}${a.owner ? ` — **Owner:** ${mdEscape(a.owner)}` : ''}${a.due ? ` — **Due:** ${mdEscape(a.due)}${a.dueDate ? ` (${a.dueDate})` : ''}` : ''}${mdRefs(a.refs, withLinks)}${flag(a)}`);
  section('Open questions', notes.openQuestions, (q) => `- ${mdEscape(q.text)}${mdRefs(q.refs, withLinks)}${flag(q)}`);
  return L.join('\n');
}

export function notesToText(meeting, notes) {
  const { when, dur } = header(meeting);
  const L = [meeting.title, [when, dur && `Duration ${dur}`].filter(Boolean).join(' - '), ''];
  if (!notes) return [...L, 'No notes yet.', ''].join('\n');
  L.push('SUMMARY', notes.summary || 'None.', '');
  const section = (title, items, fmt) => {
    L.push(title);
    if (!items?.length) L.push('  None.');
    for (const it of items || []) L.push(`  - ${fmt(it)}${it.review?.length ? ` [REVIEW: ${it.review.join(' ')}]` : ''}`);
    L.push('');
  };
  section('KEY POINTS', notes.keyPoints, (k) => `${k.text}${txtRefs(k.refs)}`);
  section('DECISIONS', notes.decisions, (d) => `${d.text}${txtRefs(d.refs)}`);
  section('ACTION ITEMS', notes.actionItems, (a) => `${a.done ? '[done] ' : ''}${a.task}${a.owner ? ` | Owner: ${a.owner}` : ''}${a.due ? ` | Due: ${a.due}` : ''}${txtRefs(a.refs)}`);
  section('OPEN QUESTIONS', notes.openQuestions, (q) => `${q.text}${txtRefs(q.refs)}`);
  return L.join('\n');
}

export function transcriptToMarkdown(meeting, segments, { withAnchors = true } = {}) {
  const L = [`# Transcript: ${mdEscape(meeting.title)}`, ''];
  for (const s of segments) {
    if (s.gap) { L.push(`- **[${formatClock(s.start)}–${formatClock(s.end)}]** _(missing: ${mdEscape(s.gapReason)})_`); continue; }
    L.push(`- ${withAnchors ? `<a id="t-${s.id}"></a>` : ''}**[${formatClock(s.start)}]** ${mdEscape(s.text)}`);
  }
  L.push('');
  return L.join('\n');
}

export function transcriptToText(meeting, segments) {
  const L = [`Transcript: ${meeting.title}`, ''];
  for (const s of segments) L.push(s.gap ? `[${formatClock(s.start)}-${formatClock(s.end)}] (missing: ${s.gapReason})` : `[${formatClock(s.start)}] ${s.text}`);
  L.push('');
  return L.join('\n');
}

/** Notes followed by the transcript, with timestamp links from the notes to transcript lines. */
export function meetingToMarkdown(meeting, notes, segments) {
  return `${notesToMarkdown(meeting, notes, { withLinks: segments.length > 0 })}\n${segments.length ? transcriptToMarkdown(meeting, segments) : ''}`;
}

export function meetingToText(meeting, notes, segments) {
  return `${notesToText(meeting, notes)}\n${segments.length ? transcriptToText(meeting, segments) : ''}`;
}

export function safeFileName(title, ext) {
  const base = String(title || 'meeting').replace(/[^\p{L}\p{N} _-]+/gu, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'meeting';
  return `${base}.${ext}`;
}
