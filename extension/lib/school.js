// School website configuration and assignment refresh/merge orchestration.
import { getItem, setItem } from './storage.js';
import { getSettings } from './settings.js';
import { fromCandidate, mergeAssignments, applyEdit, createManual, sanitizeAiAssignments } from './assignments.js';
import { chat } from './ai.js';
import { extractAssignmentsSystemPrompt, escapeForTag } from './prompts.js';
import { uid, isHttpUrl, clampText } from './util.js';

const SCHOOL_KEY = 'school';
const ASSIGNMENTS_KEY = 'assignments';

export async function getSchool() {
  return getItem(SCHOOL_KEY, { siteUrl: '', pages: [] });
}

export async function saveSchool(school) {
  await setItem(SCHOOL_KEY, school);
  return school;
}

export async function setSchoolSite(siteUrl) {
  if (!isHttpUrl(siteUrl)) throw new Error('Enter the full address of your school website, starting with https://');
  const u = new URL(siteUrl);
  const school = await getSchool();
  school.siteUrl = `${u.protocol}//${u.hostname}/`;
  return saveSchool(school);
}

export async function addSourcePage({ url, label = '', defaultClass = '', method = 'auto' }) {
  if (!isHttpUrl(url)) throw new Error('Assignment pages must be web addresses starting with http:// or https://');
  const school = await getSchool();
  const clean = url.split('#')[0];
  if (school.pages.some((p) => p.url === clean)) throw new Error('This page is already in your list.');
  if (school.pages.length >= 25) throw new Error('You can add up to 25 assignment pages.');
  const page = { id: uid('pg'), url: clean, label: clampText(label || clean, 80), defaultClass: clampText(defaultClass, 120), method: ['auto', 'heuristic', 'ai'].includes(method) ? method : 'auto', lastRefreshedAt: null, lastResult: null };
  school.pages.push(page);
  await saveSchool(school);
  return page;
}

export async function updateSourcePage(id, patch) {
  const school = await getSchool();
  school.pages = school.pages.map((p) => (p.id === id ? { ...p, ...patch, id: p.id, url: p.url } : p));
  return saveSchool(school);
}

export async function removeSourcePage(id) {
  const school = await getSchool();
  school.pages = school.pages.filter((p) => p.id !== id);
  return saveSchool(school);
}

export async function listAssignments() {
  return getItem(ASSIGNMENTS_KEY, []);
}

async function saveAssignments(list) {
  await setItem(ASSIGNMENTS_KEY, list);
}

export async function mergeAndSave(incoming) {
  const existing = await listAssignments();
  const result = mergeAssignments(existing, incoming);
  await saveAssignments(result.list);
  return result;
}

export async function editAssignment(id, patch) {
  const list = await listAssignments();
  const idx = list.findIndex((a) => a.id === id);
  if (idx < 0) throw new Error('Assignment not found.');
  list[idx] = applyEdit(list[idx], patch);
  await saveAssignments(list);
  return list[idx];
}

export async function addManualAssignment(input) {
  const a = createManual(input);
  await saveAssignments([...(await listAssignments()), a]);
  return a;
}

export async function deleteAssignment(id) {
  await saveAssignments((await listAssignments()).filter((a) => a.id !== id));
}

export async function clearAssignments() {
  await saveAssignments([]);
}

/** Turns extractor output into assignments for a configured source page (or an ad-hoc page). */
export async function candidatesToAssignments(candidates, source = {}) {
  const { dateOrder } = await getSettings();
  const now = new Date();
  return candidates.map((c) => fromCandidate(c, { now, dateOrder, source, origin: c.method === 'ai' ? 'ai' : 'extracted' }));
}

/** AI extraction for pages the heuristics can't parse. Caller must have shown the consent notice. */
export async function aiExtractAssignments(page, { onStatus } = {}) {
  const settings = await getSettings();
  const text = page.text.slice(0, settings.maxInputTokens * 4);
  const r = await chat({
    messages: [
      { role: 'system', content: extractAssignmentsSystemPrompt() },
      { role: 'user', content: `Page title: ${escapeForTag(page.title)}\nPage address: ${escapeForTag(page.url)}\n\n<page>\n${escapeForTag(text)}\n</page>` },
    ],
    json: true,
    maxTokens: 2000,
    onStatus,
  });
  const { candidates, rejected } = sanitizeAiAssignments(r.data, page.url, page.text);
  return { candidates, rejected, truncated: page.text.length > text.length, notices: r.notices };
}

export async function recordRefresh(pageId, result) {
  await updateSourcePage(pageId, { lastRefreshedAt: new Date().toISOString(), lastResult: result });
}
