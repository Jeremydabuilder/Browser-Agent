// Due-date parsing for text scraped from school websites.
// Returns a status so the UI can visibly flag uncertain dates instead of guessing silently:
//   exact     - a full date was written on the page
//   inferred  - we filled something in (year not shown, or relative words like "tomorrow")
//   ambiguous - conflicting/unclear dates; the user should check
//   missing   - no due date found
import { ymd, pad2, addDays, daysBetween } from './util.js';

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WEEKDAY_ABBR = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 };
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const NO_DATE_RE = /^(no due date|no date|none|n\/?a|tbd|tba|not set|-+|—|–)$/i;

function validDate(y, m, d) {
  const dt = new Date(y, m, d);
  return dt.getFullYear() === y && dt.getMonth() === m && dt.getDate() === d ? dt : null;
}

function inferYear(m, d, now) {
  // Choose the year that puts the date closest to "now" (ties go to the future).
  let best = null;
  for (const y of [now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1]) {
    const dt = validDate(y, m, d);
    if (!dt) continue;
    const dist = Math.abs(daysBetween(now, dt));
    if (!best || dist < best.dist || (dist === best.dist && dt > now)) best = { dt, dist };
  }
  return best?.dt || null;
}

export function parseTime(text) {
  const t = String(text || '').toLowerCase();
  if (/\bnoon\b/.test(t)) return { time: '12:00' };
  if (/\bmidnight\b/.test(t)) return { time: '23:59', note: '"Midnight" read as 11:59 PM that day.' };
  let m = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/);
  if (m) {
    let h = Number(m[1]) % 12;
    if (m[3].startsWith('p')) h += 12;
    const min = m[2] ? Number(m[2]) : 0;
    if (h < 24 && min < 60) return { time: `${pad2(h)}:${pad2(min)}` };
  }
  m = t.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (m) return { time: `${pad2(Number(m[1]))}:${m[2]}` };
  return null;
}

