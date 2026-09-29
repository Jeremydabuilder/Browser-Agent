import { getSettings, updateSettings } from '../lib/settings.js';
import { ping, resolveTaskModels, taskConfig, providerLabel, friendlyError } from '../lib/ai.js';
import { transcriptionPrice, chatPrice, getSpend, resetSpend, formatUsd } from '../lib/pricing.js';
import { GOOGLE_SERVICES, getConnections, connect, disconnect, disconnectAll } from '../lib/google-auth.js';
import { listAssignments, clearAssignments } from '../lib/school.js';
import { setItem } from '../lib/storage.js';
import { h, clear, toast, confirmDialog } from '../lib/ui.js';

const $ = (id) => document.getElementById(id);

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = h('a', { href: '#', download: name });
  a.href = url;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

let lastPing = null;

async function testCompanion() {
  const el = $('companion-status');
  el.className = 'status-line';
  el.textContent = 'Checking…';
  clear($('key-status'));
  try {
    lastPing = await ping();
    const keys = lastPing.keys || { groq: lastPing.hasKey, openai: false };
    el.className = 'status-line ok';
    el.textContent = `✓ Companion ${lastPing.version} is installed and answering. Keys are ${lastPing.keyStore === 'windows-dpapi' ? 'encrypted with Windows' : `stored as ${lastPing.keyStore}`}.`;
    for (const p of ['groq', 'openai']) {
      const has = !!keys[p];
      $('key-status').append(h('div', { class: 'key-row' }, h('span', { class: `chip ${has ? 'ok' : p === 'groq' ? 'danger' : ''}` }, has ? 'key stored' : 'no key'), h('b', {}, providerLabel(p)),
        has ? null : h('span', { class: 'muted small' }, p === 'groq' ? 'Required by default. Start menu → “Satchel - Set Groq key”.' : 'Optional. Start menu → “Satchel - Set OpenAI key” to use OpenAI.')));
    }
  } catch (err) {
    el.className = 'status-line bad';
    el.textContent = friendlyError(err);
    $('companion-help').open = true;
  }
  await refreshTasks(true);
}

function fillSelect(sel, models, current, label) {
  clear(sel);
  sel.append(h('option', { value: 'auto' }, 'Auto (recommended)'));
  for (const m of models) sel.append(h('option', { value: m.id }, `${m.id}${m.contextWindow ? ` · ${Math.round(m.contextWindow / 1000)}k context` : ''}`));
  if (current && current !== 'auto' && !models.some((m) => m.id === current)) sel.append(h('option', { value: current }, `${current} (not in your ${label} list right now)`));
  sel.value = current || 'auto';
}

/** Shows, for each task, the provider and model that will actually be used right now. */
async function refreshTasks(force = false) {
  const s = await getSettings();
  $('chat-provider').value = s.chatProvider;
  $('stt-provider').value = s.transcriptionProvider;
  const r = await resolveTaskModels({ force });
  const keys = lastPing?.keys || {};
  for (const [task, el, sel] of [['chat', 'chat-uses', 'model-select'], ['transcription', 'stt-uses', 'stt-model']]) {
    const t = r[task];
    const { preferred } = taskConfig(s, task);
    fillSelect($(sel), t.models || [], preferred, providerLabel(t.provider));
    const box = $(el);
    clear(box);
    if (lastPing && !keys[t.provider]) {
      box.className = 'status-line bad';
      box.append(`No ${providerLabel(t.provider)} key is stored, so this task can't run. Start menu → “Satchel - Set ${providerLabel(t.provider)} key”, or switch the provider.`);
      continue;
    }
    if (t.error) { box.className = 'status-line bad'; box.append(`Can't check ${providerLabel(t.provider)} right now: ${t.error}`); continue; }
    box.className = 'status-line ok';
    const price = task === 'chat' ? chatPrice(t.provider, t.model, s.priceOverrides) : transcriptionPrice(t.provider, t.model, s.priceOverrides);
    const priceText = task === 'chat' ? `≈ $${price.input} / $${price.output} per 1M tokens in/out` : `≈ ${formatUsd(price.perMinute * 60)} per hour of audio`;
    box.append('Will use: ', h('b', {}, `${providerLabel(t.provider)} · ${t.model || '(none available)'}`), t.auto ? ' (picked automatically)' : '',
      ` · ${priceText}${price.known ? '' : ' (price unknown; using a cautious estimate)'}`,
      task === 'transcription' ? (t.timestamps ? ' · timestamps per sentence' : ' · this model gives no timestamps, so notes link to 5-minute parts') : '');
  }
  await renderSpending();
}

