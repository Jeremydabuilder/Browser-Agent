// Turns the model's structured answer into something safe to display:
//  - facts must cite a source that was actually provided, and quotes are checked against the text
//  - claims without a valid source are shown as inference, not fact

export function normalizeForMatch(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―]/g, '-')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function verifyQuote(quote, sourceText) {
  const q = normalizeForMatch(quote).replace(/^["']|["']$/g, '');
  if (q.length < 8) return false;
  const src = normalizeForMatch(sourceText);
  if (src.includes(q)) return true;
  // Allow quotes that use "..." to skip text: every piece must appear, in order.
  const parts = q.split(/\s*(?:\.\.\.|…)\s*/).filter((p) => p.length >= 6);
  if (parts.length > 1) {
    let pos = 0;
    for (const p of parts) {
      const at = src.indexOf(p, pos);
      if (at < 0) return false;
      pos = at + p.length;
    }
    return true;
  }
  // Tolerate trailing punctuation differences.
  const stripped = q.replace(/[.,;:!?]+$/g, '');
  return stripped.length >= 8 && src.includes(stripped);
}

function asArray(x) {
  return Array.isArray(x) ? x : [];
}

/**
 * @param raw     parsed JSON from the model: {answer, facts:[{claim, quote, sources}], inferences:[{claim, basis}], unanswered:[]}
 * @param sources [{id:'S1', title, url, text}]
 */
export function processGroundedAnswer(raw, sources) {
  const byId = new Map(sources.map((s) => [s.id, s]));
  const facts = [];
  const inferences = [];
  let droppedCitations = 0;
  for (const f of asArray(raw?.facts).slice(0, 30)) {
    const claim = String(f?.claim || '').trim();
    if (!claim) continue;
    const cited = asArray(f.sources).map((x) => String(x).trim().toUpperCase().replace(/^\[|\]$/g, ''));
    const valid = [...new Set(cited)].filter((id) => byId.has(id));
    droppedCitations += cited.length - valid.length;
    if (!valid.length) {
      inferences.push({ claim, basis: 'Stated by the AI without a matching source, so treat it as inference.' });
      continue;
    }
    const quote = String(f.quote || '').trim();
    const verified = !!quote && valid.some((id) => verifyQuote(quote, byId.get(id).text));
    facts.push({
      claim,
      quote,
      verified,
      sources: valid.map((id) => ({ id, title: byId.get(id).title, url: byId.get(id).url })),
    });
  }
  for (const i of asArray(raw?.inferences).slice(0, 20)) {
    const claim = String(i?.claim || i || '').trim();
    if (claim) inferences.push({ claim, basis: String(i?.basis || '').trim() });
  }
  return {
    answer: String(raw?.answer || '').trim(),
    facts,
    inferences,
    unanswered: asArray(raw?.unanswered).map(String).filter(Boolean).slice(0, 10),
    droppedCitations,
  };
}