function findDates(text, now, dateOrder) {
  const found = [];
  const add = (index, date, status, note) => { if (date) found.push({ index, date, status, note }); };
  let m;
  const iso = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g;
  while ((m = iso.exec(text))) add(m.index, validDate(+m[1], +m[2] - 1, +m[3]), 'exact');

  const monthFirst = new RegExp(`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`, 'gi');
  while ((m = monthFirst.exec(text))) {
    const mon = MONTHS[m[1].toLowerCase().slice(0, m[1].toLowerCase().startsWith('sept') ? 4 : 3)];
    const d = +m[2];
    if (m[3]) add(m.index, validDate(+m[3], mon, d), 'exact');
    else add(m.index, inferYear(mon, d, now), 'inferred', 'Year not shown on the page; assumed the nearest one.');
  }
  const dayFirst = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}\\.?(?:,?\\s+(\\d{4}))?`, 'gi');
  while ((m = dayFirst.exec(text))) {
    if (found.some((f) => Math.abs(f.index - m.index) < 4)) continue;
    const mon = MONTHS[m[2].toLowerCase().slice(0, m[2].toLowerCase().startsWith('sept') ? 4 : 3)];
    const d = +m[1];
    if (m[3]) add(m.index, validDate(+m[3], mon, d), 'exact');
    else add(m.index, inferYear(mon, d, now), 'inferred', 'Year not shown on the page; assumed the nearest one.');
  }

  // Slash dates may omit the year (10/3); dash/dot dates need a year so "pages 10-12" isn't a date.
  const numeric = /(?<![\d:.\/-])(?:(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?|(\d{1,2})[.-](\d{1,2})[.-](\d{2,4}))(?![\d:\/])/g;
  while ((m = numeric.exec(text))) {
    if (m[4]) { const idx = m.index; m = [m[0], m[4], m[5], m[6]]; m.index = idx; }
    if (found.some((f) => m.index >= f.index && m.index < f.index + 12)) continue;
    let a = +m[1];
    let b = +m[2];
    let month = dateOrder === 'DMY' ? b : a;
    let day = dateOrder === 'DMY' ? a : b;
    let status = 'exact';
    let note = '';
    if (month > 12 && day <= 12) {
      [month, day] = [day, month];
      status = 'ambiguous';
      note = `Read "${m[0]}" as ${dateOrder === 'DMY' ? 'month/day' : 'day/month'} because the other order is impossible. Please check.`;
    }
    let year = m[3] ? +m[3] : null;
    if (year !== null && year < 100) year += 2000;
    let date;
    if (year) date = validDate(year, month - 1, day);
    else {
      date = inferYear(month - 1, day, now);
      if (status === 'exact') { status = 'inferred'; note = 'Year not shown on the page; assumed the nearest one.'; }
    }
    if (!date) continue;
    add(m.index, date, status, note);
  }
  return found;
}

function findRelative(text, now) {
  const t = text.toLowerCase();
  let m;
  if ((m = /\b(today|tonight)\b/.exec(t))) return { index: m.index, date: now, word: m[1] };
  if ((m = /\btomorrow\b/.exec(t))) return { index: m.index, date: addDays(now, 1), word: 'tomorrow' };
  if ((m = /\byesterday\b/.exec(t))) return { index: m.index, date: addDays(now, -1), word: 'yesterday' };
  if ((m = /\bin (\d{1,2}) days?\b/.exec(t))) return { index: m.index, date: addDays(now, +m[1]), word: m[0] };
  m = /\b(next|this)?\s*(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues?|wed|thu(?:rs?)?|fri|sat)\b\.?/.exec(t);
  if (m) {
    const name = m[2];
    const target = WEEKDAYS.indexOf(name) >= 0 ? WEEKDAYS.indexOf(name) : WEEKDAY_ABBR[name];
    if (target === undefined) return null;
    let delta = (target - now.getDay() + 7) % 7;
    if (m[1] === 'next' && delta === 0) delta = 7;
    return { index: m.index, date: addDays(now, delta), word: m[0].trim(), weekdayOnly: true, weekday: target, qualifier: m[1] || '' };
  }
  return null;
}

function weekdayMentioned(text) {
  const m = /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)\b/i.exec(text);
  if (!m) return null;
  const n = m[1].toLowerCase();
  return WEEKDAYS.indexOf(n) >= 0 ? WEEKDAYS.indexOf(n) : WEEKDAY_ABBR[n];
}

/**
 * @param {string} input   raw due text from a page, e.g. "Due Fri, Oct 3 at 11:59 PM"
 * @param {object} options { now: Date, dateOrder: 'MDY'|'DMY', datetimeAttr: string from <time datetime> }
 * @returns {{date:string|null, time:string|null, status:string, note:string, raw:string}}
 */
export function parseDue(input, { now = new Date(), dateOrder = 'MDY', datetimeAttr = '' } = {}) {
  const raw = String(input || '').replace(/\s+/g, ' ').trim();
  const result = (date, time, status, note = '') => ({ date: date ? ymd(date) : null, time: time || null, status, note, raw });

  if (datetimeAttr) {
    const attr = String(datetimeAttr).trim();
    const dOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(attr);
    if (dOnly) {
      const dt = validDate(+dOnly[1], +dOnly[2] - 1, +dOnly[3]);
      if (dt) return result(dt, parseTime(raw)?.time, 'exact');
    } else {
      const dt = new Date(attr);
      if (!Number.isNaN(dt.getTime())) {
        const hasTime = /T\d{2}:\d{2}/.test(attr);
        return result(dt, hasTime ? `${pad2(dt.getHours())}:${pad2(dt.getMinutes())}` : null, 'exact');
      }
    }
  }

  if (!raw) return result(null, null, 'missing', 'No due date was shown.');
  let focus = raw.replace(/^due( date)?\s*[:\-–]?\s*$/i, '');
  if (NO_DATE_RE.test(focus) || /\bno due date\b/i.test(focus)) return result(null, null, 'missing', 'The page says there is no due date.');
  // Prefer the part after the last "due" word ("Assigned Sep 20 · Due Sep 30").
  const dueIdx = focus.toLowerCase().lastIndexOf('due');
  if (dueIdx > 0) {
    const after = focus.slice(dueIdx);
    if (findDates(after, now, dateOrder).length || findRelative(after, now)) focus = after;
  }
  const time = parseTime(focus);
  const dates = findDates(focus, now, dateOrder);
  const distinct = [...new Map(dates.map((d) => [ymd(d.date), d])).values()];
  if (distinct.length > 1) {
    const first = distinct.sort((a, b) => a.index - b.index)[0];
    return result(first.date, time?.time, 'ambiguous', `Several dates found in "${raw}". Showing the first; please check.`);
  }
  if (distinct.length === 1) {
    const d = distinct[0];
    const wd = weekdayMentioned(focus);
    if (wd !== null && wd !== undefined && wd !== d.date.getDay()) {
      return result(d.date, time?.time, 'ambiguous', `The weekday in "${raw}" doesn't match ${ymd(d.date)}. Please check.`);
    }
    const notes = [d.note, time?.note].filter(Boolean).join(' ');
    return result(d.date, time?.time, d.status, notes);
  }
  const rel = findRelative(focus, now);
  if (rel) {
    if (rel.qualifier === 'next') {
      return result(rel.date, time?.time, 'ambiguous', `"${rel.word}" could mean this coming ${WEEKDAYS[rel.weekday]} or the one after. Showing the coming one; please check.`);
    }
    const how = rel.weekdayOnly && !rel.qualifier ? `the next ${WEEKDAYS[rel.weekday]}` : `"${rel.word}"`;
    return result(rel.date, time?.time, 'inferred', `Interpreted ${how} relative to ${ymd(now)}, when the page was read.${time?.note ? ` ${time.note}` : ''}`);
  }
  if (time) return result(null, time.time, 'missing', `Only a time ("${raw}") was found, not a date.`);
  return result(null, null, 'missing', `Couldn't find a date in "${raw.slice(0, 80)}".`);
}

export function formatDue(due, now = new Date()) {
  if (!due || !due.date) return due?.time ? `No date (time ${due.time})` : 'No due date';
  const [y, m, d] = due.date.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const diff = daysBetween(now, dt);
  const label = diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : diff === -1 ? 'Yesterday'
    : dt.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', ...(y !== now.getFullYear() ? { year: 'numeric' } : {}) });
  if (!due.time) return label;
  const [hh, mm] = due.time.split(':').map(Number);
  const t = new Date(2000, 0, 1, hh, mm).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${label}, ${t}`;
}
