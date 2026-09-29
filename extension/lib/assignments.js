// Assignment model: normalization, de-duplication/merging, and Today / This week / Later buckets.
import { parseDue } from './dates.js';
import { uid, ymd, addDays, collapseWhitespace, clampText } from './util.js';
import { normalizeForMatch } from './grounding.js';

export const EDITABLE_FIELDS = ['title', 'className', 'instructions', 'due', 'notes'];

export function normalizeTitle(title) {
  return collapseWhitespace(title)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/^(assignment|homework|hw|task|quiz|reading)\s*[:#-]\s*/i, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function normalizeClass(name) {
  return collapseWhitespace(name).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function assignmentKey(a) {
  return `${normalizeTitle(a.title)}|${normalizeClass(a.className)}`;
}

function dueIsSolid(due) {
  return !!(due && due.date && (due.status === 'exact' || due.status === 'inferred'));
}

/** Converts a raw candidate from the page extractor (or AI extraction) into an assignment. */
export function fromCandidate(c, { now = new Date(), dateOrder = 'MDY', source = {}, origin = 'extracted' } = {}) {
  const due = parseDue(c.dueText, { now, dateOrder, datetimeAttr: c.dueAttr });
  const pageUrl = c.pageUrl || source.url || '';
  const itemUrl = c.url || '';
  const className = collapseWhitespace(c.className) || collapseWhitespace(source.defaultClass) || '';
  return {
    id: uid('asg'),
    title: clampText(collapseWhitespace(c.title), 250),
    className: clampText(className, 120),
    classGuessed: !!c.classGuessed && !source.defaultClass,
    instructions: clampText(collapseWhitespace(c.instructions), 2000),
    notes: '',
    due,
    sourceUrl: itemUrl || pageUrl,
    sources: [{ pageUrl, itemUrl, label: source.label || '', seenAt: now.toISOString() }],
    status: 'open',
    origin,
    edited: {},
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    lastSeenAt: now.toISOString(),
    isNew: true,
  };
}

export function validateManual(input) {
  const errors = [];
  const title = collapseWhitespace(input.title);
  if (!title) errors.push('A title is required.');
  if (title.length > 250) errors.push('Title is too long (max 250 characters).');
  if (collapseWhitespace(input.className).length > 120) errors.push('Class name is too long.');
  if (String(input.instructions || '').length > 5000) errors.push('Instructions are too long (max 5000 characters).');
  if (input.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.dueDate)) errors.push('Due date must be a valid date.');
  if (input.dueTime && !/^\d{2}:\d{2}$/.test(input.dueTime)) errors.push('Due time must look like 14:30.');
  if (input.sourceUrl && !/^https?:\/\//i.test(input.sourceUrl)) errors.push('Link must start with http:// or https://');
  return errors;
}

export function createManual(input, now = new Date()) {
  const errors = validateManual(input);
  if (errors.length) throw new Error(errors.join(' '));
  const due = input.dueDate
    ? { date: input.dueDate, time: input.dueTime || null, status: 'exact', note: 'Entered by you.', raw: '' }
    : { date: null, time: null, status: 'missing', note: 'No due date entered.', raw: '' };
  return {
    id: uid('asg'),
    title: collapseWhitespace(input.title),
    className: collapseWhitespace(input.className),
    classGuessed: false,
    instructions: String(input.instructions || '').trim(),
    notes: '',
    due,
    sourceUrl: input.sourceUrl || '',
    sources: input.sourceUrl ? [{ pageUrl: input.sourceUrl, itemUrl: '', label: 'Added by you', seenAt: now.toISOString() }] : [],
    status: 'open',
    origin: 'manual',
    edited: { title: true, className: true, instructions: true, due: true },
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    lastSeenAt: now.toISOString(),
    isNew: false,
  };
}

/** Applies a user correction. Edited fields are protected from being overwritten by later refreshes. */
export function applyEdit(a, patch, now = new Date()) {
  const next = { ...a, edited: { ...a.edited } };
  if ('title' in patch) { next.title = collapseWhitespace(patch.title); next.edited.title = true; }
  if ('className' in patch) { next.className = collapseWhitespace(patch.className); next.classGuessed = false; next.edited.className = true; }
  if ('instructions' in patch) { next.instructions = String(patch.instructions || '').trim(); next.edited.instructions = true; }
  if ('notes' in patch) next.notes = String(patch.notes || '');
  if ('dueDate' in patch || 'dueTime' in patch) {
    const date = 'dueDate' in patch ? patch.dueDate || null : a.due?.date;
    const time = 'dueTime' in patch ? patch.dueTime || null : a.due?.time;
    next.due = date
      ? { date, time, status: 'exact', note: 'Corrected by you.', raw: a.due?.raw || '' }
      : { date: null, time: null, status: 'missing', note: 'Due date cleared by you.', raw: a.due?.raw || '' };
    next.edited.due = true;
  }
  if ('status' in patch && ['open', 'done'].includes(patch.status)) next.status = patch.status;
  if (!next.title) throw new Error('A title is required.');
  next.updatedAt = now.toISOString();
  next.isNew = false;
  return next;
}

function sourcesOverlap(a, b) {
  const urls = new Set(a.sources.map((s) => s.itemUrl).filter(Boolean));
  return b.sources.some((s) => s.itemUrl && urls.has(s.itemUrl));
}

function datesCompatible(a, b) {
  if (!dueIsSolid(a.due) || !dueIsSolid(b.due)) return true;
  return a.due.date === b.due.date;
}

export function isSameAssignment(a, b) {
  if (sourcesOverlap(a, b)) return true;
  const ta = normalizeTitle(a.title);
  const tb = normalizeTitle(b.title);
  if (!ta || ta !== tb) return false;
  const ca = normalizeClass(a.className);
  const cb = normalizeClass(b.className);
  if (ca && cb && ca !== cb) return false;
  // Same title, compatible class: same unless both have firm and different dates (e.g. weekly "Reading log").
  return datesCompatible(a, b);
}

function mergeInto(existing, incoming) {
  const merged = { ...existing, edited: { ...existing.edited } };
  let changed = false;
  for (const field of ['title', 'className', 'instructions']) {
    if (merged.edited[field]) continue;
    const val = incoming[field];
    if (val && val !== merged[field] && (field !== 'className' || !incoming.classGuessed || !merged.className)) {
      merged[field] = val;
      if (field === 'className') merged.classGuessed = incoming.classGuessed;
      changed = true;
    }
  }
  if (!merged.edited.due) {
    const better = incoming.due && (dueIsSolid(incoming.due) || !merged.due?.date);
    if (better && JSON.stringify(incoming.due) !== JSON.stringify(merged.due)) {
      if (incoming.due.date !== merged.due?.date || incoming.due.time !== merged.due?.time || incoming.due.status !== merged.due?.status) changed = true;
      merged.due = incoming.due;
    }
  }
  const known = new Set(merged.sources.map((s) => `${s.pageUrl}|${s.itemUrl}`));
  for (const s of incoming.sources) {
    const k = `${s.pageUrl}|${s.itemUrl}`;
    if (!known.has(k)) { merged.sources = [...merged.sources, s]; known.add(k); changed = true; }
    else merged.sources = merged.sources.map((x) => (`${x.pageUrl}|${x.itemUrl}` === k ? { ...x, seenAt: s.seenAt } : x));
  }
  if (!merged.sourceUrl && incoming.sourceUrl) merged.sourceUrl = incoming.sourceUrl;
  merged.lastSeenAt = incoming.lastSeenAt;
  if (changed) merged.updatedAt = incoming.updatedAt;
  return { merged, changed };
}

/**
 * Merges freshly extracted assignments into the saved list.
 * - repeated assignments (same link, or same title+class with compatible dates) are merged, not duplicated
 * - fields the user corrected are never overwritten
 */
export function mergeAssignments(existing, incoming) {
  const list = existing.map((a) => ({ ...a, isNew: false }));
  const added = [];
  const updated = [];
  let unchanged = 0;
  for (const inc of incoming) {
    const idx = list.findIndex((a) => isSameAssignment(a, inc));
    if (idx >= 0) {
      const { merged, changed } = mergeInto(list[idx], inc);
      list[idx] = merged;
      if (changed) { if (!updated.includes(merged.id)) updated.push(merged.id); } else unchanged++;
    } else {
      list.push(inc);
      added.push(inc.id);
    }
  }
  return { list, added, updated, unchanged };
}

export function dedupeCandidates(assignments) {
  return mergeAssignments([], assignments).list.map((a) => ({ ...a, isNew: true }));
}

function sortKey(a) {
  return `${a.due?.date || '9999-99-99'} ${a.due?.time || '99:99'} ${normalizeTitle(a.title)}`;
}

/** Groups open assignments into Overdue / Today / This week (next 7 days) / Later / Needs a date, plus Done. */
export function bucketize(list, now = new Date()) {
  const today = ymd(now);
  const weekEnd = ymd(addDays(now, 7));
  const buckets = { overdue: [], today: [], thisWeek: [], later: [], noDate: [], done: [] };
  for (const a of list) {
    if (a.status === 'done') { buckets.done.push(a); continue; }
    const d = a.due?.date;
    if (!d) buckets.noDate.push(a);
    else if (d < today) buckets.overdue.push(a);
    else if (d === today) buckets.today.push(a);
    else if (d <= weekEnd) buckets.thisWeek.push(a);
    else buckets.later.push(a);
  }
  for (const k of Object.keys(buckets)) buckets[k].sort((x, y) => sortKey(x).localeCompare(sortKey(y)));
  buckets.done.sort((x, y) => String(y.updatedAt).localeCompare(String(x.updatedAt)));
  return buckets;
}

export function needsAttention(a) {
  return !a.due?.date || a.due.status === 'ambiguous' || a.due.status === 'missing' || a.classGuessed;
}

/**
 * Validates AI-extracted assignments: only known string fields, sane lengths, and nothing invented -
 * the title must appear in the page text, and a due text that isn't on the page is discarded.
 */
export function sanitizeAiAssignments(data, pageUrl, pageText = '') {
  const items = Array.isArray(data?.assignments) ? data.assignments : [];
  const haystack = normalizeForMatch(pageText);
  const onPage = (s) => !pageText || (s && haystack.includes(normalizeForMatch(s)));
  const rejected = [];
  const kept = [];
  for (const x of items.slice(0, 100)) {
    const title = clampText(collapseWhitespace(x?.title), 250);
    if (!title) continue;
    if (!onPage(title)) { rejected.push(title); continue; }
    let dueText = clampText(collapseWhitespace(x?.dueText), 120);
    if (dueText && !onPage(dueText)) dueText = '';
    kept.push({
      title,
      className: clampText(collapseWhitespace(x?.className), 120),
      instructions: clampText(collapseWhitespace(x?.instructions), 400),
      dueText,
      dueAttr: '',
      url: '',
      pageUrl,
      method: 'ai',
      classGuessed: false,
    });
  }
  return { candidates: kept, rejected };
}
