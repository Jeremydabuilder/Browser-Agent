// Splitting long page text into chunks and picking the parts most relevant to a question.

export function splitIntoChunks(text, maxChars = 12000) {
  const clean = String(text || '').replace(/\r/g, '');
  if (clean.length <= maxChars) return clean.trim() ? [clean.trim()] : [];
  const paragraphs = clean.split(/\n{1,}/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let current = '';
  const push = () => { if (current.trim()) chunks.push(current.trim()); current = ''; };
  for (const para of paragraphs) {
    if (para.length > maxChars) {
      push();
      // Hard-split very long paragraphs at sentence boundaries where possible.
      let rest = para;
      while (rest.length > maxChars) {
        let cut = rest.lastIndexOf('. ', maxChars);
        if (cut < maxChars * 0.5) cut = maxChars;
        chunks.push(rest.slice(0, cut + 1).trim());
        rest = rest.slice(cut + 1);
      }
      current = rest;
      continue;
    }
    if (current.length + para.length + 1 > maxChars) push();
    current += (current ? '\n' : '') + para;
  }
  push();
  return chunks;
}

const STOP = new Set('a an the and or but of to in on for with at by from is are was were be been it this that these those what which who whom how why when where do does did can could should would will i you he she we they my your our their me us them as about into than then so if not no'.split(' '));

export function tokenize(text) {
  return String(text || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w));
}

// BM25-style scoring of chunks against a query. Returns chunks (in original order) that fit the budget.
export function selectRelevantChunks(chunks, query, budgetChars) {
  if (!chunks.length) return [];
  const total = chunks.reduce((n, c) => n + c.length, 0);
  if (total <= budgetChars) return chunks.map((text, index) => ({ index, text }));
  const qTerms = [...new Set(tokenize(query))];
  const docs = chunks.map((c) => tokenize(c));
  const avgLen = docs.reduce((n, d) => n + d.length, 0) / docs.length || 1;
  const df = new Map();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) || 0) + 1);
  const k1 = 1.4;
  const b = 0.75;
  const scored = docs.map((d, index) => {
    const tf = new Map();
    for (const t of d) tf.set(t, (tf.get(t) || 0) + 1);
    let score = 0;
    for (const q of qTerms) {
      const f = tf.get(q) || 0;
      if (!f) continue;
      const idf = Math.log(1 + (docs.length - (df.get(q) || 0) + 0.5) / ((df.get(q) || 0) + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / avgLen)));
    }
    // Slight preference for the beginning of the page (titles, intros).
    if (index === 0) score += 0.25;
    return { index, score };
  });
  scored.sort((x, y) => y.score - x.score || x.index - y.index);
  const picked = [];
  let used = 0;
  for (const s of scored) {
    const len = chunks[s.index].length;
    if (used + len > budgetChars) {
      if (!picked.length) {
        picked.push({ index: s.index, text: chunks[s.index].slice(0, budgetChars) });
        used = budgetChars;
      }
      continue;
    }
    picked.push({ index: s.index, text: chunks[s.index] });
    used += len;
  }
  return picked.sort((x, y) => x.index - y.index);
}
