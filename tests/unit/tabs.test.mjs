import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findDuplicateTabs, normalizeUrlForDuplicates, parseTabCommand, searchTabs, tabsForPrompt } from '../../extension/lib/tabs.js';
import { validateAction } from '../../extension/lib/actions.js';

const tabs = [
  { id: 1, url: 'https://a.com/page#top', title: 'A', active: false, pinned: false, lastAccessed: 5 },
  { id: 2, url: 'https://a.com/page', title: 'A', active: true, pinned: false, lastAccessed: 9 },
  { id: 3, url: 'https://www.a.com/page?utm_source=x', title: 'A', active: false, pinned: false, lastAccessed: 1 },
  { id: 4, url: 'https://b.com/', title: 'B pinned', active: false, pinned: true, lastAccessed: 1 },
  { id: 5, url: 'https://b.com', title: 'B', active: false, pinned: false, lastAccessed: 2 },
  { id: 6, url: 'https://c.com/x?q=1', title: 'C', active: false, pinned: false },
  { id: 7, url: 'https://c.com/x?q=2', title: 'C2', active: false, pinned: false },
  { id: 8, url: 'chrome://settings', title: 'Settings', active: false, pinned: false },
  { id: 9, url: 'chrome://settings', title: 'Settings', active: false, pinned: false },
];

test('URL normalization ignores fragments, tracking params, www and trailing slash', () => {
  assert.equal(normalizeUrlForDuplicates('https://www.a.com/page/?utm_source=x#frag'), 'https://a.com/page');
  assert.notEqual(normalizeUrlForDuplicates('https://c.com/x?q=1'), normalizeUrlForDuplicates('https://c.com/x?q=2'));
});

test('duplicates keep the active tab and never propose pinned tabs', () => {
  const { close, keep } = findDuplicateTabs(tabs);
  assert.deepEqual(close.map((t) => t.id).sort(), [1, 3, 5]);
  assert.ok(keep.some((t) => t.id === 2));
  assert.ok(keep.some((t) => t.id === 4), 'pinned tab is kept');
  assert.ok(!close.some((t) => t.pinned));
  assert.ok(!close.some((t) => t.url.startsWith('chrome://')));
});

test('local command parsing', () => {
  assert.deepEqual(parseTabCommand('close duplicate tabs'), { type: 'close_duplicate_tabs' });
  assert.deepEqual(parseTabCommand('Remove duplicates'), { type: 'close_duplicate_tabs' });
  assert.deepEqual(parseTabCommand('save these research tabs and close them', { selectedTabIds: [2, 6] }), { type: 'save_tabs', tabIds: [2, 6], name: 'Research', close: true });
  assert.deepEqual(parseTabCommand('save selected tabs as Bio Project', { selectedTabIds: [2] }), { type: 'save_tabs', tabIds: [2], name: 'Bio Project', close: false });
  assert.equal(parseTabCommand('save these research tabs and close them', { selectedTabIds: [] }), null, 'no selection -> AI decides which tabs, then user confirms');
  assert.deepEqual(parseTabCommand('group these as Chemistry', { selectedTabIds: [6, 7] }), { type: 'group_tabs', tabIds: [6, 7], title: 'Chemistry' });
  assert.deepEqual(parseTabCommand('close selected', { selectedTabIds: [6] }), { type: 'close_tabs', tabIds: [6] });
  assert.deepEqual(parseTabCommand('reopen bio', { savedGroups: [{ id: 'g1', name: 'Bio research' }] }), { type: 'reopen_saved_group', groupId: 'g1' });
  assert.deepEqual(parseTabCommand('find wikipedia'), { type: 'search_tabs', query: 'wikipedia' });
  assert.equal(parseTabCommand('close the tabs about news'), null);
});

test('parsed commands still pass through the validator', () => {
  const action = parseTabCommand('close selected', { selectedTabIds: [4] });
  assert.equal(validateAction(action, { tabs, explicitTabIds: [4] }).ok, true, 'user ticked the pinned tab explicitly');
});

test('search matches all terms in title or URL', () => {
  assert.deepEqual(searchTabs(tabs, 'c.com c2').map((t) => t.id), [7]);
  assert.equal(searchTabs(tabs, '').length, tabs.length);
});

test('tab list for the AI omits query strings and fragments', () => {
  const list = tabsForPrompt([{ id: 1, title: 'Grades', url: 'https://portal.school.edu/grades?student=123&token=abc#x', pinned: false }]);
  assert.deepEqual(list, [{ id: 1, title: 'Grades', site: 'portal.school.edu/grades', pinned: false }]);
});