async function renderSpending() {
  const s = await getSettings();
  const spend = await getSpend();
  $('budget').value = s.openaiBudgetUsd;
  $('spend-used').textContent = `${formatUsd(spend.openai)} of ${formatUsd(s.openaiBudgetUsd)} (${spend.requests?.openai || 0} OpenAI requests in ${spend.period})`;
  $('spend-used').className = `status-line ${spend.openai >= s.openaiBudgetUsd ? 'bad' : ''}`;
  // Price editor for the models currently selected for each task.
  const r = await resolveTaskModels();
  const wrap = $('price-editor');
  clear(wrap);
  const rows = [];
  if (r.chat.model) rows.push({ kind: 'chat', provider: r.chat.provider, model: r.chat.model });
  if (r.transcription.model) rows.push({ kind: 'stt', provider: r.transcription.provider, model: r.transcription.model });
  for (const row of rows) {
    const key = `${row.kind}:${row.provider}:${row.model}`;
    if (row.kind === 'stt') {
      const p = transcriptionPrice(row.provider, row.model, s.priceOverrides);
      const inp = h('input', { type: 'number', min: 0, step: 0.0001, value: String(+p.perMinute.toFixed(5)), 'aria-label': `Price per minute for ${row.model}` });
      inp.onchange = () => savePrice(key, Number(inp.value));
      wrap.append(h('div', { class: 'price-row' }, h('b', {}, `${providerLabel(row.provider)} ${row.model}`), 'US$ per audio minute', inp, h('span', { class: 'muted small' }, p.source === 'yours' ? '(your price)' : p.known ? '(default)' : '(unknown model: cautious guess)')));
    } else {
      const p = chatPrice(row.provider, row.model, s.priceOverrides);
      const i1 = h('input', { type: 'number', min: 0, step: 0.01, value: String(p.input), 'aria-label': `Input price for ${row.model}` });
      const i2 = h('input', { type: 'number', min: 0, step: 0.01, value: String(p.output), 'aria-label': `Output price for ${row.model}` });
      const save = () => savePrice(key, [Number(i1.value), Number(i2.value)]);
      i1.onchange = save;
      i2.onchange = save;
      wrap.append(h('div', { class: 'price-row' }, h('b', {}, `${providerLabel(row.provider)} ${row.model}`), 'US$ per 1M tokens: input', i1, 'output', i2, h('span', { class: 'muted small' }, p.source === 'yours' ? '(your price)' : p.known ? '(default)' : '(unknown model: cautious guess)')));
    }
  }
}

async function savePrice(key, value) {
  const s = await getSettings();
  await updateSettings({ priceOverrides: { ...s.priceOverrides, [key]: value } });
  toast('Price saved for estimates.');
  refreshTasks();
}

async function renderConnections() {
  const connections = await getConnections();
  const settings = await getSettings();
  const wrap = $('google-connections');
  clear(wrap);
  for (const [key, s] of Object.entries(GOOGLE_SERVICES)) {
    const c = connections[key];
    const btn = c
      ? h('button', { class: 'btn small', onclick: async () => { await disconnect(key); renderConnections(); } }, 'Disconnect')
      : h('button', {
        class: 'btn small primary', disabled: !settings.googleClientId,
        onclick: async () => {
          try { await connect(key); toast('Connected.'); } catch (err) { toast(err.message, 'error'); }
          renderConnections();
        },
      }, 'Connect');
    wrap.append(h('div', { class: 'mem' }, h('div', { class: 'row' }, h('div', {}, h('b', {}, s.label), h('div', { class: 'muted small' }, s.explain),
      c ? h('div', { class: 'small', style: 'color:var(--ok)' }, `Connected${c.email ? ` as ${c.email}` : ''} on ${new Date(c.connectedAt).toLocaleDateString()}`) : null), btn)));
  }
}

