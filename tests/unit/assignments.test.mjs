import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromCandidate, mergeAssignments, applyEdit, bucketize, createManual, validateManual, sanitizeAiAssignments, needsAttention } from '../../extension/lib/assignments.js';
import { NOW } from './helpers.mjs';

const cand = (o) => fromCandidate({ pageUrl: 'https://school.example.edu/p', ...o }, { now: NOW });

test('refresh merges repeated assignments instead of duplicating them', () => {
  const first = [cand({ title: 'Lab Report', className: 'Chem', dueText: 'Oct 5', url: 'https://s/a/1' })];
  const again = [cand({ title: 'Lab Report', className: 'Chem', dueText: 'Oct 5', url: 'https://s/a/1' })];
  const r1 = mergeAssignments([], first);
  const r2 = mergeAssignments(r1.list, again);
  assert.equal(r2.list.length, 1);
  assert.equal(r2.added.length, 0);
  assert.equal(r2.unchanged, 1);
});

test('same item link matches even if the title changed; the new title is taken', () => {
  const r1 = mergeAssignments([], [cand({ title: 'Lab', dueText: 'Oct 5', url: 'https://s/a/1' })]);
  const r2 = mergeAssignments(r1.list, [cand({ title: 'Lab Report (updated)', dueText: 'Oct 6', url: 'https://s/a/1' })]);
  assert.equal(r2.list.length, 1);
  assert.equal(r2.list[0].title, 'Lab Report (updated)');
  assert.equal(r2.list[0].due.date, '2026-10-06');
  assert.deepEqual(r2.updated, [r2.list[0].id]);
});

test('user corrections are preserved across refreshes', () => {
  const r1 = mergeAssignments([], [cand({ title: 'Essay', className: 'English', dueText: 'Oct 9', url: 'https://s/a/9' })]);
  const edited = applyEdit(r1.list[0], { dueDate: '2026-10-12', dueTime: '08:00', className: 'English 10 Honors' });
  assert.equal(edited.due.status, 'exact');
  assert.equal(edited.due.note, 'Corrected by you.');
  const r2 = mergeAssignments([edited], [cand({ title: 'Essay', className: 'English', dueText: 'Oct 9', instructions: 'New instructions', url: 'https://s/a/9' })]);
  const a = r2.list[0];
  assert.equal(a.due.date, '2026-10-12');
  assert.equal(a.className, 'English 10 Honors');
  assert.equal(a.instructions, 'New instructions', 'unedited fields still update');
});

test('weekly items with the same title but different firm dates stay separate', () => {
  const r = mergeAssignments([], [cand({ title: 'Reading log', dueText: '10/02/2026' }), cand({ title: 'Reading log', dueText: '10/09/2026' })]);
  assert.equal(r.list.length, 2);
});

test('different classes with the same title stay separate', () => {
  const r = mergeAssignments([], [cand({ title: 'Quiz 1', className: 'Math' }), cand({ title: 'Quiz 1', className: 'Spanish' })]);
  assert.equal(r.list.length, 2);
});

test('a missing date is filled in by a later refresh', () => {
  const r1 = mergeAssignments([], [cand({ title: 'Poster', className: 'Art', dueText: '' })]);
  const r2 = mergeAssignments(r1.list, [cand({ title: 'Poster', className: 'Art', dueText: '10/20/2026' })]);
  assert.equal(r2.list.length, 1);
  assert.equal(r2.list[0].due.date, '2026-10-20');
});

test('buckets: overdue, today, this week, later, needs a date, done', () => {
  const mk = (title, dueText) => cand({ title, dueText });
  const list = [mk('Old', '09/20/2026'), mk('Now', '09/28/2026'), mk('Soon', '10/02/2026'), mk('Edge', '10/05/2026'), mk('Far', '11/15/2026'), mk('Unknown', ''), { ...mk('Finished', '09/29/2026'), status: 'done' }];
  const b = bucketize(list, NOW);
  assert.deepEqual(b.overdue.map((a) => a.title), ['Old']);
  assert.deepEqual(b.today.map((a) => a.title), ['Now']);
  assert.deepEqual(b.thisWeek.map((a) => a.title), ['Soon', 'Edge']);
  assert.deepEqual(b.later.map((a) => a.title), ['Far']);
  assert.deepEqual(b.noDate.map((a) => a.title), ['Unknown']);
  assert.deepEqual(b.done.map((a) => a.title), ['Finished']);
  assert.equal(needsAttention(b.noDate[0]), true);
});

test('manual entries are validated and marked as user-owned', () => {
  assert.deepEqual(validateManual({ title: '' }), ['A title is required.']);
  assert.ok(validateManual({ title: 'x', sourceUrl: 'javascript:alert(1)' }).length);
  const m = createManual({ title: 'Buy poster board', className: 'Art', dueDate: '2026-10-01' }, NOW);
  assert.equal(m.origin, 'manual');
  assert.equal(m.due.status, 'exact');
  assert.throws(() => createManual({ title: ' ' }), /title/);
  assert.throws(() => applyEdit(m, { title: '' }), /title/);
});

test('AI-extracted assignments must appear on the page; invented due dates are dropped', () => {
  const pageText = 'Unit test: Photosynthesis quiz. Due Oct 3. Also read chapter 2.';
  const { candidates, rejected } = sanitizeAiAssignments({
    assignments: [
      { title: 'Photosynthesis quiz', dueText: 'Due Oct 3', className: 'Bio', extra: 'x' },
      { title: 'read chapter 2', dueText: 'Oct 10' },
      { title: 'Made-up essay', dueText: 'Oct 4' },
      { title: '' },
    ],
  }, 'https://s/p', pageText);
  assert.deepEqual(candidates.map((c) => [c.title, c.dueText]), [['Photosynthesis quiz', 'Due Oct 3'], ['read chapter 2', '']]);
  assert.deepEqual(rejected, ['Made-up essay']);
  assert.equal('extra' in candidates[0], false);
});
