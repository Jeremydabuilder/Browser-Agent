// Small shared helpers. No DOM or chrome.* usage here so they run in tests too.

export function uid(prefix = 'id') {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

export function clampText(text, max) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function collapseWhitespace(text) {
  return String(text ?? '').replace(/[ \s]+/g, ' ').trim();
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function estimateTokens(text) {
  // Rough heuristic (~4 characters per token for English). Used only for budgeting.
  return Math.ceil(String(text ?? '').length / 4);
}

export function isHttpUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export function originPattern(url) {
  const u = new URL(url);
  return `${u.protocol}//${u.hostname}/*`;
}

export function hostnameOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

export function pad2(n) {
  return String(n).padStart(2, '0');
}

// Local-time YYYY-MM-DD (never UTC, so dates don't shift across midnight).
export function ymd(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function parseYmd(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function addDays(date, n) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() + n);
  return d;
}

export function daysBetween(a, b) {
  return Math.round((startOfDay(b) - startOfDay(a)) / 86400000);
}
