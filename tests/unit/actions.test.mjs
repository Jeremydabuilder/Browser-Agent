import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAction, ALLOWED_ACTIONS } from '../../extension/lib/actions.js';

const tabs = [
  { id: 1, title: 'Docs', url: 'https://docs.google.com/a', pinned: true },
  { id: 2, title: 'News', url: 'https://news.example.com', pinned: false },
  { id: 3, title: 'Wiki', url: 'https://en.wikipedia.org/wiki/Cell', pinned: false },
];
const ctx = { tabs, savedGroups: [{ id: 'grp_1', name: 'Bio research' }] };

test('only allowlisted action types are accepted', () => {
  for (const type of ['run_script', 'send_email', 'submit_form', 'navigate', 'eval', '__proto__', '']) {
    const r = validateAction({ type, code: 'alert(1)' }, ctx);
    assert.equal(r.ok, false, type);
  }
  assert.deepEqual([...ALLOWED_ACTIONS].sort(), ['close_duplicate_tabs', 'close_tabs', 'focus_tab', 'group_tabs', 'none', 'reopen_saved_group', 'save_tabs', 'search_tabs', 'ungroup_tabs']);
  assert.equal(validateAction(null, ctx).ok, false);
  assert.equal(validateAction([{ type: 'close_tabs' }], ctx).ok, false);
});

test('closing tabs always requires confirmation', () => {
  const r = validateAction({ type: 'close_tabs', tabIds: [2] }, ctx);
  assert.equal(r.ok, true);
  assert.equal(r.requiresConfirmation, true);
  assert.equal(validateAction({ type: 'close_duplicate_tabs' }, ctx).requiresConfirmation, true);
  assert.equal(validateAction({ type: 'save_tabs', tabIds: [2, 3], close: true }, ctx).requiresConfirmation, true);
  assert.equal(validateAction({ type: 'save_tabs', tabIds: [2, 3] }, ctx).requiresConfirmation, false);
  assert.equal(validateAction({ type: 'group_tabs', tabIds: [2, 3], title: 'x' }, ctx).requiresConfirmation, false);
});

test('pinned tabs are excluded from closing unless explicitly selected by the user', () => {
  const r = validateAction({ type: 'close_tabs', tabIds: [1, 2] }, ctx);
  assert.deepEqual(r.action.tabIds, [2]);
  assert.match(r.warnings.join(' '), /pinned/);
  const onlyPinned = validateAction({ type: 'close_tabs', tabIds: [1] }, ctx);
  assert.equal(onlyPinned.ok, false);
  const explicit = validateAction({ type: 'close_tabs', tabIds: [1, 2] }, { ...ctx, explicitTabIds: [1] });
  assert.deepEqual(explicit.action.tabIds, [1, 2]);
  const saveClose = validateAction({ type: 'save_tabs', tabIds: [1, 3], close: true }, ctx);
  assert.deepEqual(saveClose.action.tabIds, [3]);
});

test('unknown tab ids are dropped; unknown fields are stripped', () => {
  const r = validateAction({ type: 'close_tabs', tabIds: [2, 99, '3', 'abc'], extra: 'x' }, ctx);
  assert.deepEqual(r.action.tabIds, [2, 3]);
  assert.equal('extra' in r.action, false);
  assert.ok(r.warnings.some((w) => /no longer exist/.test(w)));
  assert.ok(r.warnings.some((w) => /unexpected field/.test(w)));
  assert.equal(validateAction({ type: 'focus_tab', tabId: 42 }, ctx).ok, false);
});

test('types and values are checked', () => {
  assert.equal(validateAction({ type: 'close_tabs', tabIds: '2' }, ctx).ok, false);
  assert.equal(validateAction({ type: 'save_tabs', tabIds: [2], close: 'yes' }, ctx).ok, false);
  assert.equal(validateAction({ type: 'search_tabs' }, ctx).ok, false);
  const g = validateAction({ type: 'group_tabs', tabIds: [2], title: 'Bio\n\u0007 research '.repeat(10), color: 'neon' }, ctx);
  assert.equal(g.ok, true);
  assert.equal(g.action.color, 'blue');
  assert.ok(g.action.title.length <= 80);
  assert.doesNotMatch(g.action.title, /[\n\u0007]/);
  assert.equal(validateAction({ type: 'reopen_saved_group', groupId: 'nope' }, ctx).ok, false);
  assert.equal(validateAction({ type: 'reopen_saved_group', groupId: 'grp_1' }, ctx).ok, true);
});

test('too many tabs are rejected', () => {
  const many = Array.from({ length: 205 }, (_, i) => ({ id: i + 10, url: `https://x/${i}`, pinned: false }));
  const r = validateAction({ type: 'close_tabs', tabIds: many.map((t) => t.id) }, { tabs: many });
  assert.equal(r.ok, false);
});
