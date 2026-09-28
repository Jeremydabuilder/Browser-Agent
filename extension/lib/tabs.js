// Pure tab logic (no chrome.* calls): duplicate detection, search, and local command parsing.

export function normalizeUrlForDuplicates(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    const params = [...u.searchParams.entries()]
      .filter(([k]) => !/^(utm_|fbclid$|gclid$|mc_eid$|ref$|ref_src$)/i.test(k))
      .sort(([a], [b]) => a.localeCompare(b));
    u.search = params.length ? `?${new URLSearchParams(params).toString()}` : '';
    let s = u.toString();
    if (u.pathname !== '/' && s.endsWith('/')) s = s.slice(0, -1);
    return s.replace(/^http:\/\//, 'https://').replace('://www.', '://');
  } catch {
    return url;
  }
}

/**
 * Finds duplicate tabs. Keeps one tab per URL (preferring active, then pinned, then most recently used)
 * and proposes closing the rest. Pinned duplicates are never proposed for closing.
 */
export function findDuplicateTabs(tabs) {
  const groups = new Map();
  for (const t of tabs) {
    if (!t.url || /^(chrome|edge|about|chrome-extension|devtools):/i.test(t.url)) continue;
    const key = normalizeUrlForDuplicates(t.url);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  const keep = [];
  const close = [];
  const sets = [];
  for (const [url, list] of groups) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => (b.active - a.active) || (b.pinned - a.pinned) || ((b.lastAccessed || 0) - (a.lastAccessed || 0)) || (a.id - b.id));
    const [keeper, ...rest] = sorted;
    keep.push(keeper);
    const closable = rest.filter((t) => !t.pinned);
    close.push(...closable);
    sets.push({ url, keep: keeper, close: closable });
  }
  return { keep, close, sets };
}

export function searchTabs(tabs, query) {
  const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return tabs;
  return tabs.filter((t) => {
    const hay = `${t.title || ''} ${t.url || ''}`.toLowerCase();
    return terms.every((term) => hay.includes(term));
  });
}

/**
 * Deterministic parsing of common tab commands so they work instantly without the AI.
 * Returns an action object (still validated afterwards) or null if the AI should interpret it.
 * @param selectedTabIds tabs the user ticked in the list (used for "these"/"selected")
 */
export function parseTabCommand(text, { selectedTabIds = [], savedGroups = [] } = {}) {
  const t = String(text || '').trim().toLowerCase().replace(/[.!?]+$/, '');
  if (!t) return null;
  const refersToSelection = /\b(these|this|selected|ticked|checked|chosen)\b/.test(t);
  const nameMatch = t.match(/\b(?:as|named|called)\s+["']?([^"']{1,60}?)["']?(?:\s+and\b|$)/);

  if (/\b(close|remove|kill)\b.*\bduplicates?\b|\bduplicates?\b.*\b(close|remove)\b|^(dedupe|de-duplicate)( tabs)?$/.test(t)) {
    return { type: 'close_duplicate_tabs' };
  }
  if (/\bsave\b/.test(t) && refersToSelection && selectedTabIds.length) {
    const close = /\b(and )?(close|remove)\b/.test(t);
    let name = nameMatch ? nameMatch[1].trim() : '';
    if (!name) {
      const m = t.match(/\bsave (?:these|the|my|selected)?\s*([\w\s-]{1,40}?)\s*tabs\b/);
      if (m && m[1].trim() && !/^(these|selected|this|the)$/.test(m[1].trim())) name = m[1].trim();
    }
    return { type: 'save_tabs', tabIds: selectedTabIds, name: name ? capitalize(name) : '', close };
  }
  if (/\bgroup\b/.test(t) && refersToSelection && selectedTabIds.length) {
    return { type: 'group_tabs', tabIds: selectedTabIds, title: nameMatch ? capitalize(nameMatch[1].trim()) : '' };
  }
  if (/\bungroup\b/.test(t) && refersToSelection && selectedTabIds.length) {
    return { type: 'ungroup_tabs', tabIds: selectedTabIds };
  }
  if (/^(close|remove)\b/.test(t) && refersToSelection && selectedTabIds.length) {
    return { type: 'close_tabs', tabIds: selectedTabIds };
  }
  const reopen = t.match(/^(?:reopen|restore|open)\s+(?:saved\s+)?(?:group\s+)?["']?(.+?)["']?(?:\s+tabs)?$/);
  if (reopen && savedGroups.length) {
    const want = reopen[1].trim();
    const hit = savedGroups.find((g) => g.name.toLowerCase() === want) || savedGroups.find((g) => g.name.toLowerCase().includes(want));
    if (hit) return { type: 'reopen_saved_group', groupId: hit.id };
  }
  const search = t.match(/^(?:find|search(?: tabs)?(?: for)?|where is|show)\s+(.+)$/);
  if (search && !/\b(close|group|save)\b/.test(t)) return { type: 'search_tabs', query: search[1].replace(/\s+tabs?$/, '') };
  return null;
}

function capitalize(s) {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Compact, privacy-reduced tab list for the AI: current window only, no query strings. */
export function tabsForPrompt(tabs) {
  return tabs.map((t) => {
    let where = '';
    try { const u = new URL(t.url); where = `${u.hostname}${u.pathname}`.slice(0, 120); } catch { where = ''; }
    return { id: t.id, title: String(t.title || '').slice(0, 120), site: where, pinned: !!t.pinned };
  });
}
