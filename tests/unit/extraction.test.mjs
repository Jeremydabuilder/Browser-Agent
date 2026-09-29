import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractAssignmentCandidates, extractPageContent } from '../../extension/lib/extractor.js';
import { fromCandidate, dedupeCandidates } from '../../extension/lib/assignments.js';
import { loadFixture, NOW } from './helpers.mjs';

test('extracts assignments from a portal table with links, class, instructions', () => {
  const doc = loadFixture('portal-table.html');
  const { candidates, pageHeading } = extractAssignmentCandidates({ __doc: doc });
  assert.equal(pageHeading, 'My Assignments');
  assert.equal(candidates.length, 4, 'duplicate row removed within page');
  const ch4 = candidates.find((c) => c.title === 'Chapter 4 Reading Questions');
  assert.equal(ch4.className, 'US History');
  assert.equal(ch4.url, 'https://school.example.edu/assignment/101');
  assert.equal(ch4.instructions, 'Answer questions 1-10 on page 112.');
  assert.equal(ch4.method, 'table');
  const lab = candidates.find((c) => c.title.startsWith('Lab Report'));
  assert.equal(lab.dueAttr, '2026-10-05T23:59:00');
});

test('table candidates normalize with correct due statuses', () => {
  const doc = loadFixture('portal-table.html');
  const list = extractAssignmentCandidates({ __doc: doc }).candidates.map((c) => fromCandidate(c, { now: NOW }));
  const by = Object.fromEntries(list.map((a) => [a.title, a]));
  assert.deepEqual([by['Chapter 4 Reading Questions'].due.date, by['Chapter 4 Reading Questions'].due.status], ['2026-10-02', 'exact']);
  assert.equal(by['Lab Report: Density'].due.time, '23:59');
  assert.equal(by['Vocabulary Quiz'].due.status, 'missing');
  assert.equal(by['Essay Outline'].due.date, '2026-10-09');
  assert.equal(by['Essay Outline'].sourceUrl, 'https://school.example.edu/assignment/104');
  assert.equal(by['Essay Outline'].sources[0].pageUrl, 'https://school.example.edu/portal-table.html');
});

test('extracts card-style assignments and ignores hidden text', () => {
  const doc = loadFixture('cards.html');
  const { candidates } = extractAssignmentCandidates({ __doc: doc });
  assert.equal(candidates.length, 3);
  const [ps, poetry, fair] = candidates;
  assert.equal(ps.title, 'Unit 2 Problem Set');
  assert.equal(ps.className, 'Algebra II');
  assert.equal(ps.dueAttr, '2026-09-29');
  assert.equal(ps.url, 'https://school.example.edu/courses/7/a/55');
  assert.equal(poetry.url, 'https://school.example.edu/courses/9/a/12');
  assert.equal(poetry.dueText, 'Due tomorrow');
  assert.equal(fair.url, '', 'no link -> falls back to page URL later');
  const a = fromCandidate(fair, { now: NOW });
  assert.equal(a.sourceUrl, 'https://school.example.edu/cards.html');
  assert.equal(a.due.status, 'ambiguous');
});

test('extracts free-text teacher pages and guesses class from section headings', () => {
  const doc = loadFixture('teacher-page.html');
  const { candidates } = extractAssignmentCandidates({ __doc: doc });
  const titles = candidates.map((c) => c.title);
  assert.deepEqual(titles, ['Cell diagram', 'Read chapter 5', 'Field notes journal']);
  assert.equal(candidates[0].className, 'Biology – Period 3');
  assert.equal(candidates[0].classGuessed, true);
  assert.equal(candidates[2].className, 'Environmental Science');
  const a = fromCandidate(candidates[0], { now: NOW });
  assert.equal(a.due.date, '2026-10-02');
  assert.equal(a.classGuessed, true);
});

test('page with no assignments returns none', () => {
  const doc = loadFixture('article.html');
  assert.equal(extractAssignmentCandidates({ __doc: doc }).candidates.length, 0);
});

test('page content extraction drops nav/footer/scripts and hidden text, keeps structure', () => {
  const doc = loadFixture('cards.html');
  const page = extractPageContent({ __doc: doc });
  assert.equal(page.title, 'To-do | Learning Hub');
  assert.match(page.text, /Unit 2 Problem Set/);
  assert.doesNotMatch(page.text, /IGNORE ALL PREVIOUS/);
  const art = extractPageContent({ __doc: loadFixture('article.html') });
  assert.match(art.text, /chloroplasts/);
  assert.doesNotMatch(art.text, /Copyright 2026/);
  assert.doesNotMatch(art.text, /Home \| Science/);
  assert.equal(art.hasPasswordField, false);
  assert.equal(extractPageContent({ __doc: loadFixture('login.html') }).hasPasswordField, true);
});

test('dedupe merges repeated assignments across pages', () => {
  const a = fromCandidate({ title: 'Essay Outline', className: 'English 10', dueText: 'Oct 9', pageUrl: 'https://s/p1' }, { now: NOW });
  const b = fromCandidate({ title: 'essay outline', className: 'English 10', dueText: '10/09/2026', pageUrl: 'https://s/p2' }, { now: NOW });
  const out = dedupeCandidates([a, b]);
  assert.equal(out.length, 1);
  assert.equal(out[0].sources.length, 2);
  assert.equal(out[0].due.status, 'exact', 'firmer date wins');
});
