import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDue, parseTime } from '../../extension/lib/dates.js';
import { NOW } from './helpers.mjs';

const p = (text, opts = {}) => parseDue(text, { now: NOW, ...opts });

test('full US numeric date with time is exact', () => {
  assert.deepEqual({ ...p('10/02/2026 11:59 PM'), raw: undefined, note: undefined }, { date: '2026-10-02', time: '23:59', status: 'exact', raw: undefined, note: undefined });
});

test('ISO dates and <time datetime> attributes', () => {
  assert.equal(p('2026-11-01').date, '2026-11-01');
  const r = p('Mon Oct 5', { datetimeAttr: '2026-10-05T23:59:00' });
  assert.equal(r.date, '2026-10-05');
  assert.equal(r.time, '23:59');
  assert.equal(r.status, 'exact');
  assert.equal(p('Sep 29 at 8:00 AM', { datetimeAttr: '2026-09-29' }).time, '08:00');
});

test('month names without year infer the nearest year and say so', () => {
  const r = p('Due Oct 12');
  assert.equal(r.date, '2026-10-12');
  assert.equal(r.status, 'inferred');
  assert.match(r.note, /Year not shown/);
  assert.equal(p('Jan 5').date, '2027-01-05');
  assert.equal(p('Sep 20').date, '2026-09-20');
  assert.equal(p('12 October 2026').date, '2026-10-12');
  assert.equal(p('October 3rd, 2026').date, '2026-10-03');
});

test('weekday that matches the date stays inferred; mismatch is ambiguous', () => {
  assert.equal(p('Due Fri, Oct 9').status, 'inferred'); // Oct 9 2026 is a Friday
  const bad = p('Due Thu, Oct 9');
  assert.equal(bad.status, 'ambiguous');
  assert.match(bad.note, /weekday/);
});

test('relative dates are resolved from the read date and marked inferred', () => {
  const t = p('Due tomorrow');
  assert.equal(t.date, '2026-09-29');
  assert.equal(t.status, 'inferred');
  assert.equal(p('due today').date, '2026-09-28');
  assert.equal(p('due Friday').date, '2026-10-02');
  assert.equal(p('in 3 days').date, '2026-10-01');
  const next = p('due next Monday');
  assert.equal(next.status, 'ambiguous');
});

test('missing and no-date values', () => {
  for (const s of ['', 'No due date', 'TBD', 'n/a', '—']) assert.equal(p(s).status, 'missing', s);
  const timeOnly = p('Due 11:59 PM');
  assert.equal(timeOnly.status, 'missing');
  assert.equal(timeOnly.time, '23:59');
  assert.equal(p('Study hard').status, 'missing');
});

test('impossible month/day order is swapped and flagged', () => {
  const r = p('Due 13/10');
  assert.equal(r.date, '2026-10-13');
  assert.equal(r.status, 'ambiguous');
});

test('DMY setting reads day first', () => {
  assert.equal(p('03/10/2026', { dateOrder: 'DMY' }).date, '2026-10-03');
  assert.equal(p('03/10/2026', { dateOrder: 'MDY' }).date, '2026-03-10');
});

test('multiple dates prefer the one after "due"; otherwise ambiguous', () => {
  assert.equal(p('Assigned Sep 20 · Due Sep 30').date, '2026-09-30');
  assert.equal(p('Assigned Sep 20 · Due Sep 30').status, 'inferred');
  assert.equal(p('Sep 20 or Sep 30').status, 'ambiguous');
});

test('page ranges and invalid dates are not treated as dates', () => {
  assert.equal(p('Read pages 10-12').status, 'missing');
  assert.equal(p('Due 02/30/2026').status, 'missing');
});

test('time parsing', () => {
  assert.equal(parseTime('at 3pm').time, '15:00');
  assert.equal(parseTime('12:15 a.m.').time, '00:15');
  assert.equal(parseTime('noon').time, '12:00');
  assert.equal(parseTime('by midnight').time, '23:59');
  assert.equal(parseTime('17:45').time, '17:45');
  assert.equal(parseTime('no time'), null);
});