async function main() {
  const s = await getSettings();
  $('ext-id').textContent = chrome.runtime.id;
  $('max-tokens').value = s.maxInputTokens;
  $('timeout').value = s.requestTimeoutSec;
  $('confirm-sending').checked = s.confirmBeforeSending;
  $('use-memories').checked = s.useMemoriesInAI;
  $('date-order').value = s.dateOrder;
  $('client-id').value = s.googleClientId;
  $('redirect-uri').textContent = chrome.identity.getRedirectURL();
  $('test-companion').onclick = testCompanion;
  $('refresh-models').onclick = async () => { await refreshTasks(true); toast('Model lists updated.'); };
  $('stt-lang').value = s.transcriptionLanguage || '';
  $('chat-provider').onchange = async (e) => { await updateSettings({ chatProvider: e.target.value }); toast(`Chat and notes will use ${providerLabel(e.target.value)}.`); refreshTasks(); };
  $('stt-provider').onchange = async (e) => { await updateSettings({ transcriptionProvider: e.target.value }); toast(`Meeting transcription will use ${providerLabel(e.target.value)}.`); refreshTasks(); };
  $('model-select').onchange = async (e) => {
    const cur = await getSettings();
    await updateSettings(cur.chatProvider === 'openai' ? { openaiChatModel: e.target.value } : { model: e.target.value });
    toast('Model saved.');
    refreshTasks();
  };
  $('stt-model').onchange = async (e) => {
    const cur = await getSettings();
    await updateSettings(cur.transcriptionProvider === 'openai' ? { openaiTranscriptionModel: e.target.value } : { transcriptionModel: e.target.value });
    toast('Speech-to-text model saved.');
    refreshTasks();
  };
  $('stt-lang').onchange = async (e) => { await updateSettings({ transcriptionLanguage: e.target.value }); toast('Saved.'); };
  $('budget').onchange = async (e) => { const n = await updateSettings({ openaiBudgetUsd: e.target.value }); e.target.value = n.openaiBudgetUsd; toast(`OpenAI spending guard set to ${formatUsd(n.openaiBudgetUsd)} per month (Satchel's estimate).`); renderSpending(); };
  $('reset-spend').onclick = async () => { if (await confirmDialog({ title: 'Reset this month\'s estimate?', message: 'Satchel\'s estimate of OpenAI spending for this month goes back to $0. This does not change anything in your OpenAI account.', confirmLabel: 'Reset' })) { await resetSpend(); renderSpending(); toast('Estimate reset.'); } };
  $('max-tokens').onchange = async (e) => { const n = await updateSettings({ maxInputTokens: e.target.value }); e.target.value = n.maxInputTokens; toast('Saved.'); };
  $('timeout').onchange = async (e) => { const n = await updateSettings({ requestTimeoutSec: e.target.value }); e.target.value = n.requestTimeoutSec; toast('Saved.'); };
  $('confirm-sending').onchange = async (e) => { await updateSettings({ confirmBeforeSending: e.target.checked }); toast('Saved.'); };
  $('use-memories').onchange = async (e) => { await updateSettings({ useMemoriesInAI: e.target.checked }); toast('Saved.'); };
  $('date-order').onchange = async (e) => { await updateSettings({ dateOrder: e.target.value }); toast('Saved. New refreshes will use this.'); };
  $('copy-redirect').onclick = async () => { await navigator.clipboard.writeText($('redirect-uri').textContent); toast('Copied.'); };
  $('save-client-id').onclick = async () => {
    const v = $('client-id').value.trim();
    if (v && !/^[\w-]+\.apps\.googleusercontent\.com$/.test(v)) { toast('That does not look like a Google OAuth client ID (it ends with .apps.googleusercontent.com).', 'error'); return; }
    await updateSettings({ googleClientId: v });
    toast('Client ID saved.');
    renderConnections();
  };
  $('disconnect-google').onclick = async () => { if (await confirmDialog({ title: 'Disconnect Google?', message: 'Satchel will revoke its Google access and forget all Google connections.', confirmLabel: 'Disconnect', danger: true })) { await disconnectAll(); renderConnections(); toast('Disconnected.'); } };
  $('export-assignments').onclick = async () => download(`satchel-assignments-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(await listAssignments(), null, 2));
  $('clear-assignments').onclick = async () => { if (await confirmDialog({ title: 'Delete all assignments?', message: 'This removes every assignment from Satchel, including ones you added or corrected.', confirmLabel: 'Delete all', danger: true })) { await clearAssignments(); toast('Assignments deleted.'); } };
  $('clear-saved-tabs').onclick = async () => { if (await confirmDialog({ title: 'Delete saved tab groups?', message: 'Saved groups cannot be reopened after this.', confirmLabel: 'Delete', danger: true })) { await setItem('savedTabGroups', []); toast('Saved tab groups deleted.'); } };
  renderConnections();
  if (location.hash === '#google') $('google-guide').open = true;
  if (location.hash) document.querySelector(location.hash)?.scrollIntoView();
  testCompanion();
}

main();
