// Page and research assistant: summarize, answer questions, compare tabs, research across tabs.
// Only text from pages that were actually read is sent; unreadable pages are reported, never guessed.
import { chat, AIError } from './ai.js';
import { getSettings } from './settings.js';
import { memoriesForAI } from './memory.js';
import { splitIntoChunks, selectRelevantChunks } from './chunk.js';
import { processGroundedAnswer } from './grounding.js';
import { groundedSystemPrompt, groundedUserPrompt, chunkNotesSystemPrompt, formatSources } from './prompts.js';

const CHARS_PER_TOKEN = 4;

export function buildSources(readResults) {
  const sources = [];
  const unreadable = [];
  for (const r of readResults) {
    if (r.ok) sources.push({ id: `S${sources.length + 1}`, title: r.page.title || r.tab?.title || r.page.url, url: r.page.url || r.tab?.url, text: r.page.text, fullText: r.page.text });
    else unreadable.push({ title: r.tab?.title || r.url || 'Untitled', url: r.tab?.url || r.url || '', reason: r.reason });
  }
  return { sources, unreadable };
}

/** Fits all sources into the budget, choosing each source's most relevant passages for the question. */
export function fitSources(sources, question, budgetChars) {
  const per = Math.floor(budgetChars / Math.max(sources.length, 1));
  let trimmed = false;
  const fitted = sources.map((s) => {
    if (s.text.length <= per) return s;
    trimmed = true;
    const chunks = splitIntoChunks(s.text, Math.min(4000, per));
    const picked = selectRelevantChunks(chunks, question, per);
    return { ...s, text: picked.map((p) => p.text).join('\n[…]\n') };
  });
  return { fitted, trimmed };
}

/**
 * Describes exactly what will be sent to the AI, for the consent notice.
 */
export function describeOutgoing(sources, question) {
  const chars = sources.reduce((n, s) => n + s.text.length, 0);
  return {
    items: sources.map((s) => ({ title: s.title, url: s.url, words: Math.round(s.text.split(/\s+/).length) })),
    approxWords: Math.round(chars / 5.5),
    question,
  };
}

async function groundedCall(task, question, sources, { onStatus, note, maxTokens = 1400 } = {}) {
  const settings = await getSettings();
  const memories = await memoriesForAI(settings.useMemoriesInAI);
  let budget = settings.maxInputTokens * CHARS_PER_TOKEN;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { fitted, trimmed } = fitSources(sources, question, budget);
    const trimNote = trimmed ? 'Note: some sources were long, so only their most relevant passages are included (marked […]).' : '';
    try {
      const r = await chat({
        messages: [
          { role: 'system', content: groundedSystemPrompt(task, memories) },
          { role: 'user', content: groundedUserPrompt({ question, sources: fitted, note: [note, trimNote].filter(Boolean).join(' ') }) },
        ],
        json: true,
        maxTokens,
        onStatus,
      });
      return { ...r, trimmed };
    } catch (err) {
      if (err instanceof AIError && err.code === 'too_long' && attempt < 2) {
        budget = Math.floor(budget / 2);
        onStatus?.('That was too long for the model; trying again with less text…');
        continue;
      }
      throw err;
    }
  }
  throw new AIError('too_long', 'The text is too long even after shortening. Try selecting fewer tabs or asking about a specific part.');
}

/** Map-reduce summary for pages too long to send in one request. */
async function summarizeLong(source, question, { onStatus }) {
  const settings = await getSettings();
  const chunkChars = Math.floor(settings.maxInputTokens * CHARS_PER_TOKEN * 0.8);
  const chunks = splitIntoChunks(source.text, chunkChars).slice(0, 8);
  const notes = [];
  for (let i = 0; i < chunks.length; i++) {
    onStatus?.(`Reading part ${i + 1} of ${chunks.length}…`);
    const part = { ...source, text: chunks[i] };
    const r = await chat({
      messages: [
        { role: 'system', content: chunkNotesSystemPrompt() },
        { role: 'user', content: `Part ${i + 1} of ${chunks.length}.\n\n${formatSources([part])}` },
      ],
      json: true,
      maxTokens: 800,
      onStatus,
    });
    notes.push(r.data);
  }
  // Combine: facts from all parts become the input for a final pass.
  const combinedText = notes.map((n, i) => `Part ${i + 1}: ${n.answer || ''}\n${(n.facts || []).map((f) => `- ${f.claim} ("${f.quote || ''}")`).join('\n')}`).join('\n\n');
  const final = await groundedCall('summarize', question, [{ ...source, text: combinedText }], {
    onStatus,
    note: `This page was long, so it was read in ${chunks.length} parts; the source below contains notes and quotes from each part.`,
  });
  return { ...final, parts: chunks.length };
}

/**
 * @param task      'summarize' | 'qa' | 'compare' | 'research'
 * @param readResults results of readTab() for each chosen tab
 */
export async function runGroundedTask(task, question, readResults, { onStatus } = {}) {
  const { sources, unreadable } = buildSources(readResults);
  if (!sources.length) {
    return { answer: '', facts: [], inferences: [], unanswered: [], sources: [], unreadable, notices: [], nothingRead: true };
  }
  const settings = await getSettings();
  const budget = settings.maxInputTokens * CHARS_PER_TOKEN;
  let r;
  let parts = 0;
  if (task === 'summarize' && sources.length === 1 && sources[0].text.length > budget * 1.5) {
    r = await summarizeLong(sources[0], question, { onStatus });
    parts = r.parts;
  } else {
    r = await groundedCall(task, question, sources, { onStatus });
  }
  // Quotes are verified against the FULL page text, not just the excerpt sent.
  const verifySources = sources.map((s) => ({ ...s, text: s.fullText }));
  const processed = processGroundedAnswer(r.data, verifySources);
  return {
    ...processed,
    sources: sources.map(({ id, title, url }) => ({ id, title, url })),
    unreadable,
    trimmed: !!r.trimmed,
    parts,
    model: r.model,
    notices: r.notices || [],
  };
}
