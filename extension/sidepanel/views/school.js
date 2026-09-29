// "School" view: choose the school website and assignment pages, refresh them, and see
// assignments grouped as Overdue / Today / This week / Later / Needs a date.
import { h, clear, link, toast, modal, confirmDialog, confirmSendToAI, spinner, errorBox } from '../../lib/ui.js';
import { requestSiteAccess, hasSiteAccess, readAssignmentsInTab, unreadableReason } from '../../lib/browser.js';
import * as school from '../../lib/school.js';
import { bucketize, needsAttention, dedupeCandidates } from '../../lib/assignments.js';
import { formatDue } from '../../lib/dates.js';
import { getConnections } from '../../lib/google-auth.js';
import { importClassroom } from '../../lib/classroom.js';
import { isHttpUrl, hostnameOf } from '../../lib/util.js';

let root;
let app;
let busy = false;
const expanded = new Set();
let setupOpen = null; // remembers whether the setup section is expanded across re-renders

export function init(container, appRef) {
  root = container;
  app = appRef;
  // Re-render when the current tab changes, but never while the user is typing in this view.
  app.onTargetTab(() => { if (!root.hidden && !busy && !root.contains(document.activeElement) && !document.querySelector('.overlay')) render(); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.assignments || changes.school) && !root.hidden && !busy && !document.querySelector('.overlay')) render();
  });
}

export function show() {
  render();
}

async function render() {
  const [cfg, list, connections] = await Promise.all([school.getSchool(), school.listAssignments(), getConnections()]);
  const siteAccess = cfg.siteUrl ? await hasSiteAccess(cfg.siteUrl) : false;
  clear(root);
  root.append(renderSetup(cfg, siteAccess, connections));
  root.append(renderToolbar(cfg, connections));
  root.append(h('div', { id: 'school-status' }));
  root.append(renderBuckets(list));
}

function renderSetup(cfg, siteAccess, connections) {
  const tab = app.targetTab;
  const onSchoolSite = tab && cfg.siteUrl && isHttpUrl(tab.url) && hostnameOf(tab.url) === hostnameOf(cfg.siteUrl);
  if (!cfg.siteUrl) {
    const input = h('input', { type: 'url', placeholder: 'https://myschool.example.edu', value: tab && isHttpUrl(tab.url) ? new URL(tab.url).origin : '' });
    return h('div', { class: 'card' },
      h('h3', {}, 'Set up your school website'),
      h('p', { class: 'muted small' }, 'Satchel reads assignment pages on your school website while you are signed in, in your own browser. It does not need a school API, and it only reads the pages you choose, when you click Refresh.'),
      h('label', {}, 'School website address'), input,
      h('div', { class: 'btn-row' }, h('button', {
        class: 'btn primary',
        onclick: () => {
          const url = input.value.trim();
          if (!isHttpUrl(url)) { toast('Enter an address starting with https://', 'error'); return; }
          const access = requestSiteAccess([url]); // must run inside the click
          access.then(async (granted) => {
            await school.setSchoolSite(url);
            toast(granted ? 'School website saved.' : 'Saved. Satchel still needs permission to read it; click "Allow access".', granted ? 'info' : 'error');
            render();
          });
        },
      }, 'Save & allow access')),
      connections.classroom ? null : h('p', { class: 'muted small' }, 'Use Google Classroom? You can also connect it in Settings → Google.'),
    );
  }
  const pagesList = h('div', {}, cfg.pages.length ? cfg.pages.map(renderPageRow) : h('p', { class: 'muted small' }, 'No assignment pages yet. Open a page on your school site that lists assignments, then click “Add this page”.'));
  const addUrl = h('input', { type: 'url', placeholder: 'Or paste the address of an assignment page' });
  const details = h('details', { class: 'card', open: setupOpen ?? !cfg.pages.length, ontoggle: (e) => { setupOpen = e.target.open; } },
    h('summary', {}, `School website: ${hostnameOf(cfg.siteUrl)} · ${cfg.pages.length} page(s)`),
    siteAccess ? null : h('p', { class: 'warn small' }, 'Satchel does not have permission to read this site yet. ',
      h('button', { class: 'btn small', onclick: () => requestSiteAccess([cfg.siteUrl]).then(() => render()) }, 'Allow access')),
    h('div', { class: 'btn-row' },
      h('button', {
        class: 'btn', disabled: !tab || !isHttpUrl(tab.url),
        title: onSchoolSite ? '' : 'The current page is not on your school website, but you can still add it.',
        onclick: () => {
          const url = tab.url;
          const access = requestSiteAccess([url]);
          access.then((granted) => addPageDialog(url, tab.title, granted));
        },
      }, '＋ Add this page'),
      h('button', { class: 'btn link small', onclick: async () => { if (await confirmDialog({ title: 'Change school website?', message: 'Your assignment pages list will be kept.' })) { const c = await school.getSchool(); c.siteUrl = ''; await school.saveSchool(c); render(); } } }, 'Change website')),
    pagesList,
    h('div', { class: 'btn-row' }, addUrl, h('button', {
      class: 'btn small',
      onclick: () => {
        const url = addUrl.value.trim();
        if (!isHttpUrl(url)) { toast('Enter an address starting with https://', 'error'); return; }
        requestSiteAccess([url]).then((granted) => addPageDialog(url, '', granted));
      },
    }, 'Add')),
    h('p', { class: 'muted small' }, 'Tip: add the pages that list your assignments (for example “Upcoming”, “Assignments”, or each class page).'),
  );
  return details;
}

function renderPageRow(p) {
  const r = p.lastResult;
  const status = !r ? h('span', { class: 'chip' }, 'not refreshed')
    : r.error ? h('span', { class: 'chip danger', title: r.error }, r.signedOut ? 'signed out' : 'error')
      : h('span', { class: 'chip ok' }, `${r.count} found`);
  const methodSel = h('select', { 'aria-label': 'How to read this page', title: 'How to read this page', style: 'width:auto', onchange: (e) => school.updateSourcePage(p.id, { method: e.target.value }) },
    h('option', { value: 'auto' }, 'Auto'), h('option', { value: 'heuristic' }, 'No AI'), h('option', { value: 'ai' }, 'AI'));
  methodSel.value = p.method;
  return h('div', { class: 'page-row' },
    h('span', { class: 'grow' }, link(p.url, p.label || p.url), p.defaultClass ? h('span', { class: 'muted small' }, ` · ${p.defaultClass}`) : null),
    status, methodSel,
    h('button', { class: 'btn link small', title: 'Remove this page', onclick: async () => { await school.removeSourcePage(p.id); render(); } }, '✕'));
}

async function addPageDialog(url, title, granted) {
  const label = h('input', { type: 'text', value: title || '' });
  const cls = h('input', { type: 'text', placeholder: 'Optional, e.g. Biology' });
  const method = h('select', {}, h('option', { value: 'auto' }, 'Auto: built-in reader, AI only if nothing is found (asks first)'),
    h('option', { value: 'heuristic' }, 'Built-in reader only (never send this page to AI)'), h('option', { value: 'ai' }, 'Always use AI (asks before sending)'));
  const body = h('div', { class: 'form' },
    h('p', { class: 'small' }, link(url, url)),
    granted ? null : h('p', { class: 'warn small' }, 'Permission to read this site was not granted, so refresh will fail until you allow it.'),
    h('label', {}, 'Name'), label, h('label', {}, 'Class (used when the page does not say)'), cls, h('label', {}, 'How to read it'), method);
  const ok = await modal({ title: 'Add assignment page', body, actions: [{ label: 'Cancel', value: false }, { label: 'Add page', value: true, kind: 'primary' }] });
  if (!ok) return;
  try {
    await school.addSourcePage({ url, label: label.value.trim(), defaultClass: cls.value.trim(), method: method.value });
    toast('Page added. Click “Refresh pages” to read it.');
    render();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function renderToolbar(cfg, connections) {
  const tab = app.targetTab;
  return h('div', { class: 'btn-row sticky-actions' },
    h('button', { class: 'btn primary', disabled: !cfg.pages.length, onclick: () => refreshAll(cfg) }, '↻ Refresh pages'),
    h('button', {
      class: 'btn', disabled: !tab || !!unreadableReason(tab?.url),
      title: 'Read assignments from the page you are viewing right now',
      onclick: () => { const t = app.targetTab; const access = requestSiteAccess([t.url]); importFromTab(t, access); },
    }, 'Import from this page'),
    h('button', { class: 'btn', onclick: () => editDialog(null) }, '＋ Add manually'),
    connections.classroom ? h('button', { class: 'btn', onclick: importFromClassroom }, 'Import Classroom') : null,
  );
}

function setStatus(node) {
  const el = document.getElementById('school-status');
  if (el) { clear(el); if (node) el.append(node); }
}

async function extractWithFallback(pageResult, source) {
  // pageResult: {page, found}. Returns {assignments, usedAI, note}
  let candidates = pageResult.found.candidates;
  let usedAI = false;
  let note = '';
  const method = source.method || 'auto';
  if (method === 'ai' || (method === 'auto' && !candidates.length)) {
    if (!pageResult.page?.text || pageResult.page.text.length < 40) {
      note = 'The page had no readable text.';
    } else {
      const ok = await confirmSendToAI({
        what: 'the text of this school page (to find assignments)',
        items: [{ title: pageResult.page.title || source.label, url: pageResult.page.url, words: Math.round(pageResult.page.text.length / 5.5) }],
        extra: method === 'auto' ? 'Satchel\'s built-in reader found no assignments on this page, so it can ask the AI instead. Nothing from the page is saved except the assignments found.' : '',
      });
      if (ok) {
        const r = await school.aiExtractAssignments(pageResult.page, { onStatus: (s) => setStatus(spinner(s)) });
        candidates = r.candidates;
        usedAI = true;
        if (r.rejected.length) note = `${r.rejected.length} AI suggestion(s) were ignored because they did not appear on the page.`;
        if (r.truncated) note += ' The page was long, so only the first part was checked by the AI.';
      } else {
        note = 'AI reading was skipped.';
      }
    }
  }
  const assignments = await school.candidatesToAssignments(candidates, source);
  return { assignments: dedupeCandidates(assignments), usedAI, note };
}

async function refreshAll(cfg) {
  if (busy) return;
  busy = true;
  setStatus(spinner(`Opening ${cfg.pages.length} page(s) in background tabs…`));
  try {
    const res = await chrome.runtime.sendMessage({ cmd: 'school.fetchPages', urls: cfg.pages.map((p) => p.url) });
    if (!res?.ok) throw new Error(res?.error || 'Refresh failed.');
    const summary = [];
    let totalAdded = 0;
    let totalUpdated = 0;
    for (let i = 0; i < cfg.pages.length; i++) {
      const page = cfg.pages[i];
      const r = res.result[i];
      if (!r.ok) {
        await school.recordRefresh(page.id, { error: r.reason, signedOut: !!r.signedOut, count: 0 });
        summary.push(h('li', { class: 'error' }, `${page.label}: ${r.reason}`));
        continue;
      }
      setStatus(spinner(`Reading ${page.label}…`));
      const { assignments, usedAI, note } = await extractWithFallback(r, page);
      const merged = await school.mergeAndSave(assignments);
      totalAdded += merged.added.length;
      totalUpdated += merged.updated.length;
      await school.recordRefresh(page.id, { count: assignments.length, usedAI, note });
      summary.push(h('li', {}, `${page.label}: ${assignments.length} found (${merged.added.length} new, ${merged.updated.length} updated)${usedAI ? ' using AI' : ''}${note ? `. ${note}` : ''}`));
    }
    busy = false;
    await render();
    setStatus(h('div', { class: 'card soft small' }, h('b', {}, `Refresh done: ${totalAdded} new, ${totalUpdated} updated.`), h('ul', {}, summary)));
  } catch (err) {
    busy = false;
    setStatus(errorBox(err));
  } finally {
    busy = false;
  }
}

async function importFromTab(tab, accessPromise) {
  if (busy) return;
  busy = true;
  setStatus(spinner('Reading this page…'));
  try {
    const granted = await accessPromise.catch(() => false);
    if (!granted) throw new Error('Satchel needs permission to read this site. Click the button again and choose Allow.');
    const r = await readAssignmentsInTab(tab);
    if (!r.ok) throw new Error(r.reason);
    const cfg = await school.getSchool();
    const source = cfg.pages.find((p) => p.url === tab.url.split('#')[0]) || { url: tab.url, label: tab.title, method: 'auto' };
    const { assignments, usedAI, note } = await extractWithFallback(r, source);
    if (!assignments.length) {
      busy = false;
      setStatus(h('p', { class: 'muted' }, `No assignments were found on this page. ${note}`));
      return;
    }
    const merged = await school.mergeAndSave(assignments);
    busy = false;
    await render();
    setStatus(h('p', { class: 'card soft small' }, `Imported ${assignments.length} assignment(s): ${merged.added.length} new, ${merged.updated.length} updated${usedAI ? ' (read with AI)' : ''}. ${note}`,
      cfg.pages.some((p) => p.url === tab.url.split('#')[0]) ? '' : h('span', {}, ' ', h('button', { class: 'btn link small', onclick: () => addPageDialog(tab.url, tab.title, true) }, 'Add this page to Refresh list'))));
  } catch (err) {
    busy = false;
    setStatus(errorBox(err));
  } finally {
    busy = false;
  }
}

async function importFromClassroom() {
  if (busy) return;
  busy = true;
  setStatus(spinner('Loading your Google Classroom coursework…'));
  try {
    const r = await importClassroom();
    const merged = await school.mergeAndSave(r.assignments);
    busy = false;
    await render();
    setStatus(h('div', { class: 'card soft small' }, `Google Classroom: ${r.courseCount} class(es), ${r.assignments.length} item(s): ${merged.added.length} new, ${merged.updated.length} updated.`,
      r.problems.length ? h('ul', {}, r.problems.map((p) => h('li', { class: 'error' }, p))) : null));
  } catch (err) {
    busy = false;
    setStatus(h('p', { class: 'error' }, err.message));
  } finally {
    busy = false;
  }
}

function dueBadge(a) {
  const s = a.due?.status;
  if (!a.due?.date) return h('span', { class: 'chip warn', title: a.due?.note || '' }, a.due?.time ? `No date (${a.due.time})` : 'No due date');
  const text = formatDue(a.due);
  if (s === 'ambiguous') return h('span', { class: 'chip warn', title: a.due.note }, `⚠ ${text} (check)`);
  if (s === 'inferred') return h('span', { class: 'chip', title: a.due.note }, `${text} ?`);
  return h('span', { class: 'chip accent', title: a.due.note || '' }, text);
}

function renderAssignment(a) {
  const isOpen = expanded.has(a.id);
  const done = h('input', { type: 'checkbox', checked: a.status === 'done', title: 'Mark done', 'aria-label': `Mark ${a.title} done`, onchange: async (e) => { await school.editAssignment(a.id, { status: e.target.checked ? 'done' : 'open' }); render(); } });
  const sources = a.sources?.length ? a.sources : a.sourceUrl ? [{ itemUrl: a.sourceUrl, pageUrl: a.sourceUrl }] : [];
  return h('div', { class: `asg ${a.isNew ? 'new' : ''} ${a.status === 'done' ? 'done' : ''}` },
    h('div', { class: 'asg-top' }, done,
      h('div', { class: 'asg-main' },
        h('div', { class: 'asg-title' }, a.sourceUrl ? link(a.sourceUrl, a.title) : a.title),
        h('div', { class: 'asg-meta' },
          dueBadge(a),
          a.className ? h('span', { class: `chip ${a.classGuessed ? 'warn' : ''}`, title: a.classGuessed ? 'Class guessed from a page heading; click Edit to correct.' : '' }, a.className, a.classGuessed ? ' ?' : '') : h('span', { class: 'chip' }, 'no class'),
          a.isNew ? h('span', { class: 'chip ok' }, 'new') : null,
          a.origin === 'manual' ? h('span', { class: 'chip' }, 'added by you') : a.origin === 'classroom' ? h('span', { class: 'chip' }, 'Classroom') : a.origin === 'ai' ? h('span', { class: 'chip', title: 'Found by the AI reader' }, 'AI') : null,
          Object.keys(a.edited || {}).length && a.origin !== 'manual' ? h('span', { class: 'chip', title: 'You corrected this; refreshes will not overwrite your changes.' }, 'edited') : null)),
      h('button', { class: 'btn link small', 'aria-expanded': String(isOpen), onclick: () => { if (isOpen) expanded.delete(a.id); else expanded.add(a.id); render(); } }, isOpen ? 'Less' : 'More')),
    isOpen ? h('div', { class: 'asg-details' },
      a.instructions ? h('div', { class: 'instructions' }, a.instructions) : h('div', { class: 'muted small' }, 'No instructions captured.'),
      a.notes ? h('div', { class: 'small' }, h('b', {}, 'Your notes: '), a.notes) : null,
      a.due?.note ? h('div', { class: 'muted small' }, 'Due date: ', a.due.note, a.due.raw ? ` (page said “${a.due.raw}”)` : '') : null,
      sources.length ? h('div', { class: 'small' }, 'Original: ', sources.map((s, i) => h('span', {}, i ? ' · ' : '', link(s.itemUrl || s.pageUrl, s.label || hostnameOf(s.itemUrl || s.pageUrl) || 'link')))) : null,
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn small', onclick: () => editDialog(a) }, 'Edit'),
        h('button', { class: 'btn small', onclick: async () => { if (await confirmDialog({ title: 'Delete assignment?', message: `“${a.title}” will be removed from Satchel. (It may come back on the next refresh if it is still on the page.)`, confirmLabel: 'Delete', danger: true })) { await school.deleteAssignment(a.id); render(); } } }, 'Delete'))) : null,
  );
}

function renderBuckets(list) {
  const wrap = h('div', {});
  if (!list.length) {
    wrap.append(h('div', { class: 'empty' }, 'No assignments yet. Add your school pages above and click Refresh, import from the page you are viewing, or add one manually.'));
    return wrap;
  }
  const b = bucketize(list);
  const attention = list.filter((a) => a.status !== 'done' && needsAttention(a)).length;
  if (attention) wrap.append(h('p', { class: 'warn small' }, `${attention} assignment(s) have a missing, unclear, or guessed date or class. They are marked ⚠ or ?; open them and click Edit to correct.`));
  const section = (key, title, items) => {
    if (!items.length) return null;
    const content = h('div', {}, items.map(renderAssignment));
    return h('div', { class: `bucket ${key}` }, key === 'done'
      ? h('details', {}, h('summary', {}, `${title} (${items.length})`), content)
      : [h('h3', {}, title, h('span', { class: 'chip' }, String(items.length))), content]);
  };
  const sections = [
    section('overdue', 'Overdue', b.overdue),
    section('today', 'Today', b.today),
    section('thisWeek', 'This week', b.thisWeek),
    section('later', 'Later', b.later),
    section('noDate', 'Needs a date', b.noDate),
    section('done', 'Done', b.done),
  ];
  wrap.append(...sections.filter(Boolean));
  if (!b.overdue.length && !b.today.length && !b.thisWeek.length && !b.later.length && !b.noDate.length) wrap.prepend(h('div', { class: 'empty' }, 'All caught up! 🎉'));
  return wrap;
}

async function editDialog(a) {
  const f = {
    title: h('input', { type: 'text', value: a?.title || '', maxlength: 250 }),
    className: h('input', { type: 'text', value: a?.className || '', maxlength: 120 }),
    dueDate: h('input', { type: 'date', value: a?.due?.date || '' }),
    dueTime: h('input', { type: 'time', value: a?.due?.time || '' }),
    instructions: h('textarea', { rows: 4 }),
    notes: h('textarea', { rows: 2, placeholder: 'Private notes (only stored in your browser)' }),
    sourceUrl: h('input', { type: 'url', value: a?.sourceUrl || '', placeholder: 'https://… (optional link to the assignment)' }),
  };
  f.instructions.value = a?.instructions || '';
  f.notes.value = a?.notes || '';
  const err = h('p', { class: 'error small' });
  const body = h('div', { class: 'form' },
    h('label', {}, 'Title'), f.title, h('label', {}, 'Class'), f.className,
    h('div', { style: 'display:flex;gap:8px' }, h('div', { style: 'flex:2' }, h('label', {}, 'Due date'), f.dueDate), h('div', { style: 'flex:1' }, h('label', {}, 'Time'), f.dueTime)),
    a?.due?.raw ? h('p', { class: 'muted small' }, `The page said: “${a.due.raw}”`) : null,
    h('label', {}, 'Instructions'), f.instructions, h('label', {}, 'Notes'), f.notes,
    a ? null : [h('label', {}, 'Link'), f.sourceUrl],
    a ? h('p', { class: 'muted small' }, 'Fields you change here are kept even when the page is refreshed.') : null, err);
  await modal({
    title: a ? 'Edit assignment' : 'Add assignment',
    body,
    actions: [{ label: 'Cancel', value: null }, {
      label: a ? 'Save' : 'Add', kind: 'primary', value: true,
      validate: async () => {
        try {
          if (a) {
            const patch = {};
            if (f.title.value.trim() !== a.title) patch.title = f.title.value;
            if (f.className.value.trim() !== (a.className || '')) patch.className = f.className.value;
            if ((f.dueDate.value || null) !== (a.due?.date || null) || (f.dueTime.value || null) !== (a.due?.time || null) || (a.due?.status !== 'exact' && f.dueDate.value)) { patch.dueDate = f.dueDate.value; patch.dueTime = f.dueTime.value; }
            if (f.instructions.value.trim() !== (a.instructions || '')) patch.instructions = f.instructions.value;
            if (f.notes.value !== (a.notes || '')) patch.notes = f.notes.value;
            await school.editAssignment(a.id, patch);
          } else {
            await school.addManualAssignment({ title: f.title.value, className: f.className.value, dueDate: f.dueDate.value, dueTime: f.dueTime.value, instructions: f.instructions.value, sourceUrl: f.sourceUrl.value.trim() });
          }
          return true;
        } catch (e) {
          err.textContent = e.message;
          return false;
        }
      },
    }],
  });
  render();
}

